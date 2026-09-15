#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const RUNTIME_VERSION = '22.23.2';
export const RUNTIME_ABI = '127';
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
];
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
 * @param {Map<string, string>} files
 * @param {string} observedNodeVersion
 * @param {string} observedNodeAbi
 * @returns {{version: string, abi: string}}
 */
export function validateRuntimeSources(files, observedNodeVersion, observedNodeAbi) {
  requireExact(files.get('.nvmrc')?.trim() === RUNTIME_VERSION, `.nvmrc must pin Node ${RUNTIME_VERSION}`);
  requireExact(observedNodeVersion === RUNTIME_VERSION, `running Node must be ${RUNTIME_VERSION}, got ${observedNodeVersion}`);
  requireExact(observedNodeAbi === RUNTIME_ABI, `running Node ABI must be ${RUNTIME_ABI}, got ${observedNodeAbi}`);

  for (const relativePath of PACKAGE_FILES) {
    const manifest = parseJson(files, relativePath);
    requireExact(
      manifest.engines?.node === `>=${RUNTIME_VERSION}`,
      `${relativePath} must require Node >=${RUNTIME_VERSION}`,
    );
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
  requireExact((dockerfile.match(/COPY \.npmrc \.\//g) ?? []).length === 2, 'Dockerfile must carry engine-strict config into both stages');
  const productionStage = dockerfile.slice(productionStageStart < 0 ? 0 : productionStageStart);
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
  return { version: RUNTIME_VERSION, abi: RUNTIME_ABI };
}

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = validateRuntimeSources(
    loadRuntimeSources(repositoryRoot),
    process.versions.node,
    process.versions.modules,
  );
  console.log(`runtime-contract: PASS node=${result.version} abi=${result.abi}`);
}
