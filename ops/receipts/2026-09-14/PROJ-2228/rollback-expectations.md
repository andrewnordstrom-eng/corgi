# PROJ-2228 bounded local retained-image rollback expectations

This run card covers local artifact rollback mechanics only. It does not authorize or prove production controller behavior, protected-host service activation, live traffic health, or compatibility of changed application/schema code.

## Fixed identities

- Known-good B commit: `c880755d234d15d1df290cecea0ac0d3315e9571`
- Known-good B image ID: `sha256:64532fa96ce105f66bfd5bed951e17c1b71e9d70574c0e481d848258a4eecc72`
- B baseline already observed: readiness HTTP 200, exact revision, native UID identity, 34 migrations.
- Candidate A: the documentation/evidence-only follow-up commit, built and stamped with its exact SHA. Application code and schema are expected to remain unchanged relative to B.

## Required sequence

1. Retain B by immutable image ID before any A action. Record the image ID, repository/tag if present, container ID, revision, native UID, migration count, and readiness response.
2. Stop the existing B container only as needed for the bounded local rehearsal. Do not delete the image or resolve B through a mutable tag.
3. Start A from its exact immutable image identity and record image ID, container ID, exact stamped revision, native UID, migration count, and network membership.
4. Verify A is healthy and identifies as A before fault injection. A healthy result must include HTTP 200 readiness and exact revision identity.
5. Induce an A-only failure by disconnecting A from the internal disposable network. The fault must not alter the retained B image or shared host state.
6. Assert that A readiness becomes non-200 or otherwise fails within the bounded health timeout, and capture the failure evidence.
7. Stop/remove only the failed A container as required by the local harness. Restore B from the retained immutable image ID without rebuild, dependency reinstall, registry pull, or mutable-tag lookup.
8. Verify restored B readiness HTTP 200 and exact B revision, image ID, native UID, and 34-migration identity. Record the terminal rollback result.

## Pass/fail matrix

| Check | Pass | Fail |
|---|---|---|
| B retention | B image ID remains available and equals the recorded immutable digest | B is rebuilt, pulled, deleted, or resolved only through a mutable tag |
| A identity | A container and release stamp match A’s exact SHA before fault injection | SHA, image ID, native UID, or migration identity is ambiguous |
| A fault isolation | Only A is disconnected from the disposable internal network | B, host services, credentials, or external/protected networks are changed |
| A failure | A readiness becomes non-200 within the bounded timeout | A remains healthy, timeout is unbounded, or failure is inferred without a response |
| Rollback action | B is restarted from retained image ID with no build, install, or network fetch | Any rebuild, dependency install, image pull, or mutable-tag resolution occurs |
| B restoration | B returns HTTP 200 and exact recorded revision/image/native UID with 34 migrations | Any identity mismatch, readiness failure, migration drift, or unresolved receipt |
| Terminal evidence | Receipt names A failure and B restoration, with timestamps and digests | Only logs or container names are recorded without immutable identity |

## Claim boundary

A pass demonstrates that this local harness can retain an immutable known-good image, detect an induced candidate-only readiness failure, and restore the known-good image without rebuilding or fetching it. It does not demonstrate production orchestration, protected-host rollback, systemd behavior, live traffic recovery, controller policy, or changed-code/database compatibility. Because A is application/schema-equivalent to B, the rehearsal also does not qualify rollback across a changed application or migration boundary.

## Missing expectation to resolve before execution

The parent should record the exact A image digest and container/network identifiers before fault injection, and should confirm the disposable network name is isolated from protected or production resources. If either is unavailable, stop before inducing failure and report the rehearsal as not executable rather than substituting tags or inferred identity.

## Runtime Health Check

Verify candidate and retained image identities before fault injection.

## Deterministic Eval

Apply the pass/fail matrix above.

## Live Acceptance

This plan covers only the isolated local rehearsal.

### Automation Summary

Execute only after recording both immutable identities and network membership.
