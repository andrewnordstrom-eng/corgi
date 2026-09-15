# PROJ-2228 implementation review

Status: published as PR #415; local retained-image rollback passed. CodeQL
findings from the first hosted head were fixed and locally revalidated; hosted
checks and review on the corrected head remain pending.
This packet is not Done and is not a production release approval.

## Decision-changing findings

1. **[verified] Authorized CodeRabbit review completed.** The user approved the
   frozen 35-file packet and required tracked repository context. The review
   returned three entries representing two unique findings. Both were fixed:
   deployment instructions now install the exact checksum-verified Node archive,
   and the runtime checker verifies the observed ABI. Full verification and
   independent focused QA passed after these changes. See `review-corrections.json`.
2. **[verified] Linux/arm64 passes; Linux/amd64 remains unqualified here.** The
   actual local amd64 build fails before executing the Dockerfile's first shell
   instruction with `exec /bin/sh: exec format error` (exit 255).
   `validation-summary.json` binds the failed log. **[can't-verify-here]** A native
   amd64 hosted runner is needed; the new CI image/native step provides that
   check after the PR exists. No emulation or host configuration was changed.
3. **[verified] Alpine cannot load the shipped ONNX binding on Linux/arm64.**
   The unchanged main lock installs successfully on Node 22.23.2 Alpine, but
   ONNX fails with missing `ld-linux-aarch64.so.1`. The identical lock loads
   ONNX and Sharp on Bookworm slim. Both logs and both official image indexes
   are retained here. This observed libc mismatch justifies the base-image change.
4. **[verified] The induced Redis outage fails readiness and recovery succeeds,
   but the failure response is 500 rather than the documented 503.** See
   `readiness-failure-recovery.json`, correlation ID `1a1f5f39`, and the unchanged
   route contract at `src/feed/server.ts:357`. **[inferred]** This concerns the
   existing error/rate-limit path; a baseline reproduction is needed to establish
   whether the response behavior predates the runtime change. No response-contract
   fix is folded into this runtime packet.
5. **[verified] The installed/virtual dependency-tree diagnostic discrepancy
   persists under npm 10.9.8.** Installed `npm ls --all @hono/node-server hono
   vitest adm-zip sharp --json` exits 1 with `adm-zip@0.6.1` invalid; the same
   command with `--package-lock-only` exits 0. All four canonical audits pass.
   This is not described as an npm bug or a security exception without further
   evidence. No dependency version, override, integrity entry, or audit policy
   was changed; `lockfile-invariance.json` proves only engine metadata changed.

## Implementation

**[verified]** `.nvmrc`, five package manifests, four lockfile metadata surfaces,
four npm configurations and the CI/deploy/docs/examples workflows align on Node
22.23.2. `scripts/check-runtime-contract.mjs:7` binds version, ABI and base-image
identity. `package.json:36` adds the actual runtime check before local full verify.

**[verified]** `Dockerfile:7` pins Bookworm slim to index digest
`sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5`.
Both installs retain lifecycle suppression. The build requires a 40-character
lowercase source revision, stamps the artifact, labels the image, creates UID
1001, and uses Node for the readiness probe. `.github/workflows/ci.yml:90` adds
an actual image build and native dependency probe without publishing an image.

The selected version is an official security release:
[Node 22.23.2](https://github.com/nodejs/node/releases/tag/v22.23.2).
The Darwin toolchain's signed checksum was verified with release key
`CC68F5A3106FF448322E48ED27F5E38D5B0A215F`; its archive SHA-256 is recorded in
`preimplementation-provenance.json`. Package engine admission follows
[npm's engine-strict configuration](https://docs.npmjs.com/cli/v11/using-npm/config/#engine-strict).

## Runtime Health Check

**[verified — personal execution]** Startup health passed and explicit-worktree
admission returned ALLOW with only the user-authorized PROJ-2228 WIP exceptions.
The original lease was `atl-566965bca06e5173`, fencing token 271.
Supported startup renewal returned healthpass and ALLOW with fencing token 272;
see `review-corrections.json`. The original contradictory
startup diagnostic inspected another checkout and omitted those exceptions;
it was corrected through the supported explicit-worktree admission command.

**[verified — personal execution]** Node 22.23.2 / npm 10.9.8 / ABI 127:

| Check | Result |
| --- | --- |
| Full `npm run verify` | Exit 0; 160 test files, 2,272 passed, 1 skipped; builds, legacy-web lint, and frontend static export pass |
| Four clean `npm ci --ignore-scripts` installs | 4/4 exit 0; zero EBADENGINE |
| Four canonical moderate-threshold audits | 4/4 exit 0 |
| Main-lock Node 20 negative control | Exit 1; EBADENGINE on @atproto/api requiring Node >=22 |
| Docker empty/short/multiline source negatives | All 3 rejected |
| Linux/arm64 production image | Builds; ONNX/Sharp load; UID 1001; ABI 127 |
| Disposable PostgreSQL migrations | 34 applied using the real migration runner |
| Application readiness | HTTP 200 against isolated PostgreSQL and two Redis services |

**[verified — independent QA report, not a second personal run]** Independent QA
initially passed 386 focused checks plus real npm positive and negative engine controls.
The reviewed candidate then passed 387 focused tests. See `independent-qa.md` and
`reviewed-candidate-qa.md` for commands, hashes and evidence ownership.

## Deterministic Eval

The pre-code expectations are retained in `qa-expectations-before-code.md`.
Builder findings were reviewed by Integration, repaired, and independently
checked by QA. `validation-summary.json` records exact commands, counts and log
hashes. Baseline and failed checks were preserved instead of converted to passes.

Reproduction requires Node 22.23.2/npm 10.9.8. Run four clean installs, then the
full `npm run verify`, and the canonical audit helper for each workspace. Tests
use only tracked `.env.example` values in the child environment; do not force
`NODE_ENV=development` into `next build`. A first harness attempt did so and failed
the frontend export. Removing that harness setting made full verification pass,
consistent with [Next.js environment behavior](https://github.com/vercel/next.js/blob/canary/docs/01-app/02-guides/environment-variables.mdx).
No application source fix was made for that harness mistake.

The existing Next.js config skips its own build-time lint/type checking; the full
verify result is the exact repository command above, not a claim that every
possible standalone checker ran. No model-inference benchmark or OS vulnerability
scan is claimed from native module loading or npm audits.

## Live Acceptance

**[verified — personal execution]** Commit
`c880755d234d15d1df290cecea0ac0d3315e9571` produced Linux/arm64 image
`sha256:64532fa96ce105f66bfd5bed951e17c1b71e9d70574c0e481d848258a4eecc72`.
Its stamp, OCI label, native modules, UID, ABI, 34 migrations and HTTP 200 readiness
passed; see `committed-b-acceptance.json`. Earlier image receipts retain their
provisional base-SHA stamps and are historical evidence only. The first migration
attempt hit the disposable PostgreSQL initialization race; verifying TCP readiness
before rerunning resolved it. The retained-artifact rollback rehearsal passed for exact commits `e4ff4bb` to
`c880755`: candidate-only network loss produced HTTP 500; retained B restored
HTTP 200 and its original revision in 2.816 seconds. See `rollback-committed.json`
and the pre-execution `rollback-expectations.md`. The application/schema were
unchanged between these revisions; this does not qualify changed-schema rollback.
The CodeQL correction changes the validation helper only; its next committed
image still requires separate exact-head validation.

The isolated application deliberately has no live Jetstream feed; `/health`
reports degraded while dependency-only `/health/ready` returns 200. No production
readiness, live feed parity, protected-host rollback, or deployment is inferred.

### Automation Summary

Local CodeRabbit corrections and rollback are complete. Two introduced CodeQL
findings were then corrected by replacing dynamic regular expressions with literal
instruction comparisons; full verify and 388 independent focused tests pass.
Next: rebuild the corrected committed image and clear exact-head hosted CI/review;
update Linear with the remaining protected-release gate. Keep the existing
PROJ-2087 owner informed of the Node patch and glibc image delta. Merge, deployment,
credentials and freeze changes remain excluded by the user's instruction.
