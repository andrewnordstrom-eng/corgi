# PROJ-2258 Phase A Design Receipt

[VALIDATION RECEIPT] ops/receipts/2026-09-02/PROJ-2258/phase-a-design.md

Issue: PROJ-2258 — Split reviewer-gated promotion from least-privilege scheduled operations
Date: 2026-09-02 (America/Los_Angeles)
Repository: `andrewnordstrom-eng/corgi`
Branch: `dev/PROJ-2258-least-privilege-operations-principal`
Base: `c703244da266679a289109871920d0320f14ebf3`
Phase: A only; production execution is not authorized

## Runtime Health Check

- No SSH connection to the production host was made.
- No production account, key, sudoers entry, wrapper, file, service, database
  role, GitHub environment, Actions secret/variable, workflow binding, desired
  state, freeze, or deployment setting was created or changed.
- `CORGI_PRODUCTION_DEPLOY_ENABLED` remains outside this packet and no deploy
  workflow was dispatched.
- A disposable local `ubuntu:24.04` container, using only an empty fake
  `/opt/bluesky-feed`, passed `apply`, repeated `apply`, `verify`, `rollback`,
  and repeated `rollback`. It also proved restrictive system-directory modes
  are preserved, a writable ancestor is rejected before account creation, a
  missing home or rollback sentinel blocks every removal, and a stalled
  Redis/Docker probe exits at its 15-second deadline. The corrected lifecycle
  exited 0 and left no managed account or file behind.
- A real disposable `postgres:16` container proved that an access-exclusive
  lock cancels the direct epoch query at the five-second statement timeout and
  an unroutable endpoint exits at the five-second connection timeout.

## Deterministic Eval

- Admission passed after the founder-authorized PROJ-2258 issue/global WIP-cap
  exceptions. No overlap, worktree-count, sensitive-mutation, admin, or other
  bypass was used.
- Research provenance passed with live Linear, exact-repository, current
  official documentation, NIST, first-party Docker, and peer-reviewed sources.
- `shellcheck` passed for all three shell files.
- `bash -n` and `sh -n` passed for the provisioning, dispatcher, and Redis
  wrapper scripts.
- `tests/operations-principal-policy.test.ts` passed 20 tests. It blocks
  command-allowlist expansion, argument-bearing variants, arbitrary Docker
  access, broad sudo, supplementary-group drift, interactive shell access, and
  rollback-confirmation removal.
- `npm run verify` passed after creating the ignored local `.env` from the
  repository's non-production `.env.example`: 158 test files and 2,167 tests,
  backend TypeScript, CLI, SDK, external SDK fixture, legacy frontend lint/build,
  and canonical Next.js build.
- Report-script compilation and both offline dry runs passed.
- The CLI moderate-threshold audit gate passed. The root, legacy web, and
  `web-next` gates detected new non-allowlisted registry advisories in unchanged
  dependencies. No package manifest or lockfile differs from `origin/main`, and
  the explicit audit allowlist was not widened. This live baseline drift must be
  resolved outside this security-boundary packet before hosted convergence.
- One bounded local CodeRabbit review reported four major findings. All four
  were fixed: rollback now scans system/user/vendor service and cron locations;
  sensitive local inputs require current-user ownership and no group/other
  permissions; epoch stdin failures have direct coverage; and installation
  preserves pre-existing root-owned system-directory modes. The disposable
  lifecycle recheck proved restrictive valid parent modes remain unchanged.
- A second bounded review found five concrete deadline, path, rollback, and
  parser gaps. All were fixed: every managed-path ancestor is root-owned and
  non-writable before mutation; rollback inventory is atomic; an unterminated
  second input line is rejected; PostgreSQL connection, statement, and client
  query deadlines are bounded; and Redis has an outer 15-second deadline.
- A third bounded review found two final fail-closed gaps. Rollback now rejects
  an interrupted installation with a missing or symlinked home before removing
  anything, and the database URL read now has a five-second deadline plus a
  4,096-byte cap even when the SSH sender leaves stdin open.
- A fourth terminal review found one missing prerequisite check; provisioning
  now fails before mutation if the exact `curl` or `df` binaries used by the
  forced dispatcher are absent. No cosmetic or speculative churn was accepted.
- Exact-head review evidence will be appended before this receipt can support a
  Phase B approval request.

## Live Acceptance

- Production positive and negative tests were intentionally not run because
  Phase B is not authorized.
- Phase B must run the committed script once, then prove all four allowed
  commands succeed and the empty shell, `.env` read, arbitrary `docker exec`,
  checkout write, and service restart attempts are denied.
- The `corgi-operations` password must be locked; its only shell is `/bin/sh`
  for OpenSSH forced-command execution; it has no supplementary group and no
  direct Docker-socket access.
- The only privileged edge is the exact root-owned Redis read wrapper named in
  one sudoers rule. The application `.env` remains unreadable.
- No production key exists yet. Phase B must generate a new Ed25519 pair,
  compare its public fingerprint against the deployment identity, store only
  the private half in `production-operations`, install only the restricted
  public half on the host, and record fingerprints without key bodies.

### Automation Summary

The committed vehicle is
`ops/provision-corgi-operations-principal.sh`, with explicit `plan`, `apply`,
`verify`, `acceptance`, and confirmation-gated `rollback` modes. It installs
the tracked forced dispatcher and fixed Redis wrapper byte-for-byte, validates
the one-line sudoers file, rejects unexpected account groups or sudo references,
and refuses recursive rollback if an unexpected home file appears.

Daily health is designed around exactly four SSH tokens: `epoch-status`,
`disk-root`, `health-ready`, and `feed-updated-at`. The epoch command accepts a
dedicated read-only database URL only on stdin. Weekly export is explicitly not
granted `.env`, Docker, or broad root access; its server-side replacement is
tracked in PROJ-2261. Its historical failure is not a PROJ-2258 regression and
continues to block repository-secret retirement.

## Validation

PR: the Phase A draft link is recorded in PROJ-2258 after this receipt is committed
Exact head: verified from the immutable PR head and recorded in PROJ-2258; a
self-referential commit SHA is intentionally not embedded in its own tree
CodeRabbit: four bounded local reviews completed; all verified findings fixed
Known warnings: root/web/web-next audits currently fail on registry advisories
in unchanged dependencies; production allow/deny acceptance, GitHub environment creation,
workflow rebinding, desired-state changes, and secret retirement are Phase B or
later and remain intentionally unperformed.
