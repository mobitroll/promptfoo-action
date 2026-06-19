import * as exec from '@actions/exec';
import * as path from 'path';
import * as fs from 'fs';
import * as glob from 'glob';
import * as core from '@actions/core';

export interface IPromptFooOutput {
  results: {
    results: {
      success: boolean;
      error: string;
      vars: {[key: string]: string | boolean | number} | undefined;
    }[];
    stats: {
      successes: number;
      failures: number;
    };
  };
}

export function displayResultSummary(output: IPromptFooOutput): string {
  let text = '';
  for (const result of output.results.results) {
    if (result.success === true) {
      continue;
    }
    text += `**🚫 FAILED:**
\`\`\`
${result.error}
\`\`\`

**VARS:**
\`\`\`
${JSON.stringify(result.vars)}
\`\`\`

----------

`;
  }
  return text;
}

export function findPromptFile(promptFile: string): string {
  const jsonFiles = glob.sync(`prompts-output/**/*.json`);
  for (const jsonFile of jsonFiles) {
    if (path.basename(jsonFile).includes(promptFile)) {
      return jsonFile;
    }
  }
  throw new Error(`Prompt file not found: ${promptFile}`);
}

export function normalizePath(p: string): string {
  return p.replace(/^\.\//, '').trim();
}

export function findConfigFileFromPromptFile(
  promptFile: string,
): string | undefined {
  // Look for all yaml files and look for promptFile in them
  const yamlFiles = glob.sync('*.yaml');
  for (const yamlFile of yamlFiles) {
    const yamlContent = fs.readFileSync(yamlFile, 'utf8');
    if (yamlContent.includes(promptFile)) {
      return yamlFile;
    }
  }
  return undefined;
}

// Collect every file a config depends on: referenced prompt outputs, test vars
// (globs expanded), providers, assertion scripts and rubrics, plus the config
// file itself. Used to decide whether a changed file should (re)trigger that
// config's evaluation — not just changes to the generated prompt JSON.
export function configDependencies(configFile: string): Set<string> {
  const text = fs.readFileSync(configFile, 'utf8');
  const deps = new Set<string>([normalizePath(configFile)]);
  // Matches `file://tests/...`, `./tests/...`, `prompts-output/...`, `prompts/...`
  const tokenRe =
    /(?:file:\/\/)?((?:\.\/)?(?:tests|prompts-output|prompts)\/[^\s"',)]+)/g;
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(text)) !== null) {
    const token = normalizePath(m[1]);
    if (/[*?[\]{}]/.test(token)) {
      for (const f of glob.sync(token)) deps.add(normalizePath(f));
    } else {
      deps.add(token);
    }
  }
  return deps;
}

export async function runPromptfoo(
  promptFile: string,
  env: {[key: string]: string},
  promptFileId: number,
  additionalParameters?: string[],
): Promise<{outputFile: string; summary: string}> {
  const configFile = findConfigFileFromPromptFile(promptFile);
  if (!configFile) {
    return {
      outputFile: '',
      summary: `⚠️ No config file found for ${promptFile}\n\n`,
    };
  }
  return runConfig(
    configFile,
    promptFile,
    env,
    promptFileId,
    additionalParameters,
  );
}

// Run a single promptfoo config. When `promptFile` is given, the run is scoped
// to that prompt (`--prompts`); otherwise the whole config is evaluated (used
// when a test/provider/assertion dependency changed rather than the prompt).
export async function runConfig(
  configFile: string,
  promptFile: string | undefined,
  env: {[key: string]: string},
  promptFileId: number,
  additionalParameters?: string[],
): Promise<{outputFile: string; summary: string}> {
  const outputFile = path.join(
    process.cwd(),
    `promptfoo-output-${promptFileId}.json`,
  );
  // Emit an HTML report alongside the JSON output (-o is variadic). The JSON is
  // still used below for the PR comment summary; the HTML is for humans to skim.
  const htmlFile = path.join(
    process.cwd(),
    `promptfoo-output-${promptFileId}.html`,
  );
  const promptfooArgs = [
    'eval',
    '-c',
    configFile,
    ...(promptFile ? ['--prompts', promptFile] : []),
    '-o',
    outputFile,
    htmlFile,
    ...(additionalParameters || []),
  ];
  core.info(
    `[action] Running promptfoo with args: ${JSON.stringify(promptfooArgs)}`,
  );
  try {
    const exitCode = await exec.exec('npx promptfoo', promptfooArgs, {env});
    core.info(
      `[action] Finished running promptfoo with exit code: ${exitCode}`,
    );
  } catch (error: unknown) {
    core.error(`[action] Error running promptfoo: ${error}`);
  }
  const output: IPromptFooOutput = JSON.parse(
    fs.readFileSync(outputFile, 'utf8'),
  );
  const heading = promptFile ?? configFile;
  const summary = `# ${heading}

| Success | Failure |
|---------|---------|
| ${output.results.stats.successes}      | ${
    output.results.stats.failures
  }       |

${displayResultSummary(output)}

`;
  return {outputFile, summary};
}
