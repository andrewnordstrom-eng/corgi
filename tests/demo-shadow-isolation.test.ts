import { execFileSync, spawnSync } from 'node:child_process';
import type { SpawnSyncReturns } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  demoCorpusKeyPrefix,
  demoIdempotencyKeyPrefix,
  demoLockKeyPrefix,
  demoSessionKeyPrefix,
  demoSessionNonceKeyPrefix,
  demoSharedCorpusKeyPrefix,
  demoStagingKeyPrefix,
} from '../src/demo/store.js';
import { demoRateLimitKeyPrefix } from '../src/demo/rate-limit.js';
import { SHADOW_DEMO_SHARED_CORPUS_TTL_SECONDS } from '../src/demo/types.js';

const DEMO_SRC_DIR = fileURLToPath(new URL('../src/demo', import.meta.url));
const COMPOSE_FILE = fileURLToPath(new URL('../docker-compose.prod.yml', import.meta.url));
const SERVER_FILE = fileURLToPath(new URL('../src/feed/server.ts', import.meta.url));
const DEPLOY_FILE = fileURLToPath(new URL('../.github/workflows/deploy.yml', import.meta.url));
const DOCKERFILE = fileURLToPath(new URL('../Dockerfile', import.meta.url));
const HEALTH_WATCHDOG_FILE = fileURLToPath(new URL('../ops/health-watchdog', import.meta.url));
const REPO_CONTRACT_FILE = fileURLToPath(
  new URL('../docs/agent/REPO_CONTRACT.md', import.meta.url)
);
const OPERATOR_QUICKSTART_FILE = fileURLToPath(
  new URL('../docs/runbooks/operator-quickstart.md', import.meta.url)
);
const PROBE_UUID_A = '00000000-0000-4000-8000-000000000001';
const PROBE_UUID_B = '00000000-0000-4000-8000-000000000002';
const RUNTIME_ARTIFACT_PATHS = [
  'node_modules',
  'dist',
  'web/node_modules',
  'web/dist',
  'web-next/node_modules',
  'web-next/.next',
  'web-next/out',
  'cli/node_modules',
  'cli/dist',
  'packages/feed-sdk/dist',
] as const;
const DEPLOY_GATE_MARKERS = [
  { name: 'archive checksum', value: 'sha256sum --check "${RELEASE_ARCHIVE}.sha256"' },
  {
    name: 'archive extraction',
    value: 'tar -xzf "$RELEASE_ARCHIVE" --no-same-owner --no-same-permissions',
  },
  { name: 'candidate artifact verification', value: 'candidate_artifacts_are_complete' },
  { name: 'build provenance', value: 'BUILD_SHA="$DEPLOY_SHA"' },
  { name: 'rollback arming', value: 'ROLLBACK_ARMED=true' },
  { name: 'artifact backup', value: 'backup_previous_artifacts' },
  { name: 'artifact install', value: 'install_candidate_artifacts' },
] as const;
const EXACT_SHA_PROMOTION_MARKERS = [
  { name: 'manual SHA input', value: 'workflow_dispatch:\n    inputs:\n      sha:' },
  { name: 'least-privilege permissions', value: 'permissions:\n  contents: read' },
  {
    name: 'workflow-wide promotion concurrency',
    value: 'concurrency:\n  group: production-promotion\n  cancel-in-progress: false',
  },
  { name: 'stable validation job name', value: 'name: Validate promotion target' },
  { name: 'stable deployment job name', value: 'name: Promote validated SHA to production' },
  { name: 'validation timeout', value: 'runs-on: ubuntu-latest\n    timeout-minutes: 30' },
  { name: 'full checkout history', value: 'fetch-depth: 0' },
  { name: 'non-persistent checkout credentials', value: 'persist-credentials: false' },
  { name: 'validated SHA output', value: 'sha: ${{ steps.validate-target.outputs.sha }}' },
  { name: 'production environment', value: 'environment:\n      name: production' },
  {
    name: 'explicit production enable gate',
    value: "if: vars.CORGI_PRODUCTION_DEPLOY_ENABLED == 'true'",
  },
  {
    name: 'explicit deploy-enabled failure job',
    value: 'require-deploy-enabled:\n    name: Require production deploy enable flag',
  },
  {
    name: 'deploy-enabled dependency',
    value: 'needs: [validate-target, require-deploy-enabled]',
  },
  { name: 'enablement timeout', value: 'runs-on: ubuntu-latest\n    timeout-minutes: 5' },
  { name: 'deployment timeout', value: 'timeout-minutes: 90' },
  { name: 'production URL', value: 'url: https://feed.corgi.network' },
  {
    name: 'serialized production job',
    value: 'group: production\n      cancel-in-progress: false',
  },
  { name: 'production credential guard', value: '- name: Require production SSH credentials' },
  { name: 'pre-transfer host admission', value: '- name: Admit artifact transfer' },
  {
    name: 'remote SHA environment',
    value: 'DEPLOY_SHA: ${{ needs.validate-target.outputs.sha }}\n          DEPLOY_OPERATOR: ${{ github.actor }}',
  },
  { name: 'captured deployment output', value: 'capture_stdout: true' },
  { name: 'always-captured host receipt', value: 'id: capture-receipt\n        if: always()' },
  {
    name: 'explicit absent-receipt state',
    value: "printf '%s\\n' 'CORGI_DEPLOY_RECEIPT_ABSENT'",
  },
  {
    name: 'explicit unresolved-receipt state',
    value: "printf '%s\\n' 'CORGI_DEPLOY_RECEIPT_UNRESOLVED'",
  },
  {
    name: 'remote SHA forwarding',
    value: 'envs: DEPLOY_OPERATOR,DEPLOY_RUN_ATTEMPT,DEPLOY_RUN_ID,DEPLOY_SHA,EXPECTED_ARCHIVE_SHA256,RELEASE_ARCHIVE',
  },
  {
    name: 'runner-anchored archive digest',
    value: 'archive_sha256: ${{ steps.package-release.outputs.archive_sha256 }}',
  },
  {
    name: 'runner detached target checkout',
    value: 'git checkout --detach "$DEPLOY_SHA"\n          test "$(git rev-parse HEAD)" = "$DEPLOY_SHA"',
  },
  {
    name: 'remote detached target checkout',
    value: 'ROLLBACK_ARMED=true\n            git checkout --detach "$DEPLOY_SHA"',
  },
  {
    name: 'target equality assertion',
    value: 'test "$ACTUAL_SHA" = "$DEPLOY_SHA"',
    executableIn: 'remote',
  },
  {
    name: 'build revision assertion',
    value: 'BUILD_SHA="$DEPLOY_SHA"',
    executableIn: 'remote',
  },
  {
    name: 'exact-SHA runner verification',
    value: 'npm run verify',
    executableIn: 'runner',
  },
  {
    name: 'promotion-only readiness probe',
    value: 'http://localhost:3001/health/promotion-ready',
  },
  {
    name: 'runtime revision assertion',
    value: 'elif [ "$RUNTIME_SHA" != "$DEPLOY_SHA" ]; then',
  },
  { name: 'revision receipt marker', value: 'CORGI_DEPLOY_RECEIPT|status=' },
  {
    name: 'detached rollback checkout',
    value: 'local artifact_restore_failed=false\n              if ! git checkout --detach "$PREV_COMMIT"',
  },
  { name: 'deployment summary', value: 'echo "- Recorded at: $DEPLOYED_AT"' },
] as const;
const PROTECTED_RECOVERY_CLAIMS = [
  'protected `deploy.yml` workflow',
  'CORGI_PRODUCTION_DEPLOY_ENABLED=true',
  'one running',
  'terminal receipt',
  'approval-gated incident procedure',
  'never age-deleted',
  'host lock',
  'non-ignored untracked',
  'forward-only',
  '120 seconds',
  'corgi-deploy-receipts',
  '`status`',
  '`requested`',
  '`previous`',
  '`built`',
  '`deployed`',
  '`runtime`',
  '`requested=built=deployed=runtime`',
  '`deployed=runtime=previous`',
  'migration set',
  '`operator`',
  'UTC timestamp',
] as const;
const ROLLBACK_CONTRACT_CLAIMS = [
  'status=started',
  'PREV_COMMIT',
  'checkout equality',
  'without registry access or a',
  'always restarts the restored release after replacing served',
  'never runs a down migration',
  'previous runtime revision',
  'ingestion diagnostics',
  'advisory',
  '`rolled_back` or `rollback_failed`',
  '`rollback_interrupted`',
  'no direct-VPS manual rollback shortcut',
] as const;
const HOST_DEPLOYMENT_LOCK_MARKERS = [
  'DEPLOY_LOCK_PATH="${RECEIPT_DIR}/production.lock"',
  'exec 9> "$DEPLOY_LOCK_PATH"',
  'if ! flock -n 9; then',
] as const;

describe('shadow demo isolation guards', () => {
  it('keeps Redis state inside the demo namespace', () => {
    expect(demoSessionKeyPrefix()).toBe('demo:session:');
    expect(demoSessionNonceKeyPrefix()).toBe('demo:session-nonce:');
    expect(demoCorpusKeyPrefix()).toBe('demo:corpus:');
    expect(demoSharedCorpusKeyPrefix()).toBe('demo:corpus:current:v4:');
    expect(demoIdempotencyKeyPrefix()).toBe('demo:idempotency:');
    expect(demoLockKeyPrefix()).toBe('demo:lock:');
    expect(demoStagingKeyPrefix()).toBe('demo:staging:');
    expect(demoRateLimitKeyPrefix()).toBe('demo:rate-limit:');
  });

  it('does not import production mutation or scoring pipeline entry points', () => {
    const source = demoSourceText();

    expect(source).not.toMatch(/forceEpochTransition/);
    expect(source).not.toMatch(/closeCurrentEpochAndCreateNext/);
    expect(source).not.toMatch(/runScoringPipeline/);
    expect(source).not.toMatch(/from ['"].*\.\.\/governance\/routes\/vote/);
    expect(source).not.toMatch(/from ['"].*\.\.\/scoring\/pipeline/);
  });

  it('does not write production governance, audit, feed, or export storage', () => {
    const source = demoSourceText();

    expect(source).not.toMatch(/\bINSERT\s+INTO\s+governance_/i);
    expect(source).not.toMatch(/\bUPDATE\s+governance_/i);
    expect(source).not.toMatch(/\bDELETE\s+FROM\s+governance_/i);
    expect(source).not.toContain('feed:current');
    expect(source).not.toContain('feed:current_snapshot_id');
    expect(source).not.toMatch(/\bresearch_exports?\b/i);
  });

  it('uses a dedicated bounded no-eviction Redis without persistence', () => {
    const compose = readFileSync(COMPOSE_FILE, 'utf8');
    const store = readFileSync(new URL('../src/demo/store.ts', import.meta.url), 'utf8');
    const server = readFileSync(SERVER_FILE, 'utf8');
    const deploy = readFileSync(DEPLOY_FILE, 'utf8');

    expect(store).toContain('process.env.DEMO_REDIS_URL');
    expect(compose).toContain('demo-redis:');
    expect(compose).toContain('127.0.0.1:6381:6379');
    expect(compose).toContain('--maxmemory 64mb');
    expect(compose).toContain('--maxmemory-policy noeviction');
    expect(compose).toContain('--save ""');
    expect(compose).toContain('--appendonly no');
    expect(compose).toContain('mem_limit: 96m');
    expect(server).toContain("routeOptions.url.startsWith('/api/demo/')");
    expect(server).toContain('rateLimit: false');
    expect(server).toContain('redisUrl: config.DEMO_REDIS_URL');
    expect(server).toContain('identifierHashSecret: config.DEMO_RATE_LIMIT_HASH_SECRET');
    expect(server).not.toContain('identifierHashSecret: config.EXPORT_ANONYMIZATION_SALT');
    expect(deploy).toContain('http://localhost:3001/api/demo/sessions');
    expect(deploy).toContain('PRODUCTION_KEY_EXISTS');
    expect(deploy).toContain('DEMO_KEY_EXISTS');
    expect(deploy).toContain('DEMO_POLICY');
    expect(deploy).toContain(`DEMO_KEY="${demoSessionKeyPrefix()}\${DEMO_SESSION_ID}"`);

    expect(deploy).toContain('DEMO_RESPONSE=$(curl -fsS --max-time 90');
    expect(deploy).toContain('PROBE_TIMESTAMP=$(date +%s)');
    expect(deploy).toContain(
      "PROBE_UUID=$(node -e \"process.stdout.write(require('node:crypto').randomUUID())\")"
    );
    expect(deploy).toContain('DEMO_CLIENT_NONCE="deploy-probe-${PROBE_UUID}"');
    expect(deploy).toContain('\\"clientNonce\\":\\"${DEMO_CLIENT_NONCE}\\"');
    expect(SHADOW_DEMO_SHARED_CORPUS_TTL_SECONDS).toBe(60 * 60);
    expect(usesOnlyFixedPrivilegeDispatcherCommands(deploy)).toBe(true);

    const demoCompose = compose.split('demo-redis:')[1];
    const maxmemoryMatch = demoCompose?.match(/--maxmemory\s+(\d+)mb/);
    expect(maxmemoryMatch).toBeDefined();
    const maxmemoryBytes = Number(maxmemoryMatch?.[1]) * 1024 * 1024;
    expect(deploy).toContain(`[ "$DEMO_MAXMEMORY" != "${maxmemoryBytes}" ]`);
  });

  it.each([
    { timestamp: 1_750_000_000, expectedOctet: 1 },
    { timestamp: 1_749_999_999, expectedOctet: 250 },
  ])(
    'serializes a valid demo probe nonce at the octet boundary: %j',
    ({ timestamp, expectedOctet }) => {
      const deploy = readFileSync(DEPLOY_FILE, 'utf8');
      const output = renderDemoProbe(deploy, timestamp, PROBE_UUID_A);

      expect(output.body).toEqual({
        communityId: 'open_science_builders',
        clientNonce: `deploy-probe-${PROBE_UUID_A}`,
      });
      expect(output.body.clientNonce).toMatch(/^[A-Za-z0-9:_-]{1,64}$/);
      expect(output.octet).toBe(expectedOctet);
    }
  );

  it('does not replay a nonce when concurrent probes share a timestamp', () => {
    const deploy = readFileSync(DEPLOY_FILE, 'utf8');
    const timestamp = 1_750_000_000;

    const first = renderDemoProbe(deploy, timestamp, PROBE_UUID_A);
    const second = renderDemoProbe(deploy, timestamp, PROBE_UUID_B);

    expect(first.body.clientNonce).not.toBe(second.body.clientNonce);
  });
});

describe('fixed privileged dispatcher command matcher', () => {
  it.each([
    'sudo -n -- /usr/local/sbin/corgi-deploy-root demo-redis-ping',
    'if sudo -n -- /usr/local/sbin/corgi-deploy-root demo-redis-ping; then true; fi',
    'VALUE=$(sudo -n -- /usr/local/sbin/corgi-deploy-root demo-redis-ping)',
    'VALUE="$(sudo -n -- /usr/local/sbin/corgi-deploy-root demo-redis-ping)"',
    'sudo -n -- /usr/local/sbin/corgi-deploy-root \\\n      demo-redis-ping',
  ])('accepts privileged invocation: %j', (script) => {
    expect(usesOnlyFixedPrivilegeDispatcherCommands(script)).toBe(true);
  });

  it.each([
    '',
    '/usr/local/sbin/corgi-deploy-root demo-redis-ping',
    'sudo docker compose up -d',
    'sudo docker exec bluesky-feed-demo-redis redis-cli ping\ndocker ps',
    '# sudo -n -- /usr/local/sbin/corgi-deploy-root demo-redis-ping',
    'echo "sudo -n -- /usr/local/sbin/corgi-deploy-root demo-redis-ping"',
    'echo sudo -n -- /usr/local/sbin/corgi-deploy-root demo-redis-ping',
    'VALUE="$(sudo docker exec bluesky-feed-demo-redis redis-cli ping)"',
    'VALUE="$(printf %s "$(sudo docker exec bluesky-feed-demo-redis redis-cli ping)")"',
    'VALUE="$(printf %s "$(/usr/local/sbin/corgi-deploy-root demo-redis-ping)")"',
    'sudo -n -- /usr/local/sbin/corgi-deploy-root demo-redis-ping\nsudo -n -- /usr/bin/docker ps',
    'sudo -n -- /usr/local/sbin/corgi-deploy-root demo-redis-ping\nsudo -n -- /usr/bin/systemctl status bluesky-feed',
    'docker \\\n      compose up -d',
  ])('rejects missing or non-privileged invocation: %j', (script) => {
    expect(usesOnlyFixedPrivilegeDispatcherCommands(script)).toBe(false);
  });
});

describe('production deploy ordering guards', () => {
  it('blocks changed migrations before rollback is armed', () => {
    const deploy = readFileSync(DEPLOY_FILE, 'utf8');

    expect(() => assertDeployMigrationOrdering(deploy)).not.toThrow();
    expect(() => assertMigrationBlockContract(extractRemoteDeployScript(deploy))).not.toThrow();
  });

  it('blocks production Compose changes before rollback is armed', () => {
    const remoteScript = extractRemoteDeployScript(readFileSync(DEPLOY_FILE, 'utf8'));
    const composeBlockIndex = remoteScript.indexOf(
      'if [ -n "$COMPOSE_CHANGE_OUTPUT" ]; then'
    );
    const armedIndex = remoteScript.indexOf('ROLLBACK_ARMED=true');

    expect(remoteScript).toContain(
      'git diff --name-only "$PREV_COMMIT" "$DEPLOY_SHA" -- \'docker-compose.prod.yml\''
    );
    expect(remoteScript).toContain(
      'M0 promotion blocks changed production Compose configuration until container rollback is rehearsed'
    );
    expect(composeBlockIndex).toBeGreaterThanOrEqual(0);
    expect(armedIndex).toBeGreaterThan(composeBlockIndex);
  });

  it.each([
    'node dist/db/migrate.js',
    'npx --no tsx scripts/run-migrations.ts',
    'npm --prefix . run migrate',
    'tsx scripts/run-migrations.ts',
    'ts-node scripts/apply-migration.ts',
    'if ! node dist/db/migrate.js; then false; fi',
    '(cd . && node dist/db/migrate.js)',
    'npm run db:migration',
  ])('rejects a schema mutation runner in M0: %s', (command) => {
    const deploy = readFileSync(DEPLOY_FILE, 'utf8');
    const mutated = deploy.replace(
      '            ROLLBACK_ARMED=true',
      () => `            ${command}\n            ROLLBACK_ARMED=true`
    );

    expect(mutated).not.toBe(deploy);
    expect(() => assertMigrationBlockContract(extractRemoteDeployScript(mutated))).toThrow(
      'M0 deployment must not mutate the production schema'
    );
  });

  it.each([
    'node dist/db/down-migration.js',
    'npm run migrate:down',
    'tsx scripts/down-migration.ts',
  ])('rejects a schema mutation runner during rollback: %s', (command) => {
    const deploy = readFileSync(DEPLOY_FILE, 'utf8');
    const marker = 'echo "Rolling back application after ${failure_context}: previous=$PREV_COMMIT" >&2';
    const mutated = deploy.replace(
      marker,
      () => `${marker}\n              ${command}`
    );

    expect(mutated).not.toBe(deploy);
    expect(() => assertRollbackCoverage(extractRemoteDeployScript(mutated))).toThrow(
      'Rollback function must not run a down migration'
    );
  });

  it.each([
    {
      region: 'runner',
      from: '(cd cli && npm ci --ignore-scripts)',
      to: '(cd cli && npm ci)',
    },
    {
      region: 'mixed safe and unsafe',
      from: '(cd cli && npm ci --ignore-scripts)',
      to: '(cd cli && npm ci --ignore-scripts && npm ci)',
    },
    {
      region: 'bare npm install',
      from: '(cd cli && npm ci --ignore-scripts)',
      to: '(cd cli && npm install)',
    },
  ])(
    'requires lifecycle scripts to remain disabled for the $region clean install',
    ({ from, to }) => {
      const deploy = readFileSync(DEPLOY_FILE, 'utf8');
      const mutated = deploy.replace(from, to);
      expect(mutated).not.toBe(deploy);

      expect(() => assertExactShaPromotionContract(mutated)).toThrow(
        'Deployment install must disable lifecycle scripts'
      );
    }
  );

  it.each([
    { region: 'root install', from: 'npm ci --ignore-scripts', to: 'npm ci' },
    {
      region: 'web install',
      from: '(cd web && npm ci --ignore-scripts)',
      to: '(cd web && npm ci)',
    },
    {
      region: 'web-next install',
      from: '(cd web-next && npm ci --ignore-scripts)',
      to: '(cd web-next && npm ci)',
    },
    {
      region: 'CLI install',
      from: '(cd cli && npm ci --ignore-scripts)',
      to: '(cd cli && npm ci)',
    },
  ])(
    'requires lifecycle scripts to remain disabled for the forward $region',
    ({ from, to }) => {
      const deploy = readFileSync(DEPLOY_FILE, 'utf8');
      const mutated = deploy.replace(from, to);

      expect(mutated).not.toBe(deploy);
      expect(() => assertExactShaPromotionContract(mutated)).toThrow(
        'Deployment install must disable lifecycle scripts'
      );
    }
  );

  it.each([
    { command: 'npx tsc' },
    { command: 'npx --no tsc' },
    { command: 'npm exec --no tsc' },
  ] as const)(
    'rejects implicit package installation in the runner CLI install: $command',
    ({ command }) => {
      const deploy = readFileSync(DEPLOY_FILE, 'utf8');
      const safeCommand = '(cd cli && npm ci --ignore-scripts)';
      const unsafeCommand = `(cd cli && npm ci --ignore-scripts && ${command})`;
      const mutated = deploy.replace(safeCommand, unsafeCommand);

      expect(mutated).not.toBe(deploy);
      expect(() => assertExactShaPromotionContract(mutated)).toThrow(
        'Deployment executable must prohibit implicit package installation'
      );
    }
  );

  it('verifies the exact SHA without replacing the production .env', () => {
    const deploy = readFileSync(DEPLOY_FILE, 'utf8');
    const runnerScript = extractRunnerValidationScript(deploy);
    const remoteScript = extractRemoteDeployScript(deploy);

    expect(runnerScript).toContain('cp .env.example .env');
    expect(runnerScript).toContain('npm run verify');
    expect(runnerScript).toContain('sha256sum "$RELEASE_ARCHIVE"');
    expect(remoteScript).not.toContain('cp .env.example .env');
    expect(remoteScript).toContain(
      'Production environment file must not be writable by the deployment user'
    );
    expect(remoteScript).toContain(
      'Production environment file must be root-owned and unreadable by the deployment user'
    );
    expect(remoteScript).not.toMatch(/\bnpm\s+(?:ci|install|run)\b/);
    expect(remoteScript).not.toContain('ENV_BACKUP');
    expect(remoteScript).not.toContain('restore_env_file');
  });

  it('smoke-tests the flagged native runtime modules from the packaged archive', () => {
    const deploy = readFileSync(DEPLOY_FILE, 'utf8');
    const packageIndex = deploy.indexOf('      - name: Package verified runtime artifacts\n');
    const smokeTestIndex = deploy.indexOf('      - name: Smoke-test packaged native runtime modules\n');
    const retainIndex = deploy.indexOf('      - name: Retain verified runtime artifact for deploy job\n');
    const runnerInstallScript = extractRunnerValidationScript(deploy);
    const smokeTestScript = extractNativeModuleSmokeTestScript(deploy);

    // --ignore-scripts stays on for every workspace install; the smoke test
    // is additional verification, not a replacement for it.
    expect(runnerInstallScript).toContain('npm ci --ignore-scripts');
    expect(runnerInstallScript.match(/npm ci --ignore-scripts/g)).toHaveLength(4);
    expect(packageIndex).toBeGreaterThanOrEqual(0);
    expect(smokeTestIndex).toBeGreaterThan(packageIndex);
    expect(retainIndex).toBeGreaterThan(smokeTestIndex);
    expect(smokeTestScript).toContain('node_modules/onnxruntime-node');
    expect(smokeTestScript).toContain('node_modules/sharp');
    expect(smokeTestScript).toContain('web-next/node_modules/sharp');
    expect(smokeTestScript).toContain('require(process.argv[1])');
    expect(smokeTestScript).toContain('tar -xzf "$RELEASE_ARCHIVE"');
  });

  it('rejects a deploy script with a missing required gate', () => {
    const deploy = readFileSync(DEPLOY_FILE, 'utf8');
    const marker = DEPLOY_GATE_MARKERS.find(({ name }) => name === 'archive checksum');
    if (!marker) {
      throw new Error('Missing archive checksum test marker');
    }
    const withoutChecksum = replaceInSuccessfulDeploy(
      deploy,
      marker.value,
      ''
    );

    expect(withoutChecksum).not.toBe(deploy);
    expect(() => assertDeployMigrationOrdering(withoutChecksum)).toThrow(
      `Missing ${marker.name} gate`
    );
  });

  it('rejects a deploy script with a duplicated required gate', () => {
    const deploy = readFileSync(DEPLOY_FILE, 'utf8');
    const marker = DEPLOY_GATE_MARKERS.find(({ name }) => name === 'artifact install');
    if (!marker) {
      throw new Error('Missing artifact install test marker');
    }
    const duplicateArtifactInstall = replaceInSuccessfulDeploy(
      deploy,
      'BUILD_SHA="$DEPLOY_SHA"',
      `${marker.value}\n            BUILD_SHA="$DEPLOY_SHA"`
    );

    expect(duplicateArtifactInstall).not.toBe(deploy);
    expect(() => assertDeployMigrationOrdering(duplicateArtifactInstall)).toThrow(
      `Duplicate ${marker.name} gate`
    );
  });

  it('requires checksum verification before candidate extraction', () => {
    const deploy = readFileSync(DEPLOY_FILE, 'utf8');
    const checksum = 'sha256sum --check "${RELEASE_ARCHIVE}.sha256"';
    const mutated = replaceInSuccessfulDeploy(deploy, checksum, '');

    expect(mutated).not.toBe(deploy);
    expect(() => assertExactShaPromotionContract(mutated)).toThrow(
      'Exact-SHA artifact must verify before production mutation'
    );
  });

  it('anchors the transferred archive digest independently from its checksum file', () => {
    const deploy = readFileSync(DEPLOY_FILE, 'utf8');
    const remoteScript = extractRemoteDeployScript(deploy);

    expect(deploy).toContain(
      'archive_sha256: ${{ steps.package-release.outputs.archive_sha256 }}'
    );
    expect(deploy).toContain(
      'EXPECTED_ARCHIVE_SHA256: ${{ needs.validate-target.outputs.archive_sha256 }}'
    );
    expect(remoteScript).toContain(
      'if [[ ! "$EXPECTED_ARCHIVE_SHA256" =~ ^[0-9a-f]{64}$ ]]'
    );
    expect(remoteScript).toContain(
      'if [ "$(cat "${RELEASE_ARCHIVE}.sha256")" != "$EXPECTED_CHECKSUM_RECORD" ]'
    );
    expect(remoteScript).toContain(
      'if [ "$ACTUAL_ARCHIVE_SHA256" != "$EXPECTED_ARCHIVE_SHA256" ]'
    );
  });

  it('keeps rollback independent from package installs and rebuilds', () => {
    const rollback = extractShellFunction(
      extractRemoteDeployScript(readFileSync(DEPLOY_FILE, 'utf8')),
      'rollback_application'
    );

    expect(rollback).toContain('restore_previous_artifacts');
    expect(rollback).not.toMatch(/\bnpm\s+(?:ci|install|run)\b/);
    expect(rollback).not.toContain('write_release_artifact');
  });

  it.each([
    { name: 'pre-swap success', swapStarted: false, failure: 'none', expectedReceipt: 'preflight_failed' },
    { name: 'post-swap success', swapStarted: true, failure: 'none', expectedReceipt: 'rolled_back' },
    { name: 'pre-swap checkout failure', swapStarted: false, failure: 'git_checkout', expectedReceipt: 'rollback_failed' },
    { name: 'post-swap artifact restore failure', swapStarted: true, failure: 'restore', expectedReceipt: 'rollback_failed' },
    { name: 'post-swap restart failure', swapStarted: true, failure: 'restart', expectedReceipt: 'rollback_failed' },
    { name: 'post-swap repeated health failure', swapStarted: true, failure: 'health', expectedReceipt: 'rollback_failed' },
  ] as const)(
    'executes the rollback branch for $name',
    ({ expectedReceipt, failure, swapStarted }) => {
      const directory = mkdtempSync(join(tmpdir(), 'corgi-rollback-branch-'));
      const logPath = join(directory, 'events.log');
      const previousSha = 'b'.repeat(40);
      const requestedSha = 'a'.repeat(40);
      const rollbackFunction = extractShellFunction(
        extractRemoteDeployScript(readFileSync(DEPLOY_FILE, 'utf8')),
        'rollback_application'
      );
      try {
        writeFileSync(logPath, '', 'utf8');
        const script = `
PREV_COMMIT="$TEST_PREVIOUS_SHA"
BUILD_SHA="$TEST_REQUESTED_SHA"
DEPLOYED_SHA=none
RUNTIME_SHA=none
ARTIFACT_SWAP_STARTED=$TEST_SWAP_STARTED
write_receipt() { printf 'receipt:%s:%s:%s:%s\\n' "$1" "$BUILD_SHA" "$DEPLOYED_SHA" "$RUNTIME_SHA" >> "$TEST_LOG"; }
cleanup_terminal_artifacts() { printf 'cleanup\\n' >> "$TEST_LOG"; }
restore_previous_artifacts() {
  printf 'restore\\n' >> "$TEST_LOG"
  [ "$TEST_FAILURE" != "restore" ]
}
read_ingestion_signals() { printf '%s' '1700000000000000|1700000000'; }
ingestion_signals_are_fresh() { printf 'freshness\\n' >> "$TEST_LOG"; }
assert_health_revision() {
  printf 'revision:%s\\n' "$2" >> "$TEST_LOG"
  [ "$TEST_FAILURE" != "health" ]
}
sleep() { printf 'sleep:%s\\n' "$1" >> "$TEST_LOG"; }
cd() { printf 'cd:%s\\n' "$1" >> "$TEST_LOG"; }
git() {
  printf 'git:%s\\n' "$*" >> "$TEST_LOG"
  if [ "$1" = "checkout" ] && [ "$TEST_FAILURE" = "git_checkout" ]; then
    return 1
  fi
  if [ "$1" = "rev-parse" ]; then
    printf '%s\\n' "$TEST_PREVIOUS_SHA"
  fi
}
curl() { printf '%s' '{"status":"ok","revision":"stub"}'; }
ensure_runtime_artifacts_service_readable() { return 0; }
sudo() {
  printf 'sudo:%s\\n' "$*" >> "$TEST_LOG"
  if [ "$1" = "-n" ] && [ "$4" = "service-restart" ] && [ "$TEST_FAILURE" = "restart" ]; then
    return 1
  fi
}
${rollbackFunction}
rollback_application test_failure
`;
        const result = spawnSync('bash', ['-c', `set -Eeuo pipefail\n${script}`], {
          encoding: 'utf8',
          env: {
            ...process.env,
            TEST_FAILURE: failure,
            TEST_LOG: logPath,
            TEST_PREVIOUS_SHA: previousSha,
            TEST_REQUESTED_SHA: requestedSha,
            TEST_SWAP_STARTED: swapStarted ? 'true' : 'false',
          },
        });
        const events = readFileSync(logPath, 'utf8');

        expect(result.status === 0).toBe(expectedReceipt !== 'rollback_failed');
        expect(events).toContain(`receipt:${expectedReceipt}`);
        if (expectedReceipt === 'preflight_failed') {
          expect(events).toContain(
            `receipt:preflight_failed:${requestedSha}:${previousSha}:${previousSha}`
          );
          expect(events).toContain('cleanup');
          expect(events).not.toContain('restore');
          expect(events).not.toContain(
            'sudo:-n -- /usr/local/sbin/corgi-deploy-root service-restart'
          );
        } else if (expectedReceipt === 'rolled_back') {
          expect(events).toContain('receipt:rollback_interrupted');
          expect(events).toContain('restore');
          expect(events).toContain(
            'sudo:-n -- /usr/local/sbin/corgi-deploy-root service-restart'
          );
          expect(events).toContain(
            `receipt:rolled_back:${requestedSha}:${previousSha}:${previousSha}`
          );
          expect(events.indexOf('restore')).toBeLessThan(
            events.indexOf('sudo:-n -- /usr/local/sbin/corgi-deploy-root service-restart')
          );
          expect(
            events.indexOf('sudo:-n -- /usr/local/sbin/corgi-deploy-root service-restart')
          ).toBeLessThan(events.indexOf('cleanup'));
        } else {
          expect(events).toContain('receipt:rollback_interrupted');
          expect(events).not.toContain('receipt:rolled_back');
          if (failure === 'restore') {
            expect(events).not.toContain(
              'sudo:-n -- /usr/local/sbin/corgi-deploy-root service-restart'
            );
          }
          if (failure === 'health') {
            expect(events.match(/revision:/g)).toHaveLength(12);
            expect(events.match(/sleep:/g)).toHaveLength(11);
          }
        }
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  );

  it('keeps the executable recovery harness aligned with workflow artifacts', () => {
    const deploy = readFileSync(DEPLOY_FILE, 'utf8');
    const remoteScript = extractRemoteDeployScript(deploy);

    expect(parseRuntimeArtifactPaths(remoteScript)).toEqual(RUNTIME_ARTIFACT_PATHS);
    expect(parsePackagedRuntimeArtifactPaths(extractRunnerValidationScript(deploy))).toEqual(
      RUNTIME_ARTIFACT_PATHS
    );
  });

  it.each([
    { status: 'succeeded', built: 'requested', deployed: 'requested', runtime: 'requested', valid: true },
    { status: 'rolled_back', built: 'requested', deployed: 'previous', runtime: 'previous', valid: true },
    { status: 'preflight_failed', built: 'none', deployed: 'none', runtime: 'none', valid: true },
    { status: 'preflight_failed', built: 'requested', deployed: 'previous', runtime: 'previous', valid: true },
    { status: 'started', built: 'requested', deployed: 'none', runtime: 'none', valid: false },
    { status: 'succeeded', built: 'requested', deployed: 'requested', runtime: 'previous', valid: false },
    { status: 'preflight_failed', built: 'requested', deployed: 'requested', runtime: 'requested', valid: false },
  ] as const)(
    'keeps transfer and locked receipt admission in parity for $status/$built/$deployed/$runtime',
    ({ built, deployed, runtime, status, valid }) => {
      const requestedSha = 'a'.repeat(40);
      const previousSha = 'b'.repeat(40);
      const receipt = deploymentReceipt({
        status: status === 'started' ? 'started' : status,
        requested: requestedSha,
        previous: previousSha,
        built: built === 'requested' ? requestedSha : built,
        deployed: deployed === 'requested' ? requestedSha : deployed === 'previous' ? previousSha : deployed,
        runtime: runtime === 'requested' ? requestedSha : runtime === 'previous' ? previousSha : runtime,
        migrations: 'none',
        operator: 'andrew',
        timestamp: '2026-08-02T05:00:00Z',
      });
      const workflow = readFileSync(DEPLOY_FILE, 'utf8');
      const transferGuard = extractShellFunction(
        extractTransferAdmissionScript(workflow),
        'transfer_receipt_is_safe_terminal'
      );
      const lockedGuard = extractShellFunction(
        extractRemoteDeployScript(workflow),
        'receipt_is_safe_terminal'
      );
      const transferStatus = runReceiptGuard(
        transferGuard,
        'transfer_receipt_is_safe_terminal',
        receipt
      );
      const lockedStatus = runReceiptGuard(
        lockedGuard,
        'receipt_is_safe_terminal',
        receipt
      );

      expect(transferStatus === 0).toBe(valid);
      expect(lockedStatus).toBe(transferStatus);
    }
  );

  it('reclaims prior payloads only after validating safe terminal receipts', () => {
    const directory = mkdtempSync(join(tmpdir(), 'corgi-terminal-reclaim-'));
    const remoteScript = extractRemoteDeployScript(readFileSync(DEPLOY_FILE, 'utf8'));
    const receiptGuardFunction = extractShellFunction(
      remoteScript,
      'receipt_is_safe_terminal'
    );
    const reclaimFunction = extractShellFunction(
      remoteScript,
      'reclaim_prior_terminal_artifacts'
    );
    try {
      const attempts = [
        { attempt: '11-1', status: 'succeeded' },
        { attempt: '12-1', status: 'rolled_back' },
        { attempt: '13-1', status: 'preflight_failed' },
      ] as const;
      const incomingRoot = join(directory, 'incoming');
      mkdirSync(incomingRoot);
      mkdirSync(join(incomingRoot, '99-1'));
      for (const { attempt, status } of attempts) {
        const requestedSha = 'a'.repeat(40);
        const previousSha = 'b'.repeat(40);
        writeFileSync(
          join(directory, `${attempt}.receipt`),
          `${deploymentReceipt({
            status,
            requested: requestedSha,
            previous: previousSha,
            built: status === 'preflight_failed' ? 'none' : requestedSha,
            deployed: status === 'succeeded' ? requestedSha : status === 'rolled_back' ? previousSha : 'none',
            runtime: status === 'succeeded' ? requestedSha : status === 'rolled_back' ? previousSha : 'none',
            migrations: 'none',
            operator: 'andrew',
            timestamp: '2026-08-02T05:00:00Z',
          })}\n`,
          'utf8'
        );
        mkdirSync(join(directory, `${attempt}.candidate`));
        mkdirSync(join(directory, `${attempt}.previous`));
        mkdirSync(join(incomingRoot, attempt));
      }
      const script = `
RECEIPT_DIR="$TEST_RECEIPT_DIR"
INCOMING_ARTIFACT_ROOT="$TEST_INCOMING_ROOT"
DEPLOY_RUN_ID=99
DEPLOY_RUN_ATTEMPT=1
${receiptGuardFunction}
${reclaimFunction}
reclaim_prior_terminal_artifacts
`;
      const result = spawnSync('bash', ['-c', `set -Eeuo pipefail\n${script}`], {
        encoding: 'utf8',
        env: {
          ...process.env,
          TEST_INCOMING_ROOT: incomingRoot,
          TEST_RECEIPT_DIR: directory,
        },
      });

      expect(result.status, result.stderr).toBe(0);
      for (const { attempt } of attempts) {
        expect(existsSync(join(directory, `${attempt}.candidate`))).toBe(false);
        expect(existsSync(join(directory, `${attempt}.previous`))).toBe(false);
        expect(existsSync(join(incomingRoot, attempt))).toBe(false);
        expect(existsSync(join(directory, `${attempt}.receipt`))).toBe(true);
      }
      expect(existsSync(join(incomingRoot, '99-1'))).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each(['started', 'rollback_interrupted', 'rollback_failed'] as const)(
    'blocks promotion while a prior receipt is %s',
    (status) => {
      const directory = mkdtempSync(join(tmpdir(), 'corgi-unresolved-receipt-'));
      const incomingRoot = join(directory, 'incoming');
      const remoteScript = extractRemoteDeployScript(readFileSync(DEPLOY_FILE, 'utf8'));
      try {
        mkdirSync(incomingRoot);
        mkdirSync(join(incomingRoot, '99-1'));
        writeFileSync(
          join(directory, '14-1.receipt'),
          deploymentReceipt({
            status,
            requested: 'a'.repeat(40),
            previous: 'b'.repeat(40),
            built: 'a'.repeat(40),
            deployed: 'none',
            runtime: 'none',
            migrations: 'none',
            operator: 'andrew',
            timestamp: '2026-08-02T05:00:00Z',
          }),
          'utf8'
        );
        const result = runPriorAttemptAdmission(remoteScript, directory, incomingRoot);

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(
          'Unresolved or malformed production deployment receipt blocks promotion'
        );
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  );

  it('blocks a replayed current-attempt receipt without deleting its incoming payload', () => {
    const directory = mkdtempSync(join(tmpdir(), 'corgi-current-attempt-replay-'));
    const incomingRoot = join(directory, 'incoming');
    const currentIncoming = join(incomingRoot, '99-1');
    const remoteScript = extractRemoteDeployScript(readFileSync(DEPLOY_FILE, 'utf8'));
    try {
      mkdirSync(incomingRoot);
      mkdirSync(currentIncoming);
      writeFileSync(
        join(directory, '99-1.receipt'),
        `${deploymentReceipt({
          status: 'succeeded',
          requested: 'a'.repeat(40),
          previous: 'b'.repeat(40),
          built: 'a'.repeat(40),
          deployed: 'a'.repeat(40),
          runtime: 'a'.repeat(40),
          migrations: 'none',
          operator: 'andrew',
          timestamp: '2026-08-02T05:00:00Z',
        })}\n`,
        'utf8'
      );
      const result = runPriorAttemptAdmission(remoteScript, directory, incomingRoot);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('Current deployment attempt already has a receipt');
      expect(existsSync(currentIncoming)).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('blocks promotion when a prior payload has no safe terminal receipt', () => {
    const directory = mkdtempSync(join(tmpdir(), 'corgi-orphaned-payload-'));
    const incomingRoot = join(directory, 'incoming');
    const remoteScript = extractRemoteDeployScript(readFileSync(DEPLOY_FILE, 'utf8'));
    try {
      mkdirSync(incomingRoot);
      mkdirSync(join(incomingRoot, '14-1'));
      mkdirSync(join(incomingRoot, '99-1'));
      const result = runPriorAttemptAdmission(remoteScript, directory, incomingRoot);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        'Unresolved or malformed production deployment payload blocks promotion'
      );
      expect(existsSync(join(incomingRoot, '14-1'))).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('refuses an unclaimed rollback when the per-attempt guard cannot be created', () => {
    const directory = mkdtempSync(join(tmpdir(), 'corgi-rollback-claim-'));
    const logPath = join(directory, 'events.log');
    const onDeployError = extractShellFunction(
      extractRemoteDeployScript(readFileSync(DEPLOY_FILE, 'utf8')),
      'on_deploy_error'
    );
    try {
      writeFileSync(logPath, '', 'utf8');
      const result = spawnSync('bash', ['-c', `
set -Eeuo pipefail
ROLLBACK_ARMED=true
ROLLBACK_GUARD_DIR="$TEST_MISSING_PARENT/guard"
BASHPID="$$"
DEPLOY_MAIN_BASHPID="$BASHPID"
write_receipt() { printf 'receipt:%s\n' "$1" >> "$TEST_LOG"; }
rollback_application() { printf 'rollback\n' >> "$TEST_LOG"; }
cleanup_terminal_artifacts() { printf 'cleanup\n' >> "$TEST_LOG"; }
${onDeployError}
on_deploy_error 1
`], {
        encoding: 'utf8',
        env: {
          ...process.env,
          TEST_LOG: logPath,
          TEST_MISSING_PARENT: join(directory, 'missing'),
        },
      });
      const events = readFileSync(logPath, 'utf8');

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('refusing an unclaimed rollback');
      expect(events).toContain('receipt:rollback_interrupted');
      expect(events.split('\n')).not.toContain('rollback');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('requires disk headroom before extracting the transferred artifact', () => {
    const remoteLines = executableLines(
      extractRemoteDeployScript(readFileSync(DEPLOY_FILE, 'utf8'))
    );
    const diskGateIndex = remoteLines.findIndex((line) =>
      line.includes('[ "$AVAILABLE_DEPLOY_KIB" -lt 8388608 ]')
    );
    const extractionIndex = remoteLines.findIndex((line) =>
      line.includes('tar -xzf "$RELEASE_ARCHIVE"')
    );

    expect(diskGateIndex).toBeGreaterThanOrEqual(0);
    expect(extractionIndex).toBeGreaterThan(diskGateIndex);
  });

  it('makes runtime artifacts service-readable after restrictive extraction', () => {
    const directory = mkdtempSync(join(tmpdir(), 'corgi-artifact-modes-'));
    const remoteScript = extractRemoteDeployScript(readFileSync(DEPLOY_FILE, 'utf8'));
    const accessFunction = extractShellFunction(
      remoteScript,
      'ensure_runtime_artifacts_service_readable'
    );
    try {
      const result = spawnSync(
        'bash',
        [
          '-c',
          `set -Eeuo pipefail
umask 077
mkdir -p node_modules/example dist
printf '%s\n' module > node_modules/example/index.js
printf '%s\n' service > dist/index.js
RUNTIME_ARTIFACT_PATHS=(node_modules dist)
${accessFunction}
ensure_runtime_artifacts_service_readable`,
        ],
        { cwd: directory, encoding: 'utf8' }
      );

      expect(result.status, result.stderr).toBe(0);
      expect(statSync(directory).mode & 0o001).toBe(0o001);
      expect(statSync(join(directory, 'node_modules', 'example')).mode & 0o005).toBe(0o005);
      expect(statSync(join(directory, 'dist')).mode & 0o005).toBe(0o005);
      expect(statSync(join(directory, 'node_modules', 'example', 'index.js')).mode & 0o004).toBe(
        0o004
      );
      expect(statSync(join(directory, 'dist', 'index.js')).mode & 0o004).toBe(0o004);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each(['partial_backup', 'partial_install', 'restore_failure'] as const)(
    'restores PREV_COMMIT artifacts after $mode interruption',
    (mode) => {
      const directory = mkdtempSync(join(tmpdir(), 'corgi-retained-release-'));
      const currentDirectory = join(directory, 'current');
      const candidateDirectory = join(directory, 'candidate');
      const previousDirectory = join(directory, 'previous');
      const previousSha = 'b'.repeat(40);
      const remoteScript = extractRemoteDeployScript(readFileSync(DEPLOY_FILE, 'utf8'));
      const runtimeArtifactPaths = parseRuntimeArtifactPaths(remoteScript);
      try {
        mkdirSync(currentDirectory, { recursive: true });
        mkdirSync(candidateDirectory, { recursive: true });
        for (const artifactPath of runtimeArtifactPaths) {
          const currentPath = join(currentDirectory, artifactPath);
          mkdirSync(currentPath, { recursive: true });
          writeFileSync(join(currentPath, 'marker.txt'), `previous:${artifactPath}\n`);
        }
        writeFileSync(join(currentDirectory, 'dist', '.release-sha'), `${previousSha}\n`);
        const candidateNodeModules = join(candidateDirectory, 'node_modules');
        mkdirSync(candidateNodeModules, { recursive: true });
        writeFileSync(join(candidateNodeModules, 'marker.txt'), 'candidate:node_modules\n');

        const backupFunction = extractShellFunction(remoteScript, 'backup_previous_artifacts');
        const restoreFunction = extractShellFunction(remoteScript, 'restore_previous_artifacts');
        const script = `
RUNTIME_ARTIFACT_PATHS=(${runtimeArtifactPaths.join(' ')})
PREVIOUS_ARTIFACT_DIR="$TEST_PREVIOUS_DIR"
CANDIDATE_BUILD_DIR="$TEST_CANDIDATE_DIR"
PREV_COMMIT="$TEST_PREVIOUS_SHA"
ARTIFACT_SWAP_STARTED=false
ARTIFACT_BACKUP_COMPLETE=false
${backupFunction}
${restoreFunction}
cd "$TEST_CURRENT_DIR"
if [ "$TEST_MODE" = "partial_backup" ]; then
  MOVE_COUNT=0
  mv() {
    MOVE_COUNT=$((MOVE_COUNT + 1))
    if [ "$MOVE_COUNT" = "2" ]; then
      return 75
    fi
    command mv "$@"
  }
  if backup_previous_artifacts; then
    exit 76
  fi
  unset -f mv
elif [ "$TEST_MODE" = "partial_install" ]; then
  backup_previous_artifacts
  command mv "$TEST_CANDIDATE_DIR/node_modules" node_modules
else
  backup_previous_artifacts
  command mv "$TEST_CANDIDATE_DIR/node_modules" node_modules
  MOVE_COUNT=0
  mv() {
    MOVE_COUNT=$((MOVE_COUNT + 1))
    if [ "$MOVE_COUNT" = "1" ]; then
      return 75
    fi
    command mv "$@"
  }
  if restore_previous_artifacts; then
    exit 77
  fi
  unset -f mv
  exit 0
fi
restore_previous_artifacts
`;
        const result = spawnSync('bash', ['-c', `set -Eeuo pipefail\n${script}`], {
          encoding: 'utf8',
          env: {
            ...process.env,
            TEST_CANDIDATE_DIR: candidateDirectory,
            TEST_CURRENT_DIR: currentDirectory,
            TEST_MODE: mode,
            TEST_PREVIOUS_DIR: previousDirectory,
            TEST_PREVIOUS_SHA: previousSha,
          },
        });

        expect(result.status, result.stderr).toBe(0);
        const expectedRestoredArtifacts =
          mode === 'restore_failure'
            ? runtimeArtifactPaths.slice(1)
            : runtimeArtifactPaths;
        for (const artifactPath of expectedRestoredArtifacts) {
          expect(
            readFileSync(join(currentDirectory, artifactPath, 'marker.txt'), 'utf8')
          ).toBe(`previous:${artifactPath}\n`);
        }
        expect(readFileSync(join(currentDirectory, 'dist', '.release-sha'), 'utf8')).toBe(
          `${previousSha}\n`
        );
        if (mode === 'partial_install') {
          expect(
            readFileSync(
              join(candidateDirectory, 'failed', 'node_modules', 'marker.txt'),
              'utf8'
            )
          ).toBe('candidate:node_modules\n');
        }
        if (mode === 'restore_failure') {
          expect(result.stderr).toContain(
            'Failed to retain candidate artifact during rollback: path=node_modules'
          );
          expect(
            readFileSync(join(currentDirectory, 'node_modules', 'marker.txt'), 'utf8')
          ).toBe('candidate:node_modules\n');
          expect(
            readFileSync(join(previousDirectory, 'node_modules', 'marker.txt'), 'utf8')
          ).toBe('previous:node_modules\n');
        }
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  );

  it.each(['missing_stamp', 'mismatched_stamp', 'symlinked_artifact'] as const)(
    'rejects an unsafe restored previous release: $mode',
    (mode) => {
      const directory = mkdtempSync(join(tmpdir(), 'corgi-unsafe-restore-'));
      const currentDirectory = join(directory, 'current');
      const candidateDirectory = join(directory, 'candidate');
      const previousDirectory = join(directory, 'previous');
      const previousDist = join(previousDirectory, 'dist');
      const previousSha = 'b'.repeat(40);
      try {
        mkdirSync(currentDirectory);
        mkdirSync(candidateDirectory);
        mkdirSync(previousDirectory);
        if (mode === 'symlinked_artifact') {
          const externalDist = join(directory, 'external-dist');
          mkdirSync(externalDist);
          writeFileSync(join(externalDist, '.release-sha'), `${previousSha}\n`, 'utf8');
          symlinkSync(externalDist, previousDist);
        } else {
          mkdirSync(previousDist);
          if (mode === 'mismatched_stamp') {
            writeFileSync(join(previousDist, '.release-sha'), `${'c'.repeat(40)}\n`, 'utf8');
          }
        }
        const restoreFunction = extractShellFunction(
          extractRemoteDeployScript(readFileSync(DEPLOY_FILE, 'utf8')),
          'restore_previous_artifacts'
        );
        const script = `
RUNTIME_ARTIFACT_PATHS=(dist)
PREVIOUS_ARTIFACT_DIR="$TEST_PREVIOUS_DIR"
CANDIDATE_BUILD_DIR="$TEST_CANDIDATE_DIR"
PREV_COMMIT="$TEST_PREVIOUS_SHA"
ARTIFACT_SWAP_STARTED=true
ARTIFACT_BACKUP_COMPLETE=true
${restoreFunction}
cd "$TEST_CURRENT_DIR"
restore_previous_artifacts
`;
        const result = spawnSync('bash', ['-c', `set -Eeuo pipefail\n${script}`], {
          encoding: 'utf8',
          env: {
            ...process.env,
            TEST_CANDIDATE_DIR: candidateDirectory,
            TEST_CURRENT_DIR: currentDirectory,
            TEST_PREVIOUS_DIR: previousDirectory,
            TEST_PREVIOUS_SHA: previousSha,
          },
        });

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(
          mode === 'symlinked_artifact'
            ? 'Previous runtime artifact is missing or unsafe: path=dist'
            : 'Restored release artifact does not prove PREV_COMMIT'
        );
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  );

  it('rejects a deploy script without a service restart', () => {
    const deploy = readFileSync(DEPLOY_FILE, 'utf8');
    const withoutRestart = deploy.replaceAll(
      'sudo -n -- /usr/local/sbin/corgi-deploy-root service-restart',
      ''
    );

    expect(() => assertDeployMigrationOrdering(withoutRestart)).toThrow(
      'Missing service restart'
    );
  });

  it('rejects a deploy script without post-deploy health verification', () => {
    const deploy = readFileSync(DEPLOY_FILE, 'utf8');
    const withoutHealthCheck = deploy.replace('# Post-deploy composite health verification', '');

    expect(() => assertDeployMigrationOrdering(withoutHealthCheck)).toThrow(
      'Missing post-deploy health verification'
    );
  });

  it('rejects a deploy script that verifies health before restarting', () => {
    const deploy = readFileSync(DEPLOY_FILE, 'utf8');
    const healthMarker = '# Post-deploy composite health verification';
    const restartMarker = 'sudo -n -- /usr/local/sbin/corgi-deploy-root service-restart';
    const withoutHealthCheck = replaceInSuccessfulDeploy(deploy, healthMarker, '');
    const reordered = replaceInSuccessfulDeploy(
      withoutHealthCheck,
      restartMarker,
      `${healthMarker}\n            ${restartMarker}`
    );

    expect(() => assertDeployMigrationOrdering(reordered)).toThrow(
      'Service restart must run before post-deploy health verification'
    );
  });
});

describe('production exact-SHA promotion guards', () => {
  it('keeps embedded release shell scripts syntactically valid', () => {
    const deploy = readFileSync(DEPLOY_FILE, 'utf8');
    for (const script of [
      extractRunnerValidationScript(deploy),
      extractProductionCredentialGuard(deploy),
      extractNativeModuleSmokeTestScript(deploy),
      extractTransferAdmissionScript(deploy),
      extractRemoteDeployScript(deploy),
      extractReceiptValidationScript(deploy),
      extractUnreadableReceiptReportScript(deploy),
      extractRuntimeInspectionScript(deploy),
    ]) {
      expect(() =>
        execFileSync('bash', ['-n'], {
          input: script,
          stdio: ['pipe', 'ignore', 'pipe'],
        })
      ).not.toThrow();
    }
  });

  it('promotes only one validated main SHA through a protected serialized job', () => {
    const deploy = readFileSync(DEPLOY_FILE, 'utf8');

    expect(() => assertExactShaPromotionContract(deploy)).not.toThrow();
  });

  it('pins the VPS host fingerprint on every SSH connection', () => {
    const deploy = readFileSync(DEPLOY_FILE, 'utf8');
    const fingerprint =
      'fingerprint: ${{ secrets.PRODUCTION_VPS_SSH_FINGERPRINT }}';
    const firstFingerprintIndex = deploy.indexOf(fingerprint);
    const mutated = deploy.slice(0, firstFingerprintIndex) +
      deploy.slice(firstFingerprintIndex + fingerprint.length);

    expect(firstFingerprintIndex).toBeGreaterThanOrEqual(0);
    expect(() => assertExactShaPromotionContract(mutated)).toThrow(
      'Every production SSH connection must pin the VPS host fingerprint'
    );
  });

  it('verifies immutable SSH action payloads before exposing production credentials', () => {
    const deploy = readFileSync(DEPLOY_FILE, 'utf8');
    const payloadStep = '      - name: Pin SSH action runtime payloads\n';
    const credentialStep = '      - name: Require production SSH credentials\n';
    const firstConnection = '      - name: Admit artifact transfer\n';
    const payloadIndex = deploy.indexOf(payloadStep);
    const credentialIndex = deploy.indexOf(credentialStep);
    const connectionIndex = deploy.indexOf(firstConnection);

    expect(payloadIndex).toBeGreaterThanOrEqual(0);
    expect(credentialIndex).toBeGreaterThan(payloadIndex);
    expect(connectionIndex).toBeGreaterThan(credentialIndex);
    const payloadScript = deploy.slice(payloadIndex, credentialIndex);
    expect(payloadScript).toContain(
      'DRONE_SSH_SHA256: 1e10a9972eef167d9ddbc39e1ba80f7d44a011b4a6bc4f6149434154d9b6bb24'
    );
    expect(payloadScript).toContain(
      'DRONE_SCP_SHA256: 05bed7f47f57fffadfa9c3e53ef5b203cb66b1bc83751e261246584c59ed7649'
    );
    expect(payloadScript.match(/sha256sum --check --strict/g)).toHaveLength(2);
    expect(payloadScript).toContain('DRONE_SSH_RELEASE_URL=file://$SSH_RELEASE_ROOT');
    expect(payloadScript).toContain('DRONE_SCP_RELEASE_URL=file://$SCP_RELEASE_ROOT');
    expect(payloadScript.match(/--connect-timeout 10 --max-time 120/g)).toHaveLength(2);
  });

  it('admits host permissions, prior receipts, and disk before artifact transfer', () => {
    const deploy = readFileSync(DEPLOY_FILE, 'utf8');
    const admissionScript = extractTransferAdmissionScript(deploy);
    const credentialIndex = deploy.indexOf(
      '      - name: Require production SSH credentials\n'
    );
    const admissionIndex = deploy.indexOf('      - name: Admit artifact transfer\n');
    const transferIndex = deploy.indexOf('      - name: Transfer verified runtime artifact\n');

    expect(credentialIndex).toBeGreaterThanOrEqual(0);
    expect(admissionIndex).toBeGreaterThan(credentialIndex);
    expect(admissionIndex).toBeGreaterThanOrEqual(0);
    expect(transferIndex).toBeGreaterThan(admissionIndex);
    expect(admissionScript).toContain('sudo -n /usr/bin/true');
    expect(admissionScript).toContain(
      'sudo -n -- /usr/local/sbin/corgi-deploy-root service-user'
    );
    expect(admissionScript).toContain(
      'sudo -n -- /usr/local/sbin/corgi-deploy-root service-group'
    );
    expect(admissionScript).toContain(
      'sudo -n -- /usr/local/sbin/corgi-deploy-root service-main-pid'
    );
    expect(admissionScript).toContain('stat -c \'%u\' "/proc/${SERVICE_MAIN_PID}"');
    expect(admissionScript).toContain(
      'awk \'/^Gid:/ { print $3 }\' "/proc/${SERVICE_MAIN_PID}/status"'
    );
    expect(admissionScript).toContain('[ "$SERVICE_USER" = "$DEPLOY_USER" ]');
    expect(admissionScript).toContain('[ "$SERVICE_GID" = "$DEPLOY_GID" ]');
    expect(admissionScript).toContain('transfer_receipt_is_safe_terminal');
    expect(admissionScript).toContain('flock -n 9');
    expect(admissionScript).toContain('Unresolved or malformed production deployment payload');
    expect(admissionScript).toContain('[ "$AVAILABLE_DEPLOY_KIB" -lt 8388608 ]');
    expect(admissionScript).toContain(
      '[ -e "${INCOMING_ARTIFACT_ROOT}/${CURRENT_ATTEMPT}" ]'
    );
  });

  it('includes packages/feed-sdk/dist in both host admission path-validation loops', () => {
    const deploy = readFileSync(DEPLOY_FILE, 'utf8');
    const admissionScript = extractTransferAdmissionScript(deploy);
    const remoteScript = extractRemoteDeployScript(deploy);

    // RUNTIME_ARTIFACT_PATHS (and the runner-side packaging step) already
    // ship packages/feed-sdk/dist; both host-side admission loops that
    // validate deployment-path ownership/writability must cover it too, or
    // an unvalidated path could slip through the same checks every other
    // runtime directory gets.
    expect(admissionScript).toContain('/opt/bluesky-feed/packages/feed-sdk/dist');
    expect(remoteScript).toContain('/opt/bluesky-feed/packages/feed-sdk/dist');
  });

  it('captures the runner Node ABI and rejects a host ABI mismatch before artifact transfer', () => {
    const deploy = readFileSync(DEPLOY_FILE, 'utf8');
    const admissionScript = extractTransferAdmissionScript(deploy);
    const setupNodeIndex = deploy.indexOf('      - name: Set up Node.js\n');
    const captureAbiIndex = deploy.indexOf('      - name: Capture runner Node ABI\n');
    const installIndex = deploy.indexOf('      - name: Install exact-SHA dependencies\n');
    const diskCheckIndex = admissionScript.indexOf(
      '[ "$AVAILABLE_DEPLOY_KIB" -lt 8388608 ]'
    );
    const abiCheckIndex = admissionScript.indexOf(
      '[ "$HOST_NODE_ABI" != "$EXPECTED_NODE_ABI" ]'
    );
    const transferIndex = deploy.indexOf('      - name: Transfer verified runtime artifact\n');
    const admissionIndex = deploy.indexOf('      - name: Admit artifact transfer\n');

    // Prebuilt native bindings (see the smoke-test step) pin
    // NODE_MODULE_VERSION -- proving the runner can load them says nothing
    // about the VPS's own Node build. Captured after setup-node (so it's the
    // exact Node this job installs/builds with), asserted on the host
    // read-only admission path (fail-closed, before the artifact swap and
    // service restart, not after).
    expect(setupNodeIndex).toBeGreaterThanOrEqual(0);
    expect(captureAbiIndex).toBeGreaterThan(setupNodeIndex);
    expect(installIndex).toBeGreaterThan(captureAbiIndex);
    expect(deploy).toContain("NODE_ABI=\"$(node -p process.versions.modules)\"");
    expect(deploy).toContain('node_abi: ${{ steps.capture-node-abi.outputs.node_abi }}');
    expect(deploy).toContain('EXPECTED_NODE_ABI: ${{ needs.validate-target.outputs.node_abi }}');
    expect(deploy).toContain('envs: DEPLOY_RUN_ATTEMPT,DEPLOY_RUN_ID,EXPECTED_NODE_ABI');
    expect(diskCheckIndex).toBeGreaterThanOrEqual(0);
    expect(abiCheckIndex).toBeGreaterThan(diskCheckIndex);
    expect(admissionScript).toContain('HOST_NODE_ABI="$(node -p process.versions.modules)"');
    expect(admissionScript).toContain('Host Node ABI does not match');
    expect(admissionScript).toContain('host_node_version=$HOST_NODE_VERSION');
    // The ABI check lives inside the bounded admission script (extracted
    // between these two step markers), so it necessarily runs before the
    // artifact transfer step -- and before the swap/restart in the later
    // deploy step, which this admission step always precedes.
    expect(admissionIndex).toBeGreaterThanOrEqual(0);
    expect(transferIndex).toBeGreaterThan(admissionIndex);
  });

  it('uses only fixed-container read probes and requires demo Redis to preexist', () => {
    const deploy = readFileSync(DEPLOY_FILE, 'utf8');
    const remoteScript = extractRemoteDeployScript(deploy);

    expect(remoteScript).not.toContain('sudo docker compose');
    expect(remoteScript).not.toMatch(/sudo docker (?:run|create|start)/);
    expect(remoteScript).toContain(
      'sudo -n -- /usr/local/sbin/corgi-deploy-root \\\n                postgres-ingestion-signals'
    );
    expect(remoteScript).toContain(
      'sudo -n -- /usr/local/sbin/corgi-deploy-root demo-redis-ping'
    );
    expect(remoteScript).toContain(
      'sudo -n -- /usr/local/sbin/corgi-deploy-root production-redis-exists "$DEMO_KEY"'
    );
  });

  it.each([
    { fingerprint: `SHA256:${'A'.repeat(43)}`, valid: true },
    { fingerprint: '', valid: false },
    { fingerprint: 'SHA256:not-a-complete-fingerprint', valid: false },
  ] as const)('validates the production fingerprint before SSH: $fingerprint', ({
    fingerprint,
    valid,
  }) => {
    const guard = extractProductionCredentialGuard(readFileSync(DEPLOY_FILE, 'utf8'));
    const result = spawnSync('bash', ['-c', guard], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PRODUCTION_VPS_HOST: 'feed.example.com',
        PRODUCTION_VPS_USER: 'deploy',
        PRODUCTION_VPS_SSH_KEY: 'test-private-key',
        PRODUCTION_VPS_SSH_FINGERPRINT: fingerprint,
      },
    });

    expect(result.status === 0).toBe(valid);
    if (fingerprint.length > 0) {
      expect(result.stdout).not.toContain(fingerprint);
      expect(result.stderr).not.toContain(fingerprint);
    }
  });

  it.each([
    'PRODUCTION_VPS_HOST',
    'PRODUCTION_VPS_USER',
    'PRODUCTION_VPS_SSH_KEY',
    'PRODUCTION_VPS_SSH_FINGERPRINT',
  ] as const)('fails before SSH when %s is missing', (missingSecret) => {
    const guard = extractProductionCredentialGuard(readFileSync(DEPLOY_FILE, 'utf8'));
    const secrets = {
      PRODUCTION_VPS_HOST: 'feed.example.com',
      PRODUCTION_VPS_USER: 'deploy-user',
      PRODUCTION_VPS_SSH_KEY: 'private-key-fixture',
      PRODUCTION_VPS_SSH_FINGERPRINT: `SHA256:${'A'.repeat(43)}`,
    };
    const childEnv = { ...process.env, ...secrets };
    childEnv[missingSecret] = '';
    const result = spawnSync('bash', ['-c', guard], {
      encoding: 'utf8',
      env: childEnv,
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`name=${missingSecret}`);
    for (const [secretName, secretValue] of Object.entries(secrets)) {
      if (secretName !== missingSecret) {
        expect(result.stdout).not.toContain(secretValue);
        expect(result.stderr).not.toContain(secretValue);
      }
    }
  });

  it('uses deployment-only environment secret names and a format-specific fingerprint', () => {
    const deploy = readFileSync(DEPLOY_FILE, 'utf8');

    for (const secretName of [
      'PRODUCTION_VPS_HOST',
      'PRODUCTION_VPS_USER',
      'PRODUCTION_VPS_SSH_KEY',
      'PRODUCTION_VPS_SSH_FINGERPRINT',
    ]) {
      expect(deploy).toContain(`secrets.${secretName}`);
    }
    expect(deploy).not.toContain('secrets.VPS_SSH_HOST_KEY');
    expect(deploy).toContain(
      'Production environment file must be root-owned and unreadable by the deployment user'
    );
    expect(deploy).toContain(
      'Deployment user must not have unrestricted passwordless sudo'
    );
  });

  it.each(EXACT_SHA_PROMOTION_MARKERS)(
    'rejects a workflow without $name',
    ({ name, value }) => {
      const deploy = readFileSync(DEPLOY_FILE, 'utf8');
      const mutated = deploy.replace(value, '');

      expect(mutated).not.toBe(deploy);
      expect(() => assertExactShaPromotionContract(mutated)).toThrow(
        `Missing ${name}`
      );
    }
  );

  it.each([
    {
      name: 'target equality assertion',
      value: 'test "$ACTUAL_SHA" = "$DEPLOY_SHA"',
    },
    {
      name: 'build revision assertion',
      value: 'BUILD_SHA="$DEPLOY_SHA"',
    },
    { name: 'exact-SHA runner verification', value: 'npm run verify' },
  ])('rejects a commented-out executable $name', ({ name, value }) => {
    const deploy = readFileSync(DEPLOY_FILE, 'utf8');
    const mutated = deploy.replace(value, `# ${value}`);

    expect(mutated).not.toBe(deploy);
    expect(() => assertExactShaPromotionContract(mutated)).toThrow(`Missing ${name}`);
  });

  it('rejects an automatic main-push deployment', () => {
    const deploy = readFileSync(DEPLOY_FILE, 'utf8');
    const mutated = deploy.replace(
      'on:\n',
      'on:\n  push:\n    branches:\n      - main\n'
    );

    expect(() => assertExactShaPromotionContract(mutated)).toThrow(
      'Production deploy must not trigger on push'
    );
  });

  it('rejects mutable main checkout in the remote deploy script', () => {
    const deploy = readFileSync(DEPLOY_FILE, 'utf8');
    const remoteScript = extractRemoteDeployScript(deploy);
    const mutated = deploy.replace(
      remoteScript,
      () => remoteScript.replace(
        'git checkout --detach "$DEPLOY_SHA"',
        'git checkout --detach "$DEPLOY_SHA"\n            git pull origin main'
      )
    );

    expect(() => assertExactShaPromotionContract(mutated)).toThrow(
      'Remote deploy must not use git pull'
    );
  });

  it.each([
    { command: 'npm --prefix web ci --ignore-scripts', valid: true },
    { command: 'npm ci --prefix web --ignore-scripts', valid: true },
    { command: 'npm --prefix web install --ignore-scripts', valid: false },
    { command: 'npm --prefix web add package-name --ignore-scripts', valid: false },
    { command: 'npm ci --ignore-scripts=false', valid: false },
  ])('validates lifecycle safety with npm global flags: $command', ({ command, valid }) => {
    const assertion = () => assertLifecycleScriptContract(command, '');

    if (valid) {
      expect(assertion).not.toThrow();
    } else {
      expect(assertion).toThrow('Deployment install must disable lifecycle scripts');
    }
  });

  it.each([
    '${{ inputs.sha }}',
    '${{ github.event.inputs.sha }}',
    '${{ github.event.head_commit.message }}',
    '${{ github.ref_name }}',
  ])('rejects workflow expression interpolation in the remote script: %s', (expression) => {
    const deploy = readFileSync(DEPLOY_FILE, 'utf8');
    const remoteScript = extractRemoteDeployScript(deploy);
    const mutated = deploy.replace(
      remoteScript,
      () => remoteScript.replace(
        'git checkout --detach "$DEPLOY_SHA"',
        `git checkout --detach "$DEPLOY_SHA"\n            echo "${expression}"`
      )
    );

    expect(() => assertExactShaPromotionContract(mutated)).toThrow(
      'Remote script must receive workflow expressions through envs'
    );
  });

  it.each([
    {
      command: 'git cat-file -e "${DEPLOY_SHA}^{commit}"',
      expectedError: 'Commit existence check must run on the runner and the VPS',
    },
    {
      command: 'git merge-base --is-ancestor "$DEPLOY_SHA" refs/remotes/origin/main',
      expectedError: 'Main ancestry check must run on the runner and the VPS',
    },
    {
      command: 'git fetch --no-tags origin refs/heads/main:refs/remotes/origin/main',
      expectedError: 'Explicit main fetch must run on the runner and the VPS',
    },
  ].flatMap(({ command, expectedError }) => [
    { command, expectedError, region: 'runner' as const },
    { command, expectedError, region: 'VPS' as const },
  ]))(
    'requires the $command check independently on the $region',
    ({ command, expectedError, region }) => {
      const deploy = readFileSync(DEPLOY_FILE, 'utf8');
      const remoteScript = extractRemoteDeployScript(deploy);
      const mutated = region === 'runner'
        ? deploy.replace(command, '')
        : deploy.replace(
            remoteScript,
            () => remoteScript.replace(command, '')
          );

      expect(mutated).not.toBe(deploy);
      expect(() => assertExactShaPromotionContract(mutated)).toThrow(expectedError);
    }
  );

  it.each(['runner', 'VPS'])('requires lowercase full-SHA validation on the %s', (region) => {
    const deploy = readFileSync(DEPLOY_FILE, 'utf8');
    const validation = '[[ ! "$DEPLOY_SHA" =~ ^[0-9a-f]{40}$ ]]';
    const mutated = region === 'runner'
      ? deploy.replace(validation, '[[ invalid-runner-pattern ]]')
      : deploy.replace(
          extractRemoteDeployScript(deploy),
          () => extractRemoteDeployScript(deploy).replace(
              validation,
              '[[ invalid-vps-pattern ]]'
            )
        );

    expect(() => assertExactShaPromotionContract(mutated)).toThrow(
      'Lowercase full-SHA validation must run on the runner and the VPS'
    );
  });

  it('rejects duplicated commit validation on the VPS', () => {
    const deploy = readFileSync(DEPLOY_FILE, 'utf8');
    const remoteScript = extractRemoteDeployScript(deploy);
    const commitCheck = 'git cat-file -e "${DEPLOY_SHA}^{commit}"';
    const mutated = deploy.replace(
      remoteScript,
      () => remoteScript.replace(commitCheck, `${commitCheck}\n            ${commitCheck}`)
    );

    expect(() => assertExactShaPromotionContract(mutated)).toThrow(
      'Commit existence check must run on the runner and the VPS'
    );
  });

  it.each([
    { name: 'artifact swap', marker: 'install_candidate_artifacts' },
    {
      name: 'restart',
      marker: 'sudo -n -- /usr/local/sbin/corgi-deploy-root service-restart',
    },
    { name: 'health', marker: 'if [ "$HEALTHY" = "false" ]; then' },
  ])('rejects a deploy path without rollback coverage for $name failure', ({ marker }) => {
    const deploy = readFileSync(DEPLOY_FILE, 'utf8');
    const remoteScript = extractRemoteDeployScript(deploy);
    const successStart = remoteScript.indexOf('            ROLLBACK_ARMED=true');
    const successEnd = remoteScript.indexOf('            ROLLBACK_ARMED=false', successStart);
    const successPath = remoteScript.slice(successStart, successEnd);
    const mutatedSuccessPath = successPath.replace(marker, '');
    const mutated = deploy.replace(
      remoteScript,
      () => remoteScript.slice(0, successStart) + mutatedSuccessPath + remoteScript.slice(successEnd)
    );

    expect(() => assertRollbackCoverage(extractRemoteDeployScript(mutated))).toThrow(
      `Rollback coverage missing success-path marker: ${marker}`
    );
  });

  it('clears signal traps before disarming a successful promotion', () => {
    const deploy = readFileSync(DEPLOY_FILE, 'utf8');
    const remoteScript = extractRemoteDeployScript(deploy);
    const safeHandoff = [
      'trap - ERR EXIT HUP INT TERM',
      '            ROLLBACK_ARMED=false',
    ].join('\n');
    const unsafeHandoff = [
      'ROLLBACK_ARMED=false',
      '            trap - ERR EXIT HUP INT TERM',
    ].join('\n');
    const mutated = remoteScript.replace(safeHandoff, () => unsafeHandoff);

    expect(mutated).not.toBe(remoteScript);
    expect(() => assertRollbackCoverage(mutated)).toThrow(
      'Successful deployment must clear every rollback trap before disarming'
    );
  });

  it('rejects a deploy path that disarms rollback by explicit exit', () => {
    const deploy = readFileSync(DEPLOY_FILE, 'utf8');
    const install = 'install_candidate_artifacts';
    const mutated = replaceInSuccessfulDeploy(
      deploy,
      install,
      `${install}\n            exit 1`
    );

    expect(() => assertExactShaPromotionContract(mutated)).toThrow(
      'Rollback-armed deployment path must not bypass ERR with exit'
    );
  });

  it('rejects a rollback-armed exit after a shell operator', () => {
    const deploy = readFileSync(DEPLOY_FILE, 'utf8');
    const install = 'install_candidate_artifacts';
    const mutated = replaceInSuccessfulDeploy(
      deploy,
      install,
      `${install} && exit 1`
    );

    expect(() => assertExactShaPromotionContract(mutated)).toThrow(
      'Rollback-armed deployment path must not bypass ERR with exit'
    );
  });

  it.each([
    {
      name: 'invalid JSON',
      response: 'not-json',
      valid: false,
      error: 'Health response is not valid JSON',
    },
    {
      name: 'missing revision',
      response: JSON.stringify({ status: 'ok' }),
      valid: false,
      error: 'Health response revision is not a lowercase full SHA',
    },
    {
      name: 'uppercase revision',
      response: JSON.stringify({ status: 'ok', revision: 'A'.repeat(40) }),
      valid: false,
      error: 'Health response revision is not a lowercase full SHA',
    },
    {
      name: 'non-ok status',
      response: JSON.stringify({ status: 'degraded', revision: 'a'.repeat(40) }),
      valid: false,
      error: 'Health response status is not ok',
    },
    {
      name: 'valid exact revision',
      response: JSON.stringify({ status: 'ok', revision: 'a'.repeat(40) }),
      valid: true,
      error: '',
    },
  ])('validates the runtime health contract for $name', ({ response, valid, error }) => {
    const reader = extractShellFunction(
      extractRemoteDeployScript(readFileSync(DEPLOY_FILE, 'utf8')),
      'read_health_revision'
    );
    const result = runHealthRevisionReader(reader, response);

    expect(result.status === 0).toBe(valid);
    if (valid) {
      expect(result.stdout).toBe('a'.repeat(40));
      expect(result.stderr).toBe('');
    } else {
      expect(result.stderr).toContain(error);
    }
  });

  it('rejects a deploy path without an advancing post-restart cursor proof', () => {
    const deploy = readFileSync(DEPLOY_FILE, 'utf8');
    const marker = 'ingestion_signals_are_fresh "$POST_RESTART_SIGNALS" "$POST_RESTART_BASELINE_CURSOR"';
    const mutated = replaceInSuccessfulDeploy(deploy, marker, '');

    expect(() => assertExactShaPromotionContract(mutated)).toThrow(
      `Composite health progression proof missing marker: ${marker}`
    );
  });

  it('rejects a cursor baseline captured by the previous process', () => {
    const deploy = readFileSync(DEPLOY_FILE, 'utf8');
    const baseline = 'POST_RESTART_BASELINE_SIGNALS="$(read_ingestion_signals)"';
    const restart = 'sudo -n -- /usr/local/sbin/corgi-deploy-root service-restart';
    const withoutBaseline = replaceInSuccessfulDeploy(deploy, baseline, '');
    const mutated = replaceInSuccessfulDeploy(
      withoutBaseline,
      restart,
      `${baseline}\n            ${restart}`
    );

    expect(() => assertExactShaPromotionContract(mutated)).toThrow(
      'Cursor advancement baseline must be captured after restart'
    );
  });

  it('requires current ingestion freshness before rollback is armed', () => {
    const remoteScript = extractRemoteDeployScript(readFileSync(DEPLOY_FILE, 'utf8'));
    const freshnessIndex = remoteScript.indexOf(
      'ingestion_signals_are_fresh "$PREFLIGHT_INGESTION_SIGNALS" "0"'
    );
    const armedIndex = remoteScript.indexOf('ROLLBACK_ARMED=true');

    expect(freshnessIndex).toBeGreaterThanOrEqual(0);
    expect(armedIndex).toBeGreaterThan(freshnessIndex);
  });

  it.each([
    {
      name: 'valid row',
      signals: '1700000000000000|1700000000\n',
      commandStatus: 0,
      valid: true,
    },
    { name: 'empty query result', signals: '', commandStatus: 0, valid: false },
    {
      name: 'database command failure',
      signals: '',
      commandStatus: 1,
      valid: false,
    },
    {
      name: 'whitespace-padded row',
      signals: '  1700000000000000 | 1700000000 \n',
      commandStatus: 0,
      valid: true,
    },
  ])('fails closed while reading ingestion signals for $name', ({
    signals,
    commandStatus,
    valid,
  }) => {
    const readFunction = extractShellFunction(
      extractRemoteDeployScript(readFileSync(DEPLOY_FILE, 'utf8')),
      'read_ingestion_signals'
    );
    const result = runReadIngestionSignals(readFunction, signals, commandStatus);

    expect(result.status === 0).toBe(valid);
    if (valid) {
      expect(result.stdout).toBe('1700000000000000|1700000000');
    }
  });

  it.each([
    { name: 'valid signals', signals: '1700000000000000|1700000000', valid: true },
    { name: 'empty cursor', signals: '|1700000000', valid: false },
    { name: 'oversized cursor', signals: `${'1'.repeat(19)}|1700000000`, valid: false },
    { name: 'oversized newest-post epoch', signals: `1700000000000000|${'1'.repeat(13)}`, valid: false },
    { name: 'no indexed post', signals: '1700000000000000|0', valid: false },
    { name: 'cursor at 120-second boundary', signals: '1699999880000000|1700000000', valid: true },
    { name: 'cursor beyond 120-second boundary', signals: '1699999879000000|1700000000', valid: false },
    { name: 'newest post at 120-second boundary', signals: '1700000000000000|1699999880', valid: true },
    { name: 'newest post beyond 120-second boundary', signals: '1700000000000000|1699999879', valid: false },
    { name: 'cursor at upper tolerance boundary', signals: '1700000120000000|1700000000', valid: true },
    { name: 'cursor ahead of host clock', signals: '1700000121000000|1700000000', valid: false },
    { name: 'newest post at upper tolerance boundary', signals: '1700000000000000|1700000120', valid: true },
    { name: 'newest post ahead of host clock', signals: '1700000000000000|1700000121', valid: false },
    { name: 'signals 300 seconds behind host clock', signals: '1699999700000000|1699999700', valid: false },
    { name: 'signals 300 seconds ahead of host clock', signals: '1700000300000000|1700000300', valid: false },
    { name: 'signals missing the separator', signals: '1700000000000000', valid: false },
    { name: 'signals with extra separators', signals: '1700000000000000|1700000000|1700000001', valid: false },
    { name: 'leading-zero cursor', signals: '0700000000000000|1700000000', valid: false },
    { name: 'leading-zero newest-post epoch', signals: '1700000000000000|0700000000', valid: false },
  ])('bounds ingestion freshness arithmetic for $name', ({ signals, valid }) => {
    const freshnessFunction = extractShellFunction(
      extractRemoteDeployScript(readFileSync(DEPLOY_FILE, 'utf8')),
      'ingestion_signals_are_fresh'
    );
    const result = runIngestionFreshnessGuard(freshnessFunction, signals, '0', 0);

    expect(result.status === 0).toBe(valid);
  });

  it.each([
    { name: 'cursor equal to minimum', cursor: '1700000000000000', minimum: '1700000000000000', valid: false },
    { name: 'cursor older than minimum', cursor: '1700000000000000', minimum: '1700000000000001', valid: false },
    { name: 'cursor newer than minimum', cursor: '1700000000000001', minimum: '1700000000000000', valid: true },
    { name: 'empty minimum', cursor: '1700000000000000', minimum: '', valid: false },
    { name: 'non-numeric minimum', cursor: '1700000000000000', minimum: 'not-a-cursor', valid: false },
    { name: 'oversized minimum', cursor: '1700000000000000', minimum: '1'.repeat(19), valid: false },
    { name: 'negative minimum', cursor: '1700000000000000', minimum: '-1', valid: false },
  ])('enforces cursor advancement for $name', ({ cursor, minimum, valid }) => {
    const freshnessFunction = extractShellFunction(
      extractRemoteDeployScript(readFileSync(DEPLOY_FILE, 'utf8')),
      'ingestion_signals_are_fresh'
    );
    const result = runIngestionFreshnessGuard(
      freshnessFunction,
      `${cursor}|1700000000`,
      minimum,
      0
    );

    expect(result.status === 0).toBe(valid);
  });

  it('fails closed when host time cannot be read', () => {
    const freshnessFunction = extractShellFunction(
      extractRemoteDeployScript(readFileSync(DEPLOY_FILE, 'utf8')),
      'ingestion_signals_are_fresh'
    );
    const result = runIngestionFreshnessGuard(
      freshnessFunction,
      '1700000000000000|1700000000',
      '0',
      1
    );

    expect(result.status).not.toBe(0);
  });

  it.each([
    { name: 'running process', pid: '123', valid: true },
    { name: 'zero PID', pid: '0', valid: false },
    { name: 'non-numeric PID', pid: 'not-a-pid', valid: false },
    { name: 'multi-line PID', pid: '123\n0', valid: false },
  ])('validates the pre-restart MainPID for $name', ({ pid, valid }) => {
    const remoteScript = extractRemoteDeployScript(readFileSync(DEPLOY_FILE, 'utf8'));
    const guard = extractPreviousMainPidGuard(remoteScript);
    const result = spawnSync('bash', ['-c', `set -Eeuo pipefail\n${guard}`], {
      encoding: 'utf8',
      env: { ...process.env, PREVIOUS_MAIN_PID: pid },
    });

    expect(result.status === 0).toBe(valid);
  });

  it('requires the post-restart MainPID to differ unconditionally', () => {
    const deploy = readFileSync(DEPLOY_FILE, 'utf8');
    const mutated = deploy.replace(
      'elif [ "$MAIN_PID" = "$PREVIOUS_MAIN_PID" ]; then',
      'elif [ "$PREVIOUS_MAIN_PID" != "0" ] && [ "$MAIN_PID" = "$PREVIOUS_MAIN_PID" ]; then'
    );

    expect(() => assertExactShaPromotionContract(mutated)).toThrow(
      'Deployment must prove a changed nonzero MainPID'
    );
  });

  it('rejects a deploy workflow without an armed rollback boundary', () => {
    const deploy = readFileSync(DEPLOY_FILE, 'utf8');
    const mutated = deploy.replace('            ROLLBACK_ARMED=true\n', '');

    expect(() => assertRollbackCoverage(extractRemoteDeployScript(mutated))).toThrow(
      'Rollback error trap must remain armed through health verification'
    );
  });

  it.each([
    'DEPLOY_MAIN_BASHPID="$BASHPID"',
    'if [ "$BASHPID" != "$DEPLOY_MAIN_BASHPID" ]; then',
    'if [ -e "$ROLLBACK_GUARD_DIR" ] || [ -L "$ROLLBACK_GUARD_DIR" ]; then',
    'elif mkdir "$ROLLBACK_GUARD_DIR"; then',
  ])('rejects rollback without the single-shot marker: %s', (marker) => {
    const deploy = readFileSync(DEPLOY_FILE, 'utf8');
    const mutated = deploy.replace(marker, '');
    expect(mutated).not.toBe(deploy);

    expect(() => assertRollbackCoverage(extractRemoteDeployScript(mutated))).toThrow(
      'Rollback single-shot guard missing marker'
    );
  });

  it.each(HOST_DEPLOYMENT_LOCK_MARKERS)(
    'rejects a deploy workflow without the host-lock marker: %s',
    (marker) => {
      const remoteScript = extractRemoteDeployScript(readFileSync(DEPLOY_FILE, 'utf8'));
      const mutated = remoteScript.replace(marker, '');

      expect(mutated).not.toBe(remoteScript);
      expect(() => assertHostDeploymentLock(mutated)).toThrow(
        'Production mutations require a run-independent host lock'
      );
    }
  );

  it('rejects reading PREV_COMMIT before acquiring the host lock', () => {
    const remoteScript = extractRemoteDeployScript(readFileSync(DEPLOY_FILE, 'utf8'));
    const previousSha = 'PREV_COMMIT="$(git rev-parse HEAD)"';
    const lock = 'if ! flock -n 9; then';
    const withoutPreviousSha = remoteScript.replace(previousSha, '');
    const mutated = withoutPreviousSha.replace(
      lock,
      `${previousSha}\n            ${lock}`
    );

    expect(mutated).not.toBe(remoteScript);
    expect(() => assertHostDeploymentLock(mutated)).toThrow(
      'Production mutations require a run-independent host lock'
    );
  });

  it('rejects a runner validation command hidden in a comment', () => {
    const deploy = readFileSync(DEPLOY_FILE, 'utf8');
    const commitCheck = 'git cat-file -e "${DEPLOY_SHA}^{commit}"';
    const mutated = deploy.replace(commitCheck, `# ${commitCheck}`);

    expect(() => assertExactShaPromotionContract(mutated)).toThrow(
      'Commit existence check must run on the runner and the VPS'
    );
  });

  it.each(['run: >', 'run: echo unsafe'])('rejects unsupported runner command form: %s', (runForm) => {
    const deploy = readFileSync(DEPLOY_FILE, 'utf8');
    const mutated = deploy.replace('        run: |\n', `        ${runForm}\n`);

    expect(mutated).not.toBe(deploy);
    expect(() => extractRunnerValidationScript(mutated)).toThrow(
      'Unsupported run block form in runner validation job'
    );
  });

  it('rejects full-SHA validation hidden inside an echo command', () => {
    const deploy = readFileSync(DEPLOY_FILE, 'utf8');
    const validation = 'if [[ ! "$DEPLOY_SHA" =~ ^[0-9a-f]{40}$ ]]; then';
    const mutated = deploy.replace(validation, `echo ${JSON.stringify(validation)}`);

    expect(() => assertExactShaPromotionContract(mutated)).toThrow(
      'Lowercase full-SHA validation must run on the runner and the VPS'
    );
  });

  it.each([
    'git switch main',
    'git reset --hard origin/main',
    'git checkout origin/main',
    'git -C /tmp/repo checkout main',
    'sudo git reset --hard origin/main',
    'git --git-dir=/tmp/repo/.git switch main',
    'git --no-pager checkout main',
    'git -P switch main',
    'git --literal-pathspecs reset --hard origin/main',
    'true && git reset --hard origin/main',
    'DEPLOY_MODE=1 git switch main',
    'RESULT="$(git checkout main)"',
    'RESULT=`git reset --hard origin/main`',
    'eval "git checkout main"',
    'env DEPLOY_MODE=1 git reset --hard origin/main',
    'sudo -n -u deploy git reset --hard origin/main',
    'git \\\n reset --hard origin/main',
    'git reset \\\n --hard origin/main',
    'sudo \\\n git reset --hard origin/main',
  ])('rejects a ref mutation after locking the target: %s', (mutation) => {
    const deploy = readFileSync(DEPLOY_FILE, 'utf8');
    const targetLock = 'test "$ACTUAL_SHA" = "$DEPLOY_SHA"';
    const mutated = deploy.replace(targetLock, `${targetLock}\n            ${mutation}`);

    expect(() => assertExactShaPromotionContract(mutated)).toThrow(
      'Remote deploy path must not mutate Git refs after target lock'
    );
  });

  it('rejects mismatched, non-writable, symlinked, dangling, and missing deployment paths', () => {
    const deploy = readFileSync(DEPLOY_FILE, 'utf8');
    const accessFunction = extractShellFunction(
      extractRemoteDeployScript(deploy),
      'require_deploy_path_access'
    );
    const directory = mkdtempSync(join(tmpdir(), 'corgi-deploy-access-'));
    const gitDirectory = join(directory, '.git');
    const symlinkPath = join(directory, 'owned-link');
    const danglingSymlinkPath = join(directory, 'dangling-link');
    const missingPath = join(directory, 'missing');

    try {
      mkdirSync(gitDirectory);
      symlinkSync(gitDirectory, symlinkPath);
      symlinkSync(missingPath, danglingSymlinkPath);
      const matching = runDeployPathAccessGuard(
        accessFunction,
        gitDirectory,
        'deploy',
        'deploy',
        0
      );
      expect(matching.status).toBe(0);

      const ownerMismatch = runDeployPathAccessGuard(
        accessFunction,
        gitDirectory,
        'deploy',
        'root',
        0
      );
      expect(ownerMismatch.status).not.toBe(0);

      const statFailure = runDeployPathAccessGuard(
        accessFunction,
        gitDirectory,
        'deploy',
        'deploy',
        1
      );
      expect(statFailure.status).not.toBe(0);

      chmodSync(gitDirectory, 0o500);
      const notWritable = runDeployPathAccessGuard(
        accessFunction,
        gitDirectory,
        'deploy',
        'deploy',
        0
      );
      if (process.getuid?.() !== 0) {
        expect(notWritable.status).not.toBe(0);
      }

      for (const rejectedPath of [symlinkPath, danglingSymlinkPath, missingPath]) {
        const rejected = runDeployPathAccessGuard(
          accessFunction,
          rejectedPath,
          'deploy',
          'deploy',
          0
        );
        expect(rejected.status).not.toBe(0);
      }
    } finally {
      if (existsSync(gitDirectory)) {
        chmodSync(gitDirectory, 0o700);
      }
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each([
    { name: 'full SHA', variable: 'DEPLOY_SHA', value: 'a'.repeat(40), valid: true },
    { name: 'empty SHA', variable: 'DEPLOY_SHA', value: '', valid: false },
    { name: 'short SHA', variable: 'DEPLOY_SHA', value: 'a'.repeat(39), valid: false },
    { name: 'long SHA', variable: 'DEPLOY_SHA', value: 'a'.repeat(41), valid: false },
    { name: 'uppercase SHA', variable: 'DEPLOY_SHA', value: 'A'.repeat(40), valid: false },
    { name: 'spaced SHA', variable: 'DEPLOY_SHA', value: ` ${'a'.repeat(40)}`, valid: false },
    { name: 'newline SHA', variable: 'DEPLOY_SHA', value: `${'a'.repeat(40)}\nextra`, valid: false },
    { name: 'unset SHA', variable: 'DEPLOY_SHA', value: undefined, valid: false },
    { name: 'injected SHA', variable: 'DEPLOY_SHA', value: `${'a'.repeat(40)};id`, valid: false },
    { name: 'run ID one', variable: 'DEPLOY_RUN_ID', value: '1', valid: true },
    { name: 'large run ID', variable: 'DEPLOY_RUN_ID', value: '999999999999', valid: true },
    { name: 'empty run ID', variable: 'DEPLOY_RUN_ID', value: '', valid: false },
    { name: 'zero run ID', variable: 'DEPLOY_RUN_ID', value: '0', valid: false },
    { name: 'spaced run ID', variable: 'DEPLOY_RUN_ID', value: ' 1', valid: false },
    { name: 'injected run ID', variable: 'DEPLOY_RUN_ID', value: '1;id', valid: false },
    { name: 'run attempt one', variable: 'DEPLOY_RUN_ATTEMPT', value: '1', valid: true },
    { name: 'zero run attempt', variable: 'DEPLOY_RUN_ATTEMPT', value: '0', valid: false },
    { name: 'unset run attempt', variable: 'DEPLOY_RUN_ATTEMPT', value: undefined, valid: false },
    { name: 'operator name', variable: 'DEPLOY_OPERATOR', value: 'andrew', valid: true },
    { name: 'hyphenated operator', variable: 'DEPLOY_OPERATOR', value: 'andrew-n', valid: true },
    { name: 'bot operator', variable: 'DEPLOY_OPERATOR', value: 'github-actions[bot]', valid: true },
    { name: 'empty operator', variable: 'DEPLOY_OPERATOR', value: '', valid: false },
    { name: 'spaced operator', variable: 'DEPLOY_OPERATOR', value: 'andrew n', valid: false },
    { name: 'piped operator', variable: 'DEPLOY_OPERATOR', value: 'andrew|id', valid: false },
    { name: 'injected operator', variable: 'DEPLOY_OPERATOR', value: 'andrew;id', valid: false },
    { name: 'newline operator', variable: 'DEPLOY_OPERATOR', value: 'andrew\nother', valid: false },
    { name: 'unset operator', variable: 'DEPLOY_OPERATOR', value: undefined, valid: false },
  ])('executes the production input guard for $name', ({ variable, value, valid }) => {
    const deploy = readFileSync(DEPLOY_FILE, 'utf8');
    const script = variable === 'DEPLOY_SHA'
      ? extractRunnerValidationScript(deploy)
      : extractRemoteDeployScript(deploy);
    const guard = extractInputGuard(script, variable);
    const childEnv = { ...process.env };
    if (value === undefined) {
      delete childEnv[variable];
    } else {
      childEnv[variable] = value;
    }
    const result = spawnSync('bash', ['-c', `set -Eeuo pipefail\n${guard}`], {
      encoding: 'utf8',
      env: childEnv,
    });

    expect(result.status === 0).toBe(valid);
  });

  it.each(['andrew', 'github-actions[bot]'])(
    'accepts and summarizes a valid deployment receipt from %s',
    (operator) => {
      const deploy = readFileSync(DEPLOY_FILE, 'utf8');
      const sha = 'a'.repeat(40);
      const receipt = deploymentReceipt({
        status: 'succeeded',
        built: sha,
        deployed: sha,
        migrations: 'none',
        operator,
        previous: 'b'.repeat(40),
        requested: sha,
        runtime: sha,
        timestamp: '2026-08-02T05:00:00Z',
      });
      const result = runReceiptValidation(deploy, sha, `out: ${receipt}`, 'success');

      expect(result.status).toBe(0);
      expect(result.summary).toContain(`- Operator: ${operator}`);
      expect(result.summary).toContain(`- Healthy runtime SHA: ${sha}`);
    }
  );

  it('accepts a valid deployment receipt captured with CRLF line endings', () => {
    const deploy = readFileSync(DEPLOY_FILE, 'utf8');
    const sha = 'a'.repeat(40);
    const receipt = deploymentReceipt({
      status: 'succeeded',
      built: sha,
      deployed: sha,
      migrations: 'none',
      operator: 'andrew',
      previous: 'b'.repeat(40),
      requested: sha,
      runtime: sha,
      timestamp: '2026-08-02T05:00:00Z',
    });
    const result = runReceiptValidation(
      deploy,
      sha,
      `banner\r\n${receipt}\r\n`,
      'success'
    );

    expect(result.status).toBe(0);
    expect(result.summary).toContain(`- Healthy runtime SHA: ${sha}`);
  });

  it('rejects a preflight-failed receipt that claims production mutation', () => {
    const deploy = readFileSync(DEPLOY_FILE, 'utf8');
    const requestedSha = 'a'.repeat(40);
    const receipt = deploymentReceipt({
      status: 'preflight_failed',
      built: requestedSha,
      deployed: requestedSha,
      migrations: 'none',
      operator: 'andrew',
      previous: 'b'.repeat(40),
      requested: requestedSha,
      runtime: requestedSha,
      timestamp: '2026-08-02T05:00:00Z',
    });
    const result = runReceiptValidation(deploy, requestedSha, receipt, 'failure');

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      'Preflight-failed deployment receipt claims production mutation'
    );
  });

  it('summarizes an absent receipt as a host-preflight failure without mutation', () => {
    const deploy = readFileSync(DEPLOY_FILE, 'utf8');
    const sha = 'a'.repeat(40);
    const result = runReceiptValidation(
      deploy,
      sha,
      'CORGI_DEPLOY_RECEIPT_ABSENT',
      'failure'
    );

    expect(result.status).toBe(0);
    expect(result.summary).toContain('- Status: no receipt recorded');
    expect(result.summary).toContain('- Production mutation: none');
  });

  it('emits an absent receipt only when artifact transfer was explicitly skipped', () => {
    const deploy = readFileSync(DEPLOY_FILE, 'utf8');
    const captureStart = deploy.indexOf('      - name: Capture deployment receipt\n');
    const recordStart = deploy.indexOf('      - name: Record deployment receipt\n', captureStart);
    const captureStep = deploy.slice(captureStart, recordStart);

    expect(captureStart).toBeGreaterThanOrEqual(0);
    expect(recordStart).toBeGreaterThan(captureStart);
    expect(deploy).toContain('id: transfer-runtime');
    expect(captureStep).toContain(
      'TRANSFER_STEP_OUTCOME: ${{ steps.transfer-runtime.outcome }}'
    );
    expect(captureStep).toContain(
      'envs: DEPLOY_RUN_ATTEMPT,DEPLOY_RUN_ID,TRANSFER_STEP_OUTCOME'
    );
    expect(captureStep).toContain('[ "$TRANSFER_STEP_OUTCOME" != "skipped" ]');
    expect(captureStep.indexOf('CORGI_DEPLOY_RECEIPT_UNRESOLVED')).toBeLessThan(
      captureStep.indexOf('CORGI_DEPLOY_RECEIPT_ABSENT')
    );
  });

  it('treats a transferred payload without a receipt as unresolved', () => {
    const deploy = readFileSync(DEPLOY_FILE, 'utf8');
    const result = runReceiptValidation(
      deploy,
      'a'.repeat(40),
      'CORGI_DEPLOY_RECEIPT_UNRESOLVED',
      'failure'
    );

    expect(result.status).not.toBe(0);
    expect(result.summary).toContain('- Status: transferred payload without receipt');
    expect(result.summary).toContain('- Production state: unresolved');
    expect(result.summary).toContain('approval-gated incident procedure');
    expect(result.summary).not.toContain('- Production mutation: none');
  });

  it('rejects an absent receipt marker from a successful deployment step', () => {
    const deploy = readFileSync(DEPLOY_FILE, 'utf8');
    const result = runReceiptValidation(
      deploy,
      'a'.repeat(40),
      'CORGI_DEPLOY_RECEIPT_ABSENT',
      'success'
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('conflicts with deployment output');
  });

  it('rejects duplicate absent-receipt markers', () => {
    const deploy = readFileSync(DEPLOY_FILE, 'utf8');
    const result = runReceiptValidation(
      deploy,
      'a'.repeat(40),
      'CORGI_DEPLOY_RECEIPT_ABSENT\nCORGI_DEPLOY_RECEIPT_ABSENT',
      'failure'
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('duplicate absent-receipt markers');
    expect(result.summary).toBe('');
  });

  it.each([
    {
      name: 'missing receipt',
      mutate: (_receipt: string) => '',
      expectedError: 'must contain exactly one revision receipt',
    },
    {
      name: 'two receipt markers',
      mutate: (receipt: string) => `${receipt}\n${receipt.replace('operator=andrew', 'operator=other')}`,
      expectedError: 'must contain exactly one revision receipt',
    },
    {
      name: 'two receipt markers on one line',
      mutate: (receipt: string) => `${receipt} ${receipt}`,
      expectedError: 'must contain exactly one revision receipt',
    },
    {
      name: 'unrecognized status',
      mutate: (receipt: string) => receipt.replace('status=succeeded', 'status=unknown'),
      expectedError: 'invalid status',
    },
    {
      name: 'extra field',
      mutate: (receipt: string) => `${receipt}|extra=value`,
      expectedError: 'invalid shape',
    },
    {
      name: 'reordered fields',
      mutate: (receipt: string) => receipt
        .replace(`requested=${'a'.repeat(40)}|previous=${'b'.repeat(40)}`, `previous=${'b'.repeat(40)}|requested=${'a'.repeat(40)}`),
      expectedError: 'requested field is invalid',
    },
    {
      name: 'uppercase SHA',
      mutate: (receipt: string) => receipt.replace('built=' + 'a'.repeat(40), 'built=' + 'A'.repeat(40)),
      expectedError: 'invalid optional SHA',
    },
    {
      name: 'nonhex SHA',
      mutate: (receipt: string) => receipt.replace('runtime=' + 'a'.repeat(40), 'runtime=' + 'g'.repeat(40)),
      expectedError: 'invalid optional SHA',
    },
    {
      name: 'wrong runtime SHA',
      mutate: (receipt: string) => receipt.replace('runtime=' + 'a'.repeat(40), 'runtime=' + 'c'.repeat(40)),
      expectedError: 'does not prove the validated SHA',
    },
    {
      name: 'wrong deployed SHA',
      mutate: (receipt: string) => receipt.replace('deployed=' + 'a'.repeat(40), 'deployed=' + 'c'.repeat(40)),
      expectedError: 'does not prove the validated SHA',
    },
    {
      name: 'built and runtime mismatch',
      mutate: (receipt: string) => receipt.replace('built=' + 'a'.repeat(40), 'built=' + 'c'.repeat(40)),
      expectedError: 'does not prove the validated SHA',
    },
    {
      name: 'operator whitespace',
      mutate: (receipt: string) => receipt.replace('operator=andrew', 'operator=andrew nordstrom'),
      expectedError: 'invalid operator',
    },
    {
      name: 'operator injection',
      mutate: (receipt: string) => receipt.replace('operator=andrew', 'operator=andrew;id'),
      expectedError: 'invalid operator',
    },
    {
      name: 'migration path in M0 receipt',
      mutate: (receipt: string) => receipt.replace('migrations=none', 'migrations=src/db/migrations/001.sql'),
      expectedError: 'invalid migration set',
    },
    {
      name: 'migration path traversal',
      mutate: (receipt: string) => receipt.replace('migrations=none', 'migrations=src/db/migrations/../../etc/passwd'),
      expectedError: 'invalid migration set',
    },
    {
      name: 'Compose change on successful deployment',
      mutate: (receipt: string) => receipt.replace('compose=none', 'compose=docker-compose.prod.yml'),
      expectedError: 'invalid production Compose change set',
    },
    {
      name: 'Compose path traversal',
      mutate: (receipt: string) => receipt.replace('compose=none', 'compose=../../docker-compose.prod.yml'),
      expectedError: 'invalid production Compose change set',
    },
    {
      name: 'malformed UTC timestamp',
      mutate: (receipt: string) => receipt.replace('timestamp=2026-08-02T05:00:00Z', 'timestamp=2026-08-02T05:00:00+02:00'),
      expectedError: 'invalid timestamp',
    },
    {
      name: 'requested SHA from another promotion',
      mutate: (receipt: string) => receipt.replace(`requested=${'a'.repeat(40)}`, `requested=${'d'.repeat(40)}`),
      expectedError: 'does not match the validated SHA',
    },
    {
      name: 'malformed requested SHA',
      mutate: (receipt: string) => receipt.replace(`requested=${'a'.repeat(40)}`, 'requested=none'),
      expectedError: 'invalid SHA',
    },
    {
      name: 'malformed previous SHA',
      mutate: (receipt: string) => receipt.replace(`previous=${'b'.repeat(40)}`, 'previous=none'),
      expectedError: 'invalid SHA',
    },
  ])('rejects a deployment receipt with $name', ({ mutate, expectedError }) => {
    const deploy = readFileSync(DEPLOY_FILE, 'utf8');
    const sha = 'a'.repeat(40);
    const receipt = deploymentReceipt({
      status: 'succeeded',
      built: sha,
      deployed: sha,
      migrations: 'none',
      operator: 'andrew',
      previous: 'b'.repeat(40),
      requested: sha,
      runtime: sha,
      timestamp: '2026-08-02T05:00:00Z',
    });
    const result = runReceiptValidation(deploy, sha, mutate(receipt), 'success');

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(expectedError);
  });

  it.each(['started', 'rollback_interrupted'] as const)(
    'rejects unresolved production receipt status %s',
    (status) => {
      const deploy = readFileSync(DEPLOY_FILE, 'utf8');
      const sha = 'a'.repeat(40);
      const receipt = deploymentReceipt({
        status,
        built: 'none',
        deployed: 'none',
        migrations: 'none',
        operator: 'andrew',
        previous: 'b'.repeat(40),
        requested: sha,
        runtime: 'none',
        timestamp: '2026-08-02T05:00:00Z',
      });
      const result = runReceiptValidation(deploy, sha, receipt, 'failure');

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('unresolved production state');
    }
  );

  it('accepts a migration-blocked preflight receipt with the detected migration set', () => {
    const deploy = readFileSync(DEPLOY_FILE, 'utf8');
    const requestedSha = 'a'.repeat(40);
    const migrationSet = [
      'src/db/migrations/035_governance_rounds.sql',
      'src/db/migrations/036_policy_epoch.sql',
    ].join(',');
    const receipt = deploymentReceipt({
      status: 'preflight_failed',
      built: 'none',
      deployed: 'none',
      migrations: migrationSet,
      operator: 'andrew',
      previous: 'b'.repeat(40),
      requested: requestedSha,
      runtime: 'none',
      timestamp: '2026-08-02T05:00:00Z',
    });

    const result = runReceiptValidation(deploy, requestedSha, receipt, 'failure');

    expect(result.status).toBe(0);
    expect(result.summary).toContain(`- Migration set: ${migrationSet}`);
  });

  it('accepts a Compose-blocked preflight receipt with the detected path', () => {
    const deploy = readFileSync(DEPLOY_FILE, 'utf8');
    const requestedSha = 'a'.repeat(40);
    const receipt = deploymentReceipt({
      status: 'preflight_failed',
      built: 'none',
      deployed: 'none',
      migrations: 'none',
      operator: 'andrew',
      previous: 'b'.repeat(40),
      requested: requestedSha,
      runtime: 'none',
      timestamp: '2026-08-02T05:00:00Z',
    }).replace('compose=none', 'compose=docker-compose.prod.yml');

    const result = runReceiptValidation(deploy, requestedSha, receipt, 'failure');

    expect(result.status).toBe(0);
    expect(result.summary).toContain('- Migration set: none');
    expect(result.summary).toContain(
      '- Production Compose change set: docker-compose.prod.yml'
    );
  });

  it('accepts a pre-swap preflight receipt that proves the previous runtime', () => {
    const deploy = readFileSync(DEPLOY_FILE, 'utf8');
    const requestedSha = 'a'.repeat(40);
    const previousSha = 'b'.repeat(40);
    const receipt = deploymentReceipt({
      status: 'preflight_failed',
      built: requestedSha,
      deployed: previousSha,
      migrations: 'none',
      operator: 'andrew',
      previous: previousSha,
      requested: requestedSha,
      runtime: previousSha,
      timestamp: '2026-08-02T05:00:00Z',
    });
    const result = runReceiptValidation(deploy, requestedSha, receipt, 'failure');

    expect(result.status).toBe(0);
    expect(result.summary).toContain(`- Deployed checkout SHA: ${previousSha}`);
    expect(result.summary).toContain(`- Healthy runtime SHA: ${previousSha}`);
  });

  it('accepts a failed deployment receipt that proves restoration to PREV_COMMIT', () => {
    const deploy = readFileSync(DEPLOY_FILE, 'utf8');
    const requestedSha = 'a'.repeat(40);
    const previousSha = 'b'.repeat(40);
    const receipt = deploymentReceipt({
      status: 'rolled_back',
      built: requestedSha,
      deployed: previousSha,
      migrations: 'none',
      operator: 'andrew',
      previous: previousSha,
      requested: requestedSha,
      runtime: previousSha,
      timestamp: '2026-08-02T05:00:00Z',
    });

    const result = runReceiptValidation(deploy, requestedSha, receipt, 'failure');

    expect(result.status).toBe(0);
    expect(result.summary).toContain('- Status: rolled_back');
  });

  it.each([
    {
      status: 'preflight_failed' as const,
      built: 'none',
      deployed: 'none',
      runtime: 'none',
    },
    {
      status: 'rollback_failed' as const,
      built: 'a'.repeat(40),
      deployed: 'none',
      runtime: 'none',
    },
  ])('accepts and summarizes the terminal incident receipt $status', ({
    status,
    built,
    deployed,
    runtime,
  }) => {
    const deploy = readFileSync(DEPLOY_FILE, 'utf8');
    const requestedSha = 'a'.repeat(40);
    const previousSha = 'b'.repeat(40);
    const receipt = deploymentReceipt({
      status,
      built,
      deployed,
      migrations: 'none',
      operator: 'andrew',
      previous: previousSha,
      requested: requestedSha,
      runtime,
      timestamp: '2026-08-02T05:00:00Z',
    });

    const result = runReceiptValidation(deploy, requestedSha, receipt, 'failure');

    expect(result.status).toBe(0);
    expect(result.summary).toContain(`- Status: ${status}`);
    expect(result.summary).toContain(`- Previous SHA: ${previousSha}`);
  });

  it('rejects a rolled-back receipt that does not prove PREV_COMMIT', () => {
    const deploy = readFileSync(DEPLOY_FILE, 'utf8');
    const requestedSha = 'a'.repeat(40);
    const previousSha = 'b'.repeat(40);
    const receipt = deploymentReceipt({
      status: 'rolled_back',
      built: requestedSha,
      deployed: previousSha,
      migrations: 'none',
      operator: 'andrew',
      previous: previousSha,
      requested: requestedSha,
      runtime: 'c'.repeat(40),
      timestamp: '2026-08-02T05:00:00Z',
    });

    const result = runReceiptValidation(deploy, requestedSha, receipt, 'failure');

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      'does not prove the built target and restored previous SHA'
    );
  });

  it('rejects a rolled-back receipt without the built target SHA', () => {
    const deploy = readFileSync(DEPLOY_FILE, 'utf8');
    const requestedSha = 'a'.repeat(40);
    const previousSha = 'b'.repeat(40);
    const receipt = deploymentReceipt({
      status: 'rolled_back',
      built: 'none',
      deployed: previousSha,
      migrations: 'none',
      operator: 'andrew',
      previous: previousSha,
      requested: requestedSha,
      runtime: previousSha,
      timestamp: '2026-08-02T05:00:00Z',
    });

    const result = runReceiptValidation(deploy, requestedSha, receipt, 'failure');

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      'does not prove the built target and restored previous SHA'
    );
  });

  it('rejects a success receipt from a failed deployment step', () => {
    const deploy = readFileSync(DEPLOY_FILE, 'utf8');
    const sha = 'a'.repeat(40);
    const receipt = deploymentReceipt({
      status: 'succeeded',
      built: sha,
      deployed: sha,
      migrations: 'none',
      operator: 'andrew',
      previous: 'b'.repeat(40),
      requested: sha,
      runtime: sha,
      timestamp: '2026-08-02T05:00:00Z',
    });

    const result = runReceiptValidation(deploy, sha, receipt, 'failure');

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Failed deployment step produced a success receipt');
  });

  it('rejects a non-success receipt from a successful deployment step', () => {
    const deploy = readFileSync(DEPLOY_FILE, 'utf8');
    const requestedSha = 'a'.repeat(40);
    const previousSha = 'b'.repeat(40);
    const receipt = deploymentReceipt({
      status: 'rolled_back',
      built: requestedSha,
      deployed: previousSha,
      migrations: 'none',
      operator: 'andrew',
      previous: previousSha,
      requested: requestedSha,
      runtime: previousSha,
      timestamp: '2026-08-02T05:00:00Z',
    });

    const result = runReceiptValidation(deploy, requestedSha, receipt, 'success');

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Successful deployment step produced a non-success receipt');
  });

  it.each([
    { name: 'repository contract', path: REPO_CONTRACT_FILE },
    { name: 'operator quickstart', path: OPERATOR_QUICKSTART_FILE },
  ])(
    'keeps protected-workflow recovery, revision, and receipt gates in the $name',
    ({ path }) => {
      const document = readFileSync(path, 'utf8');

      expect(() => assertProtectedWorkflowRecoveryContract(document)).not.toThrow();
    }
  );

  it.each(PROTECTED_RECOVERY_CLAIMS)(
    'rejects recovery documentation missing the claim: %s',
    (claim) => {
      const document = readFileSync(REPO_CONTRACT_FILE, 'utf8');
      const mutated = document.replaceAll(claim, '');

      expect(mutated).not.toBe(document);
      expect(() => assertProtectedWorkflowRecoveryContract(mutated)).toThrow(
        `Missing protected recovery claim: ${claim}`
      );
    }
  );

  it('requires both ingestion signals before the operator redispatches', () => {
    const quickstart = readFileSync(OPERATOR_QUICKSTART_FILE, 'utf8');

    expect(quickstart).toContain(
      'Cursor increasing and `newest_post_age_s` at or below 120'
    );
    expect(quickstart).toContain(
      'Cursor increasing and `newest_post_age_s` above 120'
    );
    expect(quickstart).toContain(
      'Investigate ingestion filters and\n    the embedding gate; do not redispatch'
    );
    expect(quickstart).toContain(
      'Cursor static: Jetstream ingestion is stalled'
    );
    expect(quickstart).toContain('Ingestion signals are ahead of host time');
    expect(quickstart).toContain('reconcile host and database time');
    expect(quickstart).toContain('HOST_EPOCH="$(date +%s)"');
    expect(quickstart).toContain('HOST_EPOCH - CURSOR_US / 1000000');
    expect(quickstart).toContain('HOST_EPOCH - NEWEST_POST_EPOCH');
    expect(quickstart).toContain('300 seconds ahead or behind the VPS clock');
    expect(quickstart).not.toContain('EXTRACT(EPOCH FROM now())');
  });

  it('documents and enforces exact lowercase main SHA dispatch inputs', () => {
    const quickstart = readFileSync(OPERATOR_QUICKSTART_FILE, 'utf8');
    const contract = readFileSync(REPO_CONTRACT_FILE, 'utf8');

    for (const document of [quickstart, contract]) {
      expect(document).toContain('40-character lowercase');
      expect(document.toLowerCase()).toContain('abbreviated');
      expect(document.toLowerCase()).toContain('uppercase');
      expect(document.toLowerCase()).toContain('nonexistent');
      expect(document).toContain('non-`main`');
    }
  });

  it('keeps restart-oriented probes dependency-only when promotion freshness is stale', () => {
    const server = readFileSync(SERVER_FILE, 'utf8');
    const dockerfile = readFileSync(DOCKERFILE, 'utf8');
    const watchdog = readFileSync(HEALTH_WATCHDOG_FILE, 'utf8');
    const readyStart = server.indexOf("app.get('/health/ready'");
    const promotionStart = server.indexOf("app.get('/health/promotion-ready'");
    const openApiStart = server.indexOf("app.get(\n    '/api/openapi.json'", promotionStart);

    expect(readyStart).toBeGreaterThanOrEqual(0);
    expect(promotionStart).toBeGreaterThan(readyStart);
    expect(openApiStart).toBeGreaterThan(promotionStart);
    const readyRoute = server.slice(readyStart, promotionStart);
    const promotionRoute = server.slice(promotionStart, openApiStart);
    expect(readyRoute).toContain('await isReady()');
    expect(readyRoute).not.toContain('isPromotionReady');
    expect(promotionRoute).toContain('await isPromotionReady()');
    expect(promotionRoute).toContain('hide: true');
    // The promotion-ready route has its own small rate-limit bucket, not the
    // full `rateLimit: false` exemption from the global limiter.
    expect(promotionRoute).toContain('RATE_LIMIT_PROMOTION_READY_MAX');
    expect(promotionRoute).toContain('RATE_LIMIT_PROMOTION_READY_WINDOW_MS');
    expect(promotionRoute).not.toContain('config: { rateLimit: false }');
    expect(promotionRoute).toContain('isDirectLoopbackRequest(request)');
    expect(promotionRoute).toContain("reply.status(403).send({ status: 'not ready' })");
    expect(promotionRoute).toContain("reply.status(503).send({ status: 'not ready' })");
    expect(dockerfile).toContain('http://localhost:3000/health/ready');
    expect(dockerfile).not.toContain('/health/promotion-ready');
    expect(watchdog).toContain('HEALTH_URL="http://localhost:3001/health/ready"');
    expect(watchdog).not.toContain('/health/promotion-ready');
    expect(readFileSync(DEPLOY_FILE, 'utf8')).toContain(
      'http://localhost:3001/health/promotion-ready'
    );
  });

  it.each([
    { name: 'repository contract', path: REPO_CONTRACT_FILE },
    { name: 'operator quickstart', path: OPERATOR_QUICKSTART_FILE },
  ])('separates watchdog liveness from freshness readiness in the $name', ({ path }) => {
    const document = readFileSync(path, 'utf8');

    expect(document).toContain('/health/live');
    expect(document).toContain('/health/ready');
    expect(document).toContain('/health/promotion-ready');
    expect(document).toContain('systemd watchdog');
    expect(document).toContain('database and Redis');
    expect(document).toContain('120 seconds');
  });

  it('keeps the operator ingestion diagnostic fail-fast and missing-safe', () => {
    const document = readFileSync(OPERATOR_QUICKSTART_FILE, 'utf8');

    for (const marker of [
      'set -euo pipefail',
      'timeout 10s sudo docker exec bluesky-feed-postgres',
      '-v ON_ERROR_STOP=1 -tA -c',
      'cursor_age_s=MISSING',
      'newest_post_age_s=MISSING',
      'neither signal is ahead of the VPS clock',
    ]) {
      expect(document).toContain(marker);
    }
  });

  it('documents which environment backups block the first promotion', () => {
    const contract = readFileSync(REPO_CONTRACT_FILE, 'utf8');

    for (const claim of [
      'Root and `web/` `.env*.bak` files are non-ignored',
      '`web-next/` `.env*.bak` files are ignored',
      'Any unrelated\n   non-ignored artifact also blocks promotion',
    ]) {
      expect(contract).toContain(claim);
    }
  });

  it('keeps rollback restricted to the previous or explicitly approved SHA', () => {
    const contract = readFileSync(REPO_CONTRACT_FILE, 'utf8');

    expect(() => assertRollbackContract(contract)).not.toThrow();
  });

  it.each(ROLLBACK_CONTRACT_CLAIMS)(
    'rejects rollback documentation missing the claim: %s',
    (claim) => {
      const contract = readFileSync(REPO_CONTRACT_FILE, 'utf8');
      const mutated = contract.replaceAll(claim, '');

      expect(mutated).not.toBe(contract);
      expect(() => assertRollbackContract(mutated)).toThrow(
        `Missing rollback contract claim: ${claim}`
      );
    }
  );

  it.each(['*', '"*"', "'*'"])('rejects wildcard Git trust in recovery docs: %s', (value) => {
    const contract = readFileSync(REPO_CONTRACT_FILE, 'utf8');
    const mutated = `${contract}\ngit config --global --add safe.directory ${value}\n`;

    expect(() => assertProtectedWorkflowRecoveryContract(mutated)).toThrow(
      'Recovery documentation must not trust every Git directory'
    );
  });

  it('bounds runner-script extraction at the next top-level job', () => {
    const deploy = readFileSync(DEPLOY_FILE, 'utf8');
    const nextJob = '  require-deploy-enabled:\n';
    const insertedJob = [
      '  synthetic-between-validation-and-enable:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - name: Synthetic command',
      '        run: |',
      '          echo must-not-be-extracted',
      '',
    ].join('\n');
    const mutated = deploy.replace(nextJob, `${insertedJob}${nextJob}`);

    expect(mutated).not.toBe(deploy);
    expect(extractRunnerValidationScript(mutated)).not.toContain(
      'must-not-be-extracted'
    );
  });

  it('anchors remote-script extraction to the deploy step', () => {
    const deploy = readFileSync(DEPLOY_FILE, 'utf8');
    const deployStep = '      - name: Deploy to VPS\n';
    const syntheticStep = [
      '      - name: Inspect before deploy',
      '        uses: appleboy/ssh-action@example',
      '        with:',
      '          script: |',
      '            echo synthetic',
      '',
    ].join('\n');
    const mutated = deploy.replace(deployStep, `${syntheticStep}${deployStep}`);

    expect(mutated).not.toBe(deploy);
    expect(extractRemoteDeployScript(mutated)).toContain('ROLLBACK_ARMED=true');
    expect(extractRemoteDeployScript(mutated)).not.toContain('echo synthetic');

    const captureStep = '      - name: Capture deployment receipt\n';
    const insertedFollowingStep = [
      '      - name: Inspect between deploy and capture',
      '        uses: appleboy/ssh-action@example',
      '        with:',
      '          script: |',
      '            echo following-step',
      '',
    ].join('\n');
    const withFollowingStep = deploy.replace(
      captureStep,
      `${insertedFollowingStep}${captureStep}`
    );

    expect(withFollowingStep).not.toBe(deploy);
    expect(extractRemoteDeployScript(withFollowingStep)).not.toContain(
      'echo following-step'
    );
  });
});

function assertExactShaPromotionContract(workflow: string): void {
  if (/^\s*push:/m.test(workflow)) {
    throw new Error('Production deploy must not trigger on push');
  }

  const sshConnectionCount =
    workflow.match(/uses: appleboy\/(?:ssh|scp)-action@/g)?.length ?? 0;
  const fingerprintCount = workflow.match(
    /fingerprint: \$\{\{ secrets\.PRODUCTION_VPS_SSH_FINGERPRINT \}\}/g
  )?.length ?? 0;
  if (sshConnectionCount === 0 || fingerprintCount !== sshConnectionCount) {
    throw new Error('Every production SSH connection must pin the VPS host fingerprint');
  }

  for (const marker of EXACT_SHA_PROMOTION_MARKERS) {
    if (!workflow.includes(marker.value)) {
      throw new Error(`Missing ${marker.name}`);
    }
  }

  const runnerScript = extractRunnerValidationScript(workflow);
  const remoteScript = extractRemoteDeployScript(workflow);
  for (const marker of EXACT_SHA_PROMOTION_MARKERS) {
    if ('executableIn' in marker) {
      const script = marker.executableIn === 'runner' ? runnerScript : remoteScript;
      if (countExecutableCommand(script, marker.value) !== 1) {
        throw new Error(`Missing ${marker.name}`);
      }
    }
  }
  if (runnerScript.includes('${{')) {
    throw new Error('Runner shell scripts must receive workflow expressions through env');
  }
  const commitCheck = 'git cat-file -e "${DEPLOY_SHA}^{commit}"';
  if (
    countExecutableCommand(runnerScript, commitCheck) !== 1 ||
    countExecutableCommand(remoteScript, commitCheck) !== 1
  ) {
    throw new Error('Commit existence check must run on the runner and the VPS');
  }

  const ancestryCheck =
    'git merge-base --is-ancestor "$DEPLOY_SHA" refs/remotes/origin/main';
  if (
    countExecutableCommand(runnerScript, ancestryCheck) !== 1 ||
    countExecutableCommand(remoteScript, ancestryCheck) !== 1
  ) {
    throw new Error('Main ancestry check must run on the runner and the VPS');
  }

  const mainFetch = 'git fetch --no-tags origin refs/heads/main:refs/remotes/origin/main';
  if (
    countExecutableCommand(runnerScript, mainFetch) !== 1 ||
    countExecutableCommand(remoteScript, mainFetch) !== 1
  ) {
    throw new Error('Explicit main fetch must run on the runner and the VPS');
  }

  const fullShaValidation =
    'if [[ ! "$DEPLOY_SHA" =~ ^[0-9a-f]{40}$ ]]; then';
  if (
    countExecutableCommand(runnerScript, fullShaValidation) !== 1 ||
    countExecutableCommand(remoteScript, fullShaValidation) !== 1
  ) {
    throw new Error('Lowercase full-SHA validation must run on the runner and the VPS');
  }

  const remoteLines = executableLines(remoteScript);
  if (remoteLines.some((line) => gitSubcommandsInLine(line).includes('pull'))) {
    throw new Error('Remote deploy must not use git pull');
  }
  if (remoteScript.includes('${{')) {
    throw new Error('Remote script must receive workflow expressions through envs');
  }
  assertLifecycleScriptContract(runnerScript, remoteScript);
  assertMigrationBlockContract(remoteScript);
  assertRuntimeRestartContract(remoteScript);
  assertHostDeploymentLock(remoteScript);

  const targetLock = 'test "$ACTUAL_SHA" = "$DEPLOY_SHA"';
  const rollbackStart = 'if [ "$HEALTHY" = "false" ]; then';
  const targetLockIndex = remoteScript.indexOf(targetLock);
  const rollbackStartIndex = remoteScript.indexOf(rollbackStart);
  if (targetLockIndex < 0 || rollbackStartIndex <= targetLockIndex) {
    throw new Error('Missing bounded exact-SHA deploy path');
  }
  const lockedDeployPath = remoteScript.slice(
    targetLockIndex + targetLock.length,
    rollbackStartIndex
  );
  if (
    executableLines(lockedDeployPath).some((line) => gitSubcommandsInLine(line).length > 0)
  ) {
    throw new Error('Remote deploy path must not mutate Git refs after target lock');
  }
  if (
    remoteLines.some((line) =>
      gitSubcommandsInLine(line).includes('checkout') &&
      /(?:^|\s)(?:main|origin\/main)(?:\s|$)/.test(line)
    )
  ) {
    throw new Error('Remote deploy must not check out mutable main');
  }

  const checksumIndex = remoteLines.indexOf(
    'sha256sum --check "${RELEASE_ARCHIVE}.sha256"'
  );
  const extractionIndex = remoteLines.findIndex(
    (line, index) =>
      index > checksumIndex &&
      line.replace(/\s+/g, ' ') ===
        'tar -xzf "$RELEASE_ARCHIVE" --no-same-owner --no-same-permissions -C "$CANDIDATE_BUILD_DIR"'
  );
  const candidateVerifiedIndex = remoteLines.findIndex(
    (line, index) => index > extractionIndex && line === 'candidate_artifacts_are_complete'
  );
  const buildShaIndex = remoteLines.findIndex(
    (line, index) => index > candidateVerifiedIndex && line === 'BUILD_SHA="$DEPLOY_SHA"'
  );
  const armedIndex = remoteLines.findIndex(
    (line, index) => index > buildShaIndex && line === 'ROLLBACK_ARMED=true'
  );
  if (
    checksumIndex < 0 ||
    extractionIndex <= checksumIndex ||
    candidateVerifiedIndex <= extractionIndex ||
    buildShaIndex <= candidateVerifiedIndex ||
    armedIndex <= buildShaIndex
  ) {
    throw new Error('Exact-SHA artifact must verify before production mutation');
  }

  const runnerLines = executableLines(runnerScript);
  const runnerVerifyIndex = runnerLines.indexOf('npm run verify');
  const runnerStampIndex = runnerLines.indexOf(
    'printf \'%s\\n\' "$VALIDATED_SHA" > dist/.release-sha'
  );
  const runnerArchiveIndex = runnerLines.findIndex(
    (line) => line.startsWith('tar -czf "$RELEASE_ARCHIVE" -- ')
  );
  const runnerChecksumIndex = runnerLines.indexOf(
    'ARCHIVE_SHA256="$(sha256sum "$RELEASE_ARCHIVE" | awk \'{ print $1 }\')"'
  );
  if (
    runnerVerifyIndex < 0 ||
    runnerStampIndex <= runnerVerifyIndex ||
    runnerArchiveIndex <= runnerStampIndex ||
    runnerChecksumIndex <= runnerArchiveIndex
  ) {
    throw new Error('Runner must verify, stamp, archive, and checksum the exact SHA');
  }

  const successStart = checksumIndex;
  if (successStart < 0) {
    throw new Error('Missing bounded successful deployment path');
  }
  const successLines = remoteLines.slice(successStart);
  const releaseArtifactIndex = successLines.indexOf(
    'test "$(cat dist/.release-sha 2>/dev/null)" = "$DEPLOY_SHA"'
  );
  const restartIndex = successLines.indexOf(
    'sudo -n -- /usr/local/sbin/corgi-deploy-root service-restart'
  );
  const runtimeCompareIndex = successLines.findIndex((line) =>
    line.includes('[ "$RUNTIME_SHA" != "$DEPLOY_SHA" ]')
  );
  const trapClearIndex = successLines.indexOf('trap - ERR EXIT HUP INT TERM');
  const disarmIndex = successLines.indexOf('ROLLBACK_ARMED=false');
  const receiptIndex = successLines.indexOf('if ! write_receipt succeeded; then');
  if (
    releaseArtifactIndex < 0 ||
    restartIndex < 0 ||
    runtimeCompareIndex < 0 ||
    trapClearIndex < 0 ||
    disarmIndex < 0 ||
    receiptIndex < 0
  ) {
    throw new Error('Missing runtime revision or receipt marker');
  }
  if (
    restartIndex <= releaseArtifactIndex ||
    runtimeCompareIndex <= restartIndex ||
    trapClearIndex <= runtimeCompareIndex ||
    disarmIndex <= trapClearIndex ||
    receiptIndex <= disarmIndex
  ) {
    throw new Error('Runtime SHA must be process-reported before receipt');
  }

  assertRollbackCoverage(remoteScript);
}

function assertRollbackCoverage(remoteScript: string): void {
  const rollbackFunction = extractShellFunction(remoteScript, 'rollback_application');
  for (const marker of [
    'git checkout --detach "$PREV_COMMIT"',
    'restore_previous_artifacts',
    'Candidate failed before production artifact mutation; previous runtime remains active',
    'Rollback could not restore the retained PREV_COMMIT artifacts',
    'sudo -n -- /usr/local/sbin/corgi-deploy-root service-restart',
  ]) {
    if (!rollbackFunction.includes(marker)) {
      throw new Error(`Rollback function missing marker: ${marker}`);
    }
  }
  if (containsSchemaMutationRunner(rollbackFunction)) {
    throw new Error('Rollback function must not run a down migration');
  }
  if (/\bnpm\s+(?:ci|install|run)\b/.test(rollbackFunction)) {
    throw new Error('Rollback must not depend on package installation or rebuilding');
  }
  if (rollbackFunction.includes('write_release_artifact')) {
    throw new Error('Rollback must restore the retained release artifact');
  }
  for (const signalTrap of [
    "trap 'on_deploy_error \"$?\"' ERR",
    "trap 'on_deploy_error \"$?\"' EXIT",
    "trap 'on_deploy_error 129' HUP",
    "trap 'on_deploy_error 130' INT",
    "trap 'on_deploy_error 143' TERM",
  ]) {
    if (!remoteScript.includes(signalTrap)) {
      throw new Error(`Rollback interruption coverage missing trap: ${signalTrap}`);
    }
  }
  for (const singleShotMarker of [
    'DEPLOY_MAIN_BASHPID="$BASHPID"',
    'if [ "$BASHPID" != "$DEPLOY_MAIN_BASHPID" ]; then',
    'if [ -e "$ROLLBACK_GUARD_DIR" ] || [ -L "$ROLLBACK_GUARD_DIR" ]; then',
    'elif mkdir "$ROLLBACK_GUARD_DIR"; then',
  ]) {
    if (!remoteScript.includes(singleShotMarker)) {
      throw new Error(`Rollback single-shot guard missing marker: ${singleShotMarker}`);
    }
  }
  const rollbackCheckoutIndex = rollbackFunction.lastIndexOf(
    'git checkout --detach "$PREV_COMMIT"'
  );
  const rollbackRestoreIndex = rollbackFunction.indexOf('restore_previous_artifacts');
  const rollbackRestartIndex = rollbackFunction.indexOf(
    'sudo -n -- /usr/local/sbin/corgi-deploy-root service-restart'
  );
  if (
    rollbackCheckoutIndex < 0 ||
    rollbackRestoreIndex <= rollbackCheckoutIndex ||
    rollbackRestartIndex <= rollbackRestoreIndex
  ) {
    throw new Error('Rollback must restore retained artifacts before restarting');
  }
  if (
    rollbackFunction.includes('SERVICE_RESTART_ATTEMPTED') ||
    !rollbackFunction.includes(
      'The retained release replaced every served artifact; restart it without'
    )
  ) {
    throw new Error('Rollback must always restart after replacing served artifacts');
  }

  const armedIndex = remoteScript.indexOf('ROLLBACK_ARMED=true');
  if (armedIndex < 0) {
    throw new Error('Rollback error trap must remain armed through health verification');
  }
  const disarmedIndex = remoteScript.indexOf('ROLLBACK_ARMED=false', armedIndex);
  const trapClearIndex = remoteScript.indexOf(
    'trap - ERR EXIT HUP INT TERM',
    armedIndex
  );
  if (
    disarmedIndex <= armedIndex ||
    remoteScript.indexOf("trap 'on_deploy_error \"$?\"' ERR") < 0
  ) {
    throw new Error('Rollback error trap must remain armed through health verification');
  }
  if (trapClearIndex <= armedIndex || disarmedIndex <= trapClearIndex) {
    throw new Error('Successful deployment must clear every rollback trap before disarming');
  }
  const successPath = remoteScript.slice(armedIndex, disarmedIndex);
  const preflightFreshnessIndex = remoteScript.indexOf(
    'ingestion_signals_are_fresh "$PREFLIGHT_INGESTION_SIGNALS" "0"'
  );
  if (preflightFreshnessIndex < 0 || preflightFreshnessIndex > armedIndex) {
    throw new Error('Ingestion freshness must pass before rollback is armed');
  }
  for (const marker of [
    'backup_previous_artifacts',
    'install_candidate_artifacts',
    'sudo -n -- /usr/local/sbin/corgi-deploy-root service-restart',
    'if [ "$HEALTHY" = "false" ]; then',
  ]) {
    if (!successPath.includes(marker)) {
      throw new Error(`Rollback coverage missing success-path marker: ${marker}`);
    }
  }
  if (
    executableLines(successPath).some((line) =>
      line
        .split(/&&|\|\||[;|]/)
        .map((segment) => segment.trim().replace(/^[({]\s*/, ''))
        .some((segment) => /^exit(?:\s|$)/.test(segment))
    )
  ) {
    throw new Error('Rollback-armed deployment path must not bypass ERR with exit');
  }
  for (const marker of [
    'POST_RESTART_BASELINE_SIGNALS="$(read_ingestion_signals)"',
    'IFS=\'|\' read -r POST_RESTART_BASELINE_CURSOR _ <<< "$POST_RESTART_BASELINE_SIGNALS"',
    'POST_RESTART_SIGNALS="$(read_ingestion_signals)"',
    'ingestion_signals_are_fresh "$POST_RESTART_SIGNALS" "$POST_RESTART_BASELINE_CURSOR"',
  ]) {
    if (!successPath.includes(marker)) {
      throw new Error(`Composite health progression proof missing marker: ${marker}`);
    }
  }
  const restartIndex = successPath.indexOf(
    'sudo -n -- /usr/local/sbin/corgi-deploy-root service-restart'
  );
  const postRestartBaselineIndex = successPath.indexOf(
    'POST_RESTART_BASELINE_SIGNALS="$(read_ingestion_signals)"'
  );
  if (restartIndex < 0 || postRestartBaselineIndex <= restartIndex) {
    throw new Error('Cursor advancement baseline must be captured after restart');
  }
  const startedReceiptIndex = remoteScript.indexOf('write_receipt started');
  if (startedReceiptIndex < 0 || startedReceiptIndex > armedIndex) {
    throw new Error('Started receipt must be durable before deployment mutation');
  }
}

function extractRunnerValidationScript(workflow: string): string {
  const jobMarker = '  validate-target:\n';
  const jobStart = workflow.indexOf(jobMarker);
  if (jobStart < 0) {
    throw new Error('Missing bounded runner validation script');
  }
  const followingJob = /\n  [A-Za-z0-9_-]+:\n/.exec(
    workflow.slice(jobStart + jobMarker.length)
  );
  if (!followingJob || followingJob.index < 0) {
    throw new Error('Missing bounded runner validation script');
  }
  const jobEnd = jobStart + jobMarker.length + followingJob.index;
  const validationJob = workflow.slice(jobStart, jobEnd);
  const stepMarker = '      - name: Validate requested main SHA\n';
  const stepStart = validationJob.indexOf(stepMarker);
  const scriptMarker = '        run: |\n';
  if (stepStart < 0) {
    throw new Error('Missing bounded runner validation script');
  }
  const validationStepEnd = validationJob.indexOf(
    '\n      - name:',
    stepStart + stepMarker.length
  );
  if (validationStepEnd <= stepStart) {
    throw new Error('Missing bounded runner validation script');
  }
  const validationStep = validationJob.slice(stepStart, validationStepEnd);
  if (!validationStep.includes(scriptMarker)) {
    const unsupportedRun = validationStep.split('\n').find((line) => /^ *run:/.test(line));
    if (unsupportedRun) {
      throw new Error(
        `Unsupported run block form in runner validation job: ${unsupportedRun.trim()}`
      );
    }
    throw new Error('Missing bounded runner validation script');
  }
  const scriptStart = validationJob.indexOf(scriptMarker, stepStart);
  if (scriptStart < 0) {
    throw new Error('Missing bounded runner validation script');
  }
  const jobSteps = validationJob.slice(scriptStart + scriptMarker.length);
  const lines = jobSteps.split('\n');
  const scripts: string[] = [];
  let runIndent: number | null = scriptMarker.match(/^ */)?.[0].length ?? null;
  for (const line of lines) {
    const leadingSpaces = line.match(/^ */)?.[0].length ?? 0;
    if (runIndent !== null) {
      if (line.trim().length === 0 || leadingSpaces > runIndent) {
        scripts.push(line.slice(Math.min(line.length, runIndent + 2)));
        continue;
      }
      runIndent = null;
    }
    const runMatch = line.match(/^( *)run: \|$/);
    if (runMatch) {
      runIndent = runMatch[1].length;
      continue;
    }
    if (/^ *run:/.test(line)) {
      throw new Error(
        `Unsupported run block form in runner validation job: ${line.trim()}`
      );
    }
  }
  return scripts.join('\n');
}

function extractInputGuard(script: string, variable: string): string {
  const lines = script.split('\n');
  const start = lines.findIndex((line) =>
    line.includes(`if [[ ! "$${variable}" =~`)
  );
  const end = lines.findIndex((line, index) => index > start && line.trim() === 'fi');
  if (start < 0 || end <= start) {
    throw new Error(`Missing bounded input guard: variable=${variable}`);
  }
  return lines.slice(start, end + 1).join('\n');
}

function extractProductionCredentialGuard(workflow: string): string {
  const stepMarker = '      - name: Require production SSH credentials\n';
  const stepStart = workflow.indexOf(stepMarker);
  if (stepStart < 0) {
    throw new Error('Missing bounded production credential guard');
  }
  const scriptMarker = '        run: |\n';
  const start = workflow.indexOf(scriptMarker, stepStart);
  const end = workflow.indexOf('\n      - name:', start);
  if (start < 0 || end <= start) {
    throw new Error('Missing bounded production credential guard');
  }
  return workflow.slice(start + scriptMarker.length, end);
}

function extractNativeModuleSmokeTestScript(workflow: string): string {
  const stepMarker = '      - name: Smoke-test packaged native runtime modules\n';
  const stepStart = workflow.indexOf(stepMarker);
  if (stepStart < 0) {
    throw new Error('Missing bounded native-module smoke-test script');
  }
  const scriptMarker = '        run: |\n';
  const start = workflow.indexOf(scriptMarker, stepStart);
  const end = workflow.indexOf('\n      - name:', start);
  if (start < 0 || end <= start) {
    throw new Error('Missing bounded native-module smoke-test script');
  }
  return workflow.slice(start + scriptMarker.length, end);
}

function extractTransferAdmissionScript(workflow: string): string {
  const stepMarker = '      - name: Admit artifact transfer\n';
  const stepStart = workflow.indexOf(stepMarker);
  if (stepStart < 0) {
    throw new Error('Missing bounded artifact-transfer admission script');
  }
  const startMarker = '          script: |\n';
  const start = workflow.indexOf(startMarker, stepStart);
  const end = workflow.indexOf('\n      - name:', start);
  if (start < 0 || end <= start) {
    throw new Error('Missing bounded artifact-transfer admission script');
  }
  return workflow.slice(start + startMarker.length, end);
}

function extractRemoteDeployScript(workflow: string): string {
  const stepMarker = '      - name: Deploy to VPS\n';
  const stepStart = workflow.indexOf(stepMarker);
  if (stepStart < 0) {
    throw new Error('Missing bounded remote deploy script');
  }
  const startMarker = '          script: |\n';
  const start = workflow.indexOf(startMarker, stepStart);
  const end = workflow.indexOf('\n      - name:', start);
  if (start < 0 || end <= start) {
    throw new Error('Missing bounded remote deploy script');
  }
  return workflow.slice(start + startMarker.length, end);
}

function extractReceiptValidationScript(workflow: string): string {
  const stepMarker = '      - name: Record deployment receipt\n';
  const stepStart = workflow.indexOf(stepMarker);
  const scriptMarker = '        run: |\n';
  if (stepStart < 0) {
    throw new Error('Missing bounded deployment receipt validation script');
  }
  const scriptStart = workflow.indexOf(scriptMarker, stepStart);
  if (scriptStart < 0) {
    throw new Error('Missing bounded deployment receipt validation script');
  }
  const stepEnd = workflow.indexOf(
    '\n\n      - name: Report unreadable deployment receipt',
    scriptStart
  );
  if (stepEnd <= scriptStart) {
    throw new Error('Missing bounded deployment receipt validation script');
  }
  return workflow.slice(scriptStart + scriptMarker.length, stepEnd);
}

function extractUnreadableReceiptReportScript(workflow: string): string {
  const stepMarker = '      - name: Report unreadable deployment receipt\n';
  const stepStart = workflow.indexOf(stepMarker);
  const scriptMarker = '        run: |\n';
  const scriptStart = workflow.indexOf(scriptMarker, stepStart);
  const stepEnd = workflow.indexOf('\n      - name:', scriptStart);
  if (stepStart < 0 || scriptStart < 0 || stepEnd <= scriptStart) {
    throw new Error('Missing bounded unreadable-receipt report script');
  }
  return workflow.slice(scriptStart + scriptMarker.length, stepEnd);
}

function extractRuntimeInspectionScript(workflow: string): string {
  const stepMarker = '      - name: Inspect runtime and checkout consistency\n';
  const stepStart = workflow.indexOf(stepMarker);
  const scriptMarker = '          script: |\n';
  const scriptStart = workflow.indexOf(scriptMarker, stepStart);
  const stepEnd = workflow.indexOf('\n      - name:', scriptStart);
  if (stepStart < 0 || scriptStart < 0 || stepEnd <= scriptStart) {
    throw new Error('Missing bounded runtime-inspection script');
  }
  return workflow.slice(scriptStart + scriptMarker.length, stepEnd);
}

interface DeploymentReceiptFields {
  status:
    | 'succeeded'
    | 'rolled_back'
    | 'rollback_failed'
    | 'rollback_interrupted'
    | 'preflight_failed'
    | 'started';
  requested: string;
  previous: string;
  built: string;
  deployed: string;
  runtime: string;
  migrations: string;
  operator: string;
  timestamp: string;
}

function deploymentReceipt(fields: DeploymentReceiptFields): string {
  return [
    'CORGI_DEPLOY_RECEIPT',
    `status=${fields.status}`,
    `requested=${fields.requested}`,
    `previous=${fields.previous}`,
    `built=${fields.built}`,
    `deployed=${fields.deployed}`,
    `runtime=${fields.runtime}`,
    `migrations=${fields.migrations}`,
    'compose=none',
    `operator=${fields.operator}`,
    `timestamp=${fields.timestamp}`,
  ].join('|');
}

function runPriorAttemptAdmission(
  remoteScript: string,
  receiptDirectory: string,
  incomingRoot: string
): SpawnSyncReturns<string> {
  const receiptGuardFunction = extractShellFunction(
    remoteScript,
    'receipt_is_safe_terminal'
  );
  const reclaimFunction = extractShellFunction(
    remoteScript,
    'reclaim_prior_terminal_artifacts'
  );
  const script = `
RECEIPT_DIR="$TEST_RECEIPT_DIR"
INCOMING_ARTIFACT_ROOT="$TEST_INCOMING_ROOT"
DEPLOY_RUN_ID=99
DEPLOY_RUN_ATTEMPT=1
${receiptGuardFunction}
${reclaimFunction}
reclaim_prior_terminal_artifacts
`;
  return spawnSync('bash', ['-c', `set -Eeuo pipefail\n${script}`], {
    encoding: 'utf8',
    env: {
      ...process.env,
      TEST_INCOMING_ROOT: incomingRoot,
      TEST_RECEIPT_DIR: receiptDirectory,
    },
  });
}

function runReceiptGuard(
  functionSource: string,
  functionName: string,
  receipt: string
): number | null {
  const directory = mkdtempSync(join(tmpdir(), 'corgi-receipt-guard-'));
  const receiptPath = join(directory, 'attempt.receipt');
  try {
    writeFileSync(receiptPath, `${receipt}\n`, 'utf8');
    const result = spawnSync(
      'bash',
      ['-c', `set -Eeuo pipefail\n${functionSource}\n${functionName} "$TEST_RECEIPT"`],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          TEST_RECEIPT: receiptPath,
        },
      }
    );
    return result.status;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

interface ReceiptValidationResult {
  status: number | null;
  stderr: string;
  summary: string;
}

function runReceiptValidation(
  workflow: string,
  deploySha: string,
  deployOutput: string,
  deployStepOutcome: string
): ReceiptValidationResult {
  const directory = mkdtempSync(join(tmpdir(), 'corgi-deploy-receipt-'));
  const summaryPath = join(directory, 'summary.md');
  try {
    const result = spawnSync('bash', ['-c', extractReceiptValidationScript(workflow)], {
      encoding: 'utf8',
      env: {
        ...process.env,
        DEPLOY_OUTPUT: deployOutput,
        DEPLOY_STEP_OUTCOME: deployStepOutcome,
        DEPLOY_RUN_URL: 'https://github.example/actions/runs/1',
        DEPLOY_SHA: deploySha,
        GITHUB_STEP_SUMMARY: summaryPath,
      },
    });
    return {
      status: result.status,
      stderr: result.stderr,
      summary: existsSync(summaryPath) ? readFileSync(summaryPath, 'utf8') : '',
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function assertLifecycleScriptContract(runnerScript: string, remoteScript: string): void {
  for (const line of executableLines(`${runnerScript}\n${remoteScript}`)) {
    for (const invocation of npmCommandInvocations(line)) {
      if (
        ['ci', 'install', 'i', 'add'].includes(invocation.command) &&
        (invocation.command !== 'ci' || !invocation.args.includes('--ignore-scripts'))
      ) {
        throw new Error('Deployment install must disable lifecycle scripts');
      }
      if (invocation.command === 'exec') {
        throw new Error('Deployment executable must prohibit implicit package installation');
      }
    }
    if (/\bnpx\b/.test(line)) {
      throw new Error('Deployment executable must prohibit implicit package installation');
    }
  }
}

interface NpmCommandInvocation {
  command: string;
  args: string[];
}

function npmCommandInvocations(line: string): NpmCommandInvocation[] {
  const tokens = line.replace(/[(){}]/g, ' ').split(/\s+/).filter(Boolean);
  const invocations: NpmCommandInvocation[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index] !== 'npm') {
      continue;
    }
    let commandIndex = index + 1;
    while (commandIndex < tokens.length && tokens[commandIndex].startsWith('-')) {
      const option = tokens[commandIndex];
      commandIndex += 1;
      if (
        ['--prefix', '--workspace', '--userconfig', '--cache', '-C', '-w'].includes(option) &&
        commandIndex < tokens.length
      ) {
        commandIndex += 1;
      }
    }
    if (commandIndex >= tokens.length || /^(?:&&|\|\||[;|])$/.test(tokens[commandIndex])) {
      continue;
    }
    const args: string[] = [];
    for (let argIndex = commandIndex + 1; argIndex < tokens.length; argIndex += 1) {
      if (/^(?:&&|\|\||[;|])$/.test(tokens[argIndex]) || tokens[argIndex] === 'npm') {
        break;
      }
      args.push(tokens[argIndex]);
    }
    invocations.push({ command: tokens[commandIndex], args });
  }
  return invocations;
}

function assertMigrationBlockContract(remoteScript: string): void {
  for (const marker of [
    'git diff --name-only "$PREV_COMMIT" "$DEPLOY_SHA"',
    'if [ -n "$MIGRATION_CHANGE_OUTPUT" ]; then',
    'MIGRATION_SET="$(printf \'%s\\n\' "$MIGRATION_CHANGE_OUTPUT" | paste -sd, -)"',
    'M0 promotion blocks changed migrations until PREV_COMMIT compatibility is rehearsed',
    'git diff --name-only "$PREV_COMMIT" "$DEPLOY_SHA" -- \'docker-compose.prod.yml\'',
    'PROMOTION_BLOCKED=false',
    'if [ -n "$COMPOSE_CHANGE_OUTPUT" ]; then',
    'COMPOSE_CHANGE_SET="docker-compose.prod.yml"',
    'M0 promotion blocks changed production Compose configuration until container rollback is rehearsed',
    'if [ "$PROMOTION_BLOCKED" = "true" ]; then',
  ]) {
    if (!remoteScript.includes(marker)) {
      throw new Error('M0 deployment must block changed migrations');
    }
  }
  const migrationBlockIndex = remoteScript.indexOf(
    'if [ -n "$MIGRATION_CHANGE_OUTPUT" ]; then'
  );
  const armedIndex = remoteScript.indexOf('ROLLBACK_ARMED=true');
  const composeBlockIndex = remoteScript.indexOf(
    'if [ -n "$COMPOSE_CHANGE_OUTPUT" ]; then'
  );
  const combinedBlockIndex = remoteScript.indexOf(
    'if [ "$PROMOTION_BLOCKED" = "true" ]; then'
  );
  if (
    migrationBlockIndex < 0 ||
    composeBlockIndex <= migrationBlockIndex ||
    combinedBlockIndex <= composeBlockIndex ||
    armedIndex <= combinedBlockIndex
  ) {
    throw new Error('M0 deployment must block changed migrations');
  }
  if (containsSchemaMutationRunner(remoteScript)) {
    throw new Error('M0 deployment must not mutate the production schema');
  }
}

function containsSchemaMutationRunner(script: string): boolean {
  return executableLines(script).some((line) => {
    if (
      npmCommandInvocations(line).some(
        (invocation) =>
          (invocation.command === 'run' || invocation.command === 'exec') &&
          invocation.args.some((argument) => /migrat(?:e|ion)/i.test(argument))
      )
    ) {
      return true;
    }
    return line
      .split(/&&|\|\||[;|]/)
      .map((segment) => segment.trim().replace(/^(?:if\s+)?!?\s*/, ''))
      .some((segment) =>
        /^(?:node|npx|tsx|ts-node)\b[^\n]*\bmigrat(?:e|ion)/i.test(segment)
      );
  });
}

function assertRuntimeRestartContract(remoteScript: string): void {
  for (const marker of [
    'if [[ ! "$PREVIOUS_MAIN_PID" =~ ^[1-9][0-9]*$ ]]; then',
    'if [[ ! "$MAIN_PID" =~ ^[1-9][0-9]*$ ]]; then',
    'elif [ "$MAIN_PID" = "$PREVIOUS_MAIN_PID" ]; then',
  ]) {
    if (!remoteScript.includes(marker)) {
      throw new Error('Deployment must prove a changed nonzero MainPID');
    }
  }
}

function assertHostDeploymentLock(remoteScript: string): void {
  for (const marker of HOST_DEPLOYMENT_LOCK_MARKERS) {
    if (!remoteScript.includes(marker)) {
      throw new Error('Production mutations require a run-independent host lock');
    }
  }
  const lockIndex = remoteScript.indexOf('if ! flock -n 9; then');
  const previousShaIndex = remoteScript.indexOf('PREV_COMMIT="$(git rev-parse HEAD)"');
  if (lockIndex < 0 || previousShaIndex <= lockIndex) {
    throw new Error('Production mutations require a run-independent host lock');
  }
}

function executableLines(script: string): string[] {
  return script
    .replace(/\\\r?\n\s*/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

function countExecutableCommand(script: string, command: string): number {
  return executableLines(script).filter((line) => line === command).length;
}

type GitMutationSubcommand = 'checkout' | 'fetch' | 'pull' | 'reset' | 'switch' | 'unknown';

function gitSubcommandsInLine(line: string): GitMutationSubcommand[] {
  const directSubcommands = line
    .replace(/\$\(/g, ';')
    .replace(/\)/g, ';')
    .replace(/`/g, ';')
    .split(/&&|\|\||[;|]/)
    .map((segment) => gitSubcommand(segment))
    .filter((subcommand): subcommand is GitMutationSubcommand => subcommand !== null);
  const indirectSubcommands = Array.from(
    line.matchAll(/\bgit\b[^;&|`\n]*?\b(checkout|fetch|pull|reset|switch)\b/g),
    (match) => match[1] as GitMutationSubcommand
  );
  return Array.from(new Set([...directSubcommands, ...indirectSubcommands]));
}

function gitSubcommand(line: string): GitMutationSubcommand | null {
  let remainder = line.trim();
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(remainder)) {
    const assignmentMatch = remainder.match(
      /^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)\s*/
    );
    if (!assignmentMatch) {
      return null;
    }
    remainder = remainder.slice(assignmentMatch[0].length);
  }
  if (/^sudo(?:\s+|$)/.test(remainder)) {
    remainder = remainder.replace(/^sudo\s*/, '');
    while (remainder.startsWith('-')) {
      if (/^--(?:\s+|$)/.test(remainder)) {
        remainder = remainder.replace(/^--\s*/, '');
        break;
      }
      const sudoOptionWithValue = remainder.match(
        /^(?:(?:-[uUgChp]|--(?:user|group|host|chdir|prompt))\s+(?:"[^"]*"|'[^']*'|\S+))\s*/
      );
      if (sudoOptionWithValue) {
        remainder = remainder.slice(sudoOptionWithValue[0].length);
        continue;
      }
      const sudoFlag = remainder.match(/^--?[A-Za-z][A-Za-z0-9-]*(?:=\S+)?\s*/);
      if (!sudoFlag) {
        return 'unknown';
      }
      remainder = remainder.slice(sudoFlag[0].length);
    }
  }
  if (!/^git(?:\s+|$)/.test(remainder)) {
    return null;
  }
  remainder = remainder.replace(/^git\s*/, '');

  while (remainder.startsWith('-')) {
    const optionWithValueMatch = remainder.match(
      /^(?:(?:-C|-c)\s+(?:"[^"]*"|'[^']*'|\S+)|--(?:git-dir|work-tree)(?:=(?:"[^"]*"|'[^']*'|\S+)|\s+(?:"[^"]*"|'[^']*'|\S+)))\s*/
    );
    if (optionWithValueMatch) {
      remainder = remainder.slice(optionWithValueMatch[0].length);
      continue;
    }
    const flagMatch = remainder.match(/^--?[A-Za-z][A-Za-z0-9-]*(?:=\S+)?\s*/);
    if (!flagMatch) {
      return 'unknown';
    }
    remainder = remainder.slice(flagMatch[0].length);
  }

  const subcommand = remainder.match(/^([a-z][a-z-]*)/)?.[1];
  if (
    subcommand === 'checkout' ||
    subcommand === 'fetch' ||
    subcommand === 'pull' ||
    subcommand === 'reset' ||
    subcommand === 'switch'
  ) {
    return subcommand;
  }
  return null;
}

function extractShellFunction(script: string, name: string): string {
  const startMarker = `${name}() {`;
  const start = script.indexOf(startMarker);
  if (start < 0) {
    throw new Error(`Missing shell function: ${name}`);
  }
  const declarationStart = script.lastIndexOf('\n', start) + 1;
  const declaration = script.slice(declarationStart, start);
  const indentation = declaration.match(/^\s*/)?.[0] ?? '';
  const endMarker = `\n${indentation}}`;
  const end = script.indexOf(endMarker, start);
  if (end <= start) {
    throw new Error(`Missing shell function: ${name}`);
  }
  return script.slice(start, end + endMarker.length);
}

function parseRuntimeArtifactPaths(remoteScript: string): string[] {
  const match = remoteScript.match(/RUNTIME_ARTIFACT_PATHS=\(\n([\s\S]*?)\n\s*\)/);
  if (!match?.[1]) {
    throw new Error('Missing runtime artifact path array');
  }
  return match[1]
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function parsePackagedRuntimeArtifactPaths(runnerScript: string): string[] {
  const archiveLine = executableLines(runnerScript).find((line) =>
    line.startsWith('tar -czf "$RELEASE_ARCHIVE" -- ')
  );
  if (!archiveLine) {
    throw new Error('Missing packaged runtime artifact list');
  }
  const separatorIndex = archiveLine.indexOf(' -- ');
  if (separatorIndex < 0) {
    throw new Error('Missing packaged runtime artifact separator');
  }
  return archiveLine.slice(separatorIndex + 4).trim().split(/\s+/);
}

function runDeployPathAccessGuard(
  accessFunction: string,
  inspectedPath: string,
  deployUser: string,
  pathOwner: string,
  statStatus: number
): SpawnSyncReturns<string> {
  execFileSync('bash', ['-n'], {
    input: accessFunction,
    stdio: ['pipe', 'ignore', 'pipe'],
  });
  const script = `
stat() {
  if [ "$1" != "-c" ] || [ "$2" != "%U" ]; then
    return 2
  fi
  printf '%s\\n' "$TEST_PATH_OWNER"
  return "$TEST_STAT_STATUS"
}
${accessFunction}
if require_deploy_path_access "$TEST_PATH" "$TEST_DEPLOY_USER"; then
  exit 0
else
  exit 1
fi
`;
  return spawnSync('bash', ['-c', `set -Eeuo pipefail\n${script}`], {
    encoding: 'utf8',
    env: {
      ...process.env,
      TEST_DEPLOY_USER: deployUser,
      TEST_PATH: inspectedPath,
      TEST_PATH_OWNER: pathOwner,
      TEST_STAT_STATUS: String(statStatus),
    },
  });
}

function runHealthRevisionReader(
  readerFunction: string,
  healthResponse: string
): SpawnSyncReturns<string> {
  const script = `
${readerFunction}
printf '%s' "$TEST_HEALTH_RESPONSE" | read_health_revision
`;
  return spawnSync('bash', ['-c', `set -Eeuo pipefail\n${script}`], {
    encoding: 'utf8',
    env: {
      ...process.env,
      TEST_HEALTH_RESPONSE: healthResponse,
    },
  });
}

function runIngestionFreshnessGuard(
  freshnessFunction: string,
  signals: string,
  minimumCursor: string,
  dateStatus: number
): SpawnSyncReturns<string> {
  const script = `
date() {
  printf '%s\\n' '1700000000'
  return "$TEST_DATE_STATUS"
}
${freshnessFunction}
if ingestion_signals_are_fresh "$TEST_SIGNALS" "$TEST_MINIMUM_CURSOR"; then
  exit 0
else
  exit 1
fi
`;
  return spawnSync('bash', ['-c', `set -Eeuo pipefail\n${script}`], {
    encoding: 'utf8',
    env: {
      ...process.env,
      TEST_DATE_STATUS: String(dateStatus),
      TEST_MINIMUM_CURSOR: minimumCursor,
      TEST_SIGNALS: signals,
    },
  });
}

function runReadIngestionSignals(
  readFunction: string,
  signals: string,
  commandStatus: number
): SpawnSyncReturns<string> {
  const script = `
timeout() {
  printf '%s' "$TEST_SIGNALS"
  return "$TEST_COMMAND_STATUS"
}
${readFunction}
if read_ingestion_signals; then
  exit 0
else
  exit 1
fi
`;
  return spawnSync('bash', ['-c', `set -Eeuo pipefail\n${script}`], {
    encoding: 'utf8',
    env: {
      ...process.env,
      TEST_COMMAND_STATUS: String(commandStatus),
      TEST_SIGNALS: signals,
    },
  });
}

function extractPreviousMainPidGuard(remoteScript: string): string {
  const marker = 'if [[ ! "$PREVIOUS_MAIN_PID" =~ ^[1-9][0-9]*$ ]]; then';
  const start = remoteScript.indexOf(marker);
  const endMarker = '\n            fi';
  const end = remoteScript.indexOf(endMarker, start);
  if (start < 0 || end <= start) {
    throw new Error('Missing bounded pre-restart MainPID guard');
  }
  return remoteScript.slice(start, end + endMarker.length);
}

function replaceInSuccessfulDeploy(
  workflow: string,
  searchValue: string,
  replacement: string
): string {
  const successMarker = 'mkdir "$CANDIDATE_BUILD_DIR"';
  const deployStepStart = workflow.indexOf('      - name: Deploy to VPS\n');
  const successStart = workflow.indexOf(successMarker, deployStepStart);
  if (successStart < 0) {
    throw new Error('Missing bounded successful deployment path');
  }
  return (
    workflow.slice(0, successStart) +
    workflow.slice(successStart).replace(searchValue, () => replacement)
  );
}

function assertProtectedWorkflowRecoveryContract(document: string): void {
  for (const claim of PROTECTED_RECOVERY_CLAIMS) {
    if (!document.includes(claim)) {
      throw new Error(`Missing protected recovery claim: ${claim}`);
    }
  }
  if (document.includes('DEPLOY_SHA="REPLACE_WITH_FULL_40_CHARACTER_MAIN_SHA"')) {
    throw new Error('Recovery documentation must not provide a direct-VPS deploy shortcut');
  }
  if (/safe\.directory(?:\s+|\s*=\s*)['"]?\*/.test(document)) {
    throw new Error('Recovery documentation must not trust every Git directory');
  }
}

function assertRollbackContract(document: string): void {
  const rollbackStart = document.indexOf('### Rollback');
  const notesStart = document.indexOf('\nNotes:', rollbackStart);
  if (rollbackStart < 0 || notesStart <= rollbackStart) {
    throw new Error('Missing bounded rollback instructions');
  }
  const rollback = document.slice(rollbackStart, notesStart);
  for (const claim of ROLLBACK_CONTRACT_CLAIMS) {
    if (!rollback.includes(claim)) {
      throw new Error(`Missing rollback contract claim: ${claim}`);
    }
  }
}

function assertDeployMigrationOrdering(script: string): void {
  assertMigrationBlockContract(extractRemoteDeployScript(script));
  const restartMarker = 'sudo -n -- /usr/local/sbin/corgi-deploy-root service-restart';
  const postDeployHealthMarker = '# Post-deploy composite health verification';
  const deployStepStart = script.indexOf('      - name: Deploy to VPS\n');
  const successStart = script.indexOf(
    'mkdir "$CANDIDATE_BUILD_DIR"',
    deployStepStart
  );
  if (successStart < 0) {
    throw new Error('Missing bounded successful deployment path');
  }
  const successPath = script.slice(successStart);
  const postDeployHealthIndex = successPath.indexOf(postDeployHealthMarker);
  if (postDeployHealthIndex < 0) {
    throw new Error('Missing post-deploy health verification');
  }

  const restartIndex = successPath.indexOf(restartMarker);
  if (restartIndex < 0) {
    throw new Error('Missing service restart');
  }
  if (restartIndex > postDeployHealthIndex) {
    throw new Error('Service restart must run before post-deploy health verification');
  }

  const deployPath = successPath.slice(0, restartIndex + restartMarker.length);

  const gateIndexes = DEPLOY_GATE_MARKERS.map(({ name, value }) => {
    const firstIndex = deployPath.indexOf(value);
    if (firstIndex < 0) {
      throw new Error(`Missing ${name} gate`);
    }
    if (deployPath.lastIndexOf(value) !== firstIndex) {
      throw new Error(`Duplicate ${name} gate`);
    }
    return firstIndex;
  });

  const finalGateIndex = Math.max(...gateIndexes);
  const deployRestartIndex = deployPath.indexOf(restartMarker);
  if (deployRestartIndex <= finalGateIndex) {
    throw new Error('Service restart must run after every artifact promotion gate');
  }
}

function usesOnlyFixedPrivilegeDispatcherCommands(script: string): boolean {
  const tokens = tokenizeShellCommands(script);
  const dispatcherIndexes = tokens.flatMap((token, index) =>
    token === '/usr/local/sbin/corgi-deploy-root' ? [index] : []
  );
  const directPrivilegeIndexes = tokens.flatMap((token, index) =>
    token.split('/').at(-1) === 'docker' || token.split('/').at(-1) === 'systemctl'
      ? [index]
      : []
  );

  return (
    dispatcherIndexes.length > 0 &&
    directPrivilegeIndexes.length === 0 &&
    dispatcherIndexes.every((index) => isDirectSudoCommand(tokens, index))
  );
}

function isDirectSudoCommand(tokens: string[], dispatcherIndex: number): boolean {
  const boundaries = new Set(['\n', ';', '&', '|', '(', ')']);
  let commandStart = dispatcherIndex;
  while (commandStart > 0 && !boundaries.has(tokens[commandStart - 1])) {
    commandStart -= 1;
  }

  const controlWords = new Set(['if', 'then', 'elif', 'while', 'until', '!']);
  const commandPrefix = tokens
    .slice(commandStart, dispatcherIndex)
    .filter((token) => !controlWords.has(token));
  if (
    commandPrefix.length === 3 &&
    commandPrefix[0] === 'sudo' &&
    commandPrefix[1] === '-n' &&
    commandPrefix[2] === '--'
  ) {
    return true;
  }
  return (
    commandPrefix.length === 5 &&
    commandPrefix[0] === 'timeout' &&
    /^\d+[smh]$/.test(commandPrefix[1] ?? '') &&
    commandPrefix[2] === 'sudo' &&
    commandPrefix[3] === '-n' &&
    commandPrefix[4] === '--'
  );
}

function tokenizeShellCommands(script: string): string[] {
  const tokens: string[] = [];
  let word = '';
  let quote: "'" | '"' | null = null;
  let doubleQuotedCommandDepth = 0;
  let index = 0;

  const pushWord = (): void => {
    if (word.length > 0) {
      tokens.push(word);
      word = '';
    }
  };

  while (index < script.length) {
    const char = script[index];
    const next = script[index + 1];

    if (quote !== null) {
      if (quote === '"' && char === '$' && next === '(') {
        pushWord();
        tokens.push('(');
        doubleQuotedCommandDepth += 1;
        quote = null;
        index += 2;
        continue;
      }
      if (char === quote) {
        quote = null;
      } else if (char === '\\' && quote === '"' && next !== undefined) {
        word += next;
        index += 1;
      } else {
        word += char;
      }
      index += 1;
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      index += 1;
      continue;
    }

    if (char === '\\' && next === '\n') {
      index += 2;
      continue;
    }

    if (char === '#' && word.length === 0) {
      while (index < script.length && script[index] !== '\n') {
        index += 1;
      }
      continue;
    }

    if (char === '\n') {
      pushWord();
      tokens.push('\n');
      index += 1;
      continue;
    }

    if (/\s/.test(char)) {
      pushWord();
      index += 1;
      continue;
    }

    if (';&|()'.includes(char)) {
      pushWord();
      tokens.push(char);
      if (doubleQuotedCommandDepth > 0) {
        if (char === '(') {
          doubleQuotedCommandDepth += 1;
        } else if (char === ')') {
          doubleQuotedCommandDepth -= 1;
          if (doubleQuotedCommandDepth === 0) {
            quote = '"';
          }
        }
      }
      index += 1;
      continue;
    }

    word += char;
    index += 1;
  }

  pushWord();
  return tokens;
}

function renderDemoProbe(
  deploy: string,
  timestamp: number,
  probeUuid: string
): {
  body: { communityId: string; clientNonce: string };
  octet: number;
} {
  const octetAssignment = deploy.match(/^\s*(PROBE_OCTET=.*)$/m)?.[1];
  const nonceAssignment = deploy.match(/^\s*(DEMO_CLIENT_NONCE=.*)$/m)?.[1];
  const dataArgument = deploy.match(/^\s*-d\s+(.+)\s+\\$/m)?.[1];
  if (
    octetAssignment === undefined ||
    nonceAssignment === undefined ||
    dataArgument === undefined
  ) {
    throw new Error('Deploy workflow is missing the executable demo probe fragment');
  }

  const serialized = execFileSync(
    '/bin/sh',
    [
      '-eu',
      '-c',
      [
        `PROBE_TIMESTAMP=${timestamp}`,
        octetAssignment,
        `PROBE_UUID=${probeUuid}`,
        nonceAssignment,
        'printf \'%s\\n\' "$PROBE_OCTET"',
        `printf '%s' ${dataArgument}`,
      ].join('\n'),
    ],
    { encoding: 'utf8' }
  );
  const separator = serialized.indexOf('\n');
  if (separator < 1) {
    throw new Error(`Deploy workflow emitted a demo probe payload without an octet: ${serialized}`);
  }
  const octet = Number(serialized.slice(0, separator));
  if (!Number.isInteger(octet)) {
    throw new Error(`Deploy workflow emitted an invalid demo probe octet: ${serialized}`);
  }
  const serializedBody = serialized.slice(separator + 1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(serializedBody);
  } catch (error) {
    throw new Error(`Deploy workflow emitted invalid demo probe JSON: ${serializedBody}`, {
      cause: error,
    });
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('communityId' in parsed) ||
    typeof parsed.communityId !== 'string' ||
    !('clientNonce' in parsed) ||
    typeof parsed.clientNonce !== 'string'
  ) {
    throw new Error(`Deploy workflow emitted an invalid demo probe payload: ${serialized}`);
  }

  return {
    body: { communityId: parsed.communityId, clientNonce: parsed.clientNonce },
    octet,
  };
}

function demoSourceText(): string {
  return sourceFiles(DEMO_SRC_DIR)
    .map((path) => readFileSync(path, 'utf8'))
    .join('\n');
}

function sourceFiles(dir: string): string[] {
  const entries = readdirSync(dir).map((entry) => join(dir, entry));
  return entries.flatMap((entry) => {
    const stat = statSync(entry);
    if (stat.isDirectory()) {
      return sourceFiles(entry);
    }
    return entry.endsWith('.ts') ? [entry] : [];
  });
}
