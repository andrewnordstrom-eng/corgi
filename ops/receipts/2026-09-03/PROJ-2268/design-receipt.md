# PROJ-2268 repository design receipt

## Runtime Health Check

Production was not contacted. Repository-only validation runs the script plan,
shell syntax checks, and workflow policy tests without SSH, sudo, systemd, or
Docker mutation.

## Deterministic Eval

Repository validation completed successfully on the issue branch:

- `bash -n ops/corgi-deploy-root ops/provision-corgi-host-identity.sh`
- `shellcheck ops/corgi-deploy-root ops/provision-corgi-host-identity.sh`
- `actionlint .github/workflows/deploy.yml`
- `git diff --check`
- `npm run docs:verify` (15 tracked docs; 38 Markdown files scanned)
- `npm run build`
- focused Vitest policy run (2 files; 386 tests)
- `npm run verify` (158 test files; 2,177 tests; CLI, SDK, web lint/build,
  and Next production build)

Every command exited zero. The final Git commit is intentionally not
self-recorded in this immutable receipt; the reviewed exact head must be named
in the later production-authorization record.

## Live Acceptance

Deferred by authorization boundary. Live preflight, adoption, positive and
negative host tests, and rollback rehearsal require a separate founder approval
naming the reviewed exact commit. No key, account, `.env`, sudoers file, unit,
service, container, GitHub environment, deploy control, or freeze was changed.

### Automation Summary

- Packet: PROJ-2268
- Canonical repository: `https://github.com/andrewnordstrom-eng/corgi`
- Rename evidence (verified 2026-09-04): GitHub resolves both the canonical
  slug and legacy `andrewnordstrom-eng/bluesky-community-feed` slug to
  repository ID `1151738081` / node ID `R_kgDORKYg4Q`.
- Approval reference: the founder-authored 2026-09-04 `[APPROVED]` comment on
  PROJ-2268 authorizes this repository-only implementation, and PROJ-2268
  attaches PR #406 at the canonical `andrewnordstrom-eng/corgi` remote.
- Repository phase: admitted with founder-approved WIP-cap overrides
- Starting main: `c703244da266679a289109871920d0320f14ebf3`
- Production contact: none
- Production mutation: none
- Deployment: none
- Admin bypass: none
- Exact-head execution approval: required and not yet granted
