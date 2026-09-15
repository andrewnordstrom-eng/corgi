# PROJ-2228 expectations-first QA run card

Status: prepared before builder edits; read-only source observations only.

Target under test: one selected Node release, currently authorized as Node 22.23.2. The run must prove the selected version from the exact candidate rather than infer it from a package range. This card does not authorize merge, deployment, credential changes, freeze changes, or protected-host mutation.

## Current baseline observations

- `.nvmrc`, root `package.json`, `web/package.json`, Dockerfile, CI, and deploy currently target Node 20.19.0 or a floating Node 20 value.
- `cli/package.json` and `web-next/package.json` currently lack an explicit `engines.node` declaration.
- The root lockfile contains shipped `@atproto/*` entries declaring `>=22`; the current Node 20 target therefore has a meaningful incompatibility baseline.
- The deploy workflow already captures runner `NODE_MODULE_VERSION`, verifies `VALIDATED_SHA`, stamps the release archive, and has a guarded exact-SHA rollback path. Those existing protections must remain intact while the runtime version changes.
- The Docker health check targets `/health/ready`. Existing source tests inspect Docker and rollback contracts, but no existing test alone proves one runtime version across every workspace, CI workflow, container, and release artifact.

## Required pass/fail evidence

### Runtime and manifests

Pass only when `.nvmrc`, root/web/cli/web-next manifests, Docker builder and production stages, every in-scope CI/release workflow, and runtime verification all agree on Node 22.23.2 (or a separately documented exact selected version). A floating `20`, mixed major, missing workspace declaration, or unbound runtime is a fail.

For root, cli, web, and web-next, perform clean installs with engine strictness enabled and capture command, Node/npm versions, stderr, exit code, and log hash. Pass requires zero `EBADENGINE` text and exit 0. Add a blocking future-mismatch check: inject a controlled incompatible engine fixture or equivalent deterministic probe and require nonzero exit with an explicit engine diagnostic. Do not treat a successful install with warnings as pass.

### Meaningful Node 20 negative control

Run the same engine gate with Node 20.19.0 against the current `@atproto` lock graph. Pass for the negative control means the gate rejects the graph and records the `EBADENGINE` evidence. A Node 20 success, warning-only result, or a test that only scans arbitrary lockfile strings is a fail. Exclude optional platform entries such as win32-ia32 sharp from the Linux/Darwin target assertion; evaluate only actual target platform resolution and shipped runtime packages.

### Full verification and audits

Run the complete repository verification on Node 22.23.2, then run the canonical moderate-threshold audit for root, cli, web, and web-next after their clean installs. Record each workspace independently. Pass requires all four audits and full verification to exit 0; a known advisory must remain an explicit red result and cannot be hidden by changing the audit policy.

### SDK, CI, and release pins

Build the SDK, CLI, MCP path, root, web, and web-next under the selected runtime. Inspect every workflow under `.github/workflows`, including docs, examples, CI, and deploy, for exact runtime pinning and a blocking engine check. The existing floating `node-version: '20'` in `examples-build.yml` is an expected drift case until fixed or explicitly scoped out with evidence.

Release verification must bind the exact candidate SHA, selected Node version, npm version, runner ABI, package/install receipts, audit receipts, and archive digest. Pass requires the produced release stamp and digest to identify the same exact SHA used for build and verification.

### Linux container, image digest, and native ABI

Build the production image for the declared target platform on Linux/container infrastructure. Record the immutable image digest, platform/architecture, base image digest, `node --version`, `process.versions.modules`, and native module load probes for shipped native dependencies. Pass requires the image digest and ABI receipt to match the candidate and selected runtime; a Darwin-only build or host Node probe is insufficient.

Run production-shaped image smoke against the exact digest: start the image with public/test configuration, verify `/health/ready`, verify the release SHA exposed or recorded by the runtime, and exercise the minimum CLI/MCP/native startup paths relevant to the artifact. No production credentials or live host mutation are part of this run.

### Exact-SHA rollback boundary

A disposable Linux rehearsal may prove artifact-level rollback mechanics: promote candidate artifact A, retain known-good artifact B, force a bounded health failure, restore B, and verify the terminal receipt plus B's exact SHA and health. Pass requires no rebuild or dependency reinstall during rollback and an unambiguous `rolled_back` or explicit failure receipt.

Protected-host rollback, systemd/service restart, production image activation, and live traffic health are separate gated evidence. Do not claim them from local Darwin, a disposable container, source inspection, or CI text alone.

### Review gate

Pass requires no unresolved P0/P1 or HIGH/MEDIUM findings on the exact final candidate. Hosted review must be tied to the final source hash; local review or an earlier candidate is supporting evidence only.

## Evidence ownership and overlaps

- PROJ-2228 owns runtime selection/alignment, engine-strict enforcement, image/native/runtime evidence, and artifact rollback rehearsal.
- PROJ-2226 owns the dependency-audit baseline and must supply engine/advisory provenance without absorbing runtime activation.
- PROJ-2277 owns the canonical promotion audit policy; this work consumes that policy and must not add an allowlist or weaken thresholds.
- PROJ-2181 owns exact-SHA promotion and composite health; this work supplies a runtime-qualified candidate but does not promote it.
- PROJ-2225 owns release/docs freshness; runtime claims must be synchronized there without unrelated documentation scope.

## Claim boundaries

Report local Darwin, Linux-container, canonical CI, and protected-host evidence as separate rows. Do not use a green full verify, a clean virtual dependency tree, an image build, or a source contract as proof of production qualification. The final readiness statement must include exact candidate SHA, runtime/image digests, workspace receipts, negative Node 20 evidence, rollback boundary, and unresolved review/gate status.

## Runtime Health Check

Preparation only: acceptance requires separate source-bound runtime evidence. No runtime pass was declared when this plan was written.

## Deterministic Eval

The pass/fail expectations above were prepared before implementation; execution results are recorded separately.

## Live Acceptance

Protected-host deployment and production rollback are outside the authorization. Local container evidence must remain explicitly local.

### Automation Summary

Builder, Integration, then independent QA are required. This plan schedules no deployment or recurring automation.
