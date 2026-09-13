# Repo Contract -- corgi

Status: canonical repo contract
Owner: bluesky-feed
Service class: production_service
Contract version: 2
Last updated: 2026-09-09
Last verified: not yet rehearsed for the 2026-08-02 workflow revision

> Canonical reference for any human or tooling operating in this repo.

---

## 1. What This Repo Is

A production Bluesky custom feed generator for Corgi Commons, with inspectable,
community-shaped ranking. Anyone can view the public feed or use the isolated
shadow demo. Production governance is an approved waitlist pilot: participants
can vote on five global signal weights, topic priorities, and content rules.
Closed results require review and operator approval before the complete policy is
applied and the feed is rescored.

**Canonical URL:** `https://feed.corgi.network`
**API docs:** `https://docs.corgi.network`
**Repo:** `andrewnordstrom-eng/corgi` (GitHub repository ID `1151738081`)
The former `andrewnordstrom-eng/bluesky-community-feed` URL redirects to this
same repository ID. This establishes the GitHub repository rename only.
The live mapping of `feed.corgi.network` to that repository ID is unverified
in PROJ-2268; host adoption is blocked. Before approving adoption, record
authoritative service-to-repository evidence and its approval reference in the
execution receipt. A missing or mismatched mapping must stop adoption.
Production access and promotion still require their separate approval gates.
**Linear project:** tracked on the maintainers' private project board
**Product doc:** maintained in the maintainers' private product-doc tool

---

## 2. Why It Exists

Before this project, Bluesky custom feeds were opaque ranking systems controlled
by a single operator. There was no mechanism for subscribers to influence how
posts are ranked. This feed exists to:

- Let approved pilot participants submit structured ballots across signal,
  topic, and content-rule policy channels while preserving operator review.
- Provide inspectable ranking: score decompositions are persisted as raw,
  weight, and weighted values per post and epoch, then exposed when receipt
  provenance is available.
- Serve as a research instrument for studying algorithmic governance on
  decentralized social networks, with IRB-ready consent flows, research gating,
  and anonymized export.
- Demonstrate that community-governed recommendation algorithms are viable at
  production scale on AT Protocol.

---

## 3. System Shape

```text
                       Bluesky Network (AT Protocol)
                                |
                       Jetstream WebSocket
                        (public firehose)
                                |
                                v
            +-----------------------------------------+
            |          Fastify HTTP Server             |
            |  XRPC feed endpoints (AT Protocol)       |
            |  Governance APIs (vote, epochs, weights)  |
            |  Admin APIs (health, interactions, export) |
            |  Transparency APIs (explanations, stats)  |
            |  MCP server (Streamable HTTP)             |
            |  Bot server (announcements)               |
            +-----------------------------------------+
                    |              |              |
                    v              v              v
          +-----------+  +--------------+  +------------+
          | PostgreSQL |  |    Redis     |  |  Scoring   |
          | 16 (posts, |  | 7 (feed:curr |  |  Pipeline  |
          | scores,    |  |  snapshots,  |  | (batch/5m) |
          | epochs,    |  |  sessions)   |  | 5 scoring  |
          | votes,     |  |              |  | components |
          | audit)     |  |              |  +------------+
          +-----------+  +--------------+
                                          +------------+
                                          | Next.js 15 |
                                          | React 19   |
                                          | Static web |
                                          | + app UI   |
                                          +------------+
```

**Runtime:** Node.js 20, TypeScript 5, Fastify 5
**Data layer:** PostgreSQL 16 (posts, scores, governance, audit), Redis 7 (feed
cache, sessions)
**Frontend:** Next.js 15 static export, React 19, Tailwind (public pages,
transparency dashboard, voting UI)
**Protocol:** `@atproto/api`, `@atproto/xrpc-server`
**NLP:** winkNLP (topic classification at ingestion), HuggingFace Transformers
(embedding-based classification)
**Deploy target:** DigitalOcean VPS via systemd + nginx reverse proxy
**Container:** Multi-stage Docker build (node:20-alpine)

---

## 4. Key Files and Directories

| Path | Purpose |
|------|---------|
| `src/index.ts` | Entry point; boots Fastify server with all plugins and routes |
| `src/config.ts` | Centralized config with Zod-validated env vars |
| `src/ingestion/jetstream.ts` | WebSocket connection to Bluesky Jetstream firehose |
| `src/ingestion/embedding-gate.ts` | Single-post embedding classifier (at ingestion time) |
| `src/scoring/pipeline.ts` | 5-component scoring pipeline and Redis population (batch every 5 min) |
| `src/scoring/` | Individual scoring components: recency, engagement, bridging, source-diversity, relevance |
| `src/feed/` | AT Protocol XRPC feed skeleton endpoint with cursor pagination |
| `src/governance/` | Epoch lifecycle, vote submission, trimmed-mean aggregation, content rules |
| `src/transparency/` | Public endpoints: score explanations, counterfactuals, feed-level stats, audit log |
| `src/admin/routes/` | Admin APIs: governance controls, feed health, interactions, participants, export |
| `src/bot/` | Bluesky bot agent for governance announcements |
| `src/auth/admin.ts` | Admin DID allowlist session auth |
| `src/db/` | PostgreSQL client, connection pool, migrations |
| `src/mcp/` | MCP server (Streamable HTTP) for programmatic admin tooling |
| `src/scheduler/` | Cron-based scheduler for recurring jobs (scoring, health) |
| `src/lib/` | Shared utilities (logging, metrics, rate limiting) |
| `src/maintenance/` | Operational maintenance routines |
| `src/legal/` | Terms of service and privacy policy content |
| `web-next/` | Canonical Next.js frontend (public pages, demo, dashboard, voting, transparency) |
| `web/` | Legacy React + Vite frontend retained for compatibility during migration |
| `cli/` | CLI tool (`feed-cli`) for admin operations from any terminal |
| `scripts/` | Setup, migration, seed, publish-feed, report generation scripts |
| `tests/` | Unit, integration, and stress tests (Vitest) |
| `docs/` | Deployment, ops runbook, security, system overview, stability tests |
| `legal/` | Terms of Service, Privacy Policy documents |
| `Dockerfile` | Multi-stage production Docker build |
| `docker-compose.prod.yml` | Production PostgreSQL + Redis containers |
| `.github/workflows/` | CI, deploy, daily health, weekly export, docs deploy, security gates |
| `ops/` | Operational scripts and automation |

---

## 5. Build / Test / Run Commands

```bash
# Install dependencies (backend + both frontend packages)
npm install
cd web-next && npm install && cd ..
cd web && npm install && cd .. # legacy compatibility frontend

# Build (TypeScript -> dist/)
npm run build

# Run tests
npm test             # single run (vitest --run)
npm run stress       # stress tests

# Development server (tsx watch, auto-reload)
npm run dev

# Canonical frontend dev server (separate terminal)
cd web-next && npm run dev

# Production start (requires prior build)
npm start

# Database migrations
npm run migrate

# Seed initial governance epoch
npx tsx scripts/seed-governance.ts

# Publish feed record to Bluesky
npm run publish-feed

# Full verify (backend, CLI, MCP, SDK, legacy web, and web-next)
npm run verify

# Docs verification
npm run docs:verify

# CLI usage
npm run cli -- login your-handle.bsky.social xxxx-xxxx-xxxx-xxxx
npm run cli -- epoch status
npm run cli -- feed health
npm run cli -- --help
```

**Pre-commit hooks** (installed via `husky` + `lint-staged`):
- `.husky/pre-commit` runs `npx lint-staged`
- `lint-staged.config.js` currently type-checks staged TypeScript files via `tsc --noEmit`
- There is no local `.husky/commit-msg` hook; Linear key and identity enforcement happen in CI / org policy checks

---

## 6. Deploy and Rollback Notes

### Production deploy path

1. Squash-merge a green, reviewed release candidate to `main` and copy its exact
   40-character lowercase hexadecimal commit SHA.
2. Manually dispatch `deploy.yml` with that SHA and approve the protected
   `production` environment. The workflow rejects abbreviated, uppercase,
   nonexistent, or non-`main` commits before SSH access, then deploys a detached
   exact checkout.
   Its non-canceling `production` concurrency group permits one running job and
   one pending job; GitHub replaces an older pending dispatch with a newer one.
   Do not dispatch another promotion until there is a terminal receipt for the
   current attempt. Host admission fails closed for `started`,
   `rollback_interrupted`, `rollback_failed`, malformed, incomplete, or orphaned
   prior attempt evidence; only an approval-gated incident procedure may clear it.
   The capture step may report `CORGI_DEPLOY_RECEIPT_ABSENT` only when GitHub's
   transfer-step outcome explicitly proves artifact transfer was skipped and no
   incoming payload exists. The checkout and service are unchanged in that
   state. Any successful, failed, cancelled, partial, attempted, or uncertain
   transfer without a receipt is `CORGI_DEPLOY_RECEIPT_UNRESOLVED`; freeze
   dispatches and use the approval-gated incident procedure.
   A non-blocking, run-independent host lock also serializes remote deploy and
   rollback processes that outlive the workflow connection.
3. Do not recover by running `git checkout`, `npm ci`, `npm run build`, migrations,
   or service restarts directly on the VPS. Recovery and promotion must use the
   protected `deploy.yml` workflow so the exact-head runner verification,
   production approval, stage-aware rollback, and durable receipt stay coupled.
4. Before enabling the workflow for the first time, explicitly create and protect
   the GitHub `production` environment, require a reviewer, restrict deployments
   to `main`, add deployment-only `PRODUCTION_VPS_HOST`, `PRODUCTION_VPS_USER`,
   `PRODUCTION_VPS_SSH_KEY`, and `PRODUCTION_VPS_SSH_FINGERPRINT` secrets there,
   and set the
   repository-level Actions variable `CORGI_PRODUCTION_DEPLOY_ENABLED=true`.
   The fingerprint secret is a SHA256 fingerprint, not the OpenSSH `known_hosts`
   line used by other workflows. A non-printing local guard requires its exact
   OpenSSH SHA256 shape before the first connection, and every deploy SSH/SCP
   invocation verifies it.
   A missing or false variable skips production mutation; a
   missing or mismatched host fingerprint fails the SSH connection. This prevents
   GitHub from silently creating an unprotected environment. These configuration
   changes are separate approval gates.
5. The current runtime must already report a lowercase 40-character `revision`
   matching the clean checkout and overall `status: ok`. A legacy runtime without
   this contract cannot be promoted by this workflow; it needs a separately
   reviewed one-time adoption procedure. Current ingestion must also be fresh
   before rollback is armed: the persisted Jetstream cursor and newest indexed
   post must both be no more than 120 seconds old. A quiet posting window aborts
   with `preflight_failed` before any production mutation.
6. The workflow verifies the exact SHA on the runner before SSH access. On the
   host it rejects symlinked, foreign-owned, or non-writable checkout, `.git`,
   dependency, and build paths; a missing, symlinked, or deployment-user-writable
   production `.env`; tracked changes; non-ignored untracked
   files; non-forward promotions; and a checkout/runtime mismatch. Promotion is
   forward-only: the requested SHA must equal or descend from the deployed
   `PREV_COMMIT`. Redispatching the deployed SHA is permitted and forces a clean
   artifact swap and restart from the runner-verified archive; the host itself
   never rebuilds.
   Root and `web/` `.env*.bak` files are non-ignored and must be archived outside
   the checkout by an approved recovery procedure before the first dispatch;
   `web-next/` `.env*.bak` files are ignored by that workspace. Any unrelated
   non-ignored artifact also blocks promotion.
   Production configuration must live at `/etc/corgi/production.env`, root-owned
   mode 0600 under root-owned mode 0755 directory ancestry. The deployment user
   must not be able to read, write or replace it. The legacy application-directory
   `.env` must be absent, and production does not load working-directory dotenv
   files. The deployment user must not have unrestricted passwordless sudo. Its sudo policy
   must allow only the root-owned `/usr/local/sbin/corgi-deploy-root` dispatcher
   with its reviewed fixed operation tokens. Direct privileged `systemctl`,
   `docker exec`, `docker compose`, container creation and free-form container
   commands are prohibited. The demo Redis container must already be running. That host policy change is a separate
   approval gate. Host adoption pins the effective systemd drop-in boundary as
   well as the main unit. Its owned startup override replaces the inherited
   Compose hook with a fixed root-owned, read-only dependency health probe;
   Docker restart policy owns container recovery. Unknown overrides block
   adoption, and rollback restores the original startup hook. See
   [host identity adoption](../host-identity-adoption.md).
   The service must declare an explicit dedicated non-root user
   and group, distinct from the deployment account, and the active MainPID must
   be owned by that service user; otherwise both host admissions fail before
   transfer or mutation. The GitHub runner builds and verifies the exact SHA
   without production secrets and runs `scripts/audit-allowlist.mjs` at the
   moderate threshold for root, CLI, web and web-next, matching CI. Audits include
   development dependencies because the archive retains whole dependency
   directories. The shared policy fails closed on audit errors and permits only
   explicitly tracked, unexpired, workspace-scoped advisory exceptions approved
   through a separate risk decision. It stamps a checksummed runtime archive
   only after validation succeeds. It also verifies
   hardcoded SHA-256 digests for the SSH/SCP runtime binaries before exposing any
   production credential, then forces the commit-pinned action wrappers to load
   only those local payloads. The archive's 64-character digest is a separate job
   output and is rechecked against both the transferred checksum record and the
   host-computed archive digest. Before SCP, a
   fingerprinted read-only SSH admission verifies deployment path
   ownership/writability, `.env` isolation, sudo scope, host-lock availability,
   prior receipt/payload state, the exact incoming path, and at least 8 GiB free. Only then does the
   protected job transfer the archive.
   The host executes no candidate build tooling. It verifies the archive,
   every runtime directory, and the release stamp before arming rollback,
   retains the previous runtime directories, and then swaps in the candidate.
   Terminal `succeeded`, `rolled_back`, and `preflight_failed` attempts remove
   their large run-scoped payloads. Later runs reclaim payloads only for receipts
   validated as safe terminal state. Unresolved, rollback-failed, malformed,
   incomplete, or receipt-less payloads are never age-deleted: they block later
   transfer and promotion until an approval-gated incident procedure reconciles
   them.
   A current transferred payload without a receipt is reported as unresolved,
   never as proof that production was untouched or as authorization to redispatch.
7. After restart, promotion requires a new process, the requested runtime SHA,
   an advancing persisted Jetstream cursor, and both the cursor and newest indexed
   post no more than 120 seconds old. Both the pre-restart and post-restart
   `MainPID` values must be nonzero decimal PIDs and must differ. Every HTTP and
   database probe has a bounded timeout and retry budget.
8. Read the run-scoped receipt from the GitHub Actions step summary. It records
   `status`, `requested`, `previous`, `built`, `deployed`, and `runtime` SHAs,
   migration set, production Compose change set, `operator`, UTC timestamp, and
   workflow URL. The host copy is
   retained at `/opt/bluesky-feed/.git/corgi-deploy-receipts/<run-id>-<attempt>.receipt`
   for incident recovery; the runner requires exactly one valid receipt marker.
   A `succeeded` receipt requires `requested=built=deployed=runtime`. A
   `rolled_back` receipt requires `built=requested` and
   `deployed=runtime=previous`.
9. Runner clean installs disable package lifecycle scripts in every shipped workspace.
   This M0 workflow blocks every changed SQL migration and every change to
   `docker-compose.prod.yml` before rollback is armed. Migration-bearing releases
   require a separate approval-gated harness that
   applies the migration to an isolated database, restores `PREV_COMMIT`, and
   proves representative previous-release health plus read/write compatibility
   against the post-migration schema before production mutation. Compose-bearing
   releases require a rehearsed container rollback path in the later runtime-
   hardening lane.

### Docker deploy (not M0-compatible)

The generic image does not yet stamp an immutable reviewed release SHA, so
its health response reports `revision: null` even though dependency readiness
can pass. The exact-SHA workflow rejects that missing identity, so do not use
this path for M0 production promotion. Container release stamping, immutable
image pinning, and container-level identity evidence belong to the later
runtime-hardening release.

The process-liveness contract is deliberately separate from rollout readiness:
`/health/live` stays available while the process runs, and the systemd watchdog
continues heartbeats when database and Redis dependencies are healthy.
`/health/ready` exposes that same dependency-only contract for restart-oriented
probes. The direct-loopback-only `/health/promotion-ready` refuses
proxy-forwarding headers and additionally requires a valid production release
artifact plus both persisted ingestion signals within 120 seconds and no
emergency disk pressure. Stale ingestion therefore blocks promotion without
forcing a watchdog restart loop.

```bash
docker build -t bluesky-feed .
docker run -d --name bluesky-feed --env-file .env -p 3000:3000 bluesky-feed
```

### Rollback

Automatic rollback is part of the protected workflow. The host receipt is
written with `status=started` before mutation. After acquiring the host lock and
before mutation, the workflow captures `PREV_COMMIT="$(git rev-parse HEAD)"`.
After the target checkout is armed, any command failure runs
`git checkout --detach "$PREV_COMMIT"`, requires checkout equality by proving
`git rev-parse HEAD` equals
`PREV_COMMIT` before any restart or terminal receipt,
restores the retained previous runtime artifacts without registry access or a
rebuild, and always restarts the restored release after replacing served
artifacts. Rollback never runs a down migration
and succeeds only after bounded checks prove an active service reporting the
previous runtime revision. Cursor advancement and cursor/newest-post freshness remain logged
as advisory ingestion diagnostics so a quiet posting window cannot turn a successful
application restoration into `rollback_failed`. A `rolled_back` receipt keeps
`built` set to the requested candidate SHA while `deployed` and `runtime` prove
the restored previous SHA. A candidate failure before the
artifact swap records `preflight_failed` after proving checkout identity and
the previous process are unchanged; after swap, rollback must prove the restored
checkout identity before restarting, and the terminal receipt is
`rolled_back` or `rollback_failed`. Before rollback work begins, the
workflow writes `rollback_interrupted`; if the SSH action reaches its bounded
timeout during rollback, that explicit sentinel remains in the retained receipt.
If the sentinel write fails, the workflow logs the receipt failure and continues
restoring `PREV_COMMIT`; receipt durability never blocks restoration.
The remote shell traps `ERR`, `EXIT`, `HUP`, `INT`, and `TERM` and invokes the
same single-shot rollback path while armed. Subshell failures delegate rollback
to the main deploy shell, and an atomic per-attempt guard prevents duplicate
restoration. A hard kill or transport loss cannot be trapped;
`started` or `rollback_interrupted` is therefore an unresolved production state
that fails the workflow and may leave the checkout on the requested SHA.

There is no direct-VPS manual rollback shortcut. If the automatic rollback fails,
is interrupted, or leaves an unresolved receipt, freeze further dispatches,
preserve the run-scoped host receipt, and open an approval-gated incident
procedure using that receipt and backup evidence. Do not accept a copied SHA or
locally existing commit as rollback authorization.

Notes:
- DB migrations are forward-only by default. For destructive rollback, restore
  from backup first in a controlled maintenance window.
- Backups run daily via root cron using `/opt/backups/daily-backup.sh`, writing
  PostgreSQL dumps to `/mnt/host-backups/postgres`; `/opt/backups` is the
  installed-script/log path, not the backup data root.
- PostgreSQL retention is deterministic: keep only the latest 5 valid
  `dump-YYYY-MM-DD.sql.gz` files and delete invalid/truncated dumps automatically.

### Infrastructure containers

PostgreSQL and Redis run via Docker Compose on the VPS:

```bash
cd /opt/bluesky-feed
docker compose -f docker-compose.prod.yml up -d
docker compose -f docker-compose.prod.yml ps
```

### CI/CD workflows

| Workflow | Trigger | Purpose |
|----------|---------|---------|
| `ci.yml` | PR, push to main | Build, test, lint, security audit |
| `deploy.yml` | Manual full-SHA dispatch | Protected exact-SHA promotion to VPS |
| `deploy-docs.yml` | Push to main (docs-site changes) | Deploy API docs to `docs.corgi.network` |
| `daily-health.yml` | Cron (daily) | Health check, creates incident issue on failure |
| `weekly-export.yml` | Cron (weekly) | Anonymized research data export |
| `docs-freshness.yml` | Cron | Doc staleness detection |

See `docs/OPERABILITY.md`, `docs/runbooks/operator-quickstart.md`, and
`docs/runbooks/incident-response.md` for the canonical operational procedures.

---

## 7. Linked Deeper Docs

| Document | Path |
|----------|------|
| Architecture | `docs/ARCHITECTURE.md` |
| Log and journal index (local-only findings journal at `docs/eval-lab-journal.md`) | `docs/LOGS.md` |
| Operability / release procedures | `docs/OPERABILITY.md` |
| Operator quickstart | `docs/runbooks/operator-quickstart.md` |
| Incident response | `docs/runbooks/incident-response.md` |
| ADR index | `docs/adr/README.md` |
| Extensible scoring ADR | `docs/adr/ADR-0001-extensible-scoring-components.md` |
| Feed SDK package | `packages/feed-sdk/` |
| Product requirements / strategy | `docs/PRD.md` |
| Legacy system overview | `docs/SYSTEM_OVERVIEW.md` |
| Deployment guide | `docs/DEPLOYMENT.md` |
| Legacy operations runbook | `docs/OPS_RUNBOOK.md` |
| Security model and audit | `docs/SECURITY.md`, `docs/SECURITY_AUDIT.md` |
| Stability and load testing | `docs/STABILITY_TEST.md` |
| MCP setup guide | `docs/MCP_SETUP.md` |
| Issue triage | `docs/ISSUE_TRIAGE.md` |
| Versioning and releases | `docs/VERSIONING.md`, `RELEASING.md` |
| Product roadmap | `ROADMAP.md` |
| Contributing guide | `CONTRIBUTING.md` |
| Changelog | `CHANGELOG.md` |
| Code of conduct | `CODE_OF_CONDUCT.md` |
| Support channels | `SUPPORT.md` |
| Legal (ToS, Privacy) | `legal/` |
| OpenAPI spec | `docs/openapi-public.json` |
| API reference (live) | `https://docs.corgi.network` |

### Doc Compliance Tracker (production_service)

| Required Doc | Canonical Path | Status | Notes |
|--------------|----------------|--------|-------|
| readme | `README.md` | Exists | Canonical entry point for repo overview and setup |
| repo_contract | `docs/agent/REPO_CONTRACT.md` | Exists | Added in this PR |
| architecture | `docs/ARCHITECTURE.md` | Exists | Added in this PR |
| operator_runbook | `docs/runbooks/operator-quickstart.md` | Exists | Added in this PR |
| incident_runbook | `docs/runbooks/incident-response.md` | Exists | Added in this PR |
| release_operability | `docs/OPERABILITY.md` | Exists | Added in this PR |
| adr_index | `docs/adr/README.md` | Exists | Added in this PR; no ADR files tracked yet |
| prd_or_strategy | `docs/PRD.md` | Exists | Added in this PR |
| contributing | `CONTRIBUTING.md` | Exists | Repo-local contribution guide already tracked |

---

## 8. Known Gotchas

1. **Squash-only merges.** The org enforces squash merges. Using `--merge` or
   `--rebase` will be blocked by policy checks.

2. **Linear key required everywhere.** Branch names must follow
   `dev/<LINEAR-KEY>-<slug>`. PR titles must include `[KEY]`. Commit messages
   must contain a Linear key. Enforcement happens in org-policy / CI checks and
   any local hook configuration that may be installed by the workspace.

3. **Separate install targets.** Backend and frontends have separate
   `node_modules`. Run `npm install` at repo root and `cd web-next && npm
   install` for the canonical frontend. Install `web/` dependencies only when
   working on the legacy compatibility frontend. The `npm run verify` command
   covers both frontend packages.

4. **PostgreSQL port offset in production.** Docker Compose binds PostgreSQL to
   `127.0.0.1:5433` (not standard 5432) and Redis to `127.0.0.1:6380` (not
   6379) to avoid conflicts with system installs. Ensure `DATABASE_URL` and
   `REDIS_URL` in `.env` match these port mappings.

5. **Scoring pipeline runs every 5 minutes.** New posts are ingested
   continuously via Jetstream but scores are only recalculated in batch. If the
   feed looks stale after deploying, wait for the next scoring cycle or trigger
   a manual rescore via `npm run cli -- feed rescore`.

6. **Governance epoch transitions.** Fewer than 10 ballots use an arithmetic
   mean; 10 or more use a 10% trimmed mean. Closing a voting window enters
   results review. Operator approval applies signal weights, topic priorities,
   and adopted content rules together before rescoring. New databases still
   require `npx tsx scripts/seed-governance.ts`.

7. **Append-only audit log.** The `governance_audit_log` table is DB-enforced
   append-only (no edits, no deletes). Do not attempt to modify it in
   migrations.

8. **Jetstream reconnection.** The Jetstream WebSocket client automatically
   reconnects with cursor persistence (saved every 1000 events). If ingestion
   gaps appear, check cursor state and restart the service.

9. **DID requirement.** The feed generator must use `did:plc` (not `did:web`).
   Run `npm run generate-feed-did` to resolve DIDs during initial setup.

10. **VPS file paths.** Production uses `/opt/bluesky-feed/` as working
    directory. The systemd unit file is `bluesky-feed.service`.

11. **Public repo workflow exception.** This repository is public while the org
    control-plane repo (`andrewnordstrom-eng/.github`) is private. Reusable
    workflows from that private repo cannot be relied on here, so
    `coderabbit-freshness` and `coderabbit-thread-check` are intentionally
    implemented locally in `.github/workflows/` rather than inherited by
    reference. Keep `.coderabbit.yaml` `reviews.auto_review.auto_incremental_review`
    enabled so the freshness gate receives a fresh non-skipped CodeRabbit signal
    on the latest push.

---

## 9. Where to Get Live State

| What | How |
|------|-----|
| Health check | `GET https://feed.corgi.network/health` |
| Dependency readiness probe | `GET https://feed.corgi.network/health/ready` |
| Promotion readiness probe | `GET http://localhost:3001/health/promotion-ready` on the production host only |
| Liveness probe | `GET https://feed.corgi.network/health/live` |
| Feed describe | `GET https://feed.corgi.network/xrpc/app.bsky.feed.describeFeedGenerator` |
| Transparency stats | `GET https://feed.corgi.network/api/transparency/stats` |
| Current governance weights | `GET https://feed.corgi.network/api/governance/weights` |
| Service status (VPS) | `sudo systemctl status bluesky-feed` |
| Service logs (VPS) | `sudo journalctl -u bluesky-feed -f` |
| Infra containers | `cd /opt/bluesky-feed && docker compose -f docker-compose.prod.yml ps` |
| Database backups | `/mnt/host-backups/postgres/` on VPS |
| Disk/service alerts | `sudo journalctl -t bluesky-disk-alert -n 100 --no-pager` |
| Retention/cleanup logs | `sudo journalctl -t bluesky-ops-retention -n 100 --no-pager` |
| Linear project board | maintainers' private project board |
| API documentation (live) | `https://docs.corgi.network` |
