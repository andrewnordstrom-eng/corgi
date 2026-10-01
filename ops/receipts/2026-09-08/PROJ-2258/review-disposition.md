# PROJ-2258 bounded local review disposition

## Runtime Health Check

The admitted publication worktree passed startup with READY_TO_WORK on
2026-09-09. Its existing candidate was preserved through the checkpoint.

CodeRabbit completed one authorized `--uncommitted --include-untracked --light`
review of the frozen candidate with SHA256
`5c14cdd7b5625ee093893b65106ce57dc7d967a406fac8c951b44b8bde5563d8`.
It reviewed all 15 changed/untracked files and returned eight findings. The
review completed successfully; completion is not an approval verdict.

| Finding | Disposition |
| --- | --- |
| Major: disk and freshness boundary assertions | Added 79/80/85/89 percent and exactly 1,800/1,801-second cases with deterministic current time and real GNU timestamp parsing. The suggestion both requested and prohibited an 89-percent warning; the documented 80-percent warning threshold is authoritative, so 89 percent warns and succeeds. |
| Major: SSH host-key assertions | Added BatchMode, disabled global known-hosts, `-F /dev/null`, exactly one private known-hosts path beside the key, and its exact synthetic file content. |
| Major: negative workflow tests could pass for unintended failures | Assert each diagnostic marker, require the intentional transport exit 73, and reject a synthetic transport traceback. |
| Major: symlink tests could fail only because inventory changed | Keep saved originals outside the inspected tree, assert rejection is not inventory mismatch, and add an independent hardlink rejection with unchanged inventory. |
| Minor: partial database startup cleanup | Startup is inside `try/finally` with bounded calls and unique ownership labels; cleanup removes only the container owned by that invocation. Do not indiscriminately delete a pre-existing named container as suggested. Removed the unused baseline variable. |
| Trivial: structured CLI failure JSON | Deferred. Existing explicit exceptions and nonzero exits already fail closed; repeat apply includes the exact conflicting recovery path. There is no machine consumer requiring a new error schema. |
| Trivial: pullable PostgreSQL digest and version metadata | Recorded the actual server version. Retain the exact local image ID already qualified; reproduction explicitly requires this locally available image. Pullability is not necessary to validate this local packet and will not trigger a new image qualification. |
| Trivial: duplicate receipt files inside the container | Deferred. Each rehearsal emits its complete JSON receipt on stdout, captured on the workstation before the disposable container is removed. An additional `/root` copy would not improve acceptance evidence. |

## Deterministic Eval

The installer opened the live directory before acquiring the deployment lock.
A same-revision deployment completing between those operations could leave a
stale directory descriptor and mutate retired artifacts before detecting the
changed directory identity. A disposable Linux regression reproduced the failure.
The installer now acquires the existing production lock before opening the live
CLI directory. The same regression passes and proves the retired directory is
unchanged. All other installer acceptance cases pass too.

## Live Acceptance

The frozen review artifact is retained locally. The changes above are a single
post-review correction pass within the approved scope. Their behavioral checks
are recorded in the updated acceptance receipts. CodeRabbit has not reviewed
this subsequent delta; normal hosted review must cover the final published head
before merge. No follow-up full review, extra credits, commit, push, PR message,
production action or approval bypass was performed to close this local review.


### Automation Summary

The 2026-09-09 publication preparation reran full verification successfully:
2,259 tests passed with one existing skip, and builds/lint passed. No additional
source correction or local review was requested. Final-head hosted validation
and review remain required; no production or recurring workflow was activated.
