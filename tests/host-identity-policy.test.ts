import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEPLOY_WORKFLOW_PATH = path.join(REPO_ROOT, '.github', 'workflows', 'deploy.yml');
const PROVISIONER_PATH = path.join(REPO_ROOT, 'ops', 'provision-corgi-host-identity.sh');
const ROOT_WRAPPER_PATH = path.join(REPO_ROOT, 'ops', 'corgi-deploy-root');
const SERVICE_UNIT_PATH = path.join(REPO_ROOT, 'ops', 'bluesky-feed.service');

const ALLOWED_ROOT_COMMANDS = [
  'service-user',
  'service-group',
  'service-main-pid',
  'service-is-active',
  'service-state',
  'service-restart',
  'service-can-read-entrypoint',
  'postgres-ingestion-signals',
  'demo-redis-ping',
  'demo-redis-exists',
  'production-redis-exists',
  'demo-redis-maxmemory-policy',
  'demo-redis-maxmemory',
  'demo-redis-appendonly',
  'demo-redis-save',
] as const;

function assertSpawnCompleted(result: SpawnSyncReturns<string>): void {
  expect(result.error).toBeUndefined();
  expect(result.status).not.toBeNull();
  expect(result.signal).toBeNull();
}

function runSourcedFunction(
  scriptPath: string,
  libraryEnvironmentName: string,
  functionName: string,
  args: string[],
): SpawnSyncReturns<string> {
  return spawnSync(
    '/bin/bash',
    ['-c', 'source "$1"; shift; "$@"', 'bash', scriptPath, functionName, ...args],
    {
      encoding: 'utf8',
      env: {
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
        [libraryEnvironmentName]: '1',
      },
      timeout: 5_000,
    },
  );
}

describe('PROJ-2268 host identity policy', () => {
  it('keeps the privileged dispatcher closed over exact command tokens', () => {
    const wrapper = readFileSync(ROOT_WRAPPER_PATH, 'utf8');
    const caseLabels = Array.from(
      wrapper.matchAll(/^    ([a-z][a-z-]+)\)$/gm),
      (match) => match[1],
    );

    expect(caseLabels).toEqual(ALLOWED_ROOT_COMMANDS);
    expect(wrapper).not.toContain('$SSH_ORIGINAL_COMMAND');
    expect(wrapper).not.toContain('eval ');
    expect(wrapper).not.toContain('bash -c');
    expect(wrapper).not.toContain('sh -c');
    expect(wrapper).toContain("readonly SERVICE_UNIT='bluesky-feed'");
    expect(wrapper).toContain("readonly SERVICE_ENTRYPOINT='/opt/bluesky-feed/dist/index.js'");
    expect(wrapper).toContain("readonly POSTGRES_CONTAINER='bluesky-feed-postgres'");
    expect(wrapper).toContain("readonly DEMO_REDIS_CONTAINER='bluesky-feed-demo-redis'");
    expect(wrapper).toContain("readonly PRODUCTION_REDIS_CONTAINER='bluesky-feed-redis'");
  });

  it.each([
    '',
    'demo:session:demo-',
    'demo:session:demo-ok extra',
    'demo:session:demo-../escape',
    'feed:updated_at',
    `demo:session:demo-${'a'.repeat(129)}`,
  ])('rejects unsafe dynamic Redis key %j', (key) => {
    const result = runSourcedFunction(
      ROOT_WRAPPER_PATH,
      'CORGI_DEPLOY_ROOT_LIBRARY_ONLY',
      'require_demo_session_key',
      [key],
    );

    assertSpawnCompleted(result);
    expect(result.status).toBe(64);
    expect(result.stderr).toContain('Redis key must be one bounded demo session key');
  });

  it.each(['demo:session:demo-a', 'demo:session:demo-1234_ab-CD'])(
    'accepts bounded demo Redis key %j',
    (key) => {
      const result = runSourcedFunction(
        ROOT_WRAPPER_PATH,
        'CORGI_DEPLOY_ROOT_LIBRARY_ONLY',
        'require_demo_session_key',
        [key],
      );

      assertSpawnCompleted(result);
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
    },
  );

  it('routes every workflow privilege through the reviewed wrapper', () => {
    const workflow = readFileSync(DEPLOY_WORKFLOW_PATH, 'utf8');
    const invokedCommands = Array.from(
      workflow.matchAll(/corgi-deploy-root(?:[ \t]+\\\n)?[ \t\n]+([a-z][a-z-]+)/g),
      (match) => match[1],
    );

    expect(workflow).not.toMatch(/sudo(?: -n)? (?:\/usr\/bin\/)?systemctl/);
    expect(workflow).not.toMatch(/sudo(?: -n)? (?:\/usr\/bin\/)?docker/);
    expect(new Set(invokedCommands)).toEqual(new Set(ALLOWED_ROOT_COMMANDS));
    expect(workflow).toContain('sudo -n /usr/bin/true');
  });

  it('declares the dedicated systemd identity in the reviewed unit', () => {
    const unit = readFileSync(SERVICE_UNIT_PATH, 'utf8');

    expect(unit).toMatch(/^User=bluesky-feed$/m);
    expect(unit).toMatch(/^Group=bluesky-feed$/m);
    expect(unit).toMatch(/^EnvironmentFile=\/opt\/bluesky-feed\/\.env$/m);
    expect(unit).not.toMatch(/^User=root$/m);
  });

  it('keeps adoption digest-pinned, reversible, and non-recursive', () => {
    const provisioner = readFileSync(PROVISIONER_PATH, 'utf8');

    expect(provisioner).toContain('EXPECTED_SUDOERS_SHA256');
    expect(provisioner).toContain('EXPECTED_UNIT_SHA256');
    expect(provisioner).toContain('EXPECTED_REPOSITORY_SHA');
    expect(provisioner).toContain('CONFIRM-CORGI-HOST-IDENTITY-ADOPTION');
    expect(provisioner).toContain('CONFIRM-CORGI-HOST-IDENTITY-ROLLBACK');
    expect(provisioner).toContain("readonly STATE_DIR='/var/lib/corgi-host-adoption'");
    expect(provisioner).toContain('repository has tracked changes after exact-head approval');
    expect(provisioner).toContain('attempting guarded rollback');
    expect(provisioner).toContain('trap \'apply_failure_rollback "$?" "$deploy_user"\' EXIT');
    expect(provisioner).toContain('/usr/sbin/visudo -c');
    expect(provisioner).toContain('if ! /usr/bin/rmdir "$STATE_DIR"');
    expect(provisioner).toContain('rollback restored; evidence cleanup remains');
    expect(provisioner).not.toContain('rm -rf');
    expect(provisioner).not.toContain('chown -R');
    expect(provisioner).not.toContain('chmod -R');
    expect(provisioner).not.toContain('source "$STATE_FILE"');
  });

  it.each([
    { mode: 'fail', expectedStatus: 1, expectedRollback: true },
    { mode: 'return', expectedStatus: 1, expectedRollback: true },
    { mode: 'success', expectedStatus: 0, expectedRollback: false },
  ] as const)('runs guarded rollback on apply $mode', ({ mode, expectedStatus, expectedRollback }) => {
    const result = spawnSync(
      '/bin/bash',
      [
        '-c',
        `source "$1"
rollback_partial_adoption() { printf 'rollback:%s\\n' "$1"; }
applying=true
deploy_user=deploy-user
trap 'apply_failure_rollback "$?" "$deploy_user"' EXIT
case "$2" in
  fail) fail 'forced assertion failure' ;;
  return) /usr/bin/false ;;
  success) applying=false ;;
esac`,
        'bash',
        PROVISIONER_PATH,
        mode,
      ],
      {
        encoding: 'utf8',
        env: {
          PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
          CORGI_HOST_IDENTITY_LIBRARY_ONLY: '1',
        },
        timeout: 5_000,
      }
    );

    assertSpawnCompleted(result);
    expect(result.status).toBe(expectedStatus);
    expect(result.stdout.includes('rollback:deploy-user')).toBe(expectedRollback);
    expect(result.stderr.includes('attempting guarded rollback')).toBe(expectedRollback);
  });

  it('preserves apply failure and reports a failed guarded rollback', () => {
    const result = spawnSync(
      '/bin/bash',
      [
        '-c',
        `source "$1"
rollback_partial_adoption() { return 1; }
applying=true
deploy_user=deploy-user
trap 'apply_failure_rollback "$?" "$deploy_user"' EXIT
fail 'forced assertion failure'`,
        'bash',
        PROVISIONER_PATH,
      ],
      {
        encoding: 'utf8',
        env: {
          PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
          CORGI_HOST_IDENTITY_LIBRARY_ONLY: '1',
        },
        timeout: 5_000,
      }
    );

    assertSpawnCompleted(result);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('attempting guarded rollback');
    expect(result.stderr).toContain('guarded rollback failed; manual root recovery required');
  });

  it('journals identity creation intent before each account mutation', () => {
    const provisioner = readFileSync(PROVISIONER_PATH, 'utf8');
    const applyStart = provisioner.indexOf('apply_policy() {');
    const apply = provisioner.slice(applyStart);
    const trapIndex = apply.indexOf('trap \'apply_failure_rollback');
    const stateDirectoryIndex = apply.indexOf('/usr/bin/install -d -o root -g root -m 0700 "$STATE_DIR"');
    const groupPendingIndex = apply.indexOf("service_group_phase='create-pending'");
    const groupPendingWriteIndex = apply.indexOf('write_state', groupPendingIndex);
    const groupAddIndex = apply.indexOf('/usr/sbin/groupadd --system "$SERVICE_GROUP"');
    const userPendingIndex = apply.indexOf("service_user_phase='create-pending'");
    const userPendingWriteIndex = apply.indexOf('write_state', userPendingIndex);
    const userAddIndex = apply.indexOf('/usr/sbin/useradd --system');

    expect(trapIndex).toBeGreaterThanOrEqual(0);
    expect(stateDirectoryIndex).toBeGreaterThan(trapIndex);
    expect(groupPendingIndex).toBeGreaterThan(stateDirectoryIndex);
    expect(groupPendingWriteIndex).toBeGreaterThan(groupPendingIndex);
    expect(groupAddIndex).toBeGreaterThan(groupPendingWriteIndex);
    expect(userPendingIndex).toBeGreaterThan(groupAddIndex);
    expect(userPendingWriteIndex).toBeGreaterThan(userPendingIndex);
    expect(userAddIndex).toBeGreaterThan(userPendingWriteIndex);
    expect(provisioner).toContain("$service_group_phase\" != 'unchanged'");
    expect(provisioner).toContain("$service_user_phase\" != 'unchanged'");
  });

  it('renders one exact sudo target for the named deployment user', () => {
    const result = runSourcedFunction(
      PROVISIONER_PATH,
      'CORGI_HOST_IDENTITY_LIBRARY_ONLY',
      'render_sudoers',
      ['deploy-user'],
    );

    assertSpawnCompleted(result);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe(
      'deploy-user ALL=(root) NOPASSWD: /usr/local/sbin/corgi-deploy-root\n',
    );
  });

  it.each(['/etc/sudoers', '/etc/sudoers.d/../sudoers', '/tmp/deploy-policy'])(
    'rejects unsafe broad sudoers path %j',
    (sudoersPath) => {
      const result = runSourcedFunction(
        PROVISIONER_PATH,
        'CORGI_HOST_IDENTITY_LIBRARY_ONLY',
        'require_safe_sudoers_path',
        [sudoersPath],
      );

      assertSpawnCompleted(result);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('broad sudoers path');
    },
  );

  it('requires lowercase full SHA-256 digests', () => {
    const valid = runSourcedFunction(
      PROVISIONER_PATH,
      'CORGI_HOST_IDENTITY_LIBRARY_ONLY',
      'require_sha256',
      ['a'.repeat(64), 'test digest'],
    );
    const invalid = runSourcedFunction(
      PROVISIONER_PATH,
      'CORGI_HOST_IDENTITY_LIBRARY_ONLY',
      'require_sha256',
      ['A'.repeat(64), 'test digest'],
    );

    assertSpawnCompleted(valid);
    assertSpawnCompleted(invalid);
    expect(valid.status).toBe(0);
    expect(invalid.status).toBe(1);
    expect(invalid.stderr).toContain('must be a lowercase SHA-256 digest');
  });

  it('passes shell syntax and exposes a non-mutating plan mode', () => {
    for (const scriptPath of [ROOT_WRAPPER_PATH, PROVISIONER_PATH]) {
      const syntax = spawnSync('/bin/bash', ['-n', scriptPath], {
        encoding: 'utf8',
        timeout: 5_000,
      });
      assertSpawnCompleted(syntax);
      expect(syntax.status).toBe(0);
      expect(syntax.stderr).toBe('');
    }

    const plan = spawnSync('/bin/bash', [PROVISIONER_PATH, 'plan'], {
      encoding: 'utf8',
      timeout: 5_000,
    });
    assertSpawnCompleted(plan);
    expect(plan.status).toBe(0);
    expect(plan.stderr).toBe('');
    expect(plan.stdout).toContain('repository-only host-adoption plan');
    expect(plan.stdout).toContain('contents are never read or printed');
    expect(plan.stdout).toContain('requiring separate exact-head production approval');
  });
});
