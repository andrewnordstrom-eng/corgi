# Production host identity adoption

Status: PROJ-2268 repository-only design. Nothing in this document authorizes
an SSH connection, production mutation, deployment, migration, or service
restart.

## Decision

The application keeps `/opt/bluesky-feed` owned and writable by the deployment
user so the immutable-artifact workflow can swap reviewed releases. The
`bluesky-feed` process runs as a separate `bluesky-feed:bluesky-feed` system
identity with `/usr/sbin/nologin`, no supplementary groups, and no Docker
access. The systemd manager reads the root-only environment before starting the
unprivileged process; neither non-root identity receives direct `.env` access.

The production environment target is:

```text
/opt/bluesky-feed/.env  root:root  0600  regular file, never a symlink
```

The deployment user loses its existing unrestricted passwordless-sudo rule. It
receives one replacement target:

```text
DEPLOY_USER ALL=(root) NOPASSWD: /usr/local/sbin/corgi-deploy-root
```

That executable is installed root-owned and mode 0755. It does not evaluate
caller text. Its closed dispatcher fixes each executable, systemd unit,
container, SQL statement, Redis command, and Redis configuration key. The only
dynamic value is a demo-session Redis key matching
`demo:session:demo-[A-Za-z0-9_-]{1,128}`.

## Reviewed command surface

| Token | Fixed privileged operation |
| --- | --- |
| `service-user` | Read the `User` property of `bluesky-feed` |
| `service-group` | Read the `Group` property of `bluesky-feed` |
| `service-main-pid` | Read the `MainPID` property of `bluesky-feed` |
| `service-is-active` | Check that `bluesky-feed` is active without output |
| `service-state` | Print the active state of `bluesky-feed` |
| `service-restart` | Restart only `bluesky-feed` |
| `service-can-read-entrypoint` | Prove the service user can traverse to and read the fixed production entry point |
| `postgres-ingestion-signals` | Run one fixed, read-only cursor/newest-post query in `bluesky-feed-postgres` |
| `demo-redis-ping` | Ping only `bluesky-feed-demo-redis` |
| `demo-redis-exists KEY` | Read one validated demo-session key from demo Redis |
| `production-redis-exists KEY` | Read the same validated demo-session key from production Redis |
| `demo-redis-maxmemory-policy` | Read one fixed demo Redis configuration value |
| `demo-redis-maxmemory` | Read one fixed demo Redis configuration value |
| `demo-redis-appendonly` | Read one fixed demo Redis configuration value |
| `demo-redis-save` | Read one fixed demo Redis configuration value |

The wrapper uses an empty environment with a fixed `PATH`, locale, and home.
Every container call has a 15-second outer deadline. Arbitrary `systemctl`,
`docker`, `docker exec`, shell, SQL, Redis, file, and service names are rejected.
After each candidate install and rollback restore, the workflow grants only
read/traverse bits on the fixed runtime-artifact paths and asks the wrapper to
prove `bluesky-feed` can read `/opt/bluesky-feed/dist/index.js` before restart.

## Reviewable execution vehicle

`ops/provision-corgi-host-identity.sh` is the only supported vehicle. It has
five modes:

1. `plan` is local and non-privileged. It describes the boundary without
   contacting a host.
2. `preflight DEPLOY_USER BROAD_SUDOERS_PATH` is read-only. It prints only file
   metadata and SHA-256 digests for the existing unit and broad sudoers file;
   it never reads or prints `.env` contents.
3. `apply` requires the exact observed digests, the exact reviewed repository
   SHA, and the literal confirmation phrase. It backs up the unit, sudoers
   policy, and numeric `.env` metadata before mutation. A versioned journal is
   armed before state creation and records `create-pending` before each account
   or group mutation so interrupted identity setup remains reversible.
4. `verify DEPLOY_USER` proves the allow/deny matrix and active process
   identity without restarting anything.
5. `rollback DEPLOY_USER CONFIRM-CORGI-HOST-IDENTITY-ROLLBACK` restores the
   pinned prior unit, sudoers file, and `.env` ownership/mode, restarts the
   restored service, and removes only identities created by the script.

Apply refuses a dirty or wrong-head checkout, changed unit/sudoers hashes,
symlinks, foreign file owners, an inactive starting service, pre-existing
managed paths, malformed state, or an unexpected account shape. If an error
occurs after durable state is written, the guarded exit trap attempts the same
rollback path. A repeated successful `apply` runs verification and reports that
the contract is already applied.

## Future execution sequence

The following sequence is intentionally blocked until Andrew separately names
and approves the reviewed exact head for production execution.

```sh
sudo ops/provision-corgi-host-identity.sh preflight DEPLOY_USER /etc/sudoers.d/EXISTING_POLICY

sudo ops/provision-corgi-host-identity.sh apply \
  DEPLOY_USER \
  /etc/sudoers.d/EXISTING_POLICY \
  OBSERVED_SUDOERS_SHA256 \
  OBSERVED_UNIT_SHA256 \
  APPROVED_REPOSITORY_SHA \
  CONFIRM-CORGI-HOST-IDENTITY-ADOPTION

sudo ops/provision-corgi-host-identity.sh verify DEPLOY_USER
```

Preflight output must be reviewed before apply. A digest or path change requires
a new review; it must not be worked around by substituting a broader path or
weakening the script.

## Positive and negative acceptance

Positive verification requires the installed unit and wrapper to match the
reviewed sources, the service to be active, systemd `User`/`Group` to equal the
dedicated identity, the active `MainPID` UID/GID to match, the narrow sudoers
file to validate, and the deployment user to execute the fixed identity probe.
The production deploy workflow exercises the remaining fixed read-only probes
and the one service restart during a separately approved promotion.

Negative verification proves:

- deployment user cannot read or write `.env`;
- service user cannot read `.env` or write `/opt/bluesky-feed`;
- neither user is in the Docker group;
- deployment user cannot run `sudo -n /usr/bin/true`;
- an unknown dispatcher token fails;
- workflow policy contains no direct privileged `systemctl` or `docker` call.

Tests do not attempt an unauthorized restart merely to prove denial. The
root-owned allowlist and sudoers shape establish that boundary statically.

## Rollback and dependencies

Rollback restores privilege and service state in this order: restore the prior
sudoers policy, remove the narrow rule, restore the prior unit and `.env`
metadata, reload systemd, restart the restored unit, remove the dispatcher, and
delete the service account/group only if the state proves this script created
them and no process remains. Backups are SHA-256 verified before use. The state
directory is mode 0700 and its files are root-owned mode 0600.

Before execution, confirm that the deployment SSH session remains usable and
that a separate root recovery path exists. After rollback, PROJ-2258 remains
blocked until a new successful adoption. No current workflow may dispatch
while adoption or rollback is in progress.

## Sources

- [systemd execution environment](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html)
- [OpenSSH portable source and forced-command behavior](https://github.com/openssh/openssh-portable)
- [sudoers command matching](https://www.sudo.ws/docs/man/1.9.14/sudoers.man.pdf)
- [NIST SP 800-53 Rev. 5 controls](https://csrc.nist.gov/Projects/risk-management/sp800-53-controls/downloads)
- Saltzer and Schroeder, [The Protection of Information in Computer Systems](https://doi.org/10.1109/PROC.1975.9939)
