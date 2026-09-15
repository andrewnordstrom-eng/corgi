# PROJ-2228 CR round 1 Node 22 QA — corrected candidate

Base `ed3ade2a4f3487c34cdfaad8d55d64832462e944` is reference only; the candidate remains uncommitted. Current binary diff SHA-256: `9fdd45ba282416bb1607b7ab487940111bb3b4508fc7825f8a7ed3d2481c02b5`.

Current source hashes:

- `tests/demo-shadow-isolation.test.ts`: `90e58bf795be3e55af0bd262f08104a79fd254bf12ce6313551b7049483eba08`
- `.github/workflows/deploy.yml`: `b793f952692062acbddc5c9c0094ee1fc93613ba14d8f1b4c04bb0ece152ad6d`
- `scripts/check-runtime-contract.mjs`: `79de8db09ef096d42ca0e78dd7df46ef8382d978d2f30eb47656f4ce343fc51b`
- `tests/runtime-contract.test.ts`: `f353f12db4bb89add24867f5f8fb791f342b94f8741c703c451472786a834b0a`

With Node `v22.23.2` first on PATH and the public `.env.example` parsed into the child environment, the focused command:

```text
npm exec vitest run tests/runtime-contract.test.ts tests/demo-shadow-isolation.test.ts --reporter=verbose
```

completed **exit 0: 2 files passed, 400 tests passed**. The available bundled npm was `10.9.8`; parent-owned npm 11.19.1 clean-install evidence is separate. Log SHA-256: `b76c4aa8ab900e15f322c8bdd2ff4f786f2dae91b35f2474662dc74071649b46`.

The corrected guard permits only the exact runner-side `npm install --global --ignore-scripts npm@11.19.1`; it rejects the same bootstrap in the remote script, version/argument drift, missing `--ignore-scripts`, and prefix overrides. No Docker or tracked edits were performed. Production/protected-host rollback remains out of scope.

Additional direct runtime CLI check used the verified npm 11.19.1 toolchain path:

```text
PATH=/private/tmp/corgi-2228-toolchain/npm-11.19.1/node_modules/.bin:/private/tmp/corgi-2228-toolchain/node-v22.23.2-darwin-arm64/bin:$PATH node scripts/check-runtime-contract.mjs
```

Result: **exit 0**, `runtime-contract: PASS node=22.23.2 abi=127 npm=11.19.1`. The focused Vitest run used the bundled npm 10.9.8; this direct CLI validation confirms the actual pinned npm 11.19.1 path. Log SHA-256: `6841166c0e519f367fd49f98f6e29a9d71917ded8d3d111319bf5c550c2286f1`.

## Runtime Health Check

Evidence ownership and runtime are recorded above.

## Deterministic Eval

Use the commands and hashes above; results apply to the current uncommitted candidate.

## Live Acceptance

Protected-host and production claims remain outside this packet.

### Automation Summary

Complete exact committed image validation and hosted review before release handoff.
