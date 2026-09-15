# PROJ-2228 CodeRabbit round 1 repair expectations

This is an expectations-first card. It does not approve implementation changes, Docker execution, deployment, or production qualification.

## Rollback wrapper safety

Every Docker operation in the bounded rollback wrapper must have a finite timeout, including network/container inspection, candidate and known-good stop/start, readiness probes, network disconnect, and cleanup/finally operations. A timeout must produce a bounded, diagnosable error rather than hanging the host process.

If stopping A fails or times out, the wrapper must not start B. The primary A-stop failure must remain the reported error, and the terminal receipt must remain unresolved/failed rather than claiming restoration.

If cleanup or recovery fails after a primary failure, the process must exit nonzero and retain the primary failure plus recovery failure details in a safe receipt. Recovery errors must not replace a primary error, turn the run green, or leak environment values, credentials, command output containing secrets, or arbitrary container environment.

Pass evidence should include deterministic bounded-failure fixtures for: inspect timeout, stop-A timeout/failure, start-A timeout/failure, readiness timeout, network-disconnect failure, stop-A cleanup failure, and start-B recovery failure. Each case must prove terminal status and error precedence.

## Runtime contract npmrc cardinality

The runtime checker must require exactly one `engine-strict=true` directive in each intended npmrc source/stage. It must reject missing directives, two directives, contradictory values, whitespace variants that create duplicate directives, and builder/production Docker stages that do not each carry exactly one effective directive. A valid single directive must continue to pass.

The test mutations must independently cover builder-only omission, production-only omission, duplicate builder directive, duplicate production directive, and contradictory values. A generic source substring count is insufficient if stage placement or effective npm behavior can differ.

## npm cooldown finding

The cooldown finding remains open pending parent-owned primary-source research and the exact npm version used by the candidate. Do not remove the cooldown or claim it is enforced merely because a test fixture passes. Acceptance requires:

1. A primary npm source or executable behavior probe for the supported npm version.
2. A reproducible test showing the relevant cooldown behavior and boundary.
3. A clear distinction between registry/network retry behavior, package-install retry behavior, and wrapper-level retry behavior.
4. Evidence that the selected setting is actually honored by the invoked npm executable in CI/container/runtime contexts.

Until that evidence exists, preserve the finding as unresolved or explicitly bounded, with no release-readiness claim based on its removal.

## Verdict rules

Round 1 repair validation is PASS only if all rollback failure-ordering/timeout cases and runtime npmrc cardinality cases pass, and the npm cooldown finding has a documented evidence-backed disposition. A green ordinary rollback path or source-only assertion does not satisfy the failure-path requirements. Production qualification, protected-host behavior, and deployment approval remain separate gates.

## Runtime Health Check

Evidence ownership and runtime are recorded above.

## Deterministic Eval

Use the commands and hashes above; results apply to the current uncommitted candidate.

## Live Acceptance

Protected-host and production claims remain outside this packet.

### Automation Summary

Complete exact committed image validation and hosted review before release handoff.
