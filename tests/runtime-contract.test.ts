import { describe, expect, it } from 'vitest';
import {
  loadRuntimeSources,
  validateRuntimeSources,
} from '../scripts/check-runtime-contract.mjs';

const ROOT = process.cwd();
type SourceMutation = (files: Map<string, string>) => void;

const RUNTIME_DRIFT_CASES: Array<[string, SourceMutation]> = [
  ['.nvmrc', (files) => files.set('.nvmrc', '20.19.0\n')],
  ['root engine', (files) => files.set('package.json', files.get('package.json')!.replace('>=22.23.2', '>=20.19.0'))],
  ['root npm engine', (files) => files.set('package.json', files.get('package.json')!.replace('"npm": "11.19.1"', '"npm": "10.9.8"'))],
  ['root package manager', (files) => files.set('package.json', files.get('package.json')!.replace('npm@11.19.1', 'npm@10.9.8'))],
  ['CLI engine', (files) => files.set('cli/package.json', files.get('cli/package.json')!.replace('>=22.23.2', '>=20.19.0'))],
  ['web-next engine', (files) => files.set('web-next/package.json', files.get('web-next/package.json')!.replace('>=22.23.2', '>=20.19.0'))],
  ['engine strictness', (files) => files.set('web-next/.npmrc', 'save-exact=true\n')],
  ['contradictory engine strictness', (files) => files.set('web-next/.npmrc', 'engine-strict=true\nengine-strict=false\n')],
  ['whitespace contradictory engine strictness', (files) => files.set('web-next/.npmrc', 'engine-strict=true\nengine-strict = false\n')],
  ['SDK engine', (files) => files.set('packages/feed-sdk/package.json', files.get('packages/feed-sdk/package.json')!.replace('>=22.23.2', '>=20.19.0'))],
  ['workflow pin', (files) => files.set('.github/workflows/examples-build.yml', files.get('.github/workflows/examples-build.yml')!.replace('22.23.2', '22'))],
  ['workflow npm pin', (files) => files.set('.github/workflows/examples-build.yml', files.get('.github/workflows/examples-build.yml')!.replaceAll('11.19.1', '10.9.8'))],
  ['quality-gate Node pin', (files) => files.set('.github/workflows/quality-gate.yml', files.get('.github/workflows/quality-gate.yml')!.replace("node-version: '22.23.2'", "node-version: '24'"))],
  ['quality-gate npm pin', (files) => files.set('.github/workflows/quality-gate.yml', files.get('.github/workflows/quality-gate.yml')!.replaceAll('11.19.1', '10.9.8'))],
  ['workflow runtime comment', (files) => files.set('.github/workflows/quality-gate.yml', files.get('.github/workflows/quality-gate.yml')!.replace('        run: node scripts/check-runtime-contract.mjs', '        # run: node scripts/check-runtime-contract.mjs'))],
  ['workflow runtime scalar', (files) => files.set('.github/workflows/quality-gate.yml', files.get('.github/workflows/quality-gate.yml')!.replace('        run: node scripts/check-runtime-contract.mjs', '        runtime-command: node scripts/check-runtime-contract.mjs'))],
  ['workflow runtime env scalar', (files) => files.set('.github/workflows/quality-gate.yml', files.get('.github/workflows/quality-gate.yml')!.replace('        run: node scripts/check-runtime-contract.mjs', '        run: |\n          echo runtime check omitted\n        env:\n          RUNTIME_CHECK: node scripts/check-runtime-contract.mjs'))],
  ['workflow npm order', (files) => files.set('.github/workflows/quality-gate.yml', files.get('.github/workflows/quality-gate.yml')!.replace('          npm install --global --ignore-scripts npm@11.19.1\n          test "$(npm --version)" = "11.19.1"', '          test "$(npm --version)" = "11.19.1"\n          npm install --global --ignore-scripts npm@11.19.1'))],
  ['workflow runtime disabled', (files) => files.set('.github/workflows/quality-gate.yml', files.get('.github/workflows/quality-gate.yml')!.replace("        if: ${{ hashFiles('package-lock.json') != '' }}", '        if: false'))],
  ['workflow runtime error suppression', (files) => files.set('.github/workflows/quality-gate.yml', files.get('.github/workflows/quality-gate.yml')!.replace('        run: node scripts/check-runtime-contract.mjs', '        continue-on-error: true\n        run: node scripts/check-runtime-contract.mjs'))],
  ['workflow runtime custom shell', (files) => files.set('.github/workflows/quality-gate.yml', files.get('.github/workflows/quality-gate.yml')!.replace('        run: node scripts/check-runtime-contract.mjs', '        shell: echo {0}\n        run: node scripts/check-runtime-contract.mjs'))],
  ['Docker workspace manifest', (files) => files.set('Dockerfile', files.get('Dockerfile')!.replace('COPY packages/feed-sdk/package.json ./packages/feed-sdk/package.json', ''))],
  ['Docker workspace manifest wildcard lookalike', (files) => files.set('Dockerfile', files.get('Dockerfile')!.replaceAll('COPY packages/feed-sdk/package.json ./packages/feed-sdk/package.json', 'COPY packages/feed-sdk/packageXjson x/packages/feed-sdk/packageXjson'))],
  ['Docker npmrc stage placement', (files) => {
    const dockerfile = files.get('Dockerfile')!;
    const copy = 'COPY .npmrc ./';
    const productionStart = dockerfile.lastIndexOf('FROM ');
    const builder = dockerfile.slice(0, productionStart).replace(copy, `${copy}\n${copy}`);
    const production = dockerfile.slice(productionStart).replace(copy, '');
    expect(builder.split(copy)).toHaveLength(3);
    expect(production.includes(copy)).toBe(false);
    files.set('Dockerfile', builder + production);
  }],
  ['Docker source revision', (files) => files.set('Dockerfile', files.get('Dockerfile')!.replace('ARG SOURCE_REVISION', ''))],
  ['Docker npm upgrade missing', (files) => files.set('Dockerfile', files.get('Dockerfile')!.replaceAll('RUN npm install --global --ignore-scripts npm@11.19.1 && test "$(npm --version)" = "11.19.1"\n', ''))],
];

function sources(): Map<string, string> {
  return loadRuntimeSources(ROOT);
}

describe('runtime contract', () => {
  it('pins the selected Node runtime across manifests, installs, workflows, and Docker', () => {
    expect(() => validateRuntimeSources(sources(), '22.23.2', '127', '11.19.1')).not.toThrow();
  });

  it.each(RUNTIME_DRIFT_CASES)('rejects runtime drift: %s', (_label, mutate) => {
    const mutated = sources();
    mutate(mutated);
    expect(() => validateRuntimeSources(mutated, '22.23.2', '127', '11.19.1')).toThrow('runtime-contract:');
  });

  it('rejects execution under Node 20 even when source pins are current', () => {
    expect(() => validateRuntimeSources(sources(), '20.19.0', '127', '11.19.1')).toThrow(
      'running Node must be 22.23.2',
    );
  });

  it('rejects execution with an unexpected Node ABI', () => {
    expect(() => validateRuntimeSources(sources(), '22.23.2', '115', '11.19.1')).toThrow(
      'running Node ABI must be 127',
    );
  });

  it('rejects execution with an unexpected npm version', () => {
    expect(() => validateRuntimeSources(sources(), '22.23.2', '127', '10.9.8')).toThrow(
      'running npm must be 11.19.1',
    );
  });
});
