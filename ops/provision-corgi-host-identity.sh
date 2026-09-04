#!/bin/bash

set -Eeuo pipefail

readonly APPLICATION_DIR='/opt/bluesky-feed'
readonly ENVIRONMENT_FILE='/opt/bluesky-feed/.env'
readonly SERVICE_UNIT='bluesky-feed'
readonly SERVICE_USER='bluesky-feed'
readonly SERVICE_GROUP='bluesky-feed'
readonly SERVICE_HOME='/var/lib/bluesky-feed'
readonly UNIT_PATH='/etc/systemd/system/bluesky-feed.service'
readonly WRAPPER_PATH='/usr/local/sbin/corgi-deploy-root'
readonly SUDOERS_PATH='/etc/sudoers.d/corgi-deploy'
readonly STATE_DIR='/var/lib/corgi-host-adoption'
readonly STATE_FILE="${STATE_DIR}/state"
readonly STATE_TMP="${STATE_DIR}/state.tmp"
readonly UNIT_BACKUP="${STATE_DIR}/bluesky-feed.service.before"
readonly SUDOERS_BACKUP="${STATE_DIR}/deployment-sudoers.before"
readonly APPLY_CONFIRMATION='CONFIRM-CORGI-HOST-IDENTITY-ADOPTION'
readonly ROLLBACK_CONFIRMATION='CONFIRM-CORGI-HOST-IDENTITY-ROLLBACK'
SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
readonly SOURCE_DIR
readonly UNIT_SOURCE="${SOURCE_DIR}/bluesky-feed.service"
readonly WRAPPER_SOURCE="${SOURCE_DIR}/corgi-deploy-root"

fail() {
  printf '%s\n' "PROJ-2268 host-adoption error: $*" >&2
  exit 1
}

usage() {
  printf '%s\n' \
    'Usage:' \
    '  provision-corgi-host-identity.sh plan' \
    '  sudo provision-corgi-host-identity.sh preflight DEPLOY_USER BROAD_SUDOERS_PATH' \
    '  sudo provision-corgi-host-identity.sh apply DEPLOY_USER BROAD_SUDOERS_PATH EXPECTED_SUDOERS_SHA256 EXPECTED_UNIT_SHA256 EXPECTED_REPOSITORY_SHA CONFIRM-CORGI-HOST-IDENTITY-ADOPTION' \
    '  sudo provision-corgi-host-identity.sh verify DEPLOY_USER' \
    '  sudo provision-corgi-host-identity.sh rollback DEPLOY_USER CONFIRM-CORGI-HOST-IDENTITY-ROLLBACK'
}

require_arg_count() {
  local expected="$1"
  local actual="$2"
  local operation="$3"

  [[ "$actual" -eq "$expected" ]] || {
    usage >&2
    fail "${operation} expected ${expected} argument(s), received ${actual}"
  }
}

require_root() {
  [[ "$(/usr/bin/id -u)" -eq 0 ]] || fail 'this operation must run as root'
}

require_executable() {
  local path="$1"

  [[ -x "$path" ]] || fail "required executable is missing: ${path}"
}

require_sha256() {
  local digest="$1"
  local purpose="$2"

  [[ "$digest" =~ ^[0-9a-f]{64}$ ]] || fail "${purpose} must be a lowercase SHA-256 digest"
}

file_sha256() {
  /usr/bin/sha256sum "$1" | /usr/bin/awk '{ print $1 }'
}

numeric_shape() {
  /usr/bin/stat -c '%u:%g:%a' "$1"
}

assert_root_regular_file() {
  local path="$1"
  local expected_mode="$2"
  local purpose="$3"
  local shape=''

  [[ -f "$path" && ! -L "$path" ]] || fail "${purpose} must be a non-symlink regular file: ${path}"
  shape="$(numeric_shape "$path")"
  [[ "$shape" == "0:0:${expected_mode}" ]] ||
    fail "${purpose} must be root:root mode ${expected_mode}: ${path} (${shape})"
}

require_safe_sudoers_path() {
  local path="$1"

  [[ "$path" == /etc/sudoers.d/* ]] || fail 'broad sudoers path must be directly under /etc/sudoers.d'
  [[ "$(/usr/bin/dirname "$path")" == '/etc/sudoers.d' ]] || fail 'broad sudoers path must not traverse directories'
  [[ "$(/usr/bin/basename "$path")" =~ ^[A-Za-z0-9_.-]+$ ]] || fail 'broad sudoers filename is invalid'
  [[ "$path" != "$SUDOERS_PATH" ]] || fail 'broad and replacement sudoers paths must differ'
}

assert_safe_sudoers_path() {
  local path="$1"

  require_safe_sudoers_path "$path"
  assert_root_regular_file "$path" 440 'existing broad sudoers policy'
}

assert_source_files() {
  [[ -f "$UNIT_SOURCE" && ! -L "$UNIT_SOURCE" ]] ||
    fail "reviewed service unit must be a non-symlink regular file: ${UNIT_SOURCE}"
  [[ -f "$WRAPPER_SOURCE" && ! -L "$WRAPPER_SOURCE" ]] ||
    fail "reviewed privileged wrapper must be a non-symlink regular file: ${WRAPPER_SOURCE}"
  /bin/bash -n "$WRAPPER_SOURCE"
  /bin/bash -n "${BASH_SOURCE[0]}"
}

assert_reviewed_checkout() {
  local deploy_user="$1"
  local expected_repository_sha="$2"
  local repository_root=''
  local actual_repository_sha=''
  local tracked_status=''

  [[ "$expected_repository_sha" =~ ^[0-9a-f]{40}$ ]] ||
    fail 'expected repository revision must be a lowercase full SHA'
  repository_root="$(cd "${SOURCE_DIR}/.." && pwd -P)"
  actual_repository_sha="$(/usr/bin/git -C "$repository_root" rev-parse HEAD)"
  [[ "$actual_repository_sha" == "$expected_repository_sha" ]] ||
    fail "repository revision differs from exact-head approval: ${actual_repository_sha}"
  tracked_status="$(/usr/bin/git -C "$repository_root" status --short --untracked-files=no)"
  [[ -z "$tracked_status" ]] || fail 'repository has tracked changes after exact-head approval'
  [[ "$(/usr/bin/stat -c '%U' "$repository_root")" == "$deploy_user" ]] ||
    fail "repository root must be owned by deployment user: ${repository_root}"
}

assert_deploy_user() {
  local deploy_user="$1"
  local deploy_uid=''

  [[ "$deploy_user" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || fail 'deployment user name is invalid'
  /usr/bin/getent passwd "$deploy_user" >/dev/null || fail "deployment user does not exist: ${deploy_user}"
  deploy_uid="$(/usr/bin/id -u "$deploy_user")"
  [[ "$deploy_uid" -ne 0 ]] || fail 'deployment user must not be root'
  [[ "$deploy_user" != "$SERVICE_USER" ]] || fail 'deployment and service users must be distinct'
}

assert_application_baseline() {
  local deploy_user="$1"
  local deploy_uid=''
  local app_shape=''
  local env_shape=''
  local env_uid=''
  local env_mode=''

  [[ -d "$APPLICATION_DIR" && ! -L "$APPLICATION_DIR" ]] ||
    fail "application directory must be a non-symlink directory: ${APPLICATION_DIR}"
  deploy_uid="$(/usr/bin/id -u "$deploy_user")"
  app_shape="$(numeric_shape "$APPLICATION_DIR")"
  [[ "${app_shape%%:*}" == "$deploy_uid" ]] ||
    fail "application directory must remain owned by deployment user uid ${deploy_uid}: ${app_shape}"
  /usr/sbin/runuser -u "$deploy_user" -- /usr/bin/test -w "$APPLICATION_DIR" ||
    fail "deployment user must be able to write the application directory: ${deploy_user}"

  [[ -f "$ENVIRONMENT_FILE" && ! -L "$ENVIRONMENT_FILE" ]] ||
    fail "production environment must be a non-symlink regular file: ${ENVIRONMENT_FILE}"
  env_shape="$(numeric_shape "$ENVIRONMENT_FILE")"
  env_uid="${env_shape%%:*}"
  env_mode="${env_shape##*:}"
  [[ "$env_uid" == "$deploy_uid" || "$env_uid" == '0' ]] ||
    fail "production environment owner must be root or deployment user before adoption: ${env_shape}"
  [[ "$env_mode" == '600' ]] || fail "production environment must be mode 600 before adoption: ${env_shape}"
}

assert_service_account_shape() {
  local passwd_entry=''
  local account_home=''
  local account_shell=''
  local primary_group=''
  local group_name=''

  passwd_entry="$(/usr/bin/getent passwd "$SERVICE_USER")" || fail "service user is missing: ${SERVICE_USER}"
  account_home="$(printf '%s\n' "$passwd_entry" | /usr/bin/cut -d: -f6)"
  account_shell="$(printf '%s\n' "$passwd_entry" | /usr/bin/cut -d: -f7)"
  primary_group="$(/usr/bin/id -gn "$SERVICE_USER")"
  [[ "$account_home" == "$SERVICE_HOME" ]] || fail "unexpected service home: ${account_home}"
  [[ "$account_shell" == '/usr/sbin/nologin' ]] || fail "unexpected service shell: ${account_shell}"
  [[ "$primary_group" == "$SERVICE_GROUP" ]] || fail "unexpected service primary group: ${primary_group}"
  while IFS= read -r group_name; do
    case "$group_name" in
      "$SERVICE_GROUP"|'') ;;
      *) fail "service user has unexpected supplementary group: ${group_name}" ;;
    esac
  done < <(/usr/bin/id -nG "$SERVICE_USER" | /usr/bin/tr ' ' '\n')
  [[ "$(/usr/bin/id -u "$SERVICE_USER")" -ne 0 ]] || fail 'service user must not be root'
}

render_sudoers() {
  local deploy_user="$1"

  printf '%s ALL=(root) NOPASSWD: %s\n' "$deploy_user" "$WRAPPER_PATH"
}

assert_managed_sudoers() {
  local deploy_user="$1"
  local expected=''
  local actual=''

  assert_root_regular_file "$SUDOERS_PATH" 440 'managed deployment sudoers policy'
  expected="$(render_sudoers "$deploy_user")"
  actual="$(<"$SUDOERS_PATH")"
  [[ "$actual" == "$expected" ]] || fail 'managed sudoers policy differs from reviewed single-wrapper rule'
  /usr/sbin/visudo -cf "$SUDOERS_PATH" >/dev/null
}

assert_runtime_identity() {
  local service_user=''
  local service_group=''
  local main_pid=''
  local expected_uid=''
  local expected_gid=''
  local process_uid=''
  local process_gid=''

  service_user="$(/usr/bin/systemctl show "$SERVICE_UNIT" --property=User --value)"
  service_group="$(/usr/bin/systemctl show "$SERVICE_UNIT" --property=Group --value)"
  main_pid="$(/usr/bin/systemctl show "$SERVICE_UNIT" --property=MainPID --value)"
  [[ "$service_user" == "$SERVICE_USER" ]] || fail "systemd User mismatch: ${service_user}"
  [[ "$service_group" == "$SERVICE_GROUP" ]] || fail "systemd Group mismatch: ${service_group}"
  [[ "$main_pid" =~ ^[1-9][0-9]*$ ]] || fail "service MainPID is invalid: ${main_pid}"
  expected_uid="$(/usr/bin/id -u "$SERVICE_USER")"
  expected_gid="$(/usr/bin/getent group "$SERVICE_GROUP" | /usr/bin/cut -d: -f3)"
  process_uid="$(/usr/bin/stat -c '%u' "/proc/${main_pid}")"
  process_gid="$(/usr/bin/awk '/^Gid:/ { print $3 }' "/proc/${main_pid}/status")"
  [[ "$process_uid" == "$expected_uid" ]] || fail "service MainPID uid mismatch: ${process_uid}"
  [[ "$process_gid" == "$expected_gid" ]] || fail "service MainPID gid mismatch: ${process_gid}"
  /usr/bin/systemctl is-active --quiet "$SERVICE_UNIT" || fail 'service is not active'
}

assert_negative_permissions() {
  local deploy_user="$1"

  /usr/sbin/runuser -u "$deploy_user" -- /usr/bin/test ! -r "$ENVIRONMENT_FILE" ||
    fail 'deployment user can read the production environment'
  /usr/sbin/runuser -u "$deploy_user" -- /usr/bin/test ! -w "$ENVIRONMENT_FILE" ||
    fail 'deployment user can write the production environment'
  /usr/sbin/runuser -u "$SERVICE_USER" -- /usr/bin/test ! -r "$ENVIRONMENT_FILE" ||
    fail 'service user can read the production environment directly'
  /usr/sbin/runuser -u "$SERVICE_USER" -- /usr/bin/test ! -w "$APPLICATION_DIR" ||
    fail 'service user can write the application directory'
  if /usr/bin/id -nG "$deploy_user" | /usr/bin/tr ' ' '\n' | /usr/bin/grep -Fxq docker; then
    fail 'deployment user must not belong to the docker group'
  fi
  if /usr/bin/id -nG "$SERVICE_USER" | /usr/bin/tr ' ' '\n' | /usr/bin/grep -Fxq docker; then
    fail 'service user must not belong to the docker group'
  fi
  if /usr/sbin/runuser -u "$deploy_user" -- /usr/bin/sudo -n /usr/bin/true 2>/dev/null; then
    fail 'deployment user still has unrestricted passwordless sudo'
  fi
  /usr/sbin/runuser -u "$deploy_user" -- /usr/bin/sudo -n -- "$WRAPPER_PATH" service-user >/dev/null ||
    fail 'deployment user cannot run the reviewed service-user probe'
  if /usr/sbin/runuser -u "$deploy_user" -- /usr/bin/sudo -n -- "$WRAPPER_PATH" not-allowed >/dev/null 2>&1; then
    fail 'privileged wrapper accepted an unknown command token'
  fi
}

preflight() {
  local deploy_user="$1"
  local broad_sudoers_path="$2"
  local broad_sha=''
  local unit_sha=''

  require_root
  assert_source_files
  assert_deploy_user "$deploy_user"
  assert_application_baseline "$deploy_user"
  if /usr/bin/getent passwd "$SERVICE_USER" >/dev/null; then
    assert_service_account_shape
  elif /usr/bin/getent group "$SERVICE_GROUP" >/dev/null; then
    fail "service group exists without its service user: ${SERVICE_GROUP}"
  fi
  assert_root_regular_file "$UNIT_PATH" 644 'installed service unit'
  assert_safe_sudoers_path "$broad_sudoers_path"
  /usr/sbin/visudo -cf "$broad_sudoers_path" >/dev/null
  [[ "$(/usr/bin/awk -v user="$deploy_user" 'NF && $1 !~ /^#/ { active += 1; if ($1 == user) named += 1 } END { print active + 0 ":" named + 0 }' "$broad_sudoers_path")" == '1:1' ]] ||
    fail 'existing broad sudoers file must contain exactly one active rule for the deployment user so unrelated access is never removed'
  if ! /usr/sbin/runuser -u "$deploy_user" -- /usr/bin/sudo -n /usr/bin/true 2>/dev/null; then
    fail 'deployment user does not currently have the expected unrestricted passwordless sudo baseline'
  fi
  [[ ! -e "$STATE_DIR" && ! -L "$STATE_DIR" ]] ||
    fail "adoption state already exists; run verify or guarded rollback: ${STATE_DIR}"
  [[ ! -e "$SUDOERS_PATH" && ! -L "$SUDOERS_PATH" ]] ||
    fail "managed sudoers path already exists before adoption: ${SUDOERS_PATH}"
  [[ ! -e "$WRAPPER_PATH" && ! -L "$WRAPPER_PATH" ]] ||
    fail "managed wrapper path already exists before adoption: ${WRAPPER_PATH}"
  /usr/bin/systemctl is-active --quiet "$SERVICE_UNIT" || fail 'service must be active before adoption'
  broad_sha="$(file_sha256 "$broad_sudoers_path")"
  unit_sha="$(file_sha256 "$UNIT_PATH")"
  printf 'PROJ-2268 preflight passed.\n'
  printf 'broad_sudoers_path=%s\n' "$broad_sudoers_path"
  printf 'broad_sudoers_sha256=%s\n' "$broad_sha"
  printf 'unit_sha256=%s\n' "$unit_sha"
  printf 'repository_sha=%s\n' "$(/usr/bin/git -C "${SOURCE_DIR}/.." rev-parse HEAD)"
  printf 'environment_shape=%s\n' "$(numeric_shape "$ENVIRONMENT_FILE")"
}

write_state() {
  local deploy_user="$1"
  local broad_sudoers_path="$2"
  local env_shape="$3"
  local service_user_phase="$4"
  local service_group_phase="$5"
  [[ ! -e "$STATE_TMP" && ! -L "$STATE_TMP" ]] || fail "adoption state temporary path already exists: ${STATE_TMP}"
  /usr/bin/install -o root -g root -m 0600 /dev/null "$STATE_TMP"
  {
    printf 'version=2\n'
    printf 'deploy_user=%s\n' "$deploy_user"
    printf 'broad_sudoers_path=%s\n' "$broad_sudoers_path"
    printf 'environment_shape=%s\n' "$env_shape"
    printf 'unit_backup_sha256=%s\n' "$(file_sha256 "$UNIT_BACKUP")"
    printf 'sudoers_backup_sha256=%s\n' "$(file_sha256 "$SUDOERS_BACKUP")"
    printf 'service_user_phase=%s\n' "$service_user_phase"
    printf 'service_group_phase=%s\n' "$service_group_phase"
  } >"$STATE_TMP"
  /usr/bin/mv -f -- "$STATE_TMP" "$STATE_FILE"
}

read_state_value() {
  local key="$1"
  local value=''

  value="$(/usr/bin/awk -F= -v key="$key" '$1 == key { sub(/^[^=]*=/, ""); print; found += 1 } END { if (found != 1) exit 1 }' "$STATE_FILE")" ||
    fail "adoption state is missing one ${key} record"
  printf '%s' "$value"
}

assert_state_shape() {
  assert_root_regular_file "$STATE_FILE" 600 'adoption state file'
  assert_root_regular_file "$UNIT_BACKUP" 600 'service unit backup'
  assert_root_regular_file "$SUDOERS_BACKUP" 600 'deployment sudoers backup'
  [[ ! -e "$STATE_TMP" && ! -L "$STATE_TMP" ]] || fail 'adoption state has an incomplete journal write'
  [[ "$(read_state_value version)" == '2' ]] || fail 'unsupported adoption state version'
  [[ "$(file_sha256 "$UNIT_BACKUP")" == "$(read_state_value unit_backup_sha256)" ]] ||
    fail 'service unit backup digest mismatch'
  [[ "$(file_sha256 "$SUDOERS_BACKUP")" == "$(read_state_value sudoers_backup_sha256)" ]] ||
    fail 'deployment sudoers backup digest mismatch'
}

verify_policy() {
  local deploy_user="$1"
  local broad_sudoers_path=''

  require_root
  assert_source_files
  assert_deploy_user "$deploy_user"
  assert_state_shape
  [[ "$(read_state_value deploy_user)" == "$deploy_user" ]] || fail 'deployment user differs from adoption state'
  broad_sudoers_path="$(read_state_value broad_sudoers_path)"
  require_safe_sudoers_path "$broad_sudoers_path"
  [[ ! -e "$broad_sudoers_path" && ! -L "$broad_sudoers_path" ]] ||
    fail "superseded broad sudoers policy still exists: ${broad_sudoers_path}"
  assert_service_account_shape
  assert_root_regular_file "$ENVIRONMENT_FILE" 600 'production environment'
  assert_root_regular_file "$UNIT_PATH" 644 'installed service unit'
  [[ "$(file_sha256 "$UNIT_PATH")" == "$(file_sha256 "$UNIT_SOURCE")" ]] ||
    fail 'installed service unit differs from reviewed source'
  assert_root_regular_file "$WRAPPER_PATH" 755 'installed privileged wrapper'
  [[ "$(file_sha256 "$WRAPPER_PATH")" == "$(file_sha256 "$WRAPPER_SOURCE")" ]] ||
    fail 'installed privileged wrapper differs from reviewed source'
  assert_managed_sudoers "$deploy_user"
  /usr/sbin/visudo -c >/dev/null
  assert_runtime_identity
  assert_negative_permissions "$deploy_user"
  printf '%s\n' 'PROJ-2268 host identity verification passed.'
}

rollback_internal() {
  local expected_deploy_user="$1"
  local deploy_user=''
  local broad_sudoers_path=''
  local env_shape=''
  local env_uid=''
  local env_gid=''
  local env_mode=''
  local service_user_phase=''
  local service_group_phase=''
  local current_unit_sha=''
  local current_env_shape=''
  local restore_service='false'
  local state_cleanup_complete='true'

  assert_state_shape
  deploy_user="$(read_state_value deploy_user)"
  [[ "$deploy_user" == "$expected_deploy_user" ]] || fail 'rollback deployment user differs from adoption state'
  broad_sudoers_path="$(read_state_value broad_sudoers_path)"
  require_safe_sudoers_path "$broad_sudoers_path"
  env_shape="$(read_state_value environment_shape)"
  IFS=: read -r env_uid env_gid env_mode <<<"$env_shape"
  [[ "$env_uid" =~ ^[0-9]+$ && "$env_gid" =~ ^[0-9]+$ && "$env_mode" =~ ^[0-7]{3,4}$ ]] ||
    fail 'rollback environment metadata is malformed'
  service_user_phase="$(read_state_value service_user_phase)"
  service_group_phase="$(read_state_value service_group_phase)"
  [[ "$service_user_phase" == 'unchanged' || "$service_user_phase" == 'create-pending' || "$service_user_phase" == 'created' ]] ||
    fail 'invalid service-user phase'
  [[ "$service_group_phase" == 'unchanged' || "$service_group_phase" == 'create-pending' || "$service_group_phase" == 'created' ]] ||
    fail 'invalid service-group phase'

  if [[ -e "$broad_sudoers_path" || -L "$broad_sudoers_path" ]]; then
    assert_safe_sudoers_path "$broad_sudoers_path"
    [[ "$(file_sha256 "$broad_sudoers_path")" == "$(file_sha256 "$SUDOERS_BACKUP")" ]] ||
      fail 'existing rollback sudoers target differs from the pinned backup'
  else
    /usr/bin/install -o root -g root -m 0440 "$SUDOERS_BACKUP" "$broad_sudoers_path"
  fi
  /usr/sbin/visudo -cf "$broad_sudoers_path" >/dev/null
  /usr/bin/rm -f -- "$SUDOERS_PATH"
  /usr/sbin/visudo -c >/dev/null
  current_unit_sha="$(file_sha256 "$UNIT_PATH")"
  current_env_shape="$(numeric_shape "$ENVIRONMENT_FILE")"
  if [[ "$current_unit_sha" != "$(file_sha256 "$UNIT_BACKUP")" ]]; then
    /usr/bin/install -o root -g root -m 0644 "$UNIT_BACKUP" "$UNIT_PATH"
    restore_service='true'
  fi
  if [[ "$current_env_shape" != "$env_shape" ]]; then
    /usr/bin/chown "${env_uid}:${env_gid}" "$ENVIRONMENT_FILE"
    /bin/chmod "$env_mode" "$ENVIRONMENT_FILE"
    restore_service='true'
  fi
  if [[ "$restore_service" == 'true' ]]; then
    /usr/bin/systemctl daemon-reload
    /usr/bin/systemctl restart "$SERVICE_UNIT"
    /usr/bin/systemctl is-active --quiet "$SERVICE_UNIT" || fail 'rollback did not restore an active service'
  fi
  /usr/bin/rm -f -- "$WRAPPER_PATH"

  if [[ "$service_user_phase" != 'unchanged' ]] && /usr/bin/getent passwd "$SERVICE_USER" >/dev/null; then
    [[ -z "$(/usr/bin/ps -u "$SERVICE_USER" -o pid= 2>/dev/null)" ]] || fail 'service user still owns a process after rollback'
    /usr/sbin/userdel "$SERVICE_USER"
  fi
  if [[ "$service_group_phase" != 'unchanged' ]] && /usr/bin/getent group "$SERVICE_GROUP" >/dev/null; then
    /usr/sbin/groupdel "$SERVICE_GROUP"
  fi
  /usr/bin/rm -f -- "$STATE_FILE" "$STATE_TMP" "$UNIT_BACKUP" "$SUDOERS_BACKUP"
  if ! /usr/bin/rmdir "$STATE_DIR" 2>/dev/null; then
    state_cleanup_complete='false'
    printf '%s\n' \
      "PROJ-2268 rollback restored host state, but ${STATE_DIR} contains unowned entries; remove them manually before another adoption." >&2
    /usr/bin/find "$STATE_DIR" -mindepth 1 -maxdepth 1 -printf '%f\n' >&2
  fi
  if [[ "$state_cleanup_complete" == 'true' ]]; then
    printf '%s\n' 'PROJ-2268 host identity rollback completed.'
  else
    printf '%s\n' 'PROJ-2268 host identity rollback restored; evidence cleanup remains.'
  fi
}

rollback_partial_adoption() {
  if [[ -f "$STATE_FILE" && ! -L "$STATE_FILE" && \
        -f "$UNIT_BACKUP" && ! -L "$UNIT_BACKUP" && \
        -f "$SUDOERS_BACKUP" && ! -L "$SUDOERS_BACKUP" ]]; then
    /usr/bin/rm -f -- "$STATE_TMP"
    rollback_internal "$1"
    return
  fi

  /usr/bin/rm -f -- "$STATE_FILE" "$STATE_TMP" "$UNIT_BACKUP" "$SUDOERS_BACKUP"
  if [[ -e "$STATE_DIR" || -L "$STATE_DIR" ]]; then
    [[ -d "$STATE_DIR" && ! -L "$STATE_DIR" ]] || fail "partial adoption state is unsafe: ${STATE_DIR}"
    /usr/bin/rmdir "$STATE_DIR" || fail "partial adoption state contains unowned entries: ${STATE_DIR}"
  fi
}

apply_failure_rollback() {
  local status="$1"
  local deploy_user="$2"

  trap - EXIT
  [[ "${applying:-false}" == 'true' && "$status" -ne 0 ]] || return 0
  applying='false'
  printf '%s\n' 'PROJ-2268 apply failed; attempting guarded rollback' >&2
  if ! (rollback_partial_adoption "$deploy_user"); then
    printf '%s\n' 'PROJ-2268 guarded rollback failed; manual root recovery required' >&2
  fi
}

apply_policy() {
  local deploy_user="$1"
  local broad_sudoers_path="$2"
  local expected_sudoers_sha="$3"
  local expected_unit_sha="$4"
  local expected_repository_sha="$5"
  local confirmation="$6"
  local env_shape=''
  local service_user_phase='unchanged'
  local service_group_phase='unchanged'
  local sudoers_tmp=''
  local applying='false'

  require_root
  [[ "$confirmation" == "$APPLY_CONFIRMATION" ]] || fail 'apply confirmation phrase does not match'
  require_sha256 "$expected_sudoers_sha" 'expected sudoers digest'
  require_sha256 "$expected_unit_sha" 'expected unit digest'
  assert_reviewed_checkout "$deploy_user" "$expected_repository_sha"
  if [[ -f "$STATE_FILE" && ! -L "$STATE_FILE" ]]; then
    verify_policy "$deploy_user"
    printf '%s\n' 'PROJ-2268 adoption is already applied.'
    return
  fi
  preflight "$deploy_user" "$broad_sudoers_path" >/dev/null
  [[ "$(file_sha256 "$broad_sudoers_path")" == "$expected_sudoers_sha" ]] ||
    fail 'existing broad sudoers policy changed after review'
  [[ "$(file_sha256 "$UNIT_PATH")" == "$expected_unit_sha" ]] ||
    fail 'installed service unit changed after review'
  env_shape="$(numeric_shape "$ENVIRONMENT_FILE")"

  applying='true'
  trap 'apply_failure_rollback "$?" "$deploy_user"' EXIT
  /usr/bin/install -d -o root -g root -m 0700 "$STATE_DIR"
  /usr/bin/install -o root -g root -m 0600 "$UNIT_PATH" "$UNIT_BACKUP"
  /usr/bin/install -o root -g root -m 0600 "$broad_sudoers_path" "$SUDOERS_BACKUP"
  write_state "$deploy_user" "$broad_sudoers_path" "$env_shape" "$service_user_phase" "$service_group_phase"

  if ! /usr/bin/getent group "$SERVICE_GROUP" >/dev/null; then
    service_group_phase='create-pending'
    write_state "$deploy_user" "$broad_sudoers_path" "$env_shape" "$service_user_phase" "$service_group_phase"
    /usr/sbin/groupadd --system "$SERVICE_GROUP"
    service_group_phase='created'
    write_state "$deploy_user" "$broad_sudoers_path" "$env_shape" "$service_user_phase" "$service_group_phase"
  fi
  if ! /usr/bin/getent passwd "$SERVICE_USER" >/dev/null; then
    service_user_phase='create-pending'
    write_state "$deploy_user" "$broad_sudoers_path" "$env_shape" "$service_user_phase" "$service_group_phase"
    /usr/sbin/useradd --system --gid "$SERVICE_GROUP" --home-dir "$SERVICE_HOME" \
      --shell /usr/sbin/nologin --no-create-home "$SERVICE_USER"
    service_user_phase='created'
    write_state "$deploy_user" "$broad_sudoers_path" "$env_shape" "$service_user_phase" "$service_group_phase"
  fi
  assert_service_account_shape
  /usr/sbin/runuser -u "$SERVICE_USER" -- /usr/bin/test -r "${APPLICATION_DIR}/dist/index.js" ||
    fail 'service user cannot read the production entry point'
  /usr/sbin/runuser -u "$SERVICE_USER" -- /usr/bin/test -x /usr/bin/node ||
    fail 'service user cannot execute the Node runtime'

  /usr/bin/install -o root -g root -m 0755 "$WRAPPER_SOURCE" "$WRAPPER_PATH"
  sudoers_tmp="$(/usr/bin/mktemp)"
  render_sudoers "$deploy_user" >"$sudoers_tmp"
  /bin/chmod 0440 "$sudoers_tmp"
  /usr/sbin/visudo -cf "$sudoers_tmp" >/dev/null
  /usr/bin/install -o root -g root -m 0440 "$sudoers_tmp" "$SUDOERS_PATH"
  /usr/bin/rm -f -- "$sudoers_tmp"
  /usr/bin/chown root:root "$ENVIRONMENT_FILE"
  /bin/chmod 0600 "$ENVIRONMENT_FILE"
  /usr/bin/install -o root -g root -m 0644 "$UNIT_SOURCE" "$UNIT_PATH"
  /usr/bin/systemctl daemon-reload
  /usr/bin/systemctl restart "$SERVICE_UNIT"
  assert_runtime_identity
  /usr/bin/rm -f -- "$broad_sudoers_path"
  /usr/sbin/visudo -c >/dev/null
  verify_policy "$deploy_user"
  applying='false'
  trap - EXIT
  printf '%s\n' 'PROJ-2268 host identity adoption applied.'
}

rollback_policy() {
  local deploy_user="$1"
  local confirmation="$2"

  require_root
  [[ "$confirmation" == "$ROLLBACK_CONFIRMATION" ]] || fail 'rollback confirmation phrase does not match'
  rollback_internal "$deploy_user"
}

print_plan() {
  printf '%s\n' \
    'PROJ-2268 repository-only host-adoption plan:' \
    '- preflight prints only current unit/sudoers SHA-256 digests and file metadata' \
    '- apply requires those exact digests plus CONFIRM-CORGI-HOST-IDENTITY-ADOPTION' \
    '- service identity: bluesky-feed:bluesky-feed with /usr/sbin/nologin' \
    '- production .env target: root:root mode 600; contents are never read or printed' \
    '- deployment privilege: one root-owned dispatcher with a closed command allowlist' \
    '- service transition: daemon-reload and one restart, requiring separate exact-head production approval' \
    '- rollback restores the pinned unit, sudoers policy, and .env metadata before removing created identities' \
    '- no deploy, migration, candidate transfer, GitHub environment change, or key operation is included'
}

main() {
  local operation="${1:-}"

  [[ -n "$operation" ]] || {
    usage >&2
    fail 'one operation is required'
  }
  shift
  case "$operation" in
    plan)
      require_arg_count 0 "$#" "$operation"
      print_plan
      ;;
    preflight)
      require_arg_count 2 "$#" "$operation"
      preflight "$1" "$2"
      ;;
    apply)
      require_arg_count 6 "$#" "$operation"
      apply_policy "$1" "$2" "$3" "$4" "$5" "$6"
      ;;
    verify)
      require_arg_count 1 "$#" "$operation"
      verify_policy "$1"
      ;;
    rollback)
      require_arg_count 2 "$#" "$operation"
      rollback_policy "$1" "$2"
      ;;
    *)
      usage >&2
      fail "unknown operation: ${operation}"
      ;;
  esac
}

if [[ "${CORGI_HOST_IDENTITY_LIBRARY_ONLY:-0}" != '1' ]]; then
  main "$@"
fi
