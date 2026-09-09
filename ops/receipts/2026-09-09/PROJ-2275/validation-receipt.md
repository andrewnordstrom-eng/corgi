# PROJ-2275 dependency candidate — partial validation

Status: **Not release-ready. One known advisory remains unresolved.**

The candidate is based on Corgi main
`a09edeafaf085121d1340a543874de6362e1e42a`. It is separate from operational PR
[#411](https://github.com/andrewnordstrom-eng/corgi/pull/411), which remains draft
at `cb6e2f8f3c697ad626083cac611b64b59ce424c2`.

## Scope and authorization

The owner approved the PROJ-2275-only project/global capacity exception.
Admission returned ALLOW and recorded the four manifest/lock paths plus this
receipt directory. Research passed all six required source classes without an
exemption. The issue is In Progress. No audit, review, freeze, merge, or production
gate was bypassed.

On 2026-09-09 the owner explicitly authorized committing this partial candidate
and opening a dependency-repair draft PR with these receipts. This publication
authorization does not authorize merging to main or changing deployment.

## Dependency changes

| Selected dependency | Before | Candidate |
| --- | --- | --- |
| Hono override | 4.13.1 | 4.13.7 |
| Vitest | 4.1.10 | 4.1.11 |
| sharp override, root and Next.js | 0.35.3 | 0.35.4 |
| Next.js and matching eslint-config-next | 15.5.23 | 15.5.25 |
| js-yaml, Next.js override | 4.3.1 resolved | 4.3.2 |

The accompanying native binaries, libvips packages, Vitest packages and affected
transitive dependencies are enumerated in `dependency-version-changes.json`.
adm-zip remains 0.6.0. No application source, CI policy, allowlist, or runtime
configuration changed. Lockfiles were generated with npm 11.12.1, preserving
glibc/musl platform metadata that npm 10 omitted during the initial generation.

## Deterministic Eval

All four shipped workspaces passed clean `npm ci --ignore-scripts` installs.
Root and Next.js were clean-installed again after final lockfile generation.
The unchanged CLI and legacy-web lockfiles were also installed independently.

Full `npm run verify` passed: documentation verification, backend TypeScript,
159 test files with **2,257 passing tests and one skip**, CLI, local MCP, SDK,
external-component fixture, legacy-web lint/build, and Next.js 15.5.25 production
build. The fresh checkout initially lacked CI's example configuration; the final
run supplied the tracked public `.env.example` values through a child-process
environment, allowing each build/test tool to set its own NODE_ENV. No production
configuration or credential was used.

Canonical moderate-threshold audits:

| Workspace | Result |
| --- | --- |
| Root | FAIL: only GHSA-vwc7-r8mq-g2x9 remains |
| CLI | PASS |
| Legacy web | PASS |
| Next.js web | PASS |

Eight of the nine previously identified unique advisory IDs are cleared. The
root gate reports the single remaining advisory through adm-zip, ONNX Runtime,
and Transformers; those package paths are not three distinct advisory IDs.
Candidate-file hashes and local validation-log hashes are in
`validation-summary.json`; production-only results are recorded separately.

## Runtime Health Check

Native smoke on macOS arm64 / Node 20.20.2 passed actual PNG generation and
cross-workspace resizing/pixel verification using sharp 0.35.4 and libvips 8.18.6.
The ONNX native module loaded and Transformers imported successfully. This is not
an embedding-model inference benchmark or Linux production qualification.
Production runtime health was not requalified by this dependency candidate.

## Live Acceptance

Live release acceptance is **pending**. This receipt records partial local
validation and does not claim deployment or complete remediation.

[GHSA-vwc7-r8mq-g2x9](https://github.com/advisories/GHSA-vwc7-r8mq-g2x9)
still has no published patched version. The
[upstream proposal](https://github.com/cthackers/adm-zip/pull/575) was open and
unmerged during this investigation. Skipping ONNX's CUDA download does not remove
its npm adm-zip dependency. Do not suppress the advisory or treat an unpublished
fork as a supported release.

CodeRabbit CLI completed review of exactly the four uncommitted dependency files
with **zero findings**, exit 0. Candidate hashes remained unchanged throughout
that review. Lease validation and tracked-path scope checks passed. This local
review does not establish hosted validation or exact-head approval for a complete
repair; those remain pending.
Linux native validation is also pending; the only cached local Node image was
version 18, which is below the project's supported runtime.

Full remediation remains blocked. The draft PR must retain that status until
a supported remedy or separately reviewed risk decision resolves the remaining
advisory and the outstanding acceptance checks pass.

Production-only audits also passed for CLI, legacy web and Next.js. Root has
three affected package records but only the same single unique adm-zip advisory;
there are no high or critical findings in those production audit results. No
advisory was suppressed. See `production-audits.json`.

### Automation Summary

Local verification and the bounded CodeRabbit CLI review completed as recorded
above. Hosted checks and hosted review of the published commit remain pending.
The machine-readable summary describes the local validation snapshot, including
the failed root audit. This is a partial draft publication, not issue closeout.
No merge, deployment, workflow change, audit exception, or modification to
operational PR #411 is included.
