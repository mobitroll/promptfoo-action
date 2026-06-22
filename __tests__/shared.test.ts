import {normalizePath, configDependencies} from '../src/shared';
import {expect, test, describe, beforeAll, afterAll} from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

describe('normalizePath', () => {
  test('strips leading ./ and trims', () => {
    expect(normalizePath('./tests/vars/a.yaml')).toBe('tests/vars/a.yaml');
    expect(normalizePath('  prompts-output/x.json  ')).toBe(
      'prompts-output/x.json',
    );
  });
});

describe('configDependencies', () => {
  let dir: string;
  let cwd: string;

  beforeAll(() => {
    cwd = process.cwd();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfgdeps-'));
    // Files the globbed dependency must resolve to.
    fs.mkdirSync(path.join(dir, 'tests/vars/copilot'), {recursive: true});
    fs.mkdirSync(path.join(dir, 'prompts-output/ai'), {recursive: true});
    fs.writeFileSync(path.join(dir, 'tests/vars/copilot/a.yaml'), '');
    fs.writeFileSync(path.join(dir, 'tests/vars/copilot/b.yaml'), '');
    fs.writeFileSync(path.join(dir, 'prompts-output/ai/chat.json'), '{}');
    fs.writeFileSync(
      path.join(dir, 'copilot.yaml'),
      [
        'prompts:',
        '  - file://prompts-output/ai/chat.json',
        'tests:',
        '  - file://tests/vars/copilot/*.yaml',
        'defaultTest:',
        '  options:',
        '    provider: file://tests/providers/gemini.yaml',
        '  assert:',
        // A file:// reference that lives OUTSIDE tests/prompts/prompts-output.
        '    - type: javascript',
        '      value: file://scripts/check.js',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(dir, 'bare-tests.yaml'),
      [
        'prompts:',
        '  - file://prompts-output/ai/chat.json',
        // Bare `./`-prefixed tests reference without a file:// scheme.
        'tests: ./tests/vars/copilot/a.yaml',
      ].join('\n'),
    );
    process.chdir(dir);
  });

  afterAll(() => {
    process.chdir(cwd);
    fs.rmSync(dir, {recursive: true, force: true});
  });

  test('includes the config itself, the prompt output, expanded test globs and providers', () => {
    const deps = configDependencies('copilot.yaml');
    expect(deps.has('copilot.yaml')).toBe(true);
    expect(deps.has('prompts-output/ai/chat.json')).toBe(true);
    // The `*.yaml` glob must expand to the actual test files.
    expect(deps.has('tests/vars/copilot/a.yaml')).toBe(true);
    expect(deps.has('tests/vars/copilot/b.yaml')).toBe(true);
    // Provider path referenced even though the file does not exist on disk.
    expect(deps.has('tests/providers/gemini.yaml')).toBe(true);
  });

  test('catches file:// references outside the content directories', () => {
    const deps = configDependencies('copilot.yaml');
    // Regression: assertion script outside tests/prompts/prompts-output.
    expect(deps.has('scripts/check.js')).toBe(true);
  });

  test('catches bare ./-prefixed tests references without a file:// scheme', () => {
    const deps = configDependencies('bare-tests.yaml');
    expect(deps.has('tests/vars/copilot/a.yaml')).toBe(true);
  });
});
