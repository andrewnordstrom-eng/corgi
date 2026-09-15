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
  ['CLI engine', (files) => files.set('cli/package.json', files.get('cli/package.json')!.replace('>=22.23.2', '>=20.19.0'))],
  ['web-next engine', (files) => files.set('web-next/package.json', files.get('web-next/package.json')!.replace('>=22.23.2', '>=20.19.0'))],
  ['engine strictness', (files) => files.set('web-next/.npmrc', 'save-exact=true\n')],
  ['contradictory engine strictness', (files) => files.set('web-next/.npmrc', 'engine-strict=true\nengine-strict=false\n')],
  ['whitespace contradictory engine strictness', (files) => files.set('web-next/.npmrc', 'engine-strict=true\nengine-strict = false\n')],
  ['SDK engine', (files) => files.set('packages/feed-sdk/package.json', files.get('packages/feed-sdk/package.json')!.replace('>=22.23.2', '>=20.19.0'))],
  ['workflow pin', (files) => files.set('.github/workflows/examples-build.yml', files.get('.github/workflows/examples-build.yml')!.replace('22.23.2', '22'))],
  ['Docker workspace manifest', (files) => files.set('Dockerfile', files.get('Dockerfile')!.replace('COPY packages/feed-sdk/package.json ./packages/feed-sdk/package.json', ''))],
  ['Docker source revision', (files) => files.set('Dockerfile', files.get('Dockerfile')!.replace('ARG SOURCE_REVISION', ''))],
];

function sources(): Map<string, string> {
  return loadRuntimeSources(ROOT);
}

describe('runtime contract', () => {
  it('pins the selected Node runtime across manifests, installs, workflows, and Docker', () => {
    expect(() => validateRuntimeSources(sources(), '22.23.2', '127')).not.toThrow();
  });

  it.each(RUNTIME_DRIFT_CASES)('rejects runtime drift: %s', (_label, mutate) => {
    const mutated = sources();
    mutate(mutated);
    expect(() => validateRuntimeSources(mutated, '22.23.2', '127')).toThrow('runtime-contract:');
  });

  it('rejects execution under Node 20 even when source pins are current', () => {
    expect(() => validateRuntimeSources(sources(), '20.19.0', '127')).toThrow(
      'running Node must be 22.23.2',
    );
  });

  it('rejects execution with an unexpected Node ABI', () => {
    expect(() => validateRuntimeSources(sources(), '22.23.2', '115')).toThrow(
      'running Node ABI must be 127',
    );
  });
});
