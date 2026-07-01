#!/usr/bin/env node
import { Command } from "commander";
import { runInit } from "./commands/init.js";
import { runConfig } from "./commands/config.js";
import { runDoctor } from "./commands/doctor.js";
import { runBench } from "./commands/bench.js";
import { runAgent } from "./commands/run.js";
import { runLSPServer } from "./commands/LSPServer.js";
import { runLogin } from "./commands/login.js";

const program = new Command();

program
  .name("orbit")
  .description("Orbit - Local AI Coding Agent Runtime")
  .version("0.1.0")
  .argument("[task]", "task description for Orbit to execute")
  .option("--provider <provider>", "specify model provider")
  .option("--model <model>", "specify model name")
  .option("--yes", "bypass low-risk approvals")
  .option("--multi", "run in multi-agent planning/coding/review mode")
  .option("--direct", "run interactive REPL in direct console streaming mode")
  .action(async (task, options) => {
    const cwd = process.cwd();
    const overrides: any = {};
    if (options.provider) {
      overrides.provider = { default: options.provider };
    }
    if (options.model) {
      overrides.models = { default: options.model };
    }
    if (options.direct) {
      overrides.direct = true;
    }
    if (options.yes) {
      overrides.permissions = { mode: "auto" };
    }
    await runAgent(cwd, task, overrides, !!options.multi);
  });

program
  .command("init")
  .description("initialize ORBIT.md guidelines file")
  .action(() => {
    runInit(process.cwd());
  });

program
  .command("config")
  .description("show resolved configurations")
  .action(() => {
    runConfig(process.cwd());
  });

program
  .command("login")
  .description("interactively configure API keys for models")
  .action(async () => {
    await runLogin();
  });

program
  .command("doctor")
  .description("diagnose local environment and API configs")
  .option("--probe", "perform a lightweight live provider capability probe")
  .action(async (options) => {
    await runDoctor(process.cwd(), { probe: !!options.probe });
  });

program
  .command("bench")
  .description(
    "measure provider first-token latency, throughput, and cache usage",
  )
  .option("--model <model>", "model to benchmark")
  .option("--prompt <prompt>", "custom benchmark prompt")
  .option("--repeat <n>", "number of benchmark samples to record")
  .option("--max-tokens <n>", "maximum completion tokens for each sample")
  .option("--json", "print benchmark samples as JSON")
  .action(async (options) => {
    await runBench(process.cwd(), {
      model: options.model,
      prompt: options.prompt,
      repeat: options.repeat,
      maxTokens: options.maxTokens,
      json: !!options.json,
    });
  });

program
  .command("lsp")
  .description("start the local LSP autocomplete server")
  .action(async () => {
    await runLSPServer(process.cwd());
  });

program
  .command("exec")
  .description("run a task in non-interactive mode and stream events as JSONL")
  .argument("<prompt>", "the task prompt to execute")
  .option("--provider <provider>", "specify model provider")
  .option("--model <model>", "specify model name")
  .option("--jsonl", "output event logs in JSONL format")
  .action(async (prompt, options) => {
    const cwd = process.cwd();
    const overrides: any = {};
    if (options.provider) {
      overrides.provider = { default: options.provider };
    }
    if (options.model) {
      overrides.models = { default: options.model };
    }
    await runAgent(cwd, prompt, overrides, false, {
      nonInteractive: true,
      jsonl: !!options.jsonl,
    });
  });

program.parse(process.argv);
