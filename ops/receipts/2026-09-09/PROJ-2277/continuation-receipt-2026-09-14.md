# PROJ-2277 audit policy continuation — 2026-09-14

Status: locally validated candidate; hosted checks and substantive review remain required after publication. This supersedes the September 9 readiness conclusions without rewriting that historical receipt.

## Identity and scope

[verified] Integrated main `c9833d1ca1e7114212eabd7510c3b469ddd0b6cb` into the existing PR branch at `888f0af0239d440e1471a8e57a9c0feb74ecf042`, preserving both histories. The three implementation files are `.github/workflows/deploy.yml`, `docs/agent/REPO_CONTRACT.md`, and `tests/demo-shadow-isolation.test.ts`. The implementation patch SHA-256 is `130d91d36e92eaf263a7aeddcdc9f38934853af674d73c96bafbaee3db9a4fd1`.

Reproduce with `git diff --binary c9833d1ca1e7114212eabd7510c3b469ddd0b6cb HEAD -- .github/workflows/deploy.yml docs/agent/REPO_CONTRACT.md tests/demo-shadow-isolation.test.ts | shasum -a 256` after committing this receipt. The companion JSON records individual file and log hashes, commands and execution times.

[verified] All eight dependency manifests/locks and the canonical audit wrapper match integrated main byte-for-byte. This continuation adds no dependency override or advisory exception. The old adm-zip proposal is marked superseded without activation because the patched dependency is already on main and the fresh audits pass.

## Deterministic Eval

[verified — direct execution] Node 20.19.0 / npm 10.8.2 on darwin-arm64: four `npm ci --ignore-scripts` installs succeeded. The canonical full-graph moderate-threshold audits passed for root, cli, web and web-next. `npm run verify` passed: 159 test files, 2,298 tests passed and one skipped, including backend, CLI, MCP, SDK and fixture builds, documentation validation, legacy frontend lint/build and Next.js static export. Public tracked `.env.example` values were injected into the child environment, excluding NODE_ENV; no production configuration was used.

[verified — independent QA execution, receipt personally inspected] QA declared its policy expectations before validation, then ran `node node_modules/vitest/vitest.mjs run tests/audit-allowlist-script.test.ts tests/demo-shadow-isolation.test.ts`: two files and 458 tests passed. Its source hash matches the implementation hash above. Independent integration review accepted the bounded source change. A prior source-only verdict missed a literal-false regression; both full-suite and QA execution caught it. Direct line/value comparison fixed that defect and both suites were rerun successfully. Earlier 2,290/450 counts are superseded.

[verified] Review findings and source-backed dispositions are recorded in the companion JSON. The substantive guard findings were fixed, including job controls placed after the step list. The local review snapshots preceded the final fixes; independent full and focused execution validates those fixes, while hosted review must assess the final commit. The request to add root-lock overrides metadata was not applied: npm 10.8.2 Arborist `lib/shrinkwrap.js` lines 85–105 excludes that field from serialized package metadata; fresh installs and the lock-only dependency tree pass. A frontend-override concern was checked in web-next's own install context. These dispositions do not substitute for hosted review.

## Runtime Health Check

[verified] Root installation emitted 16 engine warnings under Node 20.19.0. `npm ls --all @hono/node-server hono vitest adm-zip sharp --json` reported an actual-tree adm-zip range diagnostic (exit 1); adding `--package-lock-only` passed (exit 0). Installed and locked patched versions agree. This observation is recorded in the existing runtime qualification packet; no claim is made that its cause is proven or production compatibility is qualified.

[can't-verify-here] A supported Linux production image and protected runtime acceptance are separate gates. This local policy validation is not evidence that those gates passed.

## Live Acceptance

[verified] Four real registry audits passed, replacing the historical September 9 advisory failures. The empty allowlist remains unchanged. No main merge, freeze modification, host operation, protected workflow dispatch, production bundle creation/upload, or deployment was performed.

[can't-verify-here] Hosted checks and substantive review for the new commit must be obtained after push. PR readiness is distinct from release approval. The separate private security-release owner retains production-path ownership.

### Automation Summary

Completed: existing issue-specific admission and scoped lease; main integration; builder fix; independent integration review; expectations-first QA; four fresh installs/audits; full validation; local review and documented dispositions. Receipt hashes and commands support reproduction; raw logs remain local temporary evidence and are not guaranteed durable storage.

Next: commit and push the existing branch, update PR evidence, obtain exact-head hosted CI and review, then hand off the qualified commit. Main merge and deployment remain separately gated. No issue is marked Done by this pre-publication receipt.
