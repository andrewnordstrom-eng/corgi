# PROJ-2258 Phase B local acceptance

Status: repository candidate prepared; local acceptance passed; the bounded review is complete and its
findings have a recorded disposition. This is not a production delivery or freeze-lift receipt.

## Runtime Health Check

- Branch: `dev/PROJ-2258-phase-b-rollout`.
- Base: merged Phase A `a09edeafaf085121d1340a543874de6362e1e42a`.
- Admission: normal scoped continuation, fencing token 259. Only the explicitly
  approved PROJ-2258 project/global WIP exceptions were used. Worktree-pressure,
  path, review, freeze and production gates remain enforced.
- Scope: two database SQL scripts, one CLI installer, existing operations policy
  tests, daily-health workflow, operations documentation and this receipt directory.
- No commit, push, PR, production write, key/password generation, environment
  change, workflow dispatch or external delivery note is part of this acceptance.

## Deterministic Eval

`npm run verify` passed: 159 test files, 2,259 passing tests and the existing
one macOS-only skip; backend, CLI, MCP, SDK, fixture and both frontend builds
passed, including the legacy frontend lint. The initial sandbox attempt denied
loopback listening in ten existing HTTP tests; the authorized rerun with local
socket access passed them. The existing frontend bundle-size warning remains.

The disposable Linux acceptance used image
`sha256:a82032cfe573db60678a43c2390da27737578e2d9eceb7fde43b11d3b68e16b1`,
network disabled and a read-only synthetic fixture mount. Its containers were
removed on completion.

- `installer-rehearsal-receipt.json`: 19 cases, including SIGKILL during backup,
  after either live replacement and during rollback; full 42-file manifest
  comparisons; partial scratch recovery; corrupted candidate/manifest/backup;
  symlinks; writable staging; and contention with the deployment workflow lock. A demonstrated acquisition
  race now passes: the live directory is opened only after that lock is held.
- `workflow-rehearsal-receipt.json`: 18 cases executing the actual workflow Bash,
  GNU date and timeout against a synthetic SSH transport, with the current-time
  query fixed for deterministic 1,800/1,801-second boundary checks. This proves four fixed
  tokens, stdin-only DB credential transfer, strict SSH options, cleanup after
  success/failure, and correct failure handling for each command, invalid/stale/
  future timestamps, critical/malformed disk responses and missing credentials.
  It is not authentication or real-host command acceptance. Expected failure
  reasons and the intentional SSH exit code are checked, so a broken transport
  assertion cannot masquerade as a successful negative test.
- `database-rehearsal-receipt.json`: real PostgreSQL 16 in an isolated disposable
  container, two allowed SELECTs and eight denied operations. Additional checks
  cover PUBLIC schema/table/sequence drift, the non-reserved custom role
  `pgcustom`, repeat apply, LOGIN-enabled rollback refusal, and restoration of
  the inspected PUBLIC TEMP privilege. LOGIN stays disabled; credential
  authentication remains separately unqualified.

## Reproduction

Run `python3 ops/receipts/2026-09-08/PROJ-2258/rehearse-database.py` on a workstation
with the exact locally available PostgreSQL image named in that script. It
creates only a disposable network-isolated database and removes it in `finally`.
No production connection or volume is used.

For Linux filesystem/workflow acceptance, prepare a local fixture directory with
`baseline/` containing the CLI built from deployed source
`2892597cf9f352f0d941b9734d366b867b2ffcdd`, the two pinned manifests from this
directory, the two candidate compiled files from reviewed source
`b51266cc1738ed90457d132ff66925a8bd10aad3`, the installer, daily-health.yml, and
`rehearse-installer.py`/`rehearse-workflow.py`. Build both CLI revisions using the
same dependency layout as this repository. Mount this directory read-only at
`/fixture` in the pinned disposable policy image, with `--network none` and
`--rm`, and run the two Python rehearsal scripts there. The installer fixture
refuses execution outside a root container. Never run its destructive synthetic
filesystem reset on a host.

The CLI packet is authenticated by the pinned full manifest hashes in the
installer. A future operator must independently authenticate the installer
itself before privileged execution; an uploaded checksum file alone is not a
trust anchor.

See `review-disposition.md` for all eight CodeRabbit findings and the additional
lock-order correction. The review covered the initial frozen snapshot; the final
corrections have local regression evidence and still need normal hosted review
on the eventual published head. No exact-head hosted approval is claimed.

## Live Acceptance

The scoped control-plane model is merged and reconciled under PROJ-2274. A fresh
read-only plan proposes exactly two environment PUTs and two main-branch policy
POSTs with zero blockers; live environment parity has not been applied or accepted. Host execution needs explicit approval of the reviewed payload,
fresh stable database/Redis/service evidence, unchanged CLI dependency metadata,
quiesced callers and deployment state, and the existing safe production lock.
The installer refuses to create a missing deployment lock. The earlier readiness
timeout/watchdog incident remains diagnosed only as an application deadline;
this packet does not claim its underlying cause is fixed.

Host installation, dedicated credentials and true SSH/DB authentication,
environment parity and secrets must pass before merging the daily-health
binding. The main freeze remains enforced. Weekly export requires PROJ-2261's
separate repair before rebinding and blocks secret retirement. This preparation
cannot close PROJ-2258 or PROJ-2087.


### Automation Summary

Publication preparation on 2026-09-09 renewed the same seven-path lease through
ordinary admission, fencing token 260, without a new capacity bypass. Startup
returned READY_TO_WORK on the admitted worktree after its documented checkpoint
recovery; all 16 prepared files were restored byte-for-byte. Fresh `npm run verify`
passed 2,259 tests with one existing skip, builds and lint. The implementation
is unchanged; only these receipt headings and prerequisite status were updated.
The future draft PR and hosted review remain separate from operational activation.
