import * as core from '@actions/core';
import * as github from '@actions/github';
import * as glob from 'glob';
import {simpleGit} from 'simple-git';
import {
  runPromptfoo,
  runConfig,
  configDependencies,
  findConfigFileFromPromptFile,
  normalizePath,
} from './shared';

const gitInterface = simpleGit();

export async function run(): Promise<void> {
  try {
    const openaiApiKey: string = core.getInput('openai-api-key', {
      required: false,
    });
    const azureOpenaiApiKey: string = core.getInput('azure-openai-api-key', {
      required: false,
    });
    const githubToken: string = core.getInput('github-token', {required: true});
    const promptFilesGlobs: string[] = core
      .getInput('prompts', {required: true})
      .split('\n');
    const cachePath: string = core.getInput('cache-path', {required: false});

    core.setSecret(openaiApiKey);
    core.setSecret(azureOpenaiApiKey);
    core.setSecret(githubToken);

    const pullRequest = github.context.payload.pull_request;
    if (!pullRequest) {
      throw new Error('No pull request found.');
    }

    core.info(`git diff --name-only origin/main`);
    const changedFilesRaw = await gitInterface.diff([
      '--name-only',
      'origin/main',
    ]);
    core.info('Changed files:');
    core.info(JSON.stringify(changedFilesRaw));
    const changedSet = new Set(
      changedFilesRaw.split('\n').map(normalizePath).filter(Boolean),
    );

    // Resolve glob patterns to the prompt-output files that changed.
    const promptFiles: string[] = [];
    for (const globPattern of promptFilesGlobs) {
      const matches = glob.sync(globPattern.trim());
      const changedMatches = matches
        .map(normalizePath)
        .filter(file => changedSet.has(file));
      promptFiles.push(...changedMatches);
    }
    const promptFileSet = new Set(promptFiles);

    // Configs whose NON-prompt dependencies changed (test vars, providers,
    // assertion scripts, rubrics, or the config file itself) must be re-run as
    // a whole — editing a test no longer changes a prompt JSON, so the
    // prompt-only detection above would miss them.
    const wholeConfigs: string[] = [];
    for (const configFile of glob.sync('*.yaml')) {
      const hits = [...configDependencies(configFile)].filter(d => changedSet.has(d));
      const hasNonPromptHit = hits.some(h => !promptFileSet.has(h));
      if (hits.length > 0 && hasNonPromptHit) {
        wholeConfigs.push(normalizePath(configFile));
      }
    }
    const wholeConfigSet = new Set(wholeConfigs);

    core.info(`Changed prompt files: ${promptFiles.join(', ')}`);
    core.info(`Affected configs (whole run): ${wholeConfigs.join(', ')}`);
    if (promptFiles.length === 0 && wholeConfigs.length === 0) {
      return;
    }

    const env = {
      ...process.env,
      ...(azureOpenaiApiKey ? {AZURE_OPENAI_API_KEY: azureOpenaiApiKey} : {}),
      ...(openaiApiKey ? {OPENAI_API_KEY: openaiApiKey} : {}),
      ...(cachePath ? {PROMPTFOO_CACHE_PATH: cachePath} : {}),
    };

    let body = '';
    let id = 1;

    // Whole-config runs (a test/provider/assertion dependency changed).
    for (const configFile of wholeConfigs) {
      core.info(`Running promptfoo for config ${configFile}`);
      const {summary} = await runConfig(configFile, undefined, env, id++);
      body += summary;
    }

    // Per-prompt runs (a prompt JSON changed), skipping any whose config is
    // already covered by a whole-config run above.
    for (const promptFile of promptFiles) {
      const configFile = findConfigFileFromPromptFile(promptFile);
      if (configFile && wholeConfigSet.has(normalizePath(configFile))) {
        continue;
      }
      core.info(`Running promptfoo for ${promptFile}`);
      const {summary} = await runPromptfoo(promptFile, env, id++);
      body += summary;
    }

    // Comment PR
    const octokit = github.getOctokit(githubToken);
    await octokit.rest.issues.createComment({
      ...github.context.repo,
      issue_number: pullRequest.number,
      body,
    });
  } catch (error) {
    if (error instanceof Error) {
      handleError(error);
    } else {
      handleError(new Error(String(error)));
    }
  }
}

export function handleError(error: Error): void {
  core.setFailed(error.message);
}

if (require.main === module) {
  run();
}
