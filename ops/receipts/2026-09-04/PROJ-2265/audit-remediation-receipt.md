# PROJ-2265 dependency remediation validation

Validation date: 2026-09-05
Base revision: `c703244da266679a289109871920d0320f14ebf3`

## Runtime Health Check

Repository validation used Node.js 20.19.0. The backend TypeScript build passes after numeric `TRUST_PROXY` hop counts were replaced with an explicit `TypeError` and migration guidance. IP/CIDR, named ranges, boolean aliases, and address lists retain their existing behavior.

No production endpoint, host, configuration, deployment, or freeze state was inspected or changed. Any deployed numeric `TRUST_PROXY` value requires migration to an explicit trusted proxy address or range before rollout.

## Deterministic Eval

- Final `npm run verify`, after the environment example correction and hosted-review CIDR coverage addition: PASS with public `.env.example` values supplied to the process, excluding `NODE_ENV` so Vitest and Next.js select their normal modes. This includes docs verification, backend build, 157 test files / 2,156 tests, CLI build, SDK build and fixture compilation, legacy frontend lint/build, and Next.js static export.
- The existing `build:mcp-local` command reports that the optional `src/mcp-local` directory is absent and skips its build; no new skip was introduced.
- Security defaults coverage includes six numeric forms and trusted/untrusted peer injection cases with the installed Fastify package. The final full suite also exercises `10.0.0.7` against the trusted `10.0.0.0/8` entry, retaining the original localhost and nonmatching-peer assertions.
- All four shipped workspace moderate-threshold audit guards: PASS (root, CLI, web, web-next).
- All four raw `npm audit --omit=dev --audit-level=moderate` checks: PASS, zero reported vulnerabilities.
- Earlier candidate clean installs under Node.js 20.19.0 passed in all four workspaces; manifests and lockfiles were unchanged during this compatibility repair.
- `git diff --check`: PASS.
- Audit guard is byte-identical to the base; SHA-256 `8279603234edd2284d4bbf24f2969940ae2d1c9bfbf298f6eff1d20f04c9bc8e`.

The initial reproduction failed with TS2769 at `src/feed/server.ts` because the parser returned `number` while Fastify 5.12.1 no longer supports it. The final build succeeds and numeric configurations throw before Fastify construction. Real injection tests verify that untrusted immediate peers cannot override forwarded IP, host, or protocol, while trusted peers retain that behavior.

Two validation harness failures were resolved without product changes: the sandbox denied localhost listeners (`listen EPERM`), and exporting development `NODE_ENV` into Next.js caused a prerender failure. The final full run permitted local test networking and let each tool select its standard mode.

## Live Acceptance

Local CodeRabbit review completed with no high or medium findings. Its single trivial suggestion was an additional trusted-CIDR test. Hosted review repeated that coverage request at comment 3940272617; the final candidate adds the matching CIDR peer case and passes full validation. Independent candidate review reported no concrete bypass or regression.

Hosted CI passed on the preceding `7fccb6c2b51d8a21fc8341388ed5550ef6bd100c` head, including backend/frontend verification and CodeQL. New-head hosted checks and exact-head review remain pending after the CIDR coverage addition. The active PROJ-2087 emergency-only main-freeze rule remains a separate normal-merge blocker. This receipt does not establish merge, deployment, or production readiness.

### Automation Summary

The candidate contains the targeted dependency upgrades/lockfile refreshes, numeric proxy compatibility repair, regression coverage, and changelog migration guidance. Audit exceptions remain unchanged.

The authorized comment-only correction to `.env.example` removes the unsupported `"1"` example and directs numeric hop-count users to a trusted proxy IP or CIDR. The actual `loopback` default is unchanged.

The initial environment-example admission block was resolved by PROJ-2269, merged through org-infra PR #761 at `a37d8f62dc6e2a544e299801536aee39159668a3`. The actual shared control-plane checkout was refreshed to that revision through `control-plane-sync`. PROJ-2265 then renewed lease `atl-f5ae4ea288af34a2` at fencing token 247 with the explicit `.env.example` path and normal WIP gates enforced. The PROJ-2269-only WIP exception was not carried into this renewal. Final workspace audit guards passed again after the correction.
