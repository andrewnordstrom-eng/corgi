# PROJ-2275 — published adm-zip patch validation, September 12

Status: local dependency remediation validated; hosted approval and release acceptance remain pending.

This follow-up supersedes the September 9 receipt's unresolved-advisory conclusion. Upstream released adm-zip 0.6.1 on September 11 and its release notes identify the destination-symlink extraction fix: https://github.com/cthackers/adm-zip/releases/tag/v0.6.1 . This receipt remains in the original admitted directory; its assessment date is September 12.

## Scope and provenance

The implementation changes only the root adm-zip override, locked version, tarball URL, and integrity digest, from 0.6.0 to 0.6.1. No other dependency resolution or platform metadata changes. The empty audit allowlist and application/runtime/workflow source are unchanged by this dependency patch.

Parent candidate: `c5c842c7bddf4b6fb407b042cc8498e80fb7c164`.
Implementation patch SHA-256: `c6efca3311e0f0a63f3afd6f49164f254230d0cf041ef64ae417dff79268e9d7`.
The existing PROJ-2275 worktree and scope were reacquired normally; lease `atl-3eacf807c8ad05c0`, fencing token 263. Existing issue-specific project/global capacity exceptions were retained. No new worktree or advisory exception was requested.

## Deterministic Eval

[verified] Four fresh `npm ci --ignore-scripts` installs and all four canonical moderate-threshold, full-graph audit-wrapper invocations passed on September 12: root, CLI, legacy web, and Next.js. No advisory was suppressed.

[verified] `npm run verify` passed for the dependency candidate: 159 test files / 2,258 tests, documentation checks, backend/CLI/MCP/SDK builds, external-component fixture, frontend lint/build, and Next.js export.

[verified] A separate full verification of the same dependency tree plus PR #413's three implementation files passed: 159 files / 2,273 tests. The policy head was `888f0af0239d440e1471a8e57a9c0feb74ecf042`; its historical receipts were not part of the implementation overlay. Neither published head was rebased or merged to perform this integration check.

[verified] A disposable extraction regression confirmed that adm-zip 0.6.1 rejects pre-existing file and directory symlinks with overwrite enabled, preserves an outside sentinel, and still performs ordinary extraction. The regression fixture was local validation material, not an application source change.

All 931 selected source-file digests matched the final combined manifest after testing. Exact commands, exit codes, implementation/input/log hashes, test counts, and regression results accompany this receipt in `patch-validation-summary-2026-09-12.json`. Local raw evidence is in `/private/tmp/proj2275-sep12-validation/`.

## Runtime Health Check

[verified] Linux ARM64, Node 20.19.0, nonroot UID 1000: the unmodified Corgi embedder initialized the real q8 `Xenova/all-MiniLM-L6-v2` model and returned three finite normalized 384-dimensional vectors. Native ONNX/Sharp bindings loaded. An instrumented load guard passed its positive control and observed zero adm-zip or ONNX installer module loads during embedding initialization and inference.

[inferred] This supports separation of the observed inference path from installer extraction; it is not universal non-reachability proof.

[verified] The existing Node 20 pin still emits 16 root `EBADENGINE` warnings. This patch changes none of those packages or the selected runtime. Supported-runtime alignment remains separately owned work. [can't-verify-here] This Linux ARM64 run does not establish x64 qualification or production health; a compatible isolated x64 runner and the release acceptance process are needed.

## Live Acceptance

No merge, production deployment, workflow dispatch, host mutation, freeze amendment, or audit exception occurred. Hosted validation and current-head review remain required before normal merge consideration. The broader security release's runtime, operations, performance, rollback, and production gates remain applicable.

### Automation Summary

All recorded install, audit, verification, extraction-regression, and embedding phases exited zero. The test environment used only public `.env.example` values, lifecycle-script suppression, a nonroot container, and a dedicated validation mount. CodeRabbit CLI completed review of exactly `package.json` and `package-lock.json` with zero findings and exit 0. The implementation patch hash remained unchanged. The two receipt files were prepared afterward and are validated separately for formatting. Hosted review is distinct and remains pending.
