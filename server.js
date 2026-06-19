const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');

const app = express();
const port = process.env.PORT || 3000;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET;
const IS_STAGING = process.env.USERNODE_ENV === 'staging';
const CHAIN_ID = process.env.CHAIN_ID || '1';

const PUBLIC_API_PATHS = new Set(['/health', '/favicon.ico']);
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

app.use(express.json());

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

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.get('/api/env', (_req, res) => {
  res.json({ staging: IS_STAGING, chain_id: CHAIN_ID });
});

// Username cache endpoint — read by usernode-usernames.js (no auth required)
app.get('/__usernames/state', (_req, res) => {
  const usernames = IS_STAGING ? Object.assign({}, DEMO_USERNAMES) : {};
  res.json({ usernames, lastSeenTs: 0, count: Object.keys(usernames).length });
});

// Per-address username lookup — public, used by frontend in staging for demo addresses
app.get('/api/usernames/:pubkey', (req, res) => {
  const username = IS_STAGING ? (DEMO_USERNAMES[req.params.pubkey] || null) : null;
  res.json({ username });
});

app.get('/api/me', (req, res) => {
  res.json({ id: req.user.id, username: req.user.username, usernode_pubkey: req.user.usernode_pubkey || null, address: req.user.usernode_pubkey || null });
});

// ── Campaigns ──────────────────────────────────────────────────────────────

app.post('/api/campaigns', async (req, res) => {
  try {
    const { title, description, cover_emoji, target_amount, deadline, creator_address } = req.body;
    if (!title || !title.trim()) return res.status(400).json({ error: 'title required' });
    if (!target_amount || !Number.isInteger(Number(target_amount)) || Number(target_amount) <= 0)
      return res.status(400).json({ error: 'target_amount must be a positive integer' });
    if (!deadline || new Date(deadline) <= new Date())
      return res.status(400).json({ error: 'deadline must be in the future' });
    if (!creator_address || !creator_address.startsWith('ut1'))
      return res.status(400).json({ error: 'creator_address must be a ut1... address' });

    const { rows } = await pool.query(`
      INSERT INTO campaigns (creator_user_id, creator_username, creator_address, title, description, cover_emoji, target_amount, deadline)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *
    `, [req.user.id, req.user.username, creator_address, title.trim(), description || '', cover_emoji || '', BigInt(target_amount), deadline]);
    res.json({ campaign: rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/campaigns', async (req, res) => {
  try {
    const { status, mine, limit = 50, offset = 0 } = req.query;
    const params = [];
    const conditions = [];
    if (status) { params.push(status); conditions.push(`c.status = $${params.length}`); }
    if (mine === '1') { params.push(req.user.id); conditions.push(`c.creator_user_id = $${params.length}`); }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    params.push(Number(limit), Number(offset));
    const { rows } = await pool.query(`
      SELECT c.*,
        COUNT(DISTINCT co.id) FILTER (WHERE co.status = 'confirmed') AS backer_count
      FROM campaigns c
      LEFT JOIN contributions co ON co.campaign_id = c.id
      ${where}
      GROUP BY c.id
      ORDER BY c.created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}
    `, params);
    res.json({ campaigns: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/campaigns/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT c.*,
        COUNT(DISTINCT co.id) FILTER (WHERE co.status = 'confirmed') AS backer_count
      FROM campaigns c
      LEFT JOIN contributions co ON co.campaign_id = c.id
      WHERE c.id = $1
      GROUP BY c.id
    `, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const campaign = rows[0];

    const { rows: backers } = await pool.query(`
      SELECT contributor_username, contributor_address, amount, created_at
      FROM contributions
      WHERE campaign_id = $1 AND status = 'confirmed'
      ORDER BY created_at DESC
      LIMIT 20
    `, [req.params.id]);

    const { rows: myContribs } = await pool.query(`
      SELECT * FROM contributions
      WHERE campaign_id = $1 AND contributor_user_id = $2
      ORDER BY created_at DESC
    `, [req.params.id, req.user.id]);

    res.json({ campaign, backers, my_contributions: myContribs });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/campaigns/:id', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM campaigns WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const campaign = rows[0];
    if (campaign.creator_user_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

    const { action, description, cover_emoji } = req.body;
    if (action === 'cancel') {
      if (campaign.status !== 'active') return res.status(400).json({ error: 'Can only cancel active campaigns' });
      const { rows: updated } = await pool.query(
        `UPDATE campaigns SET status='cancelled', updated_at=NOW() WHERE id=$1 RETURNING *`,
        [req.params.id]
      );
      return res.json({ campaign: updated[0] });
    }

    const updates = [];
    const params = [];
    if (description !== undefined) { params.push(description); updates.push(`description=$${params.length}`); }
    if (cover_emoji !== undefined) { params.push(cover_emoji); updates.push(`cover_emoji=$${params.length}`); }
    if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });
    params.push(req.params.id);
    const { rows: updated } = await pool.query(
      `UPDATE campaigns SET ${updates.join(', ')}, updated_at=NOW() WHERE id=$${params.length} RETURNING *`,
      params
    );
    res.json({ campaign: updated[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ── Contributions ───────────────────────────────────────────────────────────

app.post('/api/campaigns/:id/contributions', async (req, res) => {
  try {
    const { txid, amount, memo, contributor_address, resend_of_contribution_id } = req.body;
    if (!txid) return res.status(400).json({ error: 'txid required' });
    if (!amount || Number(amount) <= 0) return res.status(400).json({ error: 'amount must be positive' });

    const { rows: camp } = await pool.query('SELECT id FROM campaigns WHERE id = $1', [req.params.id]);
    if (!camp.length) return res.status(404).json({ error: 'Campaign not found' });

    await pool.query(`
      INSERT INTO contributions (campaign_id, contributor_user_id, contributor_username, contributor_address, amount, txid, memo, resend_of_contribution_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (txid) DO NOTHING
    `, [req.params.id, req.user.id, req.user.username, contributor_address || null, BigInt(amount), txid, memo || null, resend_of_contribution_id || null]);

    const { rows } = await pool.query('SELECT * FROM contributions WHERE txid = $1', [txid]);
    res.json({ contribution: rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/campaigns/:id/contributions', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT * FROM contributions WHERE campaign_id = $1 ORDER BY created_at DESC
    `, [req.params.id]);
    res.json({ contributions: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Creator-only: all contributions for a campaign (all statuses, no cap)
app.get('/api/campaigns/:id/contributions/all', async (req, res) => {
  try {
    const { rows: camp } = await pool.query('SELECT * FROM campaigns WHERE id = $1', [req.params.id]);
    if (!camp.length) return res.status(404).json({ error: 'Campaign not found' });
    if (camp[0].creator_user_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

    const { rows } = await pool.query(`
      SELECT * FROM contributions WHERE campaign_id = $1 ORDER BY created_at DESC
    `, [req.params.id]);
    res.json({ contributions: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/contributions/mine', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT co.*, c.title AS campaign_title, c.id AS campaign_id,
        ro.txid AS resend_of_txid, ro.status AS resend_of_status
      FROM contributions co
      JOIN campaigns c ON c.id = co.campaign_id
      LEFT JOIN contributions ro ON ro.id = co.resend_of_contribution_id
      WHERE co.contributor_user_id = $1
      ORDER BY co.created_at DESC
    `, [req.user.id]);
    res.json({ contributions: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// All contributions received across campaigns the logged-in user created
app.get('/api/transactions/received', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT co.*, c.title AS campaign_title, c.id AS campaign_id
      FROM contributions co
      JOIN campaigns c ON c.id = co.campaign_id
      WHERE c.creator_user_id = $1
      ORDER BY co.created_at DESC
    `, [req.user.id]);
    res.json({ contributions: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/contributions/:id/refresh', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM contributions WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const contrib = rows[0];
    if (contrib.contributor_user_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

    const updated = await reconcileContribution(contrib);
    res.json({ contribution: updated });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ── Explorer proxy ──────────────────────────────────────────────────────────

app.use('/explorer-api', async (req, res) => {
  try {
    const NODE_RPC_URL = process.env.NODE_RPC_URL || 'http://localhost:3001';
    const target = NODE_RPC_URL.replace(/\/$/, '') + req.path;
    const fetchOpts = { method: req.method, headers: { 'content-type': 'application/json' } };
    if (req.method !== 'GET' && req.body) fetchOpts.body = JSON.stringify(req.body);
    const upstream = await fetch(target, fetchOpts);
    const body = await upstream.text();
    res.status(upstream.status).set('content-type', upstream.headers.get('content-type') || 'application/json').send(body);
  } catch (err) {
    res.status(502).json({ error: 'Explorer proxy error', detail: err.message });
  }
});

// ── Reconciler ──────────────────────────────────────────────────────────────

async function reconcileContribution(contrib) {
  // Skip demo txids in staging — seeded statuses stay fixed
  if (IS_STAGING && contrib.txid && contrib.txid.startsWith('demo-tx-')) {
    return contrib;
  }

  try {
    const NODE_RPC_URL = process.env.NODE_RPC_URL || 'http://localhost:3001';
    const url = `${NODE_RPC_URL.replace(/\/$/, '')}/${CHAIN_ID}/transactions`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ txid: contrib.txid }),
    });

    if (resp.ok) {
      const data = await resp.json();
      // Match across id field names the bridge recognizes
      const txs = Array.isArray(data) ? data : (data.transactions || data.results || [data]);
      const tx = txs.find(t => {
        const id = t.tx_id || t.txid || t.txId || t.hash || t.tx_hash || t.txHash || t.id;
        return id === contrib.txid;
      });

      if (tx && (tx.block_height || tx.blockHeight || tx.block)) {
        const blockHeight = tx.block_height || tx.blockHeight || tx.block;
        await pool.query(`
          UPDATE contributions SET status='confirmed', block_height=$1, confirmation_checked_at=NOW(), updated_at=NOW()
          WHERE id=$2
        `, [blockHeight, contrib.id]);
        await recomputeCampaign(contrib.campaign_id);
        const { rows } = await pool.query('SELECT * FROM contributions WHERE id=$1', [contrib.id]);
        return rows[0];
      }
    }

    // Heuristic: if tx not found after 30 min since created_at, mark failed.
    // This is a best-effort timeout — the explorer has no explicit "failed" status.
    const ageMs = Date.now() - new Date(contrib.created_at).getTime();
    if (ageMs > 30 * 60 * 1000) {
      await pool.query(`
        UPDATE contributions SET status='failed', confirmation_checked_at=NOW(), updated_at=NOW()
        WHERE id=$1
      `, [contrib.id]);
      const { rows } = await pool.query('SELECT * FROM contributions WHERE id=$1', [contrib.id]);
      return rows[0];
    }
  } catch (err) {
    console.error('reconcile error for contribution', contrib.id, err.message);
  }

  // Update checked_at even when no state change
  await pool.query(`UPDATE contributions SET confirmation_checked_at=NOW() WHERE id=$1`, [contrib.id]);
  const { rows } = await pool.query('SELECT * FROM contributions WHERE id=$1', [contrib.id]);
  return rows[0];
}

async function recomputeCampaign(campaignId) {
  await pool.query(`
    UPDATE campaigns
    SET confirmed_total = COALESCE((
      SELECT SUM(amount) FROM contributions WHERE campaign_id=$1 AND status='confirmed'
    ), 0),
    updated_at = NOW()
    WHERE id=$1
  `, [campaignId]);
  // funded transition
  await pool.query(`
    UPDATE campaigns SET status='funded', updated_at=NOW()
    WHERE id=$1 AND status='active' AND confirmed_total >= target_amount
  `, [campaignId]);
}

async function runReconciler() {
  try {
    // Deadline sweep
    await pool.query(`
      UPDATE campaigns SET status='expired', updated_at=NOW()
      WHERE status='active' AND deadline < NOW() AND confirmed_total < target_amount
    `);

    // Pending sweep: last 48h
    const { rows: pending } = await pool.query(`
      SELECT * FROM contributions
      WHERE status='pending' AND created_at > NOW() - INTERVAL '48 hours'
      FOR UPDATE SKIP LOCKED
    `);

    for (const contrib of pending) {
      await reconcileContribution(contrib);
    }
  } catch (err) {
    console.error('reconciler error:', err.message);
  }
}

// ── Static + SPA fallback ───────────────────────────────────────────────────

// Browsers request favicon automatically with no token; return 204 so the
// request doesn't fall through to the auth-gated SPA wildcard handler.
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

// ── Boot ────────────────────────────────────────────────────────────────────

async function start() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS campaigns (
      id SERIAL PRIMARY KEY,
      creator_user_id INTEGER NOT NULL,
      creator_username VARCHAR(255) NOT NULL,
      creator_address VARCHAR(128) NOT NULL,
      title VARCHAR(200) NOT NULL,
      description TEXT,
      cover_emoji VARCHAR(16),
      target_amount BIGINT NOT NULL,
      deadline TIMESTAMPTZ NOT NULL,
      status VARCHAR(24) NOT NULL DEFAULT 'active',
      confirmed_total BIGINT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS contributions (
      id SERIAL PRIMARY KEY,
      campaign_id INTEGER NOT NULL REFERENCES campaigns(id),
      contributor_user_id INTEGER NOT NULL,
      contributor_username VARCHAR(255) NOT NULL,
      contributor_address VARCHAR(128),
      amount BIGINT NOT NULL,
      txid VARCHAR(128) UNIQUE,
      memo VARCHAR(255),
      status VARCHAR(16) NOT NULL DEFAULT 'pending',
      block_height BIGINT,
      resend_of_contribution_id INTEGER REFERENCES contributions(id),
      confirmation_checked_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_contributions_campaign ON contributions(campaign_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_contributions_user ON contributions(contributor_user_id, created_at DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_contributions_status ON contributions(status)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_campaigns_creator_user ON campaigns(creator_user_id)`);

  // Staging seeds
  if (IS_STAGING) {
    const now = new Date();
    const future30 = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const future7 = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const past7 = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const past30 = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();

    await pool.query(`
      INSERT INTO campaigns (id, creator_user_id, creator_username, creator_address, title, description, cover_emoji, target_amount, deadline, status, confirmed_total)
      VALUES
        (900001, 999001, 'staging-demo-user', 'ut1demoCreator1xxxxxxxxxxxxxxxxxxxxxxxxxx', 'Staging demo — Community Solar Panel', 'Help us install solar panels on the community center roof. All funds go directly toward equipment and installation costs.', '☀️', 5000, $1, 'active', 2100),
        (900002, 999002, 'staging-demo-user2', 'ut1demoCreator2xxxxxxxxxxxxxxxxxxxxxxxxxx', 'Staging demo — Open Source Library', 'Fund the development of a free open-source library for local community resource mapping.', '📚', 1000, $2, 'active', 950),
        (900003, 999003, 'staging-demo-user3', 'ut1demoCreator3xxxxxxxxxxxxxxxxxxxxxxxxxx', 'Staging demo — Local Playground', 'New playground equipment for kids in the neighborhood.', '🛝', 3000, $1, 'funded', 3200),
        (900004, 999004, 'staging-demo-user4', 'ut1demoCreator4xxxxxxxxxxxxxxxxxxxxxxxxxx', 'Staging demo — Art Installation', 'Community mural project celebrating local culture and history.', '🎨', 2000, $3, 'expired', 800)
      ON CONFLICT (id) DO NOTHING
    `, [future30, future7, past30]);

    await pool.query(`
      INSERT INTO contributions (id, campaign_id, contributor_user_id, contributor_username, contributor_address, amount, txid, memo, status, block_height)
      VALUES
        (990001, 900001, 999010, 'staging-demo-backer-1', 'ut1demoBacker1xxxxxxxxxxxxxxxxxxxxxxxxxx', 700, 'demo-tx-001', 'cf:900001', 'confirmed', 12001),
        (990002, 900001, 999011, 'staging-demo-backer-2', 'ut1demoBacker2xxxxxxxxxxxxxxxxxxxxxxxxxx', 800, 'demo-tx-002', 'cf:900001', 'confirmed', 12002),
        (990003, 900001, 999010, 'staging-demo-backer-1', 'ut1demoBacker1xxxxxxxxxxxxxxxxxxxxxxxxxx', 600, 'demo-tx-003', 'cf:900001', 'confirmed', 12003),
        (990004, 900002, 999011, 'staging-demo-backer-2', 'ut1demoBacker2xxxxxxxxxxxxxxxxxxxxxxxxxx', 500, 'demo-tx-004', 'cf:900002', 'confirmed', 12004),
        (990005, 900002, 999010, 'staging-demo-backer-1', 'ut1demoBacker1xxxxxxxxxxxxxxxxxxxxxxxxxx', 450, 'demo-tx-005', 'cf:900002', 'confirmed', 12005),
        (990006, 900003, 999012, 'staging-demo-backer-3', 'ut1demoBacker3xxxxxxxxxxxxxxxxxxxxxxxxxx', 1000, 'demo-tx-006', 'cf:900003', 'confirmed', 11900),
        (990007, 900003, 999011, 'staging-demo-backer-2', 'ut1demoBacker2xxxxxxxxxxxxxxxxxxxxxxxxxx', 1200, 'demo-tx-007', 'cf:900003', 'confirmed', 11901),
        (990008, 900003, 999010, 'staging-demo-backer-1', 'ut1demoBacker1xxxxxxxxxxxxxxxxxxxxxxxxxx', 1000, 'demo-tx-008', 'cf:900003', 'confirmed', 11902),
        (990009, 900004, 999012, 'staging-demo-backer-3', 'ut1demoBacker3xxxxxxxxxxxxxxxxxxxxxxxxxx', 800, 'demo-tx-009', 'cf:900004', 'confirmed', 11500),
        (990010, 900001, 999010, 'staging-demo-backer-1', 'ut1demoBacker1xxxxxxxxxxxxxxxxxxxxxxxxxx', 200, 'demo-tx-010', 'cf:900001', 'pending', NULL),
        (990011, 900002, 999011, 'staging-demo-backer-2', 'ut1demoBacker2xxxxxxxxxxxxxxxxxxxxxxxxxx', 150, 'demo-tx-011', 'cf:900002', 'failed', NULL)
      ON CONFLICT (id) DO NOTHING
    `);
  }

  setInterval(runReconciler, 20000);

  app.listen(port, () => console.log(`Listening on :${port}`));
}

start().catch(err => { console.error(err); process.exit(1); });
