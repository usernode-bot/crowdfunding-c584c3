# Crowdfunding — notes for Claude Code

This app runs on **Usernode Social Vibecoding**. If you're Claude Code
editing this repo, read the platform conventions before making
changes:

**Platform conventions (authoritative, always current):**
https://social-vibecoding.usernodelabs.org/claude.md

Fetch that URL at the start of each session — it's the single source
of truth for platform-wide behavior (auth model, `USERNODE_ENV`,
public/private tables, "don't `git push`", etc.). The hosted copy is
updated in place when platform rules change, so fetching it gives you
today's rules, not a stale snapshot.

When running inside Usernode's dev-chat, those same conventions are
already injected into your system prompt, so the fetch is a no-op in
that path — but it's the right reflex when someone runs Claude Code
against this repo locally or from another harness.

If a rule below this line conflicts with the hosted conventions, the
hosted conventions win. This file is **app-specific** — write down
things about *this* app that belong in the repo: product intent,
data-model quirks, style preferences, opt-in policies (e.g. which
tables you've marked private), etc.

---

## About Crowdfunding

Community Fund is a chain-first crowdfunding dApp where users create campaigns and contribute funds. All state is derived by replaying on-chain transactions — there is no database. The server polls `APP_PUBKEY` for incoming transactions, reconstructs campaign and contribution state in memory, and the client reads `/api/state` to render the UI.

## App-specific conventions

- **No database**: State lives entirely in on-chain transaction memos. `server.js` maintains an in-memory cache rebuilt from chain replay on each restart.
- **APP_PUBKEY** receives every user transaction (creates and contributions). **SENDER_APP_PUBKEY / SENDER_APP_SECRET_KEY** are used only for server-initiated withdrawals and refunds.
- **Memo schema** — all memos are `{app: "crowdfunding", type: "<type>", ...}`:
  - `create_campaign` — includes `{id, title, description, emoji, goal, deadline}` nested under `campaign`
  - `contribute` — includes `{campaign: "<id>"}`. Amount is always taken from `tx.amount`, never from memo.
  - `withdraw` — server sends to creator; includes `{campaign_id}`
  - `refund` — server sends to contributor; includes `{campaign_id, contributor}`
- **Campaign IDs** are generated client-side: `cmp-${Date.now().toString(16)}-${4 hex chars}`
- **First-create-wins**: if two transactions claim the same campaign ID, only the first (by block height) is accepted.
- **Amount values** are integers (no floats). Do not introduce float currency handling.
- **Staging seed**: `seedStagingData()` in `server.js` populates 4 demo campaigns with obviously fake data at boot when `USERNODE_ENV=staging`. Demo tx IDs start with `demo-` and are marked in `seenTxIds` to prevent poller re-processing.
- **CAN_SIGN guard**: server-initiated transactions only execute when `SENDER_APP_SECRET_KEY` is set and is not `"staging_placeholder_secret_key_not_valid"`.
- **processAutoRefunds**: server automatically refunds all unique contributors of expired campaigns that haven't been refunded yet, if `CAN_SIGN` is true.
