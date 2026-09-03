# Least-privilege scheduled operations principal

Status: PROJ-2258 Phase A design packet. Nothing in this document authorizes a
production connection or mutation.

## Decision

Use a dedicated `corgi-operations` Linux account for scheduled health
observations. The account has a locked password, primary group
`corgi-operations`, no supplementary groups, and is specifically absent from
the `docker` and `sudo` groups. Its home is `/var/lib/corgi-operations`, owned
by root and not writable by the account.

The account uses `/bin/sh` only because OpenSSH invokes a forced command through
the account shell with `-c`. Interactive use is denied by the authorized-key
options and the dispatcher. `/usr/sbin/nologin` is not suitable here because it
would prevent the forced command from running too.

The authorized key is one Ed25519 key with this prefix:

```text
restrict,command="/usr/local/sbin/corgi-operations-command" ssh-ed25519 <public-key> <comment>
```

`restrict` disables PTY allocation, agent/X11/port forwarding, and user rc
processing. The root-owned dispatcher rejects an empty command and every
command not exactly equal to one of the four tokens below. It does not evaluate
arguments or invoke a caller-supplied shell fragment.

## Key custody

The Phase B operator generates a new Ed25519 pair for this principal. It must
not reuse the deployment key.

The reviewed generation shape is:

```sh
key_dir="$(mktemp -d)"
chmod 700 "$key_dir"
ssh-keygen -q -t ed25519 -N '' -C corgi-production-operations \
  -f "$key_dir/id_ed25519"
```

The comment is intentionally a single token because the provisioning script
accepts only the key type, key blob, and at most one comment field.

- Private half: stored only as the `PRODUCTION_OPERATIONS_SSH_KEY` secret in
  the future GitHub `production-operations` environment. A trusted operator may
  use a mode-0600 temporary file during generation and secret upload, then must
  remove it. A workflow writes it only to an ephemeral runner file under
  `$RUNNER_TEMP`, mode 0600, and deletes it on every exit.
- Public half: installed only in the root-owned
  `/var/lib/corgi-operations/.ssh/authorized_keys`, mode 0600, with the
  restriction prefix above. Its SHA256 public-key fingerprint—not the key
  body—is recorded in the Phase B receipt.
- Host identity: the server's existing OpenSSH host key remains a separate
  trust object in `PRODUCTION_OPERATIONS_SSH_HOST_KEY`. It is never inferred
  with `accept-new`.

After Phase B installs the public half and uploads the private half with a
non-printing `gh secret set PRODUCTION_OPERATIONS_SSH_KEY
--env production-operations < "$key_dir/id_ed25519"`, the operator removes
`$key_dir`. The receipt records the fingerprint produced from
`id_ed25519.pub`, never either key body.

The environment also needs `PRODUCTION_OPERATIONS_HOST`, fixed user value
`corgi-operations`, and a dedicated `PRODUCTION_OPERATIONS_DATABASE_URL`.
That database credential is a PostgreSQL login restricted to `CONNECT`,
`USAGE` on the application schema, and `SELECT` on `governance_epochs` and
`subscribers`, the only tables read by `epoch status --direct`. It is passed as
one newline-terminated stdin record to `epoch-status`; it is never placed in an
SSH command argument or stored on the host. Creating that database role and
credential is a Phase B production mutation and is not performed in Phase A.

## Exact daily-health command surface

| SSH token | Executed host command | Privilege |
| --- | --- | --- |
| `epoch-status` | clean environment plus `/usr/bin/timeout --foreground 15s /usr/bin/node /opt/bluesky-feed/cli/dist/index.js epoch status --direct --json`; the dedicated read-only database URL arrives on stdin | `corgi-operations` |
| `disk-root` | `/usr/bin/df -P /` | `corgi-operations` |
| `health-ready` | `/usr/bin/curl --fail --silent --show-error --max-time 10 http://127.0.0.1:3001/health/ready` | `corgi-operations` |
| `feed-updated-at` | `/usr/bin/sudo -n -- /usr/local/libexec/corgi-read-feed-updated-at` | one fixed sudo target |

The Redis helper is root-owned and contains only:

```text
/usr/bin/timeout --foreground 15s /usr/bin/docker exec bluesky-feed-redis redis-cli --raw GET feed:updated_at
```

The only sudoers entry is:

```text
corgi-operations ALL=(root) NOPASSWD: /usr/local/libexec/corgi-read-feed-updated-at
```

This avoids Docker group or socket access. Docker documents that the `docker`
group grants root-level privileges; the wrapper fixes both the container and
the Redis command/key instead. The CLI direct database pool additionally fixes
the PostgreSQL connection timeout at five seconds, server statement timeout at
five seconds, and client query timeout at seven seconds. The outer 15-second
deadline bounds startup, cleanup, and any failure outside the database driver.

## Weekly export is not part of this privilege grant

The existing weekly job reads `BOT_*` or `BSKY_*` application passwords from
`/opt/bluesky-feed/.env`, creates an isolated CLI session, writes two plaintext
CSV files under a unique remote `/tmp` directory, copies them, and removes the
session and temporary files. The production admission contract now requires
`.env` to be root-owned and unreadable by non-root. Granting `corgi-operations`
read access would undo that control, and adding a broad root export wrapper
would make the operations key an application-credential exfiltration path.

PROJ-2258 therefore does not make weekly export work and does not treat its
15-plus-week failure as a regression. Follow-up PROJ-2261 must implement a
server-side export job with a single fixed operation: the application service
reads its own credentials, creates the export in a root/service-owned run
directory, returns only the two expected files (or an encrypted archive), and guarantees session
and plaintext cleanup on every exit. A dedicated export credential is an
acceptable fallback only if it is scoped to export APIs, independently
revocable, never stored in `.env` readable by the operations user, and proven
unable to call non-export admin surfaces. Repository secret copies cannot be
retired while weekly export remains red.

## Phase B verification matrix

`ops/provision-corgi-operations-principal.sh apply PUBLIC_KEY_FILE` is the only
installation vehicle. It is idempotent: a repeated run validates the existing
account shape, overwrites only the four managed files with reviewed content,
validates sudoers before installation, and reruns local policy verification.

Positive tests, run through `acceptance`, require all four exact tokens to
succeed:

1. `epoch-status` returns JSON using the dedicated read-only database login.
2. `disk-root` returns POSIX `df` output.
3. `health-ready` returns a non-empty loopback readiness response.
4. `feed-updated-at` successfully performs the fixed Redis read; an empty key
   value is data, not authorization failure.

Negative tests send an empty interactive request and exact attempts to read
`.env`, run arbitrary `docker exec`, write under `/opt/bluesky-feed`, and
restart `bluesky-feed.service`. Each must exit nonzero through the dispatcher
without executing. Root-side `verify` additionally proves the user cannot read
`.env`, cannot write the checkout or Docker socket, has no supplementary group,
and has exactly one sudoers rule. The restart prohibition is checked by
deny-by-default dispatch plus policy inspection; the test never risks actually
restarting production to prove a negative.

## Rollback

Rollback is an explicit, guarded script mode:

```sh
sudo ops/provision-corgi-operations-principal.sh rollback CONFIRM-CORGI-OPERATIONS-ROLLBACK
```

After confirming no process, systemd unit, or cron entry references the user,
the script executes the equivalent of:

```sh
rm -f /etc/sudoers.d/corgi-operations \
  /usr/local/sbin/corgi-operations-command \
  /usr/local/libexec/corgi-read-feed-updated-at \
  /var/lib/corgi-operations/.ssh/authorized_keys
rmdir /var/lib/corgi-operations/.ssh /var/lib/corgi-operations
userdel corgi-operations
groupdel corgi-operations # only if the dedicated group remains
```

The two `rmdir` calls fail closed if an unexpected file appears; rollback never
recursively deletes an uninspected directory.

Before host rollback, GitHub-side callers must also be quiesced: disable or
rebind both scheduled workflows through a reviewed change, wait for every run
using `production-operations` to finish, and confirm the operations private key
is no longer available to a runnable job. The host script then checks active
processes, system and user unit directories, system crontabs, and per-user cron
spools before removing anything.

No current repository workflow, service unit, or cron definition references
`corgi-operations`; it is a new principal. Because Phase A does not inspect the
production host, the script rechecks processes and host schedules immediately
before rollback rather than claiming unseen host state. Phase B must record
that dependency check in its receipt.

## Phase boundary and receipt

Phase A commits this design, the two fixed command files, the idempotent
provision/verify/acceptance/rollback script, blocking policy tests, and
`ops/receipts/2026-09-02/PROJ-2258/phase-a-design.md`. It does not create a key,
connect to production, create GitHub environments, edit desired state, bind
workflows, move or remove secrets, set `CORGI_PRODUCTION_DEPLOY_ENABLED`,
dispatch a deploy, use an admin bypass, or change the freeze.

Phase B requires a new explicit founder approval. Its receipt must record the
reviewed commit SHA, key fingerprint, account and file modes, allow/deny test
results, environment policies, secret names only, workflow run URLs and SHAs,
and rollback dependency check. It must never record secret values.

## Sources

- [OpenSSH `sshd` manual](https://man.openbsd.org/sshd.8) for authorized-key
  `restrict` and forced-command behavior.
- [OpenSSH `sshd_config` manual](https://man.openbsd.org/sshd_config) for the
  requirement that forced commands are invoked via the user's shell.
- [Docker Linux post-installation guidance](https://docs.docker.com/engine/install/linux-postinstall/)
  for Docker-group root-equivalent access.
- [sudoers manual](https://www.sudo.ws/docs/man/1.9.14/sudoers.man.pdf) for
  exact command matching and avoiding wildcard argument rules.
- [NIST least privilege definition](https://csrc.nist.gov/glossary/term/least_privilege).
- Saltzer and Schroeder, “The Protection of Information in Computer Systems,”
  Proceedings of the IEEE 63(9), 1975,
  [doi:10.1109/PROC.1975.9939](https://doi.org/10.1109/PROC.1975.9939).
