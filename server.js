const express = require('express');
const path = require('path');
const jwt = require('jsonwebtoken');

const app = express();
const port = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;
const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_STAGING = process.env.USERNODE_ENV === 'staging';
const CHAIN_ID = process.env.CHAIN_ID || '1';
const NODE_RPC_URL = process.env.NODE_RPC_URL || 'http://localhost:3001';
const APP_PUBKEY = process.env.APP_PUBKEY || (NODE_ENV !== 'production' ? 'ut1dev-dummy-pubkey' : null);
const APP_SECRET_KEY = process.env.APP_SECRET_KEY;
const SENDER_APP_PUBKEY = process.env.SENDER_APP_PUBKEY;
const SENDER_APP_SECRET_KEY = process.env.SENDER_APP_SECRET_KEY;
const USERNAMES_PUBKEY = 'ut1p0p7y8ujacndc60r4a7pzk45dufdtarp6satvc0md7866633u8sqagm3az';

// Warn if APP_PUBKEY or SENDER_APP_PUBKEY look like public keys instead of wallet addresses
if (APP_PUBKEY && APP_PUBKEY.startsWith('utpk1')) {
  console.warn('⚠️  WARNING: APP_PUBKEY appears to be a public key (utpk1...), not a wallet address (ut1...). This will cause transaction failures. Public keys are for signing only — use a wallet address instead.');
}
if (SENDER_APP_PUBKEY && SENDER_APP_PUBKEY.startsWith('utpk1')) {
  console.warn('⚠️  WARNING: SENDER_APP_PUBKEY appears to be a public key (utpk1...), not a wallet address (ut1...). This will cause transaction failures. Public keys are for signing only — use a wallet address instead.');
}

// Validate required secrets at startup — only in production
function validateSecrets() {
  if (NODE_ENV !== 'production') return;

  const missing = [];

  if (!process.env.APP_PUBKEY) {
    missing.push('APP_PUBKEY (receives every user transaction for campaign creates and contributions)');
  }
  if (!process.env.APP_SECRET_KEY) {
    missing.push('APP_SECRET_KEY (private signing key for APP_PUBKEY)');
  }
  if (!process.env.SENDER_APP_PUBKEY) {
    missing.push('SENDER_APP_PUBKEY (public key for server-initiated withdrawals and refunds)');
  }
  if (!process.env.SENDER_APP_SECRET_KEY) {
    missing.push('SENDER_APP_SECRET_KEY (private signing key for withdrawals and refunds)');
  }

  if (missing.length > 0) {
    const errorMsg = `Critical: Missing required wallet secrets:\n  • ${missing.join('\n  • ')}\n\nThe application cannot run without all four secrets. Please configure them in the Secrets UI.`;
    throw new Error(errorMsg);
  }
}

// Signing is only available when all signing secrets are present
const CAN_SIGN = !!(APP_SECRET_KEY && SENDER_APP_PUBKEY && SENDER_APP_SECRET_KEY);

const PUBLIC_API_PATHS = new Set(['/health', '/favicon.ico', '/api/state', '/api/env']);
const PUBLIC_PREFIXES = ['/explorer-api/', '/api/usernames/', '/api/trust/'];

// ── In-memory state (source of truth = chain; this is a performance cache) ──

const state = {
  campaigns: new Map(),      // id → CampaignRecord
  contributions: [],          // ContributionRecord[] append-only
  withdrawals: new Map(),    // campaign_id → WithdrawalRecord
  refunds: new Map(),        // `${campaign_id}:${contributor_address}` → RefundRecord
  seenTxIds: new Set(),      // dedup guard
  usernames: new Map(),      // pubkey → username (from global usernames contract)

  // ── Trust & governance state (all replayed from chain) ──
  approvals: new Map(),      // campaign_id → Map<admin_pubkey, "approve"|"reject">
  ratings: new Map(),        // campaign_id → Map<rater_pubkey, number 1..5>
  proposals: new Map(),      // proposal_id → {proposal_id, action, candidate, regions[], proposer, opened_at, height, resolved, approveVotes, globalCount}
  proposalVotes: new Map(),  // proposal_id → Map<admin_pubkey, "approve"|"reject">
  admins: new Map(),         // pubkey → {regions:Set<string>, global:boolean} — live roster
};

// Bootstrap roster (from dapp.json). state.admins = bootstrap + passed governance proposals.
let bootstrapAdmins = new Map();

let lastUsernamesFetch = 0;

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

// ── Trust, reputation & admin governance helpers ──────────────────────────────

const MAX_ADMINS_PER_REGION = 50;

function badgeForScore(s) {
  if (s >= 90) return 'Platinum';
  if (s >= 70) return 'Gold';
  if (s >= 40) return 'Silver';
  return 'Bronze';
}

// Funding status of a campaign (active/funded/withdrawn/expired/refunded) — the
// pending/rejected approval overlay is applied separately in /api/state.
function fundingStatus(camp) {
  const now = Date.now();
  const contribs = state.contributions.filter(c => c.campaign_id === camp.id);
  const total_raised = contribs.reduce((s, c) => s + c.amount, 0);
  if (state.withdrawals.has(camp.id)) return 'withdrawn';
  if (total_raised >= camp.goal) return 'funded';
  if (new Date(camp.deadline).getTime() < now) {
    const unique = [...new Set(contribs.map(c => c.from))];
    const allRefunded = unique.length > 0 &&
      unique.every(addr => state.refunds.has(`${camp.id}:${addr}`));
    return allRefunded ? 'refunded' : 'expired';
  }
  return 'active';
}

// 0–100 trust score for a fundraiser address, computed live from in-memory state.
function computeTrustScore(addr) {
  const empty = { verified: false, pastCampaigns: 0, successRate: 0, finished: 0, avgRating: null, ratingCount: 0 };
  if (!addr) return { score: 0, badge: 'Bronze', breakdown: empty };

  // Identity (0–25): linked wallet + registered username → 25; wallet only → 10.
  const hasName = state.usernames.has(addr);
  const identity = hasName ? 25 : 10;

  // Track record (0–20): number of campaigns launched.
  const mine = [...state.campaigns.values()].filter(c => c.creator_address === addr);
  const trackRecord = (Math.min(mine.length, 5) / 5) * 20;

  // Success rate (0–35): over *finished* campaigns only.
  let finished = 0, success = 0;
  for (const c of mine) {
    const st = fundingStatus(c);
    if (st === 'funded' || st === 'withdrawn') { finished++; success++; }
    else if (st === 'expired' || st === 'refunded') { finished++; }
  }
  const successRate = finished > 0 ? success / finished : 0;
  const successPts = successRate * 35;

  // Backer ratings (0–20): only counts when the creator has ≥3 ratings total.
  let ratingSum = 0, ratingCount = 0;
  for (const c of mine) {
    const rm = state.ratings.get(c.id);
    if (rm) for (const v of rm.values()) { ratingSum += v; ratingCount++; }
  }
  const avg = ratingCount > 0 ? ratingSum / ratingCount : 0;
  const ratingPts = ratingCount >= 3 ? ((avg - 1) / 4) * 20 : 0;

  const score = Math.round(Math.max(0, Math.min(100, identity + trackRecord + successPts + ratingPts)));
  return {
    score,
    badge: badgeForScore(score),
    breakdown: {
      verified: hasName,
      pastCampaigns: mine.length,
      successRate: Math.round(successRate * 100),
      finished,
      avgRating: ratingCount > 0 ? Number(avg.toFixed(1)) : null,
      ratingCount,
    },
  };
}

// How many admins in the roster cover a given region.
function regionCount(roster, region) {
  let n = 0;
  for (const v of roster.values()) if (v.regions.has(region)) n++;
  return n;
}

// Add/merge an admin into a roster, enforcing the 50-per-region cap.
function addToRoster(roster, pubkey, regions, global) {
  if (!pubkey) return;
  const existing = roster.get(pubkey) || { regions: new Set(), global: false };
  if (global) existing.global = true;
  for (const r of (regions || [])) {
    const R = String(r).toUpperCase().slice(0, 2);
    if (!R || existing.regions.has(R)) continue;
    if (regionCount(roster, R) >= MAX_ADMINS_PER_REGION) {
      console.warn(`admin roster: region ${R} at cap (${MAX_ADMINS_PER_REGION}); skipping ${pubkey}`);
      continue;
    }
    existing.regions.add(R);
  }
  roster.set(pubkey, existing);
}

// Recompute state.admins = bootstrap roster + every governance proposal that has
// passed, applied deterministically in chronological order. Idempotent.
function recomputeAdminRoster() {
  const roster = new Map();
  for (const [pk, info] of bootstrapAdmins) {
    roster.set(pk, { regions: new Set(info.regions), global: !!info.global });
  }

  const proposals = [...state.proposals.values()].sort(
    (a, b) => (a.height - b.height) || (a.proposal_id < b.proposal_id ? -1 : 1)
  );

  for (const p of proposals) {
    const globalAdmins = [...roster.entries()].filter(([, v]) => v.global).map(([k]) => k);
    const globalCount = globalAdmins.length;
    const votes = state.proposalVotes.get(p.proposal_id);
    let approveVotes = 0;
    if (votes) {
      for (const [voter, vote] of votes) {
        if (vote === 'approve' && roster.has(voter) && roster.get(voter).global) approveVotes++;
      }
    }
    const passed = globalCount > 0 && approveVotes > 0.51 * globalCount;
    p.resolved = passed ? 'passed' : 'open';
    p.approveVotes = approveVotes;
    p.globalCount = globalCount;

    if (!passed) continue;
    if (p.action === 'add') {
      addToRoster(roster, p.candidate, p.regions, false);
    } else if (p.action === 'remove') {
      const target = roster.get(p.candidate);
      // Never remove the last global admin — that would lock out governance.
      if (target && target.global && globalCount - 1 < 1) {
        console.warn(`governance: refusing to remove last global admin ${p.candidate}`);
        p.resolved = 'open';
        continue;
      }
      roster.delete(p.candidate);
    }
  }

  state.admins = roster;
}

// Eligible admins for a campaign's region. Regional admins first; if the region
// has fewer than 3 admins, global admins are pulled in to reach a majority.
function eligibleAdminsForRegion(region) {
  const R = String(region || 'US').toUpperCase().slice(0, 2);
  const regional = [];
  const globals = [];
  for (const [pk, info] of state.admins) {
    if (info.regions.has(R)) regional.push(pk);
    if (info.global) globals.push(pk);
  }
  const eligible = new Set(regional);
  if (regional.length < 3) for (const g of globals) eligible.add(g);
  return eligible;
}

// The single decentralized approval gate: score 99–100 auto-publishes, otherwise
// the campaign needs >51% of its eligible regional admins to approve.
function computeCampaignApproval(camp) {
  const score = computeTrustScore(camp.creator_address).score;
  const autoPublish = score >= 99;

  const eligible = eligibleAdminsForRegion(camp.region || 'US');
  eligible.delete(camp.creator_address); // a creator can't approve their own campaign
  const eligibleCount = eligible.size;

  const votes = state.approvals.get(camp.id) || new Map();
  let approvals = 0, rejections = 0;
  for (const [admin, decision] of votes) {
    if (!eligible.has(admin)) continue; // non-eligible signers ignored
    if (decision === 'approve') approvals++;
    else if (decision === 'reject') rejections++;
  }

  const quorumMet = eligibleCount > 0 && approvals > 0.51 * eligibleCount;
  const rejected = eligibleCount > 0 && rejections > 0.51 * eligibleCount;
  const published = autoPublish || quorumMet;
  return { autoPublish, approvals, rejections, eligibleCount, quorumMet, published, rejected, score };
}

// Admin context for a viewer address. In staging, any authenticated user is
// treated as a global admin so the Admin UI is reachable on a fresh login.
function getAdminContext(addr) {
  let info = addr ? state.admins.get(addr) : null;
  if (!info && IS_STAGING && addr) {
    info = { regions: new Set(), global: true, synthetic: true };
  }
  if (!info) return { is_admin: false, is_global: false, admin_regions: [] };
  return { is_admin: true, is_global: !!info.global, admin_regions: [...info.regions] };
}

function loadBootstrapAdmins() {
  bootstrapAdmins = new Map();
  let cfg = [];
  try { cfg = (require('./dapp.json').admins) || []; } catch (_) { cfg = []; }
  for (const a of cfg) {
    if (a && a.pubkey) addToRoster(bootstrapAdmins, a.pubkey, a.regions || [], !!a.global);
  }
  recomputeAdminRoster();
  console.log(`[admins] bootstrapped ${bootstrapAdmins.size} admin(s) from dapp.json`);
}

// ── Routes ───────────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.get('/api/env', (_req, res) =>
  res.json({ staging: IS_STAGING, chain_id: CHAIN_ID, app_pubkey: APP_PUBKEY })
);

app.get('/__usernames/state', (_req, res) => {
  res.json({
    usernames: Object.fromEntries(state.usernames),
    lastSeenTs: lastUsernamesFetch,
    count: state.usernames.size,
  });
});

app.get('/api/usernames/:pubkey', (req, res) => {
  res.json({ username: state.usernames.get(req.params.pubkey) || null });
});

app.get('/api/me', (req, res) => {
  const addr = req.user.usernode_pubkey || null;
  const ctx = getAdminContext(addr);
  res.json({
    id: req.user.id,
    username: req.user.username,
    usernode_pubkey: addr,
    address: addr,
    is_admin: ctx.is_admin,
    is_global: ctx.is_global,
    admin_regions: ctx.admin_regions,
    trust: computeTrustScore(addr),
  });
});

// Public reputation lookup for any address (badges, profile breakdowns).
app.get('/api/trust/:pubkey', (req, res) => {
  res.json(computeTrustScore(req.params.pubkey));
});

// ── Chain state (replayed from transactions) ──────────────────────────────────

app.get('/api/state', (req, res) => {
  const viewer = req.user && req.user.usernode_pubkey ? req.user.usernode_pubkey : null;
  const campaigns = [];

  for (const [id, camp] of state.campaigns) {
    const contribs = state.contributions.filter(c => c.campaign_id === id);
    const total_raised = contribs.reduce((s, c) => s + c.amount, 0);
    const backer_count = new Set(contribs.map(c => c.from)).size;

    const ap = computeCampaignApproval(camp);

    // Visibility gate: published campaigns are public; a pending/rejected
    // campaign is only ever returned to its own creator.
    if (!ap.published && camp.creator_address !== viewer) continue;

    let status;
    if (ap.rejected) {
      status = 'rejected';
    } else if (!ap.published) {
      status = 'pending';
    } else {
      status = fundingStatus(camp);
    }

    campaigns.push({
      ...camp,
      region: camp.region || 'US',
      language: camp.language || 'en',
      total_raised,
      backer_count,
      status,
      trust: computeTrustScore(camp.creator_address),
      approval: {
        approvals: ap.approvals,
        rejections: ap.rejections,
        eligibleCount: ap.eligibleCount,
        quorumMet: ap.quorumMet,
        autoPublish: ap.autoPublish,
      },
    });
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

  // Ratings the viewer has left (so the client can pre-fill the star control).
  const myRatings = {};
  if (viewer) {
    for (const [cid, rm] of state.ratings) {
      if (rm.has(viewer)) myRatings[cid] = rm.get(viewer);
    }
  }
  // Aggregate per-campaign rating summary (public).
  const ratingSummary = {};
  for (const [cid, rm] of state.ratings) {
    if (!rm.size) continue;
    let sum = 0; for (const v of rm.values()) sum += v;
    ratingSummary[cid] = { avg: Number((sum / rm.size).toFixed(1)), count: rm.size };
  }

  res.json({ campaigns, contributions: state.contributions, withdrawals, refunds, myRatings, ratingSummary });
});

// Pending campaigns awaiting review, scoped to the admin's regions (all regions
// for global admins). 403 for non-admins.
app.get('/api/admin/queue', (req, res) => {
  const addr = req.user.usernode_pubkey || null;
  const ctx = getAdminContext(addr);
  if (!ctx.is_admin) return res.status(403).json({ error: 'Not an admin' });

  const queue = [];
  for (const camp of state.campaigns.values()) {
    const ap = computeCampaignApproval(camp);
    if (ap.published || ap.rejected) continue; // pending only
    const region = camp.region || 'US';
    if (!ctx.is_global && !ctx.admin_regions.includes(region)) continue;

    const votes = state.approvals.get(camp.id) || new Map();
    queue.push({
      id: camp.id,
      title: camp.title,
      description: camp.description,
      emoji: camp.emoji,
      region,
      language: camp.language || 'en',
      goal: camp.goal,
      deadline: camp.deadline,
      creator_address: camp.creator_address,
      creator_trust: computeTrustScore(camp.creator_address),
      approvals: ap.approvals,
      rejections: ap.rejections,
      eligibleCount: ap.eligibleCount,
      quorumMet: ap.quorumMet,
      hasVoted: votes.has(addr),
      myVote: votes.get(addr) || null,
      created_at: camp.created_at,
    });
  }
  queue.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  res.json({ queue, is_global: ctx.is_global, admin_regions: ctx.admin_regions });
});

// Admin add/remove governance proposals with live tallies. 403 for non-admins.
app.get('/api/admin/proposals', (req, res) => {
  const addr = req.user.usernode_pubkey || null;
  const ctx = getAdminContext(addr);
  if (!ctx.is_admin) return res.status(403).json({ error: 'Not an admin' });

  const proposals = [...state.proposals.values()].map(p => {
    const votes = state.proposalVotes.get(p.proposal_id) || new Map();
    let approve = 0, reject = 0;
    for (const v of votes.values()) { if (v === 'approve') approve++; else if (v === 'reject') reject++; }
    return {
      proposal_id: p.proposal_id,
      action: p.action,
      candidate: p.candidate,
      candidate_name: state.usernames.get(p.candidate) || null,
      regions: p.regions || [],
      proposer: p.proposer,
      resolved: p.resolved || 'open',
      approve,
      reject,
      approveVotes: typeof p.approveVotes === 'number' ? p.approveVotes : approve,
      globalCount: typeof p.globalCount === 'number' ? p.globalCount : 0,
      hasVoted: votes.has(addr),
      myVote: votes.get(addr) || null,
      opened_at: p.opened_at,
    };
  });
  // Open proposals first, then most-recent.
  proposals.sort((a, b) => {
    const ar = a.resolved === 'open' ? 0 : 1;
    const br = b.resolved === 'open' ? 0 : 1;
    if (ar !== br) return ar - br;
    return new Date(b.opened_at) - new Date(a.opened_at);
  });
  res.json({ proposals, can_vote: ctx.is_global, is_global: ctx.is_global });
});

// Creator-initiated withdrawal — server signs the on-chain disbursement
app.post('/api/campaigns/:id/withdraw', async (req, res) => {
  const campaignId = req.params.id;
  const camp = state.campaigns.get(campaignId);
  if (!camp) return res.status(404).json({ error: 'Campaign not found' });

  const myAddr = req.user.usernode_pubkey;
  if (!myAddr) {
    return res.status(403).json({ error: 'No wallet linked to your account. Link a wallet in your Usernode profile to withdraw.' });
  }
  if (camp.creator_address !== myAddr) {
    return res.status(403).json({ error: 'Not the campaign creator' });
  }
  if (state.withdrawals.has(campaignId)) {
    return res.status(400).json({ error: 'Already withdrawn' });
  }

  const ap = computeCampaignApproval(camp);
  if (!ap.published) {
    return res.status(400).json({ error: 'Campaign is still pending admin review' });
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

const EXPLORER_TIMEOUT_MS = 11000;             // bound each upstream attempt
const EXPLORER_MAX_ATTEMPTS = 3;               // 1 initial + 2 retries
const EXPLORER_RETRY_BACKOFF_MS = [250, 750];  // backoff before retry 2 and 3
const RETRYABLE_UPSTREAM_STATUS = new Set([502, 503, 504]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Format a fetch() failure into a stable, human-readable detail string.
// Node.js native fetch() wraps low-level errors in a TypeError with the real
// error on err.cause (ECONNREFUSED, ENOTFOUND, ETIMEDOUT, …); AbortSignal.timeout
// surfaces as a TimeoutError.
function explorerErrorDetail(err) {
  const cause = err.cause || err;
  if (err.name === 'TimeoutError' || cause.name === 'TimeoutError' || err.name === 'AbortError') {
    return `ETIMEDOUT (request exceeded ${EXPLORER_TIMEOUT_MS}ms)`;
  }
  let detail = cause.message || err.message || 'unknown error';
  if (cause.code) {
    detail = cause.code + (cause.message ? ` (${cause.message})` : '');
  }
  return detail;
}

app.use('/explorer-api', async (req, res) => {
  // Build the target from req.url so the query string survives the mount strip
  // (req.path drops it — e.g. ?address=… would be silently lost).
  const target = NODE_RPC_URL.replace(/\/$/, '') + req.url;
  const fetchOpts = { method: req.method, headers: { 'content-type': 'application/json' } };
  if (req.method !== 'GET' && req.body) fetchOpts.body = JSON.stringify(req.body);

  let lastDetail = 'unknown error';
  for (let attempt = 1; attempt <= EXPLORER_MAX_ATTEMPTS; attempt++) {
    try {
      const upstream = await fetch(target, { ...fetchOpts, signal: AbortSignal.timeout(EXPLORER_TIMEOUT_MS) });
      // Retry transient upstream 5xx (gateway/unavailable/timeout) — these are
      // idempotent reads/polls, so a re-issue is safe and absorbs single blips.
      if (RETRYABLE_UPSTREAM_STATUS.has(upstream.status) && attempt < EXPLORER_MAX_ATTEMPTS) {
        lastDetail = `upstream HTTP ${upstream.status}`;
        await sleep(EXPLORER_RETRY_BACKOFF_MS[attempt - 1] || 750);
        continue;
      }
      const body = await upstream.text();
      return res.status(upstream.status)
        .set('content-type', upstream.headers.get('content-type') || 'application/json')
        .send(body);
    } catch (err) {
      lastDetail = explorerErrorDetail(err);
      if (attempt < EXPLORER_MAX_ATTEMPTS) {
        await sleep(EXPLORER_RETRY_BACKOFF_MS[attempt - 1] || 750);
        continue;
      }
    }
  }

  console.error(`explorer proxy exhausted: ${req.method} ${req.url} after ${EXPLORER_MAX_ATTEMPTS} attempts — ${lastDetail}`);
  res.status(502).json({ error: 'Explorer proxy error', detail: lastDetail });
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

function processUsernameTransaction(tx) {
  let memo;
  try { memo = JSON.parse(tx.memo || '{}'); } catch (_) { return; }
  if (memo.app !== 'usernames' || memo.type !== 'set_username' || !memo.username) return;
  const from = txFrom(tx);
  if (from) state.usernames.set(from, String(memo.username).slice(0, 64));
}

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
  const height = tx.block_height || tx.blockHeight || tx.block || 0;

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
          region: String(c.region || 'US').toUpperCase().slice(0, 2),
          language: String(c.language || 'en').toLowerCase().slice(0, 8),
          creator_address: from,
          created_tx: id,
          created_at: ts,
        });
      }
      break;
    }
    case 'approve_campaign': {
      const cid = String(memo.campaign || '');
      if (!cid || !from) break;
      const decision = memo.decision === 'reject' ? 'reject' : 'approve';
      if (!state.approvals.has(cid)) state.approvals.set(cid, new Map());
      const m = state.approvals.get(cid);
      if (!m.has(from)) m.set(from, decision); // first-write-wins per (campaign, admin)
      break;
    }
    case 'rate_campaign': {
      const cid = String(memo.campaign || '');
      let r = parseInt(memo.rating, 10);
      if (!cid || !from || !r) break;
      r = Math.max(1, Math.min(5, r));
      // Only backers who actually contributed may rate.
      const contributed = state.contributions.some(c => c.campaign_id === cid && c.from === from);
      if (!contributed) break;
      if (!state.ratings.has(cid)) state.ratings.set(cid, new Map());
      state.ratings.get(cid).set(from, r); // last-write-wins (re-rating updates)
      break;
    }
    case 'admin_proposal': {
      const pid = String(memo.proposal_id || '');
      const candidate = String(memo.candidate || '');
      if (!pid || !candidate) break;
      const action = memo.action === 'remove' ? 'remove' : 'add';
      if (!state.proposals.has(pid)) {
        state.proposals.set(pid, {
          proposal_id: pid,
          action,
          candidate,
          regions: Array.isArray(memo.regions) ? memo.regions.map(x => String(x).toUpperCase().slice(0, 2)) : [],
          proposer: from,
          opened_at: ts,
          height,
          resolved: 'open',
        });
      }
      break;
    }
    case 'admin_vote': {
      const pid = String(memo.proposal_id || '');
      if (!pid || !from) break;
      const vote = memo.vote === 'reject' ? 'reject' : 'approve';
      if (!state.proposalVotes.has(pid)) state.proposalVotes.set(pid, new Map());
      const m = state.proposalVotes.get(pid);
      if (!m.has(from)) m.set(from, vote); // first-write-wins per (proposal, admin)
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
  try {
    const [appTxs, senderTxs, usernameTxs] = await Promise.all([
      fetchTxsForAddress(APP_PUBKEY),
      SENDER_APP_PUBKEY && SENDER_APP_PUBKEY !== APP_PUBKEY
        ? fetchTxsForAddress(SENDER_APP_PUBKEY)
        : Promise.resolve([]),
      fetchTxsForAddress(USERNAMES_PUBKEY),
    ]);

    // Merge and dedup campaign/contribution txs by txid
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

    // Process username transactions in block-height order (last-write-wins per address)
    const sortedUsernameTxs = usernameTxs.slice().sort((a, b) => {
      const ha = a.block_height || a.blockHeight || a.block || 0;
      const hb = b.block_height || b.blockHeight || b.block || 0;
      return ha - hb;
    });
    for (const tx of sortedUsernameTxs) processUsernameTransaction(tx);
    lastUsernamesFetch = Date.now();

    // Re-derive the live admin roster (bootstrap + passed governance proposals)
    // after every replay so newly-passed add/remove proposals take effect.
    recomputeAdminRoster();

    await processAutoRefunds();
  } catch (err) {
    console.error('poller error:', err.message);
  }
}

// ── Staging demo data ─────────────────────────────────────────────────────────

// Demo admin addresses — these mirror the dapp.json "admins" bootstrap block so
// the roster and the seeded approvals line up on a fresh staging DB.
const DEMO_ADMIN_US = 'ut1demoadminus0000000000000000000000000000000000000000000000';
const DEMO_ADMIN_CA = 'ut1demoadminca0000000000000000000000000000000000000000000000';
const DEMO_ADMIN_GB = 'ut1demoadmingb0000000000000000000000000000000000000000000000';
const DEMO_ADMIN_G1 = 'ut1demoadminglobal100000000000000000000000000000000000000000';
const DEMO_ADMIN_G2 = 'ut1demoadminglobal200000000000000000000000000000000000000000';

function seedStagingData() {
  const now = new Date();
  const future30 = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();
  const future7 = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const past7 = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const past30 = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const TRUSTED = 'ut1demoTrustedCreator00000000000000000000000000000000000000';
  const NEWBIE_US = 'ut1demoNewbieUS000000000000000000000000000000000000000000000';
  const NEWBIE_GB = 'ut1demoNewbieGB000000000000000000000000000000000000000000000';

  // Usernames (drive the "identity verified" trust input + display names).
  state.usernames.set(TRUSTED, 'staging-demo-trusted');
  state.usernames.set(DEMO_ADMIN_US, 'staging-demo-admin-us');
  state.usernames.set(DEMO_ADMIN_G1, 'staging-demo-admin-global');

  const campaigns = [
    // Original demo campaigns (US). Low-trust creators, but pre-approved below
    // so they publish and Discover isn't empty.
    { id: 'demo-camp-001', title: 'Staging demo — Community Solar Panel', description: 'Help us install solar panels on the community center roof. All funds go directly toward equipment and installation costs.', emoji: '☀️', goal: 5000, deadline: future30, region: 'US', language: 'en', creator_address: 'ut1demoCreator1xxxxxxxxxxxxxxxxxxxxxxxxxx', created_tx: 'demo-tx-c01', created_at: past30 },
    { id: 'demo-camp-002', title: 'Staging demo — Open Source Library', description: 'Fund the development of a free open-source library for local community resource mapping.', emoji: '📚', goal: 1000, deadline: future7, region: 'US', language: 'en', creator_address: 'ut1demoCreator2xxxxxxxxxxxxxxxxxxxxxxxxxx', created_tx: 'demo-tx-c02', created_at: past7 },
    { id: 'demo-camp-003', title: 'Staging demo — Local Playground', description: 'New playground equipment for kids in the neighborhood.', emoji: '🛝', goal: 3000, deadline: future30, region: 'US', language: 'en', creator_address: 'ut1demoCreator3xxxxxxxxxxxxxxxxxxxxxxxxxx', created_tx: 'demo-tx-c03', created_at: past30 },
    { id: 'demo-camp-004', title: 'Staging demo — Art Installation', description: 'Community mural project celebrating local culture and history.', emoji: '🎨', goal: 2000, deadline: past7, region: 'US', language: 'en', creator_address: 'ut1demoCreator4xxxxxxxxxxxxxxxxxxxxxxxxxx', created_tx: 'demo-tx-c04', created_at: past30 },
    // High-trust creator: an active, auto-published (score 99–100) campaign.
    { id: 'demo-camp-trusted-active', title: 'Staging demo — Trusted Maker Workshop', description: 'A Platinum-badge fundraiser by an established creator — auto-published with no admin review.', emoji: '🏆', goal: 4000, deadline: future30, region: 'US', language: 'en', creator_address: TRUSTED, created_tx: 'demo-tx-ct-active', created_at: past7 },
    // Low-trust pending campaigns (the admin review queue).
    { id: 'demo-camp-pending-us', title: 'Staging demo — Pending US Campaign', description: 'A brand-new fundraiser in the US awaiting admin review (below quorum).', emoji: '⏳', goal: 1500, deadline: future30, region: 'US', language: 'en', creator_address: NEWBIE_US, created_tx: 'demo-tx-pus', created_at: past7 },
    { id: 'demo-camp-pending-gb', title: 'Staging demo — Pending GB Campaign', description: 'A new UK fundraiser — its region has fewer than 3 admins, so global admins are pulled in to reach a majority.', emoji: '🇬🇧', goal: 2500, deadline: future30, region: 'GB', language: 'en', creator_address: NEWBIE_GB, created_tx: 'demo-tx-pgb', created_at: past30 },
  ];

  // 5 finished, successful (withdrawn) past campaigns by the trusted creator —
  // these build the 0–100 trust score (track record + success rate).
  for (let i = 1; i <= 5; i++) {
    campaigns.push({
      id: `demo-camp-trusted-${i}`,
      title: `Staging demo — Trusted Past Project #${i}`,
      description: 'A successfully funded and withdrawn past campaign that contributes to the creator’s reputation.',
      emoji: '✅', goal: 100, deadline: past7, region: 'US', language: 'en',
      creator_address: TRUSTED, created_tx: `demo-tx-ct${i}`, created_at: past30,
    });
  }
  campaigns.forEach(c => state.campaigns.set(c.id, c));

  // Contributions: meet goal on the 5 trusted past campaigns (→ withdrawn), plus
  // the original demo contributions.
  const contribs = [
    { txid: 'demo-tx-001', campaign_id: 'demo-camp-001', from: 'ut1demoBacker1xxxxxxxxxxxxxxxxxxxxxxxxxx', amount: 700, ts: past30 },
    { txid: 'demo-tx-002', campaign_id: 'demo-camp-001', from: 'ut1demoBacker2xxxxxxxxxxxxxxxxxxxxxxxxxx', amount: 800, ts: past30 },
    { txid: 'demo-tx-003', campaign_id: 'demo-camp-001', from: 'ut1demoBacker1xxxxxxxxxxxxxxxxxxxxxxxxxx', amount: 600, ts: past30 },
    { txid: 'demo-tx-004', campaign_id: 'demo-camp-002', from: 'ut1demoBacker2xxxxxxxxxxxxxxxxxxxxxxxxxx', amount: 500, ts: past7 },
    { txid: 'demo-tx-005', campaign_id: 'demo-camp-002', from: 'ut1demoBacker1xxxxxxxxxxxxxxxxxxxxxxxxxx', amount: 450, ts: past7 },
    { txid: 'demo-tx-006', campaign_id: 'demo-camp-003', from: 'ut1demoBacker3xxxxxxxxxxxxxxxxxxxxxxxxxx', amount: 1000, ts: past30 },
  ];
  for (let i = 1; i <= 5; i++) {
    contribs.push({ txid: `demo-tx-ctc${i}`, campaign_id: `demo-camp-trusted-${i}`, from: `ut1demoBacker${i}xxxxxxxxxxxxxxxxxxxxxxxxxx`, amount: 100, ts: past30 });
  }
  contribs.forEach(c => state.contributions.push(c));

  // Withdrawals on the trusted past campaigns → status "withdrawn" = success.
  for (let i = 1; i <= 5; i++) {
    state.withdrawals.set(`demo-camp-trusted-${i}`, { txid: `demo-tx-ctw${i}`, to: TRUSTED, amount: 100, ts: past7 });
  }

  // Ratings on the trusted creator's campaigns (≥3, avg 5.0) → full rating points.
  const setRating = (cid, rater, r) => {
    if (!state.ratings.has(cid)) state.ratings.set(cid, new Map());
    state.ratings.get(cid).set(rater, r);
  };
  setRating('demo-camp-trusted-1', 'ut1demoBacker1xxxxxxxxxxxxxxxxxxxxxxxxxx', 5);
  setRating('demo-camp-trusted-2', 'ut1demoBacker2xxxxxxxxxxxxxxxxxxxxxxxxxx', 5);
  setRating('demo-camp-trusted-3', 'ut1demoBacker3xxxxxxxxxxxxxxxxxxxxxxxxxx', 5);
  setRating('demo-camp-trusted-4', 'ut1demoBacker4xxxxxxxxxxxxxxxxxxxxxxxxxx', 4);

  // Approvals.
  const setApproval = (cid, admin, decision) => {
    if (!state.approvals.has(cid)) state.approvals.set(cid, new Map());
    state.approvals.get(cid).set(admin, decision);
  };
  // Original US demo campaigns: 2 approvals each (us + global-1) → >51% of 3 → published.
  ['demo-camp-001', 'demo-camp-002', 'demo-camp-003', 'demo-camp-004'].forEach(cid => {
    setApproval(cid, DEMO_ADMIN_US, 'approve');
    setApproval(cid, DEMO_ADMIN_G1, 'approve');
  });
  // Pending US: 1 approval out of 3 eligible → still below quorum → stays in queue.
  setApproval('demo-camp-pending-us', DEMO_ADMIN_US, 'approve');
  // Pending GB: no votes yet → stays in queue, demonstrates global fallback.

  // Governance proposals.
  state.proposals.set('demo-prop-open', {
    proposal_id: 'demo-prop-open', action: 'add',
    candidate: 'ut1demoCandidateOpen0000000000000000000000000000000000000000',
    regions: ['US'], proposer: DEMO_ADMIN_G1, opened_at: past7, height: 1, resolved: 'open',
  });
  state.proposalVotes.set('demo-prop-open', new Map([[DEMO_ADMIN_G1, 'approve']]));

  state.proposals.set('demo-prop-passed', {
    proposal_id: 'demo-prop-passed', action: 'add',
    candidate: 'ut1demoCandidatePassed00000000000000000000000000000000000000',
    regions: ['CA'], proposer: DEMO_ADMIN_G1, opened_at: past30, height: 1, resolved: 'open',
  });
  state.proposalVotes.set('demo-prop-passed', new Map([[DEMO_ADMIN_G1, 'approve'], [DEMO_ADMIN_G2, 'approve']]));

  // Mark all seeded tx ids as seen so the poller never re-processes them.
  ['demo-tx-c01', 'demo-tx-c02', 'demo-tx-c03', 'demo-tx-c04', 'demo-tx-ct-active', 'demo-tx-pus', 'demo-tx-pgb',
   'demo-tx-001', 'demo-tx-002', 'demo-tx-003', 'demo-tx-004', 'demo-tx-005', 'demo-tx-006',
   'demo-tx-ct1', 'demo-tx-ct2', 'demo-tx-ct3', 'demo-tx-ct4', 'demo-tx-ct5',
   'demo-tx-ctc1', 'demo-tx-ctc2', 'demo-tx-ctc3', 'demo-tx-ctc4', 'demo-tx-ctc5',
   'demo-tx-ctw1', 'demo-tx-ctw2', 'demo-tx-ctw3', 'demo-tx-ctw4', 'demo-tx-ctw5',
  ].forEach(t => state.seenTxIds.add(t));

  // Apply the seeded governance proposals to the live roster.
  recomputeAdminRoster();

  console.log('[Staging] Seeded trust/governance demo data (admins, pending queue, ratings, proposals)');
}

// ── Boot ──────────────────────────────────────────────────────────────────────

async function start() {
  // Validate secrets immediately — fail fast if any are missing
  validateSecrets();

  // Load the admin roster from dapp.json before any replay/seed.
  loadBootstrapAdmins();

  if (IS_STAGING) {
    seedStagingData();
  }

  // Replay chain history immediately, then poll on interval
  runPoller().catch(err => console.error('initial poll error:', err.message));
  setInterval(runPoller, 5000);

  app.listen(port, () => console.log(`Listening on :${port}`));
}

start().catch(err => { console.error(err); process.exit(1); });
