# PROJ-2228 reviewed-candidate QA report

Verdict: **PASS for focused local runtime-contract and deployment-contract evidence.** This report does not qualify production deployment or protected-host rollback.

Worktree: `/private/tmp/proj-2228-corgi-runtime`
Observed source base: `c9833d1ca1e7114212eabd7510c3b469ddd0b6cb`
Runtime used: Node `22.23.2`, npm `10.9.8`, Darwin arm64 toolchain at `/private/tmp/corgi-2228-toolchain/node-v22.23.2-darwin-arm64/bin`.

## Focused execution

Command:

```text
/private/tmp/corgi-2228-toolchain/node-v22.23.2-darwin-arm64/bin/node \
  node_modules/vitest/vitest.mjs run \
  tests/runtime-contract.test.ts tests/demo-shadow-isolation.test.ts
```

Result: exit `0`; 2 test files passed; **387 tests passed**.
Log: `/private/tmp/corgi-2228-validation/qa-reviewed-focused.log`
Log SHA-256: `df9130da7f7baf3e4b6be84f6696249bf6b6282e55f4cb598d5783ee36ed0ebf`

The runtime-contract tests now cover the explicit observed ABI argument and reject ABI `115` when the contract requires ABI `127`. The deployment-contract suite remains green.

## Source checks

Read-only inspection confirms:

- `.nvmrc`, all five package manifests, all four workflow families, Docker builder/production stages, and release docs use Node `22.23.2`.
- Runtime contract requires ABI `127` and validates `process.versions.modules` in its CLI path.
- CI checks both `process.version === v22.23.2` and `process.versions.modules === 127` in the native/runtime lane.
- Docker uses the pinned `node:22.23.2-bookworm-slim` digest in both stages, validates a full lowercase `SOURCE_REVISION`, carries engine-strict configuration into both stages, and retains `/health/ready` health checking.
- Deployment documentation uses the signed Node checksum reference, exact `/opt/corgi-node-v22.23.2` path, `node --version` check, and ABI `127` check. The service example uses the same absolute runtime path.

Current source hashes:

```text
scripts/check-runtime-contract.mjs  a7fa9bf85adc6e0b39a21c856fd5f468926a4fd2788f8c89d7abba3fc36d06b9
tests/runtime-contract.test.ts      a392735a04310b6276f81cc6ad1f345d0b0cd17bd8fb6dc33f25665e9eb966db
docs/DEPLOYMENT.md                  fe61fcc415e83e26940fa4e8170684de12ddb36a961f6604f8c7bbb0e1acb692
docs/agent/REPO_CONTRACT.md          e52fcfe49461b7fffca031f24c502fef25dfa7e3703aa4ab6ff096c9ab402edd
.github/workflows/ci.yml             648c51d10db41aef410761e020b255ac6aaa742619431bad5624b47408cea8b3
.github/workflows/deploy.yml          959c911b09d7a0a3d626ff9be120bd2117958df458dfad03acfdc94c058371d5
```

## Boundaries

Parent-owned evidence reports full verification, four CI installs with zero `EBADENGINE`, four audits, disposable Linux image/native/health checks, and the current CodeRabbit approved review. Those receipts are not reclassified as independent local evidence here.

This QA pass does not claim production image qualification, protected-host service activation, live traffic health, or exact-SHA rollback on a protected host. No tracked files, host installations, containers, credentials, commits, deployments, or freeze changes were performed.

## Runtime Health Check

Node 22.23.2 and ABI 127 were used for focused QA.

## Deterministic Eval

387 focused tests passed; see the command and hash above.

## Live Acceptance

Production and protected-host acceptance remain excluded.

### Automation Summary

Continue with commit-bound image validation and hosted review.
