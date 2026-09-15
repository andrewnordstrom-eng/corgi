# PROJ-2228 CR round 1 rollback harness QA

## Source binding

- Worktree: `/private/tmp/proj-2228-corgi-runtime`
- HEAD at review: `ed3ade2a4f3487c34cdfaad8d55d64832462e944`
- `rollback-committed.py` SHA-256: `9e2b3f3ff60a121144b9f6e4901f98b4d878ce2a67c4fb917ec18c39712891d0`
- `test_rollback_committed.py` SHA-256: `b209ecd6da3b9fabb33bf1537fa73c44eced0818cd79d6554600282704db56cf`

## Controlled validation

Command:

```text
python3 -m unittest -v ops/receipts/2026-09-14/PROJ-2228/test_rollback_committed.py
```

Result: exit 0; 6 tests passed in 0.001s. Output SHA-256: `8447486e8284b60c26f7bb714e956dfa2aff1eef28cef5d3575bcdb0abb33671`.

Covered and passed: finite timeout propagation to inspect/stop/start; timeout redaction; run timeout plus inspect timeout preserving the run error; no known-good start when candidate stop fails; candidate stop then known-good start ordering; known-good start timeout receipt.

## Independent main-path probe

A temporary in-memory mocked invocation of `main()` induced a primary candidate-run failure and a candidate-stop timeout during recovery. It returned exit code 1, retained the primary `RuntimeError` in `record.error`, recorded `recovery_errors`, and did not call `start B` after stop-A failed. No Docker was invoked.

## Verdict

PARTIAL for the written controlled harness expectations. The six recorded tests passed, but readiness-timeout and network-disconnect failure fixtures were missing; the earlier PASS wording overstated matrix completion. Corrected during review round 2 on 2026-09-15. Historical commands, counts, and hashes above remain unchanged. The implementation’s `main()` also preserves primary failure and makes recovery failure nonzero under the probe. This is local mocked evidence only; parent’s real Docker rehearsal remains required for retained-image identity/readiness/native/migration and production-controller rollback claims.

## Runtime Health Check

Evidence ownership and runtime are recorded above.

## Deterministic Eval

Use the commands and hashes above; results apply to the current uncommitted candidate.

## Live Acceptance

Protected-host and production claims remain outside this packet.

### Automation Summary

Complete exact committed image validation and hosted review before release handoff.
