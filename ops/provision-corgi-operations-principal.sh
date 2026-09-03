#!/usr/bin/env bash

set -Eeuo pipefail

readonly OPERATIONS_USER='corgi-operations'
readonly OPERATIONS_GROUP='corgi-operations'
readonly OPERATIONS_HOME='/var/lib/corgi-operations'
readonly AUTHORIZED_KEYS_PATH="${OPERATIONS_HOME}/.ssh/authorized_keys"
readonly DISPATCHER_PATH='/usr/local/sbin/corgi-operations-command'
readonly REDIS_READER_PATH='/usr/local/libexec/corgi-read-feed-updated-at'
readonly SUDOERS_PATH='/etc/sudoers.d/corgi-operations'
readonly SUDOERS_RULE='corgi-operations ALL=(root) NOPASSWD: /usr/local/libexec/corgi-read-feed-updated-at'
readonly ROLLBACK_CONFIRMATION='CONFIRM-CORGI-OPERATIONS-ROLLBACK'
SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
readonly SOURCE_DIR

fail() {
  printf '%s\n' "PROJ-2258 provisioning error: $*" >&2
  exit 1
}

usage() {
  printf '%s\n' \
    'Usage:' \
    '  provision-corgi-operations-principal.sh plan' \
    '  sudo provision-corgi-operations-principal.sh apply PUBLIC_KEY_FILE' \
    '  sudo provision-corgi-operations-principal.sh verify' \
    '  sudo provision-corgi-operations-principal.sh rollback CONFIRM-CORGI-OPERATIONS-ROLLBACK' \
    '  provision-corgi-operations-principal.sh acceptance HOST PRIVATE_KEY KNOWN_HOSTS DATABASE_URL_FILE'
}

require_exact_arg_count() {
  local expected="$1"
  local actual="$2"
  local operation="$3"
  if [[ "$actual" -ne "$expected" ]]; then
    usage >&2
    fail "${operation} expected ${expected} argument(s), received ${actual}"
  fi
}

require_root() {
  if [[ "$(/usr/bin/id -u)" -ne 0 ]]; then
    fail 'this operation must run as root'
  fi
}

require_executable() {
  local path="$1"
  [[ -x "$path" ]] || fail "required executable is missing: ${path}"
}

assert_source_files() {
  [[ -f "${SOURCE_DIR}/corgi-operations-command" ]] ||
    fail "missing dispatcher source: ${SOURCE_DIR}/corgi-operations-command"
  [[ -f "${SOURCE_DIR}/corgi-read-feed-updated-at" ]] ||
    fail "missing Redis wrapper source: ${SOURCE_DIR}/corgi-read-feed-updated-at"
  /bin/bash -n "${SOURCE_DIR}/corgi-operations-command"
  /bin/sh -n "${SOURCE_DIR}/corgi-read-feed-updated-at"
}

assert_safe_directory_chain() {
  local directory="$1"
  local current="$directory"
  local metadata=''
  local owner=''
  local mode=''

  while :; do
    if [[ -e "$current" || -L "$current" ]]; then
      [[ -d "$current" && ! -L "$current" ]] ||
        fail "required parent is not a non-symlink directory: ${current}"
      metadata="$(/usr/bin/stat -c '%u:%a' "$current")"
      owner="${metadata%%:*}"
      mode="${metadata#*:}"
      [[ "$owner" == '0' ]] || fail "required parent is not root-owned: ${current} (uid ${owner})"
      (( (8#${mode} & 8#022) == 0 )) ||
        fail "required parent is group- or other-writable: ${current} (${mode})"
    fi
    [[ "$current" == '/' ]] && break
    current="$(/usr/bin/dirname "$current")"
  done

}

ensure_root_parent_directory() {
  local directory="$1"

  assert_safe_directory_chain "$directory"
  if [[ ! -e "$directory" ]]; then
    /usr/bin/install -d -o root -g root -m 0755 "$directory"
  fi
  assert_safe_directory_chain "$directory"
}

assert_safe_existing_managed_path() {
  local path="$1"
  local metadata=''
  local owner=''
  local mode=''

  if [[ ! -e "$path" && ! -L "$path" ]]; then
    return
  fi
  [[ -f "$path" && ! -L "$path" ]] || fail "managed path is not a non-symlink regular file: ${path}"
  metadata="$(/usr/bin/stat -c '%u:%a' "$path")"
  owner="${metadata%%:*}"
  mode="${metadata#*:}"
  [[ "$owner" == '0' ]] || fail "managed path is not root-owned: ${path} (uid ${owner})"
  (( (8#${mode} & 8#022) == 0 )) ||
    fail "managed path is group- or other-writable: ${path} (${mode})"
}

read_numeric_owner_mode() {
  local path="$1"
  local metadata=''

  if metadata="$(/usr/bin/stat -c '%u:%a' "$path" 2>/dev/null)"; then
    :
  else
    metadata="$(/usr/bin/stat -f '%u:%Lp' "$path")"
  fi
  printf '%s' "$metadata"
}

assert_application_directory_isolated() {
  local path="$1"
  local forbidden_owner_uid="$2"
  local metadata=''
  local owner=''
  local mode=''

  [[ -d "$path" && ! -L "$path" ]] ||
    fail "production application path must be a non-symlink directory: ${path}"
  metadata="$(read_numeric_owner_mode "$path")"
  owner="${metadata%%:*}"
  mode="${metadata#*:}"
  (( (8#${mode} & 8#022) == 0 )) ||
    fail "production application path is group- or other-writable: ${path} (${mode})"
  if [[ -n "$forbidden_owner_uid" && "$owner" == "$forbidden_owner_uid" ]]; then
    fail "operations account must not own the production application path: ${path}"
  fi
}

assert_isolated_secret_file() {
  local path="$1"
  local expected_owner_uid="$2"
  local purpose="$3"
  local metadata=''
  local owner=''
  local mode=''

  [[ -f "$path" && ! -L "$path" ]] ||
    fail "${purpose} must be a non-symlink regular file"
  metadata="$(read_numeric_owner_mode "$path")"
  owner="${metadata%%:*}"
  mode="${metadata#*:}"
  [[ "$owner" == "$expected_owner_uid" ]] ||
    fail "${purpose} must have owner uid ${expected_owner_uid} before provisioning (uid ${owner})"
  (( (8#${mode} & 8#077) == 0 )) ||
    fail "${purpose} must grant no group or other permissions before provisioning (${mode})"
}

assert_production_environment_isolated() {
  local operations_uid=''

  assert_safe_directory_chain /opt
  if /usr/bin/getent passwd "$OPERATIONS_USER" >/dev/null; then
    operations_uid="$(/usr/bin/id -u "$OPERATIONS_USER")"
  fi
  assert_application_directory_isolated /opt/bluesky-feed "$operations_uid"
  assert_isolated_secret_file /opt/bluesky-feed/.env 0 'production environment file'
}

remove_new_account_after_failed_isolation() {
  local isolation_error="$1"

  /usr/sbin/userdel "$OPERATIONS_USER" ||
    fail "failed to remove newly created ${OPERATIONS_USER} after isolation rejection: ${isolation_error}"
  if /usr/bin/getent group "$OPERATIONS_GROUP" >/dev/null; then
    /usr/sbin/groupdel "$OPERATIONS_GROUP" ||
      fail "failed to remove newly created ${OPERATIONS_GROUP} after isolation rejection: ${isolation_error}"
  fi
  fail "post-account isolation rejected provisioning and the new account was removed: ${isolation_error}"
}

read_public_key() {
  local public_key_file="$1"
  local public_key=''
  local key_type=''
  local key_blob=''
  local key_comment=''
  local extra_field=''
  local line_count=''

  [[ -f "$public_key_file" ]] || fail "public key file does not exist: ${public_key_file}"
  [[ ! -L "$public_key_file" ]] || fail "public key file must not be a symlink: ${public_key_file}"
  line_count="$(/usr/bin/awk 'NF { count += 1 } END { print count + 0 }' "$public_key_file")"
  [[ "$line_count" == '1' ]] || fail 'public key file must contain exactly one non-empty key line'
  public_key="$(/usr/bin/awk 'NF { print; exit }' "$public_key_file")"
  read -r key_type key_blob key_comment extra_field <<<"$public_key"
  [[ "$key_type" == 'ssh-ed25519' ]] || fail 'operations public key must use Ed25519'
  [[ -n "$key_blob" ]] || fail 'operations public key blob is missing'
  [[ -z "$extra_field" ]] || fail 'operations public key comment must contain no whitespace'
  /usr/bin/ssh-keygen -l -f "$public_key_file" >/dev/null || fail 'operations public key is invalid'
  if [[ -n "$key_comment" ]]; then
    printf '%s %s %s' "$key_type" "$key_blob" "$key_comment"
  else
    printf '%s %s' "$key_type" "$key_blob"
  fi
}

assert_account_shape() {
  local passwd_entry=''
  local account_home=''
  local account_shell=''
  local group_name=''

  passwd_entry="$(/usr/bin/getent passwd "$OPERATIONS_USER")" || fail "missing user: ${OPERATIONS_USER}"
  account_home="$(printf '%s\n' "$passwd_entry" | /usr/bin/cut -d: -f6)"
  account_shell="$(printf '%s\n' "$passwd_entry" | /usr/bin/cut -d: -f7)"
  [[ "$account_home" == "$OPERATIONS_HOME" ]] || fail "unexpected home for ${OPERATIONS_USER}: ${account_home}"
  [[ "$account_shell" == '/bin/sh' ]] || fail "unexpected shell for ${OPERATIONS_USER}: ${account_shell}"

  while IFS= read -r group_name; do
    case "$group_name" in
      "$OPERATIONS_GROUP") ;;
      '') ;;
      *) fail "${OPERATIONS_USER} has unexpected supplementary group: ${group_name}" ;;
    esac
  done < <(/usr/bin/id -nG "$OPERATIONS_USER" | /usr/bin/tr ' ' '\n')

  /usr/bin/passwd -S "$OPERATIONS_USER" | /usr/bin/awk '$2 == "L" { found = 1 } END { exit(found ? 0 : 1) }' ||
    fail "password authentication is not locked for ${OPERATIONS_USER}"
}

assert_file_shape() {
  local path="$1"
  local expected_shape="$2"
  local actual_shape=''

  [[ -f "$path" ]] || fail "required regular file is missing: ${path}"
  [[ ! -L "$path" ]] || fail "required file must not be a symlink: ${path}"
  actual_shape="$(/usr/bin/stat -c '%U:%G:%a' "$path")"
  [[ "$actual_shape" == "$expected_shape" ]] ||
    fail "unexpected owner or mode for ${path}: expected ${expected_shape}, found ${actual_shape}"
}

assert_no_other_sudo_references() {
  local match=''
  while IFS= read -r match; do
    [[ -z "$match" ]] && continue
    [[ "$match" == "${SUDOERS_PATH}:"* ]] && continue
    fail "unexpected sudo policy references ${OPERATIONS_USER}: ${match%%:*}"
  done < <(/usr/bin/grep -R -n -F -- "$OPERATIONS_USER" /etc/sudoers /etc/sudoers.d 2>/dev/null || true)
}

verify_host_policy() {
  local sudoers_content=''

  assert_source_files
  assert_production_environment_isolated
  assert_account_shape
  assert_file_shape "$DISPATCHER_PATH" 'root:root:755'
  assert_file_shape "$REDIS_READER_PATH" 'root:root:755'
  assert_file_shape "$AUTHORIZED_KEYS_PATH" 'root:root:600'
  assert_file_shape "$SUDOERS_PATH" 'root:root:440'
  [[ "$(/usr/bin/stat -c '%U:%G:%a' "$OPERATIONS_HOME")" == 'root:root:755' ]] ||
    fail "unexpected owner or mode for ${OPERATIONS_HOME}"
  [[ "$(/usr/bin/stat -c '%U:%G:%a' "${OPERATIONS_HOME}/.ssh")" == 'root:root:700' ]] ||
    fail "unexpected owner or mode for ${OPERATIONS_HOME}/.ssh"

  /usr/bin/cmp -s "${SOURCE_DIR}/corgi-operations-command" "$DISPATCHER_PATH" ||
    fail 'installed dispatcher differs from the reviewed repository source'
  /usr/bin/cmp -s "${SOURCE_DIR}/corgi-read-feed-updated-at" "$REDIS_READER_PATH" ||
    fail 'installed Redis wrapper differs from the reviewed repository source'
  /usr/sbin/visudo -cf "$SUDOERS_PATH" >/dev/null
  sudoers_content="$(<"$SUDOERS_PATH")"
  [[ "$sudoers_content" == "$SUDOERS_RULE" ]] || fail 'sudoers policy differs from the single reviewed command rule'
  assert_no_other_sudo_references

  /usr/bin/grep -Eq '^restrict,command="/usr/local/sbin/corgi-operations-command" ssh-ed25519 [A-Za-z0-9+/]+=*([[:space:]][^[:space:]]+)?$' "$AUTHORIZED_KEYS_PATH" ||
    fail 'authorized_keys does not contain exactly the restricted Ed25519 forced command'
  [[ "$(/usr/bin/awk 'NF { count += 1 } END { print count + 0 }' "$AUTHORIZED_KEYS_PATH")" == '1' ]] ||
    fail 'authorized_keys must contain exactly one non-empty key line'

  /usr/sbin/runuser -u "$OPERATIONS_USER" -- /usr/bin/test ! -r /opt/bluesky-feed/.env ||
    fail "${OPERATIONS_USER} can read /opt/bluesky-feed/.env"
  /usr/sbin/runuser -u "$OPERATIONS_USER" -- /usr/bin/test ! -w /opt/bluesky-feed ||
    fail "${OPERATIONS_USER} can write under /opt/bluesky-feed"
  if [[ -e /var/run/docker.sock ]]; then
    /usr/sbin/runuser -u "$OPERATIONS_USER" -- /usr/bin/test ! -w /var/run/docker.sock ||
      fail "${OPERATIONS_USER} can write to the Docker socket"
  fi

  printf '%s\n' 'PROJ-2258 host policy verification passed.'
  /usr/bin/ssh-keygen -lf "$AUTHORIZED_KEYS_PATH"
}

apply_policy() {
  local public_key_file="$1"
  local public_key=''
  local authorized_keys_tmp=''
  local sudoers_tmp=''
  local isolation_error=''
  local created_account='false'

  require_root
  for executable in \
    /bin/bash /usr/bin/awk /usr/bin/cmp /usr/bin/curl /usr/bin/cut /usr/bin/df \
    /usr/bin/dirname /usr/bin/docker /usr/bin/env /usr/bin/getent \
    /usr/bin/id /usr/bin/install /usr/bin/node /usr/bin/passwd /usr/bin/ssh-keygen \
    /usr/bin/stat /usr/bin/sudo /usr/bin/timeout /usr/bin/tr /usr/sbin/runuser /usr/sbin/useradd \
    /usr/sbin/userdel /usr/sbin/groupdel /usr/sbin/usermod /usr/sbin/visudo; do
    require_executable "$executable"
  done
  assert_source_files
  [[ -f /opt/bluesky-feed/cli/dist/index.js ]] || fail 'built epoch CLI is missing at /opt/bluesky-feed/cli/dist/index.js'
  [[ -d /opt/bluesky-feed ]] || fail 'production checkout is missing at /opt/bluesky-feed'
  assert_production_environment_isolated
  public_key="$(read_public_key "$public_key_file")"

  for directory in "$OPERATIONS_HOME" "${OPERATIONS_HOME}/.ssh" \
    /usr/local/libexec /usr/local/sbin /etc/sudoers.d; do
    assert_safe_directory_chain "$directory"
  done
  for managed_path in "$AUTHORIZED_KEYS_PATH" "$DISPATCHER_PATH" "$REDIS_READER_PATH" "$SUDOERS_PATH"; do
    assert_safe_existing_managed_path "$managed_path"
  done

  if /usr/bin/getent passwd "$OPERATIONS_USER" >/dev/null; then
    assert_account_shape
  else
    /usr/sbin/useradd --system --user-group --home-dir "$OPERATIONS_HOME" --shell /bin/sh --no-create-home "$OPERATIONS_USER"
    created_account='true'
    if ! /usr/sbin/usermod --lock "$OPERATIONS_USER"; then
      remove_new_account_after_failed_isolation 'password lock failed'
    fi
  fi
  if [[ "$created_account" == 'true' ]] &&
    ! isolation_error="$(assert_production_environment_isolated 2>&1)"; then
    remove_new_account_after_failed_isolation "$isolation_error"
  fi

  for directory in "$OPERATIONS_HOME" "${OPERATIONS_HOME}/.ssh" \
    /usr/local/libexec /usr/local/sbin /etc/sudoers.d; do
    ensure_root_parent_directory "$directory"
  done
  /usr/bin/install -d -o root -g root -m 0755 "$OPERATIONS_HOME"
  /usr/bin/install -d -o root -g root -m 0700 "${OPERATIONS_HOME}/.ssh"
  /usr/bin/install -o root -g root -m 0755 "${SOURCE_DIR}/corgi-operations-command" "$DISPATCHER_PATH"
  /usr/bin/install -o root -g root -m 0755 "${SOURCE_DIR}/corgi-read-feed-updated-at" "$REDIS_READER_PATH"

  authorized_keys_tmp="$(/usr/bin/mktemp)"
  sudoers_tmp="$(/usr/bin/mktemp)"
  trap '/usr/bin/rm -f -- "${authorized_keys_tmp:-}" "${sudoers_tmp:-}"' RETURN
  printf 'restrict,command="%s" %s\n' "$DISPATCHER_PATH" "$public_key" >"$authorized_keys_tmp"
  /usr/bin/install -o root -g root -m 0600 "$authorized_keys_tmp" "$AUTHORIZED_KEYS_PATH"
  printf '%s\n' "$SUDOERS_RULE" >"$sudoers_tmp"
  /bin/chmod 0440 "$sudoers_tmp"
  /usr/sbin/visudo -cf "$sudoers_tmp" >/dev/null
  /usr/bin/install -o root -g root -m 0440 "$sudoers_tmp" "$SUDOERS_PATH"
  /usr/sbin/visudo -cf "$SUDOERS_PATH" >/dev/null
  trap - RETURN
  /usr/bin/rm -f -- "$authorized_keys_tmp" "$sudoers_tmp"

  verify_host_policy
}

assert_rollback_isolated() {
  local process_ids=''
  local dependency=''
  local entry=''
  local -a entries=()

  [[ -d "$OPERATIONS_HOME" && ! -L "$OPERATIONS_HOME" ]] ||
    fail "operations home is missing or unsafe; rollback made no changes: ${OPERATIONS_HOME}"
  [[ -d "${OPERATIONS_HOME}/.ssh" && ! -L "${OPERATIONS_HOME}/.ssh" ]] ||
    fail "operations SSH directory is missing or unsafe; rollback made no changes: ${OPERATIONS_HOME}/.ssh"
  for entry in "$AUTHORIZED_KEYS_PATH" "$DISPATCHER_PATH" "$REDIS_READER_PATH" "$SUDOERS_PATH"; do
    [[ -f "$entry" && ! -L "$entry" ]] ||
      fail "managed file is missing or unsafe; rollback made no changes: ${entry}"
  done

  shopt -s nullglob dotglob
  entries=("${OPERATIONS_HOME}"/*)
  shopt -u nullglob dotglob
  for entry in "${entries[@]}"; do
    [[ "$entry" == "${OPERATIONS_HOME}/.ssh" ]] ||
      fail "unexpected entry blocks rollback before mutation: ${entry}"
  done
  shopt -s nullglob dotglob
  entries=("${OPERATIONS_HOME}/.ssh"/*)
  shopt -u nullglob dotglob
  for entry in "${entries[@]}"; do
    [[ "$entry" == "$AUTHORIZED_KEYS_PATH" ]] ||
      fail "unexpected SSH entry blocks rollback before mutation: ${entry}"
  done

  process_ids="$(/usr/bin/ps -u "$OPERATIONS_USER" -o pid= 2>/dev/null || true)"
  [[ -z "${process_ids//[[:space:]]/}" ]] || fail "active processes still depend on ${OPERATIONS_USER}: ${process_ids}"

  for dependency in "/var/spool/cron/${OPERATIONS_USER}" "/var/spool/cron/crontabs/${OPERATIONS_USER}"; do
    [[ ! -e "$dependency" && ! -L "$dependency" ]] ||
      fail "user crontab still depends on ${OPERATIONS_USER}: ${dependency}"
  done

  while IFS= read -r dependency; do
    [[ -z "$dependency" ]] && continue
    fail "system schedule or service still references ${OPERATIONS_USER}: ${dependency%%:*}"
  done < <(/usr/bin/grep -R -n -F -- "$OPERATIONS_USER" \
    /etc/crontab /etc/cron.d /etc/cron.daily /etc/cron.hourly /etc/cron.weekly /etc/cron.monthly \
    /var/spool/cron /etc/systemd/system /etc/systemd/user \
    /usr/lib/systemd/system /usr/lib/systemd/user /lib/systemd/system /lib/systemd/user \
    2>/dev/null || true)
}

rollback_policy() {
  local confirmation="$1"

  require_root
  for executable in /usr/bin/getent /usr/bin/grep /usr/bin/ps /usr/bin/rm /usr/bin/rmdir \
    /usr/sbin/groupdel /usr/sbin/userdel; do
    require_executable "$executable"
  done
  [[ "$confirmation" == "$ROLLBACK_CONFIRMATION" ]] || fail 'rollback confirmation phrase does not match'
  if ! /usr/bin/getent passwd "$OPERATIONS_USER" >/dev/null; then
    [[ ! -e "$DISPATCHER_PATH" && ! -e "$REDIS_READER_PATH" && ! -e "$SUDOERS_PATH" && ! -e "$OPERATIONS_HOME" ]] ||
      fail 'account is absent but one or more managed files remain; reconcile manually before retrying'
    printf '%s\n' 'PROJ-2258 rollback is already complete.'
    return
  fi

  assert_rollback_isolated
  /usr/bin/rm -f -- "$SUDOERS_PATH" "$DISPATCHER_PATH" "$REDIS_READER_PATH" "$AUTHORIZED_KEYS_PATH"
  /usr/bin/rmdir -- "${OPERATIONS_HOME}/.ssh"
  /usr/bin/rmdir -- "$OPERATIONS_HOME"
  /usr/sbin/userdel "$OPERATIONS_USER"
  if /usr/bin/getent group "$OPERATIONS_GROUP" >/dev/null; then
    /usr/sbin/groupdel "$OPERATIONS_GROUP"
  fi
  [[ ! -e "$OPERATIONS_HOME" ]] || fail "home remains after rollback: ${OPERATIONS_HOME}"
  printf '%s\n' 'PROJ-2258 rollback completed; the dedicated account, key, wrapper, dispatcher, and sudoers rule were removed.'
}

assert_private_input_file() {
  local path="$1"
  local purpose="$2"
  local metadata=''
  local owner=''
  local mode=''

  if metadata="$(/usr/bin/stat -c '%u:%a' "$path" 2>/dev/null)"; then
    :
  else
    metadata="$(/usr/bin/stat -f '%u:%Lp' "$path")"
  fi
  owner="${metadata%%:*}"
  mode="${metadata#*:}"
  [[ "$owner" == "$(/usr/bin/id -u)" ]] ||
    fail "${purpose} must be owned by the current user: ${path}"
  (( (8#${mode} & 8#077) == 0 )) ||
    fail "${purpose} must have no group or other permission bits: ${path} (${mode})"
}

run_remote_acceptance() {
  local host="$1"
  local private_key="$2"
  local known_hosts="$3"
  local database_url_file="$4"
  local output_dir=''
  local command=''
  local result_path=''
  local -a ssh_options=(
    -i "$private_key"
    -o BatchMode=yes
    -o IdentitiesOnly=yes
    -o StrictHostKeyChecking=yes
    -o "UserKnownHostsFile=${known_hosts}"
  )

  [[ -n "$host" ]] || fail 'acceptance host must not be empty'
  for path in "$private_key" "$known_hosts" "$database_url_file"; do
    [[ -f "$path" ]] || fail "acceptance input file does not exist: ${path}"
    [[ ! -L "$path" ]] || fail "acceptance input file must not be a symlink: ${path}"
  done
  assert_private_input_file "$private_key" 'private key'
  assert_private_input_file "$database_url_file" 'database URL file'
  output_dir="$(/usr/bin/mktemp -d)"
  trap '/usr/bin/rm -rf -- "${output_dir:-}"' RETURN

  /usr/bin/ssh "${ssh_options[@]}" "${OPERATIONS_USER}@${host}" epoch-status \
    <"$database_url_file" >"${output_dir}/epoch-status.out"
  /usr/bin/grep -Eq '^\{' "${output_dir}/epoch-status.out" || fail 'epoch-status did not return JSON'
  /usr/bin/ssh "${ssh_options[@]}" "${OPERATIONS_USER}@${host}" disk-root \
    >"${output_dir}/disk-root.out"
  /usr/bin/grep -Fq 'Mounted on' "${output_dir}/disk-root.out" || fail 'disk-root did not return POSIX df output'
  /usr/bin/ssh "${ssh_options[@]}" "${OPERATIONS_USER}@${host}" health-ready \
    >"${output_dir}/health-ready.out"
  [[ -s "${output_dir}/health-ready.out" ]] || fail 'health-ready returned an empty response'
  /usr/bin/ssh "${ssh_options[@]}" "${OPERATIONS_USER}@${host}" feed-updated-at \
    >"${output_dir}/feed-updated-at.out"

  for command in \
    'cat /opt/bluesky-feed/.env' \
    'docker exec bluesky-feed-redis redis-cli FLUSHALL' \
    'touch /opt/bluesky-feed/PROJ-2258-negative-test' \
    'sudo systemctl restart bluesky-feed.service'; do
    result_path="${output_dir}/negative-$(( ${#command} )).out"
    # shellcheck disable=SC2029 # The client-side value is a fixed test vector; the forced command rejects it remotely.
    if /usr/bin/ssh "${ssh_options[@]}" "${OPERATIONS_USER}@${host}" "$command" >"$result_path" 2>&1; then
      fail "forbidden command unexpectedly succeeded: ${command}"
    fi
    /usr/bin/grep -Fq 'command denied' "$result_path" || fail "forbidden command did not fail through the dispatcher: ${command}"
  done

  # shellcheck disable=SC2029 # The redirection is intentionally local; no remote command is supplied.
  if /usr/bin/ssh "${ssh_options[@]}" "${OPERATIONS_USER}@${host}" >"${output_dir}/negative-shell.out" 2>&1; then
    fail 'interactive shell request unexpectedly succeeded'
  fi
  /usr/bin/grep -Fq 'command denied' "${output_dir}/negative-shell.out" ||
    fail 'interactive shell request did not fail through the dispatcher'

  /usr/bin/rm -rf -- "$output_dir"
  trap - RETURN
  printf '%s\n' 'PROJ-2258 remote acceptance passed: four allowed commands succeeded and all forbidden commands were denied.'
}

print_plan() {
  printf '%s\n' \
    'PROJ-2258 Phase B execution plan (does not mutate when printed):' \
    "  account: ${OPERATIONS_USER}:${OPERATIONS_GROUP}, home ${OPERATIONS_HOME}, shell /bin/sh, password locked" \
    "  forced command: ${DISPATCHER_PATH}" \
    "  public key: ${AUTHORIZED_KEYS_PATH}, root:root 0600, restrict + forced-command options" \
    "  Redis wrapper: ${REDIS_READER_PATH}, root:root 0755, fixed container/key arguments" \
    "  sudoers: ${SUDOERS_PATH}, exactly: ${SUDOERS_RULE}" \
    '  supplementary groups: none; specifically not docker or sudo' \
    '  production application .env: remains unreadable' \
    '  allowed SSH commands: epoch-status, disk-root, health-ready, feed-updated-at' \
    "  rollback confirmation: ${ROLLBACK_CONFIRMATION}"
}

main() {
  local operation="${1:-}"

  [[ -n "$operation" ]] || {
    usage >&2
    exit 64
  }
  shift
  case "$operation" in
    plan)
      require_exact_arg_count 0 "$#" "$operation"
      print_plan
      ;;
    apply)
      require_exact_arg_count 1 "$#" "$operation"
      apply_policy "$1"
      ;;
    verify)
      require_exact_arg_count 0 "$#" "$operation"
      require_root
      verify_host_policy
      ;;
    rollback)
      require_exact_arg_count 1 "$#" "$operation"
      rollback_policy "$1"
      ;;
    acceptance)
      require_exact_arg_count 4 "$#" "$operation"
      run_remote_acceptance "$1" "$2" "$3" "$4"
      ;;
    *)
      usage >&2
      fail "unknown operation: ${operation}"
      ;;
  esac
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
