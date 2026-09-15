# PROJ-2228 final focused QA report

Status: **PASS for local focused runtime-contract and engine-gate evidence.** This report does not qualify production deployment, protected-host rollback, or release readiness.

Candidate worktree: `/private/tmp/proj-2228-corgi-runtime`
Candidate base observed: `c9833d1ca1e7114212eabd7510c3b469ddd0b6cb`
Runtime: Node `22.23.2`, npm `10.9.8`, Darwin arm64 toolchain at `/private/tmp/corgi-2228-toolchain/node-v22.23.2-darwin-arm64/bin`.

## Independent commands and receipts

Focused tests were run with public `.env.example` values in the child environment:

```text
/private/tmp/corgi-2228-toolchain/node-v22.23.2-darwin-arm64/bin/node \
  node_modules/vitest/vitest.mjs run \
  tests/runtime-contract.test.ts tests/demo-shadow-isolation.test.ts
```

Result: exit `0`; 2 files passed; 386 tests passed.
Log: `/private/tmp/corgi-2228-validation/qa-focused.log`
Log SHA-256: `f35a737f35ce549efd7ee0536b79d7931623a68b98ceac0e8caa9f54c0ad8ff2`

The focused runtime-contract suite positively verifies Node 22.23.2 source alignment and rejects mutations to `.nvmrc`, root/CLI/web-next/SDK engines, npm engine strictness, workflow pins, Docker workspace manifests, and Docker source-revision binding. It also rejects execution under Node 20. The demo-shadow suite verifies existing Docker, native, health, packaging, exact-SHA, and rollback contract guards.

Real npm engine-strict controls used a temporary fixture containing the candidate root `package.json` and `package-lock.json`; no installed workspace was mutated:

```text
node22/bin/npm ci --dry-run --ignore-scripts --engine-strict --no-audit --no-fund
```

Positive Node 22.23.2 result: exit `0`, 612 packages planned.
Log: `/private/tmp/corgi-2228-validation/engine-positive.log`
Log SHA-256: `243ef86a08f657dd7ea12600608d28703f77e86c9041ebb1f4892c5e85c65eaf`

```text
node20/bin/npm ci --dry-run --ignore-scripts --engine-strict --no-audit --no-fund
```

Negative Node 20.19.0 result: exit `1`, `EBADENGINE`; npm reports required `>=22.23.2` and actual Node `v20.19.0`.
Log: `/private/tmp/corgi-2228-validation/engine-negative.log`
Log SHA-256: `17c3bd878ea1bee08b1cc96e7903252a5fa7476be1f467b52dd94fef1478f64d`

The negative control used `PATH` rooted at the Node 20.19.0 toolchain so npm's shebang could not resolve to the host Node 24 binary.

## Source evidence hashes

Key final source files were hashed read-only:

```text
.nvmrc                                      08062faf0d7a2d22f5d7933c50e975dd1527034275597be7c1b3b9fd2b9d079a
package.json                                fbd355c92ba3c0396ee6d1bc3826601d91a94fb2c0f51ea4d2fb01ea7174b07d
cli/package.json                            9d5e565daffcdeb91a90eda3e280d8f724b8ddd3f6822eb9a2541eefe3b18c6b
web/package.json                            dd44a7555390c82feefb9336cc80bc557721829584144a5570fe500452f141f3
web-next/package.json                        f89d1eebf2b83d881ba8b7df5a63d4826840b3282b7736190bf55f1d1a136e6d
packages/feed-sdk/package.json               79a86d8381c65523c506e54b26ba6f267e109bf888108601c0ab2d4079e044c6
Dockerfile                                  4070218e6cfa9890124d306e4774c877259c6ca07afcfe4e85f44618d8e78a85
scripts/check-runtime-contract.mjs          7de5ea2808f8da16f1507e0c6d502d1b8526a49fb4650a32f1a80a8081872c0f
tests/runtime-contract.test.ts              1e5b3448d332be67419b1fc9cee6152147f5a8f8d2ea08d1a0ea9ad282c7884f
```

## Parent-owned evidence and boundaries

The parent reports full verification at 160 files, 2,269 tests passed, 1 skipped; four CI installs with zero `EBADENGINE`; four canonical audits passed; and separate Linux/glibc image/native/health evidence. Those are parent-owned receipts, not replaced by this local Darwin run.

The current report does not claim:

- Docker image digest/platform/native ABI qualification from Darwin.
- Production image smoke or protected-host service health.
- Exact-SHA rollback on a protected host. A disposable artifact rollback is a separate bounded proof; production rollback remains gated.
- Merge, deployment, credentials, freeze changes, or production readiness.

Optional platform lock entries such as win32-ia32 sharp were not treated as target-runtime failures; the negative control evaluated the actual root Linux/Darwin-compatible lock graph under npm engine-strict.

## Runtime Health Check

This independent report covers local focused checks; the implementation receipt separates Linux image and protected-host evidence.

## Deterministic Eval

386 focused checks passed; exact commands and hashes are recorded above.

## Live Acceptance

External review and final commit-bound image/rollback acceptance remain pending. No production qualification is claimed.

### Automation Summary

QA ran after Builder and Integration; no merge or deployment was performed.
