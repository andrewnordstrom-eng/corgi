import { spawn, spawnSync, type SpawnSyncReturns } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DISPATCHER_PATH = path.join(REPO_ROOT, 'ops', 'corgi-operations-command');
const REDIS_READER_PATH = path.join(REPO_ROOT, 'ops', 'corgi-read-feed-updated-at');
const PROVISIONER_PATH = path.join(
  REPO_ROOT,
  'ops',
  'provision-corgi-operations-principal.sh',
);
const DIRECT_DATABASE_PATH = path.join(REPO_ROOT, 'cli', 'src', 'direct.ts');

function assertSpawnCompleted(result: SpawnSyncReturns<string>): void {
  expect(result.error).toBeUndefined();
  expect(result.status).not.toBeNull();
  expect(result.signal).toBeNull();
}

function runDispatcher(command: string, input: string | undefined): SpawnSyncReturns<string> {
  return spawnSync('/usr/bin/env', ['bash', DISPATCHER_PATH], {
    encoding: 'utf8',
    env: {
      PATH: '/usr/bin:/bin',
      SSH_ORIGINAL_COMMAND: command,
    },
    input,
    timeout: 5_000,
  });
}

async function runDispatcherWithOpenStdin(command: string, input: string): Promise<{
  code: number | null;
  elapsedMillis: number;
  stderr: string;
}> {
  const startedAt = Date.now();
  const child = spawn('/usr/bin/env', ['bash', DISPATCHER_PATH], {
    env: {
      PATH: '/usr/bin:/bin',
      SSH_ORIGINAL_COMMAND: command,
    },
    stdio: ['pipe', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  child.stdin.write(input);

  const code = await new Promise<number | null>((resolve, reject) => {
    const guard = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('dispatcher did not enforce its five-second input deadline'));
    }, 7_000);
    child.once('error', (error) => {
      clearTimeout(guard);
      reject(error);
    });
    child.once('close', (exitCode) => {
      clearTimeout(guard);
      resolve(exitCode);
    });
  });

  return {
    code,
    elapsedMillis: Date.now() - startedAt,
    stderr,
  };
}

function createAcceptanceInputs(): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'corgi-operations-acceptance-'));
  writeFileSync(path.join(directory, 'private-key'), 'test-private-key\n', { mode: 0o600 });
  writeFileSync(path.join(directory, 'known-hosts'), 'test-host-key\n', { mode: 0o644 });
  writeFileSync(path.join(directory, 'database-url'), 'postgresql://test.invalid/db\n', {
    mode: 0o600,
  });
  return directory;
}

function runAcceptance(directory: string, databaseUrlPath: string): SpawnSyncReturns<string> {
  return spawnSync(
    'bash',
    [
      PROVISIONER_PATH,
      'acceptance',
      'invalid.example',
      path.join(directory, 'private-key'),
      path.join(directory, 'known-hosts'),
      databaseUrlPath,
    ],
    {
      encoding: 'utf8',
      timeout: 5_000,
    },
  );
}

function runProvisionerFunction(functionName: string, args: string[]): SpawnSyncReturns<string> {
  return spawnSync(
    '/bin/bash',
    ['-c', 'source "$1"; shift; "$@"', 'bash', PROVISIONER_PATH, functionName, ...args],
    {
      encoding: 'utf8',
      timeout: 5_000,
    },
  );
}

describe('PROJ-2258 operations principal policy', () => {
  it('keeps the dispatcher allowlist exact and argument-free', () => {
    const dispatcher = readFileSync(DISPATCHER_PATH, 'utf8');
    const caseLabels = Array.from(dispatcher.matchAll(/^  ([a-z-]+)\)$/gm), (match) => match[1]);

    expect(caseLabels).toEqual([
      'epoch-status',
      'disk-root',
      'health-ready',
      'feed-updated-at',
    ]);
    expect(dispatcher).not.toContain('eval ');
    expect(dispatcher).not.toContain('sh -c');
    expect(dispatcher).not.toContain('bash -c');
    expect(dispatcher).not.toContain('docker exec');
  });

  it.each([
    '',
    'epoch-status --help',
    'cat /opt/bluesky-feed/.env',
    'docker exec bluesky-feed-redis redis-cli FLUSHALL',
    'touch /opt/bluesky-feed/PROJ-2258-negative-test',
    'sudo systemctl restart bluesky-feed.service',
  ])('denies the unlisted SSH command %j', (command) => {
    const result = runDispatcher(command, undefined);

    assertSpawnCompleted(result);
    expect(result.status).toBe(64);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('corgi-operations: command denied:');
  });

  it.each([
    {
      input: '',
      message: 'requires one newline-terminated database URL within five seconds',
    },
    {
      input: 'https://example.invalid/db\n',
      message: 'rejected an invalid database URL scheme',
    },
    {
      input: 'postgresql://example.invalid/db\nsecond-line\n',
      message: 'accepts exactly one input line',
    },
    {
      input: 'postgresql://example.invalid/db\nsecond-line',
      message: 'accepts exactly one input line',
    },
    {
      input: `postgresql://${'a'.repeat(4_100)}\n`,
      message: 'database URL exceeds 4096 bytes',
    },
  ])('rejects invalid epoch-status stdin: $message', ({ input, message }) => {
    const result = runDispatcher('epoch-status', input);

    assertSpawnCompleted(result);
    expect(result.status).toBe(65);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(message);
  });

  it(
    'rejects an unterminated database URL while the sender keeps stdin open',
    async () => {
      const result = await runDispatcherWithOpenStdin(
        'epoch-status',
        'postgresql://example.invalid/db',
      );

      expect(result.code).toBe(65);
      expect(result.elapsedMillis).toBeGreaterThanOrEqual(4_500);
      expect(result.elapsedMillis).toBeLessThan(6_500);
      expect(result.stderr).toContain(
        'requires one newline-terminated database URL within five seconds',
      );
    },
    8_000,
  );

  it('fixes the Redis container, executable, subcommand, and key', () => {
    const redisReader = readFileSync(REDIS_READER_PATH, 'utf8');

    expect(redisReader).toMatch(
      /exec \/usr\/bin\/timeout --foreground 15s \\\n  \/usr\/bin\/docker exec bluesky-feed-redis \\\n  redis-cli --raw GET feed:updated_at/,
    );
    expect(redisReader).not.toContain('$SSH_ORIGINAL_COMMAND');
    expect(redisReader).not.toContain('"$@"');
  });

  it('bounds both direct PostgreSQL work and fixed Redis reads', () => {
    const dispatcher = readFileSync(DISPATCHER_PATH, 'utf8');
    const directDatabase = readFileSync(DIRECT_DATABASE_PATH, 'utf8');
    const provisioner = readFileSync(PROVISIONER_PATH, 'utf8');

    expect(dispatcher).toContain('/usr/bin/timeout --foreground "$COMMAND_TIMEOUT"');
    expect(directDatabase).toContain('statement_timeout: DIRECT_DATABASE_STATEMENT_TIMEOUT_MILLIS');
    expect(directDatabase).toContain('query_timeout: DIRECT_DATABASE_QUERY_TIMEOUT_MILLIS');
    expect(provisioner).toContain('/usr/bin/timeout');
  });

  it('installs one restricted key and one exact sudo target', () => {
    const provisioner = readFileSync(PROVISIONER_PATH, 'utf8');

    expect(provisioner).toContain(
      "readonly SUDOERS_RULE='corgi-operations ALL=(root) NOPASSWD: /usr/local/libexec/corgi-read-feed-updated-at'",
    );
    expect(provisioner).toContain(
      'restrict,command="%s" %s\\n',
    );
    expect(provisioner).toContain("readonly OPERATIONS_USER='corgi-operations'");
    expect(provisioner).toContain("readonly OPERATIONS_HOME='/var/lib/corgi-operations'");
    expect(provisioner).toContain("[[ \"$account_shell\" == '/bin/sh' ]]");
    expect(provisioner).toContain('has unexpected supplementary group');
    expect(provisioner).toContain('ensure_root_parent_directory "$directory"');
    expect(provisioner).toContain('required parent is group- or other-writable');
    expect(provisioner).toContain('assert_safe_existing_managed_path "$managed_path"');
    expect(provisioner).toContain('assert_production_environment_isolated');
    expect(provisioner).toContain("assert_isolated_secret_file /opt/bluesky-feed/.env 0 'production environment file'");
    expect(provisioner).toContain('unexpected entry blocks rollback before mutation');
    expect(provisioner).toContain('operations home is missing or unsafe; rollback made no changes');
    expect(provisioner).toContain('/usr/bin/curl');
    expect(provisioner).toContain('/usr/bin/df');
    expect(provisioner).not.toContain(
      '/usr/bin/install -d -o root -g root -m 0755 /usr/local/libexec /usr/local/sbin /etc/sudoers.d',
    );
    expect(provisioner).not.toContain('usermod -aG docker');
    expect(provisioner).not.toContain('ALL=(ALL)');
  });

  it('keeps apply, verify, acceptance, and guarded rollback in one reviewable vehicle', () => {
    const result = spawnSync('bash', [PROVISIONER_PATH, 'plan'], {
      encoding: 'utf8',
      timeout: 5_000,
    });

    assertSpawnCompleted(result);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('allowed SSH commands: epoch-status, disk-root, health-ready, feed-updated-at');
    expect(result.stdout).toContain('supplementary groups: none; specifically not docker or sudo');
    expect(result.stdout).toContain('rollback confirmation: CONFIRM-CORGI-OPERATIONS-ROLLBACK');
  });

  it('rejects a symlinked database URL input before opening SSH', () => {
    const directory = createAcceptanceInputs();
    const databaseUrlLink = path.join(directory, 'database-url-link');

    try {
      symlinkSync(path.join(directory, 'database-url'), databaseUrlLink);
      const result = runAcceptance(directory, databaseUrlLink);

      assertSpawnCompleted(result);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('acceptance input file must not be a symlink');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects a database URL input with group or other permission bits', () => {
    const directory = createAcceptanceInputs();
    const databaseUrlPath = path.join(directory, 'database-url');

    try {
      chmodSync(databaseUrlPath, 0o644);
      const result = runAcceptance(directory, databaseUrlPath);

      assertSpawnCompleted(result);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('database URL file must have no group or other permission bits');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each([0o400, 0o600])('accepts an isolated secret file with mode %o', (mode) => {
    const directory = mkdtempSync(path.join(tmpdir(), 'corgi-operations-secret-'));
    const secretPath = path.join(directory, 'secret');

    try {
      writeFileSync(secretPath, 'not-a-real-secret\n', { mode });
      chmodSync(secretPath, mode);
      const result = runProvisionerFunction('assert_isolated_secret_file', [
        secretPath,
        String(process.getuid()),
        'test secret',
      ]);

      assertSpawnCompleted(result);
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each([0o640, 0o644])('rejects a secret file with mode %o', (mode) => {
    const directory = mkdtempSync(path.join(tmpdir(), 'corgi-operations-secret-'));
    const secretPath = path.join(directory, 'secret');

    try {
      writeFileSync(secretPath, 'not-a-real-secret\n', { mode });
      chmodSync(secretPath, mode);
      const result = runProvisionerFunction('assert_isolated_secret_file', [
        secretPath,
        String(process.getuid()),
        'test secret',
      ]);

      assertSpawnCompleted(result);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('must grant no group or other permissions');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects missing, symlinked, and incorrectly owned secret files', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'corgi-operations-secret-'));
    const secretPath = path.join(directory, 'secret');
    const secretLink = path.join(directory, 'secret-link');

    try {
      const missing = runProvisionerFunction('assert_isolated_secret_file', [
        secretPath,
        String(process.getuid()),
        'test secret',
      ]);
      assertSpawnCompleted(missing);
      expect(missing.status).toBe(1);
      expect(missing.stderr).toContain('must be a non-symlink regular file');

      writeFileSync(secretPath, 'not-a-real-secret\n', { mode: 0o600 });
      symlinkSync(secretPath, secretLink);
      const symlink = runProvisionerFunction('assert_isolated_secret_file', [
        secretLink,
        String(process.getuid()),
        'test secret',
      ]);
      assertSpawnCompleted(symlink);
      expect(symlink.status).toBe(1);
      expect(symlink.stderr).toContain('must be a non-symlink regular file');

      const wrongOwner = runProvisionerFunction('assert_isolated_secret_file', [
        secretPath,
        String(process.getuid() + 1),
        'test secret',
      ]);
      assertSpawnCompleted(wrongOwner);
      expect(wrongOwner.status).toBe(1);
      expect(wrongOwner.stderr).toContain('must have owner uid');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each([0o775, 0o757])('rejects an application directory with mode %o', (mode) => {
    const directory = mkdtempSync(path.join(tmpdir(), 'corgi-operations-app-'));

    try {
      chmodSync(directory, mode);
      const result = runProvisionerFunction('assert_application_directory_isolated', [
        directory,
        '',
      ]);

      assertSpawnCompleted(result);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('is group- or other-writable');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects an application directory owned by the operations account UID', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'corgi-operations-app-'));

    try {
      chmodSync(directory, 0o755);
      const result = runProvisionerFunction('assert_application_directory_isolated', [
        directory,
        String(process.getuid()),
      ]);

      assertSpawnCompleted(result);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('operations account must not own the production application path');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.runIf(statSync('/etc/hosts').uid !== process.getuid?.())(
    'rejects a database URL input owned by another user',
    () => {
      const directory = createAcceptanceInputs();

      try {
        const result = runAcceptance(directory, '/etc/hosts');

        assertSpawnCompleted(result);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('database URL file must be owned by the current user');
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
});
