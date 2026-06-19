const express = require('express');
const path = require('path');
const jwt = require('jsonwebtoken');

const app = express();
const port = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;
const IS_STAGING = process.env.USERNODE_ENV === 'staging';
const CHAIN_ID = process.env.CHAIN_ID || '1';
const NODE_RPC_URL = process.env.NODE_RPC_URL || 'http://localhost:3001';
const APP_PUBKEY = process.env.APP_PUBKEY || '';
const SENDER_APP_PUBKEY = process.env.SENDER_APP_PUBKEY || '';
const SENDER_APP_SECRET_KEY = process.env.SENDER_APP_SECRET_KEY || '';

// Signing is unavailable when the secret key is absent or the staging placeholder
const CAN_SIGN = !!SENDER_APP_SECRET_KEY &&
  SENDER_APP_SECRET_KEY !== 'staging_placeholder_secret_key_not_valid';

const PUBLIC_API_PATHS = new Set(['/health', '/favicon.ico', '/api/state', '/api/env']);
const PUBLIC_PREFIXES = ['/explorer-api/', '/api/usernames/'];

const DEMO_USERNAMES = {
  'ut1demoCreator1xxxxxxxxxxxxxxxxxxxxxxxxxx': 'creator-solar',
  'ut1demoCreator2xxxxxxxxxxxxxxxxxxxxxxxxxx': 'creator-library',
  'ut1demoCreator3xxxxxxxxxxxxxxxxxxxxxxxxxx': 'creator-playground',
  'ut1demoCreator4xxxxxxxxxxxxxxxxxxxxxxxxxx': 'creator-art',
  'ut1demoBacker1xxxxxxxxxxxxxxxxxxxxxxxxxx': 'backer-alex',
  'ut1demoBacker2xxxxxxxxxxxxxxxxxxxxxxxxxx': 'backer-jordan',
  'ut1demoBacker3xxxxxxxxxxxxxxxxxxxxxxxxxx': 'backer-casey',
};

// ── In-memory state (source of truth = chain; this is a performance cache) ──

const state = {
  campaigns: new Map(),      // id → CampaignRecord
  contributions: [],          // ContributionRecord[] append-only
  withdrawals: new Map(),    // campaign_id → WithdrawalRecord
  refunds: new Map(),        // `${campaign_id}:${contributor_address}` → RefundRecord
  seenTxIds: new Set(),      // dedup guard
};

app.use(express.json());

// ── Auth ─────────────────────────────────────────────────────────────────────

app.use((req, res, next) => {
  const token = req.query.token || req.headers['x-usernode-token'];
  if (token && JWT_SECRET) {
    try { req.user = jwt.verify(token, JWT_SECRET); } catch {}
  }
  if (req.method !== 'GET' || req.path.startsWith('/api/')) {
    if (PUBLIC_API_PATHS.has(req.path)) return next();
    if (PUBLIC_PREFIXES.some((p) => req.path.startsWith(p))) return next();
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
});

// ── Routes ───────────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.get('/api/env', (_req, res) =>
  res.json({ staging: IS_STAGING, chain_id: CHAIN_ID, app_pubkey: APP_PUBKEY })
);

app.get('/__usernames/state', (_req, res) => {
  const usernames = IS_STAGING ? { ...DEMO_USERNAMES } : {};
  res.json({ usernames, lastSeenTs: 0, count: Object.keys(usernames).length });
});

app.get('/api/usernames/:pubkey', (req, res) => {
  res.json({ username: IS_STAGING ? (DEMO_USERNAMES[req.params.pubkey] || null) : null });
});

app.get('/api/me', (req, res) => {
  res.json({
    id: req.user.id,
    username: req.user.username,
    usernode_pubkey: req.user.usernode_pubkey || null,
    address: req.user.usernode_pubkey || null,
  });
});

// ── Chain state (replayed from transactions) ──────────────────────────────────

app.get('/api/state', (_req, res) => {
  const now = Date.now();
  const campaigns = [];

  for (const [id, camp] of state.campaigns) {
    const contribs = state.contributions.filter(c => c.campaign_id === id);
    const total_raised = contribs.reduce((s, c) => s + c.amount, 0);
    const backer_count = new Set(contribs.map(c => c.from)).size;
    const hasWithdrawal = state.withdrawals.has(id);
    const deadlinePassed = new Date(camp.deadline).getTime() < now;

    let status;
    if (hasWithdrawal) {
      status = 'withdrawn';
    } else if (total_raised >= camp.goal) {
      status = 'funded';
    } else if (deadlinePassed) {
      const unique = [...new Set(contribs.map(c => c.from))];
      const allRefunded = unique.length > 0 &&
        unique.every(addr => state.refunds.has(`${id}:${addr}`));
      status = allRefunded ? 'refunded' : 'expired';
    } else {
      status = 'active';
    }

    campaigns.push({ ...camp, total_raised, backer_count, status });
  }

  campaigns.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  const withdrawals = [];
  for (const [campaign_id, w] of state.withdrawals) {
    withdrawals.push({ campaign_id, ...w });
  }

  const refunds = [];
  for (const [key, r] of state.refunds) {
    const colonIdx = key.indexOf(':');
    const campaign_id = key.slice(0, colonIdx);
    const contributor = key.slice(colonIdx + 1);
    refunds.push({ campaign_id, contributor, ...r });
  }

  res.json({ campaigns, contributions: state.contributions, withdrawals, refunds });
});

// Creator-initiated withdrawal — server signs the on-chain disbursement
app.post('/api/campaigns/:id/withdraw', async (req, res) => {
  const campaignId = req.params.id;
  const camp = state.campaigns.get(campaignId);
  if (!camp) return res.status(404).json({ error: 'Campaign not found' });

  const myAddr = req.user.usernode_pubkey;
  if (!myAddr || camp.creator_address !== myAddr) {
    return res.status(403).json({ error: 'Not the campaign creator' });
  }
  if (state.withdrawals.has(campaignId)) {
    return res.status(400).json({ error: 'Already withdrawn' });
  }

  const contribs = state.contributions.filter(c => c.campaign_id === campaignId);
  const total_raised = contribs.reduce((s, c) => s + c.amount, 0);
  if (total_raised < camp.goal) {
    return res.status(400).json({ error: 'Campaign goal not yet reached' });
  }
  if (!CAN_SIGN) {
    return res.status(503).json({ error: 'Signing not available in this environment' });
  }

  try {
    const txid = await signAndSend(camp.creator_address, total_raised, {
      app: 'crowdfunding',
      type: 'withdraw',
      campaign: campaignId,
    });
    state.withdrawals.set(campaignId, {
      txid,
      to: camp.creator_address,
      amount: total_raised,
      ts: new Date().toISOString(),
    });
    res.json({ txid, amount: total_raised });
  } catch (err) {
    console.error('withdraw error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Explorer proxy ────────────────────────────────────────────────────────────

app.use('/explorer-api', async (req, res) => {
  try {
    const target = NODE_RPC_URL.replace(/\/$/, '') + req.path;
    const fetchOpts = { method: req.method, headers: { 'content-type': 'application/json' } };
    if (req.method !== 'GET' && req.body) fetchOpts.body = JSON.stringify(req.body);
    const upstream = await fetch(target, fetchOpts);
    const body = await upstream.text();
    res.status(upstream.status)
      .set('content-type', upstream.headers.get('content-type') || 'application/json')
      .send(body);
  } catch (err) {
    res.status(502).json({ error: 'Explorer proxy error', detail: err.message });
  }
});

// ── Static + SPA fallback ─────────────────────────────────────────────────────

app.get('/favicon.ico', (_req, res) => res.status(204).end());
app.use(express.static(path.join(__dirname, 'public')));

app.get('*', (req, res) => {
  if (!req.user) {
    return res.status(401).send(`<!doctype html><meta charset=utf-8><title>Open in Usernode</title>
<body style="font-family:system-ui;background:#09090b;color:#e4e4e7;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">
  <div style="max-width:24rem;padding:2rem;text-align:center">
    <h1 style="font-size:1.25rem;margin:0 0 0.5rem">Open this app inside Usernode</h1>
    <p style="color:#a1a1aa;font-size:0.9rem;margin:0 0 1.25rem">This page is served via the platform; direct visits aren't authenticated.</p>
    <a href="https://social-vibecoding.usernodelabs.org" style="display:inline-block;padding:0.5rem 1rem;background:#7c3aed;color:white;border-radius:0.5rem;text-decoration:none;font-size:0.9rem">Go to Usernode</a>
  </div>
</body>`);
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Chain helpers ──────────────────────────────────────────────────────────────

async function signAndSend(to, amount, memoObj) {
  const resp = await fetch(`${NODE_RPC_URL.replace(/\/$/, '')}/${CHAIN_ID}/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      from: SENDER_APP_PUBKEY,
      to,
      amount,
      memo: JSON.stringify(memoObj),
      secret_key: SENDER_APP_SECRET_KEY,
    }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Node send failed: ${resp.status} ${text.slice(0, 200)}`);
  }
  const data = await resp.json();
  return data.txid || data.tx_id || data.id || data.hash;
}

async function fetchTxsForAddress(address) {
  if (!address) return [];
  try {
    const resp = await fetch(
      `${NODE_RPC_URL.replace(/\/$/, '')}/${CHAIN_ID}/transactions?address=${encodeURIComponent(address)}`,
      { signal: AbortSignal.timeout(10000) }
    );
    if (!resp.ok) return [];
    const data = await resp.json();
    return Array.isArray(data) ? data : (data.transactions || data.results || []);
  } catch (err) {
    console.error(`fetchTxs(${address}) failed:`, err.message);
    return [];
  }
}

function txId(tx) { return tx.tx_id || tx.txid || tx.txId || tx.hash || tx.tx_hash || tx.id; }
function txFrom(tx) { return tx.from || tx.sender || tx.from_address; }
function txTo(tx) { return tx.to || tx.recipient || tx.to_address; }
function txAmount(tx) { return parseInt(tx.amount || tx.value || '0', 10) || 0; }
function txTs(tx) { return tx.timestamp || tx.created_at || tx.time || new Date().toISOString(); }

function processTransaction(tx) {
  const id = txId(tx);
  if (!id || state.seenTxIds.has(id)) return;
  state.seenTxIds.add(id);

  let memo;
  try { memo = JSON.parse(tx.memo || '{}'); } catch (_) { return; }
  if (memo.app !== 'crowdfunding') return;

  const from = txFrom(tx);
  const to = txTo(tx);
  const amount = txAmount(tx);
  const ts = txTs(tx);

  switch (memo.type) {
    case 'create_campaign': {
      const c = memo.campaign;
      if (!c || !c.id || !c.title || c.goal === undefined || !c.deadline) break;
      if (!state.campaigns.has(c.id)) {
        state.campaigns.set(c.id, {
          id: c.id,
          title: String(c.title).slice(0, 200),
          description: String(c.description || '').slice(0, 1000),
          emoji: String(c.emoji || '💡').slice(0, 8),
          goal: Math.max(1, parseInt(c.goal, 10) || 0),
          deadline: c.deadline,
          creator_address: from,
          created_tx: id,
          created_at: ts,
        });
      }
      break;
    }
    case 'contribute': {
      const cid = String(memo.campaign || '');
      if (!cid || !state.campaigns.has(cid) || amount <= 0) break;
      if (!state.contributions.some(c => c.txid === id)) {
        state.contributions.push({ txid: id, campaign_id: cid, from, amount, ts });
      }
      break;
    }
    case 'withdraw': {
      const cid = String(memo.campaign || '');
      if (cid && !state.withdrawals.has(cid)) {
        state.withdrawals.set(cid, { txid: id, to, amount, ts });
      }
      break;
    }
    case 'refund': {
      const cid = String(memo.campaign || '');
      const contributor = String(memo.contributor || '');
      if (!cid || !contributor) break;
      const key = `${cid}:${contributor}`;
      if (!state.refunds.has(key)) {
        state.refunds.set(key, { txid: id, to: contributor, amount, ts });
      }
      break;
    }
  }
}

async function processAutoRefunds() {
  if (!CAN_SIGN) return;
  const now = Date.now();

  for (const [id, camp] of state.campaigns) {
    if (IS_STAGING && id.startsWith('demo-')) continue;
    if (new Date(camp.deadline).getTime() >= now) continue;

    const contribs = state.contributions.filter(c => c.campaign_id === id);
    const total_raised = contribs.reduce((s, c) => s + c.amount, 0);
    if (total_raised >= camp.goal || state.withdrawals.has(id)) continue;

    const byContributor = {};
    for (const c of contribs) {
      byContributor[c.from] = (byContributor[c.from] || 0) + c.amount;
    }

    for (const [addr, amt] of Object.entries(byContributor)) {
      const key = `${id}:${addr}`;
      if (state.refunds.has(key)) continue;
      try {
        const txid = await signAndSend(addr, amt, {
          app: 'crowdfunding',
          type: 'refund',
          campaign: id,
          contributor: addr,
        });
        state.refunds.set(key, { txid, to: addr, amount: amt, ts: new Date().toISOString() });
        console.log(`refund sent: ${amt} → ${addr} for campaign ${id} txid:${txid}`);
      } catch (err) {
        console.error(`auto-refund failed addr=${addr} campaign=${id}:`, err.message);
      }
    }
  }
}

async function runPoller() {
  if (!APP_PUBKEY && !SENDER_APP_PUBKEY) {
    if (!IS_STAGING) console.warn('APP_PUBKEY not set — poller skipped');
    return;
  }
  try {
    const [appTxs, senderTxs] = await Promise.all([
      fetchTxsForAddress(APP_PUBKEY),
      SENDER_APP_PUBKEY && SENDER_APP_PUBKEY !== APP_PUBKEY
        ? fetchTxsForAddress(SENDER_APP_PUBKEY)
        : Promise.resolve([]),
    ]);

    // Merge and dedup by txid
    const deduped = new Map();
    for (const tx of [...appTxs, ...senderTxs]) {
      const id = txId(tx);
      if (id && !deduped.has(id)) deduped.set(id, tx);
    }

    // Replay in block-height order so state is consistent
    const sorted = [...deduped.values()].sort((a, b) => {
      const ha = a.block_height || a.blockHeight || a.block || 0;
      const hb = b.block_height || b.blockHeight || b.block || 0;
      return ha - hb;
    });

    for (const tx of sorted) processTransaction(tx);
    await processAutoRefunds();
  } catch (err) {
    console.error('poller error:', err.message);
  }
}

// ── Staging seed ──────────────────────────────────────────────────────────────

function seedStagingData() {
  const now = new Date();
  const future30 = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();
  const future7 = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const past7 = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const past30 = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();

  [
    {
      id: 'demo-camp-001',
      title: 'Staging demo — Community Solar Panel',
      description: 'Help us install solar panels on the community center roof. All funds go directly toward equipment and installation costs.',
      emoji: '☀️',
      goal: 5000,
      deadline: future30,
      creator_address: 'ut1demoCreator1xxxxxxxxxxxxxxxxxxxxxxxxxx',
      created_tx: 'demo-tx-c01',
      created_at: past30,
    },
    {
      id: 'demo-camp-002',
      title: 'Staging demo — Open Source Library',
      description: 'Fund the development of a free open-source library for local community resource mapping.',
      emoji: '📚',
      goal: 1000,
      deadline: future7,
      creator_address: 'ut1demoCreator2xxxxxxxxxxxxxxxxxxxxxxxxxx',
      created_tx: 'demo-tx-c02',
      created_at: past7,
    },
    {
      id: 'demo-camp-003',
      title: 'Staging demo — Local Playground',
      description: 'New playground equipment for kids in the neighborhood.',
      emoji: '🛝',
      goal: 3000,
      deadline: future30,
      creator_address: 'ut1demoCreator3xxxxxxxxxxxxxxxxxxxxxxxxxx',
      created_tx: 'demo-tx-c03',
      created_at: past30,
    },
    {
      id: 'demo-camp-004',
      title: 'Staging demo — Art Installation',
      description: 'Community mural project celebrating local culture and history.',
      emoji: '🎨',
      goal: 2000,
      deadline: past7,
      creator_address: 'ut1demoCreator4xxxxxxxxxxxxxxxxxxxxxxxxxx',
      created_tx: 'demo-tx-c04',
      created_at: past30,
    },
  ].forEach(c => state.campaigns.set(c.id, c));

  state.contributions.push(
    { txid: 'demo-tx-001', campaign_id: 'demo-camp-001', from: 'ut1demoBacker1xxxxxxxxxxxxxxxxxxxxxxxxxx', amount: 700, ts: past30 },
    { txid: 'demo-tx-002', campaign_id: 'demo-camp-001', from: 'ut1demoBacker2xxxxxxxxxxxxxxxxxxxxxxxxxx', amount: 800, ts: past30 },
    { txid: 'demo-tx-003', campaign_id: 'demo-camp-001', from: 'ut1demoBacker1xxxxxxxxxxxxxxxxxxxxxxxxxx', amount: 600, ts: past30 },
    { txid: 'demo-tx-004', campaign_id: 'demo-camp-002', from: 'ut1demoBacker2xxxxxxxxxxxxxxxxxxxxxxxxxx', amount: 500, ts: past7 },
    { txid: 'demo-tx-005', campaign_id: 'demo-camp-002', from: 'ut1demoBacker1xxxxxxxxxxxxxxxxxxxxxxxxxx', amount: 450, ts: past7 },
    { txid: 'demo-tx-006', campaign_id: 'demo-camp-003', from: 'ut1demoBacker3xxxxxxxxxxxxxxxxxxxxxxxxxx', amount: 1000, ts: past30 },
    { txid: 'demo-tx-007', campaign_id: 'demo-camp-003', from: 'ut1demoBacker2xxxxxxxxxxxxxxxxxxxxxxxxxx', amount: 1200, ts: past30 },
    { txid: 'demo-tx-008', campaign_id: 'demo-camp-003', from: 'ut1demoBacker1xxxxxxxxxxxxxxxxxxxxxxxxxx', amount: 1000, ts: past30 },
    { txid: 'demo-tx-009', campaign_id: 'demo-camp-004', from: 'ut1demoBacker3xxxxxxxxxxxxxxxxxxxxxxxxxx', amount: 800, ts: past30 },
    { txid: 'demo-tx-010', campaign_id: 'demo-camp-001', from: 'ut1demoBacker1xxxxxxxxxxxxxxxxxxxxxxxxxx', amount: 200, ts: past7 },
  );

  // demo-camp-003: funded and already withdrawn
  state.withdrawals.set('demo-camp-003', {
    txid: 'demo-tx-w01',
    to: 'ut1demoCreator3xxxxxxxxxxxxxxxxxxxxxxxxxx',
    amount: 3200,
    ts: past7,
  });

  // demo-camp-004: expired and refunded
  state.refunds.set('demo-camp-004:ut1demoBacker3xxxxxxxxxxxxxxxxxxxxxxxxxx', {
    txid: 'demo-tx-r01',
    to: 'ut1demoBacker3xxxxxxxxxxxxxxxxxxxxxxxxxx',
    amount: 800,
    ts: past7,
  });

  // Prevent poller from re-processing demo txids
  [
    'demo-tx-001', 'demo-tx-002', 'demo-tx-003', 'demo-tx-004', 'demo-tx-005',
    'demo-tx-006', 'demo-tx-007', 'demo-tx-008', 'demo-tx-009', 'demo-tx-010',
    'demo-tx-c01', 'demo-tx-c02', 'demo-tx-c03', 'demo-tx-c04',
    'demo-tx-w01', 'demo-tx-r01',
  ].forEach(id => state.seenTxIds.add(id));
}

// ── Boot ──────────────────────────────────────────────────────────────────────

async function start() {
  if (IS_STAGING) seedStagingData();

  // Replay chain history immediately, then poll on interval
  runPoller().catch(err => console.error('initial poll error:', err.message));
  setInterval(runPoller, 5000);

  app.listen(port, () => console.log(`Listening on :${port}`));
}

start().catch(err => { console.error(err); process.exit(1); });
