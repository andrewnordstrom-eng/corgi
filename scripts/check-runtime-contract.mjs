#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const RUNTIME_VERSION = '22.23.2';
export const RUNTIME_ABI = '127';
export const NPM_VERSION = '11.19.1';
export const BASE_IMAGE =
  'node:22.23.2-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5';

const PACKAGE_FILES = [
  'package.json',
  'cli/package.json',
  'web/package.json',
  'web-next/package.json',
  'packages/feed-sdk/package.json',
];
const LOCK_FILES = ['package-lock.json', 'cli/package-lock.json', 'web/package-lock.json', 'web-next/package-lock.json'];
const NPMRC_FILES = ['.npmrc', 'cli/.npmrc', 'web/.npmrc', 'web-next/.npmrc'];
const WORKFLOW_FILES = [
  '.github/workflows/ci.yml',
  '.github/workflows/deploy.yml',
  '.github/workflows/docs-freshness.yml',
  '.github/workflows/examples-build.yml',
  '.github/workflows/quality-gate.yml',
];
const REQUIRED_NODE_JOBS = new Map([
  ['.github/workflows/ci.yml', ['docs-verify', 'backend-verify', 'frontend-verify']],
  ['.github/workflows/deploy.yml', ['validate-target']],
  ['.github/workflows/docs-freshness.yml', ['docs-freshness']],
  ['.github/workflows/examples-build.yml', ['build-examples']],
  ['.github/workflows/quality-gate.yml', ['quality-gate']],
]);
const WORKSPACE_MANIFESTS = [
  'packages/feed-sdk/package.json',
  'examples/civility-component/package.json',
];

/** @param {string} rootDirectory @returns {Map<string, string>} */
export function loadRuntimeSources(rootDirectory) {
  const files = new Map();
  for (const relativePath of [
    '.nvmrc',
    '.dockerignore',
    'Dockerfile',
    ...PACKAGE_FILES,
    ...LOCK_FILES,
    ...NPMRC_FILES,
    ...WORKFLOW_FILES,
  ]) {
    files.set(relativePath, readFileSync(path.join(rootDirectory, relativePath), 'utf8'));
  }
  return files;
}

export class RuntimeContractError extends Error {
  constructor(message) {
    super(`runtime-contract: ${message}`);
    this.name = 'RuntimeContractError';
  }
}

function requireExact(condition, message) {
  if (!condition) throw new RuntimeContractError(message);
}

function parseJson(files, relativePath) {
  try {
    return JSON.parse(files.get(relativePath));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new RuntimeContractError(`cannot parse ${relativePath}: ${reason}`);
  }
}

/**
 * Parse the narrow workflow step shape used by this repository. Unsupported step
 * mappings fail closed so comments and arbitrary YAML scalars cannot satisfy a
 * runtime command check.
 * @param {string} workflow
 * @returns {Array<{uses: string, run: string, nodeVersion: (string|null), ifCondition: (string|null), shell: (string|null), continueOnError: (string|null)}>}
 */
function parseWorkflowSteps(workflow) {
  const lines = workflow.split('\n');
  const stepsLine = lines.findIndex((line) => line === '    steps:');
  requireExact(stepsLine >= 0, 'workflow Node job must define steps');
  const starts = [];
  for (let index = stepsLine + 1; index < lines.length; index += 1) {
    if (/^      - /.test(lines[index])) starts.push(index);
  }
  requireExact(starts.length > 0, 'workflow Node job must define executable step mappings');
  return starts.map((start, position) => {
    const end = starts[position + 1] ?? lines.length;
    const block = lines.slice(start, end);
    requireExact(/^      - name:\s*\S/.test(block[0]), 'workflow steps must use named mappings');
    const runLines = block.filter((line) => /^        run:/.test(line));
    const usesLines = block.filter((line) => /^        uses:/.test(line));
    requireExact(runLines.length <= 1 && usesLines.length <= 1, 'workflow steps must not duplicate run or uses fields');
    const readField = (field) => {
      const matches = block.filter((line) => line.startsWith(`        ${field}:`));
      requireExact(matches.length <= 1, `workflow steps must not duplicate ${field} fields`);
      return matches.length === 1 ? matches[0].slice(`        ${field}:`.length).trim() : null;
    };
    const withLines = block.filter((line) => /^ {8}with:/.test(line));
    requireExact(withLines.length <= 1, 'workflow steps must not duplicate with mappings');
    const withFields = new Map();
    if (withLines.length === 1) {
      requireExact(/^ {8}with:\s*$/.test(withLines[0]), 'workflow with fields must use canonical block mappings');
      const withIndex = block.indexOf(withLines[0]);
      for (const line of block.slice(withIndex + 1)) {
        const trimmed = line.trim();
        if (trimmed === '' || trimmed.startsWith('#')) continue;
        const indentation = line.match(/^\s*/)?.[0].length ?? 0;
        if (indentation < 10) break;
        if (indentation > 10) continue;
        const fieldMatch = line.match(/^\s{10}([A-Za-z0-9_-]+):\s*(.*)$/);
        requireExact(fieldMatch !== null, 'workflow with mappings must use scalar fields');
        const [, field, rawValue] = fieldMatch;
        requireExact(!withFields.has(field), `workflow with mappings must not duplicate ${field}`);
        const value = rawValue.split(/\s+#/, 1)[0].trim();
        withFields.set(field, value.replace(/^(['"])(.*)\1$/, '$2'));
      }
    }
    let run = '';
    if (runLines.length === 1) {
      const runIndex = block.indexOf(runLines[0]);
      const value = runLines[0].replace(/^        run:\s*/, '');
      requireExact(value !== '', 'workflow run fields must have a command');
      if (/^\|[-+]?\s*$/.test(value)) {
        const body = [];
        for (const line of block.slice(runIndex + 1)) {
          const trimmed = line.trim();
          if (trimmed === '' || trimmed.startsWith('#')) continue;
          const indentation = line.match(/^\s*/)?.[0].length ?? 0;
          if (indentation < 10) break;
          body.push(line.slice(10));
        }
        run = body.join('\n');
      } else if (!value.startsWith('#')) {
        requireExact(!value.startsWith('>'), 'workflow run fields must use literal block scalars');
        run = value;
      }
    }
    const uses = usesLines.length === 1 ? usesLines[0].replace(/^        uses:\s*/, '').split(/\s+#/, 1)[0].trim() : '';
    requireExact(!(runLines.length === 1 && usesLines.length === 1), 'workflow steps must not combine run and uses');
    return {
      uses,
      run,
      nodeVersion: withFields.get('node-version') ?? null,
      ifCondition: readField('if'),
      shell: readField('shell'),
      continueOnError: readField('continue-on-error'),
    };
  });
}

/** @param {string} run @returns {Array<string>} */
function executableRunLines(run) {
  return run
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
}

/** @param {string} line @returns {boolean} */
function isExecutableNpmCi(line) {
  let command = line.trim();
  if (command.startsWith('(') && command.endsWith(')')) command = command.slice(1, -1).trim();
  command = command.replace(/^cd\s+(?:cli|web|web-next)\s+&&\s+/, '');
  if (!command.startsWith('npm ci ')) return false;
  const flags = command.slice('npm ci '.length).trim().split(/\s+/);
  const allowedFlags = new Set(['--ignore-scripts', '--no-audit', '--no-fund']);
  return flags.filter((flag) => flag === '--ignore-scripts').length === 1 &&
    flags.every((flag) => allowedFlags.has(flag));
}

/**
 * @param {Map<string, string>} files
 * @param {string} observedNodeVersion
 * @param {string} observedNodeAbi
 * @param {string} observedNpmVersion
 * @returns {{version: string, abi: string, npm: string}}
 */
export function validateRuntimeSources(files, observedNodeVersion, observedNodeAbi, observedNpmVersion) {
  requireExact(files.get('.nvmrc')?.trim() === RUNTIME_VERSION, `.nvmrc must pin Node ${RUNTIME_VERSION}`);
  requireExact(observedNodeVersion === RUNTIME_VERSION, `running Node must be ${RUNTIME_VERSION}, got ${observedNodeVersion}`);
  requireExact(observedNodeAbi === RUNTIME_ABI, `running Node ABI must be ${RUNTIME_ABI}, got ${observedNodeAbi}`);
  requireExact(observedNpmVersion === NPM_VERSION, `running npm must be ${NPM_VERSION}, got ${observedNpmVersion}`);

  for (const relativePath of PACKAGE_FILES) {
    const manifest = parseJson(files, relativePath);
    requireExact(
      manifest.engines?.node === `>=${RUNTIME_VERSION}`,
      `${relativePath} must require Node >=${RUNTIME_VERSION}`,
    );
    if (relativePath !== 'packages/feed-sdk/package.json') {
      requireExact(manifest.engines?.npm === NPM_VERSION, `${relativePath} must require npm ${NPM_VERSION}`);
      requireExact(manifest.packageManager === `npm@${NPM_VERSION}`, `${relativePath} must pin npm@${NPM_VERSION}`);
    }
    if (relativePath === 'package.json') {
      requireExact(
        manifest.scripts?.['runtime:verify'] === 'node scripts/check-runtime-contract.mjs' &&
          manifest.scripts?.verify?.startsWith('npm run runtime:verify && '),
        'package.json verify must run the runtime contract first',
      );
    }
  }
  for (const relativePath of LOCK_FILES) {
    const lockfile = parseJson(files, relativePath);
    requireExact(
      lockfile.packages?.['']?.engines?.node === `>=${RUNTIME_VERSION}`,
      `${relativePath} root package must require Node >=${RUNTIME_VERSION}`,
    );
    requireExact(
      lockfile.packages?.['']?.engines?.npm === NPM_VERSION,
      `${relativePath} root package must require npm ${NPM_VERSION}`,
    );
    if (relativePath === 'package-lock.json') {
      requireExact(
        lockfile.packages?.['packages/feed-sdk']?.engines?.node === `>=${RUNTIME_VERSION}`,
        'package-lock.json feed SDK workspace must require Node >=22.23.2',
      );
    }
  }
  for (const relativePath of NPMRC_FILES) {
    const npmrc = files.get(relativePath) ?? '';
    const engineStrictEntries = npmrc
      .split('\n')
      .map((line) => line.trim())
      .map((line) => line.match(/^engine-strict\s*=\s*(.*)$/)?.[1])
      .filter((value) => value !== undefined);
    requireExact(
      engineStrictEntries.length === 1 && engineStrictEntries[0].trim() === 'true',
      `${relativePath} must contain exactly one engine-strict=true directive`,
    );
  }
  for (const relativePath of WORKFLOW_FILES) {
    const workflow = files.get(relativePath) ?? '';
    const versions = [...workflow.matchAll(/node-version:\s*["']?([^"'\s]+)["']?/g)].map(
      (match) => match[1],
    );
    requireExact(versions.length > 0, `${relativePath} must configure setup-node`);
    requireExact(
      versions.every((version) => version === RUNTIME_VERSION),
      `${relativePath} must pin every setup-node version to ${RUNTIME_VERSION}`,
    );
    requireExact(
      workflow.includes('run: node scripts/check-runtime-contract.mjs') ||
        /^\s+node scripts\/check-runtime-contract\.mjs\s*$/m.test(workflow),
      `${relativePath} must execute the runtime contract check`,
    );
    const jobStarts = [...workflow.matchAll(/^  [A-Za-z0-9_-]+:\s*$/gm)].map((match) => match.index ?? 0);
    const jobs = jobStarts.map((start, index) => workflow.slice(start, jobStarts[index + 1] ?? workflow.length));
    const requiredJobIds = REQUIRED_NODE_JOBS.get(relativePath);
    requireExact(requiredJobIds !== undefined, `${relativePath} must declare its required Node jobs`);
    for (const jobId of requiredJobIds) {
      requireExact(jobs.filter((job) => job.startsWith(`  ${jobId}:\n`)).length === 1, `${relativePath} must contain required Node job ${jobId}`);
    }
    const nodeJobs = jobs.filter((job) => job.includes('uses: actions/setup-node@') ||
      requiredJobIds.some((jobId) => job.startsWith(`  ${jobId}:\n`)));
    requireExact(nodeJobs.length > 0, `${relativePath} must contain setup-node jobs`);
    for (const job of nodeJobs) {
      const steps = parseWorkflowSteps(job);
      const setupSteps = steps.filter((step) => step.uses.startsWith('actions/setup-node@'));
      const npmSteps = steps.filter((step) => {
        const lines = executableRunLines(step.run);
        return JSON.stringify(lines) === JSON.stringify([
          `npm install --global --ignore-scripts npm@${NPM_VERSION}`,
          `test "$(npm --version)" = "${NPM_VERSION}"`,
        ]) || JSON.stringify(lines) === JSON.stringify([
          'set -euo pipefail',
          `npm install --global --ignore-scripts npm@${NPM_VERSION}`,
          `test "$(npm --version)" = "${NPM_VERSION}"`,
        ]);
      });
      const runtimeSteps = steps.filter((step) => {
        const lines = executableRunLines(step.run);
        return JSON.stringify(lines) === JSON.stringify(['node scripts/check-runtime-contract.mjs']) ||
          JSON.stringify(lines) === JSON.stringify(['set -euo pipefail', 'node scripts/check-runtime-contract.mjs']);
      });
      requireExact(setupSteps.length === 1 && npmSteps.length === 1 && runtimeSteps.length === 1, `${relativePath} each Node job must contain one canonical setup, npm, and runtime step`);
      requireExact(setupSteps[0].nodeVersion === RUNTIME_VERSION, `${relativePath} setup-node must set node-version to ${RUNTIME_VERSION}`);
      const packageCondition = relativePath === '.github/workflows/quality-gate.yml'
        ? "${{ hashFiles('**/package.json') != '' }}"
        : null;
      const runtimeCondition = relativePath === '.github/workflows/quality-gate.yml'
        ? "${{ hashFiles('package-lock.json') != '' }}"
        : null;
      const validateCriticalStep = (step, label, expectedCondition) => {
        requireExact(step.ifCondition === null || step.ifCondition === expectedCondition, `${relativePath} ${label} step has an unsupported condition`);
        requireExact(step.shell === null || step.shell === 'bash', `${relativePath} ${label} step must use the default shell or bash`);
        requireExact(step.continueOnError === null || step.continueOnError === 'false', `${relativePath} ${label} step must not suppress errors`);
      };
      validateCriticalStep(setupSteps[0], 'setup-node', packageCondition);
      validateCriticalStep(npmSteps[0], 'npm bootstrap', packageCondition);
      validateCriticalStep(runtimeSteps[0], 'runtime check', runtimeCondition);
      const installCandidates = steps.flatMap((step) => executableRunLines(step.run).filter((line) => /\bnpm\s+ci\b/.test(line)));
      requireExact(installCandidates.every((line) => isExecutableNpmCi(line)), `${relativePath} npm ci commands must be executable and use --ignore-scripts`);
      const installSteps = steps.filter((step) => executableRunLines(step.run).some((line) => isExecutableNpmCi(line)));
      const nonInstallingJob = (relativePath === '.github/workflows/docs-freshness.yml' && job.startsWith('  docs-freshness:')) ||
        (relativePath === '.github/workflows/ci.yml' && job.startsWith('  docs-verify:'));
      requireExact(nonInstallingJob ? installSteps.length === 0 : installSteps.length > 0, `${relativePath} Node job has an unexpected npm ci install contract`);
      for (const installStep of installSteps) {
        validateCriticalStep(installStep, 'npm ci', runtimeCondition);
        const commands = executableRunLines(installStep.run);
        const installCommands = commands[0] === 'set -euo pipefail' ? commands.slice(1) : commands;
        requireExact(installCommands.length > 0 && installCommands.every(isExecutableNpmCi), `${relativePath} npm ci steps must contain only canonical executable install commands`);
      }
      const setupIndex = steps.indexOf(setupSteps[0]);
      const npmIndex = steps.indexOf(npmSteps[0]);
      const runtimeIndex = steps.indexOf(runtimeSteps[0]);
      const installIndex = installSteps.length > 0 ? steps.indexOf(installSteps[0]) : -1;
      requireExact(
        setupSteps.length === 1 && npmSteps.length === 1 && runtimeSteps.length === 1 &&
          setupIndex >= 0 && npmIndex > setupIndex && runtimeIndex > npmIndex &&
          (nonInstallingJob ? installIndex === -1 : installIndex > runtimeIndex),
        `${relativePath} each Node job must pin npm ${NPM_VERSION} before the runtime check`,
      );
    }
  }

  const dockerfile = files.get('Dockerfile') ?? '';
  const builderStageStart = dockerfile.indexOf(`FROM ${BASE_IMAGE} AS builder`);
  const productionStageStart = dockerfile.indexOf(`FROM ${BASE_IMAGE} AS production`);
  const builderStage = dockerfile.slice(
    builderStageStart,
    productionStageStart < 0 ? dockerfile.length : productionStageStart,
  );
  requireExact(
    [...dockerfile.matchAll(/^FROM\s+([^\s]+)\s+AS\s+(builder|production)$/gm)].length === 2,
    'Dockerfile must have builder and production base stages',
  );
  for (const stage of ['builder', 'production']) {
    requireExact(
      dockerfile.includes(`FROM ${BASE_IMAGE} AS ${stage}`),
      `Dockerfile ${stage} stage must use the verified ${BASE_IMAGE} image`,
    );
  }
  requireExact(
    builderStage.includes('ARG SOURCE_REVISION') &&
      builderStage.includes("RUN test \"${#SOURCE_REVISION}\" -eq 40 && printf '%s\\n' \"$SOURCE_REVISION\" | grep -Eq '^[0-9a-f]{40}$'"),
    'Dockerfile builder stage must validate SOURCE_REVISION as a full lowercase SHA',
  );
  const productionStage = dockerfile.slice(productionStageStart < 0 ? 0 : productionStageStart);
  for (const [stageName, stageSource] of [['builder', builderStage], ['production', productionStage]]) {
    const matchingLines = stageSource.split('\n').filter((line) => line.trim() === 'COPY .npmrc ./');
    requireExact(
      matchingLines.length === 1,
      `Dockerfile ${stageName} stage must carry engine-strict config exactly once`,
    );
    const npmInstallLine = `RUN npm install --global --ignore-scripts npm@${NPM_VERSION} && test "$(npm --version)" = "${NPM_VERSION}"`;
    const npmInstallIndex = stageSource.indexOf(npmInstallLine);
    const npmCiIndex = stageSource.indexOf('RUN npm ci');
    requireExact(
      stageSource.split('\n').filter((line) => line.trim() === npmInstallLine).length === 1 &&
        npmInstallIndex >= 0 && npmCiIndex > npmInstallIndex,
      `Dockerfile ${stageName} stage must pin npm ${NPM_VERSION} before installs`,
    );
  }
  for (const relativePath of WORKSPACE_MANIFESTS) {
    const instruction = `COPY ${relativePath} ./${relativePath}`;
    for (const [stageName, stageSource] of [['builder', builderStage], ['production', productionStage]]) {
      const matchingLines = stageSource.split('\n').filter((line) => line.trim() === instruction);
      requireExact(
        matchingLines.length === 1,
        `Dockerfile ${stageName} stage must provide workspace manifest ${relativePath} before npm ci`,
      );
    }
  }

  requireExact(
    (dockerfile.match(/npm ci[^\n]*--ignore-scripts/g) ?? []).length === 2 &&
      dockerfile.includes('npm ci --omit=dev --ignore-scripts'),
    'Dockerfile builder and production installs must retain --ignore-scripts',
  );
  requireExact(
    dockerfile.includes("grep -Eq '^[0-9a-f]{40}$'") &&
      dockerfile.includes("printf '%s\\n' \"$SOURCE_REVISION\" > dist/.release-sha") &&
      dockerfile.includes('LABEL org.opencontainers.image.revision="$SOURCE_REVISION"'),
    'Dockerfile must require and bind the exact source revision',
  );
  requireExact(
    dockerfile.includes("CMD node -e \"require('node:http').get('http://localhost:3000/health/ready'"),
    'Dockerfile healthcheck must use the Node runtime available in the slim image',
  );

  const dockerignore = files.get('.dockerignore') ?? '';
  for (const relativePath of WORKSPACE_MANIFESTS) {
    requireExact(
      !dockerignore.split('\n').some((line) => line.trim() === relativePath || line.trim() === 'packages/' || line.trim() === 'examples/'),
      `.dockerignore must not exclude ${relativePath}`,
    );
  }
  return { version: RUNTIME_VERSION, abi: RUNTIME_ABI, npm: NPM_VERSION };
}

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const observedNpmVersion = execFileSync('npm', ['--version'], { encoding: 'utf8', timeout: 10_000 }).trim();
  const result = validateRuntimeSources(
    loadRuntimeSources(repositoryRoot),
    process.versions.node,
    process.versions.modules,
    observedNpmVersion,
  );
  console.log(`runtime-contract: PASS node=${result.version} abi=${result.abi} npm=${result.npm}`);
}
