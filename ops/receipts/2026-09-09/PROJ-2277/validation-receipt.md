# PROJ-2277 audit-policy alignment — local candidate

Status: local validation and external CLI review complete.
Pre-publication snapshot; no release approval or deployment is claimed.

## Scope and identity

[verified] Base: `a09edeafaf085121d1340a543874de6362e1e42a`.
The workflow now invokes the existing CI audit wrapper at the moderate threshold
for root, CLI, web and web-next before packaging. It audits development
dependencies retained in the archive. The contract and existing deployment
regression tests were updated. No dependency manifest, lockfile, allowlist,
artifact layout, host operation or deployment trigger changed.

[verified] Admission returned ALLOW with lease `atl-cbc21aaca15a24f7`, fencing
token 262, expiring 2026-09-09T23:06:13Z. The owner explicitly authorized
PROJ-2277-only project/global WIP and worktree-pressure exceptions. Other gates
remain enforced. Research passed without a research exemption.

The three-file review patch SHA-256 is
`8bdacdf3573c5fb1220d8d7ce79e48573b464158dd1ea6da340ef9a0e8288906`.
File and validation-log hashes are in `validation-summary.json`. Reproduce the
patch with `git diff --binary a09edeafaf085121d1340a543874de6362e1e42a -- .github/workflows/deploy.yml docs/agent/REPO_CONTRACT.md tests/demo-shadow-isolation.test.ts`
against the recorded base, including after committing this candidate.

## Deterministic Eval

[verified] Four `npm ci --ignore-scripts` installs passed. Focused deployment and
audit-wrapper tests: 432 passed. Full `npm run verify`: 159 test files passed,
2,272 tests passed, one skipped; documentation, backend, CLI, MCP, SDK, external
component fixture, legacy frontend lint/build and Next.js build passed. The
public tracked `.env.example` supplied test configuration through the child
environment, excluding NODE_ENV so each tool chooses its mode. No production
configuration was used. Documentation verification also passed after the final
contract metadata edit. `git diff --check` passed.

The initial full run could not bind loopback sockets in the sandbox. The final
run with authorized loopback access passed; tests were not skipped or weakened.
Sandboxed DNS also prevented the initial audits. The network-enabled runs below
are the actual advisory results, with outputs preserved in the summary.

| Workspace | Canonical moderate-threshold audit |
| --- | --- |
| Root | FAIL: six advisory IDs |
| CLI | PASS |
| Web | PASS |
| Web-next | FAIL: four advisory IDs |

[verified] These are nine unique IDs inherited from main (sharp appears in two
workspaces). This policy candidate intentionally does not incorporate the
separate dependency PR. No exception was added to make these checks green.

## Runtime Health Check

[verified] This candidate runs no production service operations. Local full
validation passed; it does not qualify a Linux release archive or deployment.
[can't-verify-here] Production readiness requires the separately authorized
protected promotion and runtime acceptance procedure.

## Live Acceptance

[verified] PR #412 was read from GitHub and remains OPEN, draft, at
`c5c842c7bddf4b6fb407b042cc8498e80fb7c164`.

[verified] After the owner explicitly authorized the exact external payload,
CodeRabbit CLI reviewed the three implementation files and completed with exit
0: one trivial suggestion, no blocking findings. The reviewed patch hash remained
unchanged. The suggestion concerns stronger checks of unchanged CI steps; direct
source inspection confirmed those commands are executable and unsuppressed.
The rationale for deferring this broader test enhancement is recorded in
`review-disposition.json`. This does not claim hosted exact-head approval,
review of these locally prepared receipts, or release acceptance.

`adm-zip-decision-proposal.json` is a separate, inactive risk-decision proposal.
Its owner, expiry and conditions require explicit acceptance before any
allowlist change. The current allowance list remains empty.

### Automation Summary

Completed: issue-specific admission, guarded isolated worktree, scoped local
implementation, four installs, focused tests, full verification, real audits,
and required external CLI review with disposition. Pending: commit/publication
gates and subsequent hosted review. No workflow dispatch, production bundle transfer,
service restart, merge, unrelated worktree removal or active advisory exception.
