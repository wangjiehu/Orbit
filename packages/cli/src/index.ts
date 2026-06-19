#!/usr/bin/env node
import { Command } from 'commander';
import { runInit } from './commands/init.js';
import { runConfig } from './commands/config.js';
import { runDoctor } from './commands/doctor.js';
import { runAgent } from './commands/run.js';

const program = new Command();

program
  .name('orbit')
  .description('Orbit - Local AI Coding Agent Runtime')
  .version('0.1.0')
  .argument('[task]', 'task description for Orbit to execute')
  .option('--provider <provider>', 'specify model provider')
  .option('--model <model>', 'specify model name')
  .option('--yes', 'bypass low-risk approvals')
  .option('--multi', 'run in multi-agent planning/coding/review mode')
  .action(async (task, options) => {
    const cwd = process.cwd();
    const overrides: any = {};
    if (options.provider) {
      overrides.provider = { default: options.provider };
    }
    if (options.model) {
      overrides.models = { default: options.model };
    }
    await runAgent(cwd, task, overrides, !!options.multi);
  });

program
  .command('init')
  .description('initialize ORBIT.md guidelines file')
  .action(() => {
    runInit(process.cwd());
  });

program
  .command('config')
  .description('show resolved configurations')
  .action(() => {
    runConfig(process.cwd());
  });

program
  .command('doctor')
  .description('diagnose local environment and API configs')
  .action(() => {
    runDoctor(process.cwd());
  });

program.parse(process.argv);
