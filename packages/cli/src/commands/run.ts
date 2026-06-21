import {
  ConfigLoader,
  ConfigSchema,
  CredentialsManager,
} from "@orbit-ai/config";
import {
  AgentLoop,
  UserInteraction,
  Orchestrator,
  eventBus,
  AutocompleteEngine,
} from "@orbit-ai/core";
import { resolveSafePath, generateId } from "@orbit-ai/shared";
import http from "http";
import {
  DeepSeekAnthropicProvider,
  DeepSeekOpenAIProvider,
  OpenAIProvider,
  AnthropicProvider,
  OllamaProvider,
} from "@orbit-ai/model-providers";
import { Prompt, DiffView, Renderer } from "@orbit-ai/tui";
import picocolors from "picocolors";
import glob from "fast-glob";
import { existsSync, readFileSync, writeFileSync, mkdirSync, watch } from "fs";
import { join, dirname, resolve } from "path";
import { homedir } from "os";
import readline from "readline";
import { SymbolIndexer } from "@orbit-ai/context-engine";
import { execSync } from "child_process";
import { PermissionEngine } from "@orbit-ai/permissions";
import { expandCustomCommand, loadCustomCommands } from "./customCommands.js";

let currentTui: FullscreenTui | null = null;

const BUILTIN_SLASH_COMMANDS = [
  "/help",
  "/status",
  "/config",
  "/model",
  "/chat",
  "/commit",
  "/exit",
  "/quit",
  "/rollback",
  "/timeline",
  "/rewind",
  "/clear",
  "/compact",
  "/history",
  "/edit",
  "/inspect",
  "/doc",
  "/diagnose",
  "/resolve",
  "/references",
  "/run",
  "/grep",
  "/api",
  "/register",
  "/language",
  "/fork",
  "/mode",
  "/ask",
  "/code",
  "/copy",
  "/copy-context",
  "/git",
  "/tokens",
  "/read-only",
  "/readonly",
  "/new",
  "/reset",
  "/delete",
  "/rm",
  "/del",
  "/btw",
  "/memory",
  "/commands",
] as const;

import {
  previousCodePointIndex,
  nextCodePointIndex,
  parseMouseWheelDirection,
  pageText,
  FullscreenTui,
} from "../tui/FullscreenTui.js";

export {
  previousCodePointIndex,
  nextCodePointIndex,
  parseMouseWheelDirection,
};

export function printOutput(text: string, raw = false) {
  if (currentTui && currentTui.isActive) {
    currentTui.addSystemMessage(text, raw);
  } else {
    console.log(text);
  }
}
interface LocalState {
  lastSessionId?: string;
  lastModel?: string;
}

function getLocalState(cwd: string): LocalState {
  const statePath = join(cwd, ".orbit", "state.json");
  if (!existsSync(statePath)) return {};
  try {
    return JSON.parse(readFileSync(statePath, "utf8"));
  } catch {
    return {};
  }
}

function saveLocalState(cwd: string, state: LocalState): void {
  const statePath = join(cwd, ".orbit", "state.json");
  try {
    const dir = dirname(statePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const current = getLocalState(cwd);
    const updated = { ...current, ...state };
    writeFileSync(statePath, JSON.stringify(updated, null, 2), "utf8");
  } catch {}
}

function startAutocompleteServer(cwd: string, config: any) {
  const engine = new AutocompleteEngine();
  const server = http.createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(200);
      res.end();
      return;
    }

    if (req.method === "POST" && req.url === "/autocomplete") {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", async () => {
        try {
          const parsed = JSON.parse(body);
          const prefix = parsed.prefix || "";
          const suffix = parsed.suffix || "";
          const completion = await engine.autocomplete(prefix, suffix, config);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ completion }));
        } catch (e: any) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  let port = 6018;
  const startListen = (p: number) => {
    server.listen(p, "127.0.0.1", () => {
      eventBus.emitEvent("info", {
        message: `Autocomplete bridge server running on http://127.0.0.1:${p}`,
      });
    });
    server.on("error", (err: any) => {
      if (err.code === "EADDRINUSE") {
        startListen(p + 1);
      }
    });
  };
  startListen(port);
  return server;
}

export async function runAgent(
  cwd: string,
  task?: string,
  cliOverrides?: any,
  multi?: boolean,
): Promise<void> {
  const config = ConfigLoader.loadSync(cwd, cliOverrides);

  if (!cliOverrides || !cliOverrides.model) {
    const localState = getLocalState(cwd);
    if (localState.lastModel) {
      config.models.default = localState.lastModel;
    }
  }

  if (config.models) {
    if (config.models.default) {
      config.models.default = config.models.default.replace(/\[1m\]/g, "");
    }
    if (config.models.fast) {
      config.models.fast = config.models.fast.replace(/\[1m\]/g, "");
    }
  }

  const providerName = config.provider.default;
  const pConfig = config.providers[providerName];
  if (!pConfig) {
    console.error(
      picocolors.red(
        `Provider "${providerName}" is not defined in configuration.`,
      ),
    );
    return;
  }

  let providerInstance: any;
  if (pConfig.type === "anthropic-compatible") {
    providerInstance = new DeepSeekAnthropicProvider(
      pConfig.apiKey,
      pConfig.baseUrl,
    );
  } else if (pConfig.type === "openai-compatible") {
    providerInstance = new DeepSeekOpenAIProvider(
      pConfig.apiKey,
      pConfig.baseUrl,
    );
  } else if (pConfig.type === "openai") {
    providerInstance = new OpenAIProvider(pConfig.apiKey, pConfig.baseUrl);
  } else if (pConfig.type === "anthropic") {
    providerInstance = new AnthropicProvider(pConfig.apiKey, pConfig.baseUrl);
  } else if (pConfig.type === "ollama") {
    providerInstance = new OllamaProvider(pConfig.baseUrl);
  }

  if (!providerInstance) {
    console.error(
      picocolors.red(`Unsupported provider type "${pConfig.type}".`),
    );
    return;
  }

  const interaction: UserInteraction = {
    async askApproval(reason: string, preview?: string): Promise<boolean> {
      console.log(`\nRisk Warning: ${reason}`);
      if (preview) {
        console.log(picocolors.gray(`Parameters: ${preview}`));
      }
      return await Prompt.askApproval("Confirm action?");
    },
    showText(text: string): void {
      console.log(text);
    },
    async showDiff(
      filePath: string,
      before: string | null,
      after: string,
    ): Promise<void> {
      await pageText(DiffView.render(filePath, before, after));
    },
  };

  let activeTask = task;
  if (!activeTask) {
    await runRepl(
      cwd,
      config,
      providerInstance,
      interaction,
      multi,
      !!cliOverrides?.direct,
    );
    return;
  }

  if (multi) {
    const orchestrator = new Orchestrator(
      cwd,
      config,
      providerInstance,
      activeTask,
      interaction,
    );
    await orchestrator.run();
  } else {
    const loop = new AgentLoop(
      cwd,
      config,
      providerInstance,
      activeTask,
      interaction,
    );
    await loop.run();
  }
}

async function runRepl(
  cwd: string,
  config: any,
  providerInstance: any,
  interaction: UserInteraction,
  multi?: boolean,
  direct?: boolean,
): Promise<void> {
  const version = "v0.1.0";
  const sigintHandler = () => {
    // Prevent process exit on Ctrl+C during agent execution or REPL waiting.
  };
  process.on("SIGINT", sigintHandler);

  const isTTY =
    process.stdin.isTTY && typeof process.stdin.setRawMode === "function";
  const useFullscreenTui = isTTY && !direct;
  const autocompleteServer = config.autocomplete?.enabled
    ? startAutocompleteServer(cwd, config)
    : null;

  const tui = new FullscreenTui(cwd, config.models.default, version, config);
  currentTui = tui;
  tui.setPermissionsMode(config.permissions.mode);

  const tuiInteraction: UserInteraction = {
    async askApproval(reason: string, preview?: string): Promise<boolean> {
      const wasActive = useFullscreenTui && tui.isActive;
      if (wasActive) tui.stop();

      console.log(`\nRisk Warning: ${reason}`);
      if (preview) {
        console.log(picocolors.gray(`Parameters: ${preview}`));
      }
      const approved = await Prompt.askApproval("Confirm action?");

      if (wasActive) tui.start(config.budgetLimit);
      return approved;
    },
    showText(text: string): void {
      if (useFullscreenTui && tui.isActive) {
        tui.addLog(text);
      } else {
        console.log(text);
      }
    },
    async showDiff(
      filePath: string,
      before: string | null,
      after: string,
    ): Promise<void> {
      const wasActive = useFullscreenTui && tui.isActive;
      if (wasActive) tui.stop();

      await pageText(DiffView.render(filePath, before, after));

      if (wasActive) tui.start(config.budgetLimit);
    },
  };

  const localState = getLocalState(cwd);
  let resumeSessionId: string | undefined;
  if (localState.lastSessionId) {
    const resume = await Prompt.askApproval(
      `Found previous session (${localState.lastSessionId}). Resume last session?`,
    );
    if (resume) {
      resumeSessionId = localState.lastSessionId;
    }
  }

  const loop = new AgentLoop(
    cwd,
    config,
    providerInstance,
    "REPL Interactive Shell Started",
    tuiInteraction,
    {
      disableStatusBar: useFullscreenTui,
      sessionId: resumeSessionId,
    },
  );

  saveLocalState(cwd, {
    lastSessionId: loop.getSessionId(),
    lastModel: loop.getModelOverride() || config.models.default,
  });

  if (resumeSessionId && useFullscreenTui) {
    tui.loadHistory(loop.getHistory());
  }

  tui.setModelNameGetter(
    () => loop.getModelOverride() || config.models.default,
  );

  // Load autocomplete candidates
  let candidates = await getAutocompleteCandidates(cwd, config);
  tui.setCandidates(candidates);

  const onModelDelta = (payload: any) => {
    if (useFullscreenTui) {
      tui.handleModelDelta(payload.text);
    } else {
      process.stdout.write(payload.text);
    }
  };
  const onLoopStart = (payload: any) => {
    if (useFullscreenTui) {
      tui.startAttempt(payload.attempt);
    }
  };
  const onCostUpdate = (payload: any) => {
    if (useFullscreenTui) {
      tui.setCost(
        payload.sessionCost,
        payload.totalInputTokens,
        payload.totalCacheReadTokens,
        payload.totalOutputTokens,
      );
    }
  };
  const onThinkingDelta = (payload: any) => {
    if (useFullscreenTui) {
      tui.handleThinkingDelta(payload.text);
    } else {
      process.stdout.write(picocolors.gray(payload.text));
    }
  };

  eventBus.on("model_delta", onModelDelta);
  eventBus.on("loop_start", onLoopStart);
  eventBus.on("cost_update", onCostUpdate);
  eventBus.on("thinking_delta", onThinkingDelta);

  // Start background file watcher (Dynamic Incremental Watcher with Config Ignores)
  let watchTimeout: NodeJS.Timeout | null = null;
  const ignorePatterns = config.context?.ignore || [];
  const ignoreRegexes = ignorePatterns.map((pattern: string) => {
    const escaped = pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*\*/g, ".*")
      .replace(/\*/g, "[^/]*");
    const finalPattern = escaped.endsWith(".*")
      ? "^" + escaped + "$"
      : "(^" + escaped + "$|^" + escaped + "\/.*)";
    return new RegExp(finalPattern);
  });

  const normCwd = resolve(cwd).toLowerCase().replace(/\\/g, "/");
  const normHome = resolve(homedir()).toLowerCase().replace(/\\/g, "/");
  const isHomeOrRoot =
    normCwd === normHome ||
    normCwd === "/" ||
    /^[a-zA-Z]:\/$/.test(normCwd) ||
    dirname(normCwd) === normCwd;

  let watcher: any = null;
  if (!isHomeOrRoot) {
    const indexer = new SymbolIndexer(cwd);
    watcher = watch(cwd, { recursive: true }, (eventType, filename) => {
      if (
        filename &&
        /\.(ts|tsx|js|jsx)$/.test(filename) &&
        !filename.includes(".orbit")
      ) {
        const normalized = filename.replace(/\\/g, "/");
        const isIgnored = ignoreRegexes.some((rx: RegExp) =>
          rx.test(normalized),
        );
        if (isIgnored) return;

        if (watchTimeout) clearTimeout(watchTimeout);
        watchTimeout = setTimeout(() => {
          indexer.index().catch(() => {});
        }, 500); // debounce 500ms
      }
    });
  }

  if (useFullscreenTui) {
    tui.start(config.budgetLimit);
  } else {
    Renderer.printHeader(loop.getSessionId(), config.models.default, cwd);
  }

  try {
    while (true) {
      let input: string | null;
      if (useFullscreenTui) {
        input = await tui.askInput();
      } else {
        input = await Prompt.askTextWithAutocomplete(
          "Type your task or command...",
          makeCompleter(candidates),
          `${picocolors.bold(picocolors.magenta("orbit"))}${picocolors.gray(" ❯ ")}`,
        );
      }

      if (input === null) {
        if (useFullscreenTui) {
          tui.stop();
        }
        console.log(
          picocolors.yellow("Exiting Orbit Interactive Shell. Goodbye!"),
        );
        break;
      }
      if (!input) continue;

      let trimmed = input.trim();
      if (!trimmed) continue;

      if (trimmed.startsWith("/")) {
        const commandName = trimmed.slice(1).split(/\s+/, 1)[0].toLowerCase();
        const customCommand = loadCustomCommands(
          cwd,
          BUILTIN_SLASH_COMMANDS,
        ).find((candidate) => candidate.name === commandName);
        if (customCommand) {
          const rawArguments = trimmed.slice(commandName.length + 1).trim();
          trimmed = expandCustomCommand(customCommand, rawArguments);
          tui.addLog(
            `${config.language === "zh" ? "已展开自定义命令" : "Expanded custom command"} /${customCommand.name}`,
          );
        }
      }

      if (trimmed.startsWith("!") || trimmed.startsWith("/run")) {
        const wasActive = useFullscreenTui && tui.isActive;
        if (wasActive) tui.stop();

        let shellCmd = "";
        if (trimmed.startsWith("!")) {
          shellCmd = trimmed.substring(1).trim();
        } else {
          shellCmd = trimmed.substring(4).trim();
        }

        const isZh = config.language === "zh";
        if (!shellCmd) {
          console.log(
            isZh
              ? picocolors.yellow(
                  "用法: !<shell_command> 或 /run <shell_command>",
                )
              : picocolors.yellow(
                  "Usage: !<shell_command> or /run <shell_command>",
                ),
          );
          if (wasActive) tui.start(config.budgetLimit);
          continue;
        }

        const permissionEngine = new PermissionEngine(config);
        const decision = permissionEngine.evaluate(
          "bash",
          { command: shellCmd },
          "execute",
        );
        if (decision.action === "deny") {
          console.log(
            picocolors.red(
              isZh
                ? `✖ 命令已被安全策略阻止: ${decision.reason}`
                : `✖ Command blocked by safety policy: ${decision.reason}`,
            ),
          );
          if (wasActive) tui.start(config.budgetLimit);
          continue;
        }
        if (decision.action === "ask") {
          const approved = await Prompt.askApproval(
            isZh
              ? `命令需要 ${decision.risk} 权限：${shellCmd}`
              : `Command requires ${decision.risk} permission: ${shellCmd}`,
          );
          if (!approved) {
            console.log(
              picocolors.yellow(
                isZh ? "已取消命令执行。" : "Command execution cancelled.",
              ),
            );
            if (wasActive) tui.start(config.budgetLimit);
            continue;
          }
        }

        console.log(
          isZh
            ? picocolors.cyan(`\n正在执行 Shell 命令: ${shellCmd}...`)
            : picocolors.cyan(`\nRunning shell command: ${shellCmd}...`),
        );

        try {
          const { spawnSync } = await import("child_process");
          const result = spawnSync(shellCmd, {
            cwd,
            stdio: "inherit",
            shell: true,
          });

          if (result.status === 0) {
            console.log(
              isZh
                ? picocolors.green(`\n✔ 命令执行成功。`)
                : picocolors.green(`\n✔ Command completed successfully.`),
            );
          } else {
            console.log(
              isZh
                ? picocolors.red(`\n✖ 命令执行失败，退出代码: ${result.status}`)
                : picocolors.red(
                    `\n✖ Command failed with exit code ${result.status}`,
                  ),
            );
          }

          await Prompt.askText(
            isZh
              ? "按 Enter 键返回 Orbit..."
              : "Press Enter to return to Orbit...",
          );
        } catch (err: any) {
          console.log(
            isZh
              ? picocolors.red(`无法执行命令: ${err.message}`)
              : picocolors.red(`Failed to execute command: ${err.message}`),
          );
        } finally {
          tui.syncFromLoop(loop);
          if (wasActive) tui.start(config.budgetLimit);
        }
        continue;
      }

      if (trimmed.startsWith("/")) {
        const parts = trimmed.split(" ");
        const command = parts[0].toLowerCase();

        if (command === "/exit" || command === "/quit") {
          console.log(
            picocolors.yellow("Exiting Orbit Interactive Shell. Goodbye!"),
          );
          break;
        }

        if (command === "/help") {
          const helpText = [
            "",
            "Available Slash Commands:",
            "  /help           - Show this help message",
            "  /status         - Display session provider, active model, cost, and budget",
            "  /config [k=v]   - View or modify configurations interactively or via key=value",
            "  /model [name]   - Get or set the active model dynamically",
            "  /chat [sub]     - Manage/switch sessions (subcommands: list/ls, new, delete/rm, switch <id/index>)",
            "  /api            - Configure API keys and Base URLs interactively",
            "  /commit [msg]   - Stage changes and commit them (LLM message generation if empty)",
            "  /exit, /quit    - Terminate the REPL session",
            "  /rollback       - Revert the last file edits checkpoint",
            "  /timeline       - List persistent file checkpoints for this session",
            "  /rewind [id|n]  - Rewind this session to a selected checkpoint",
            "  /clear          - Clear terminal screen",
            "  /compact        - Compact older agent chat history",
            "  /history        - Display command history of this session",
            "  /edit           - Open external editor for long/multiline prompts",
            "  /inspect        - (CodeWhale) Visualize codebase outline and stats",
            "  /doc [file]     - (Codex) Generate TSDoc/JSDoc documentation for a file",
            "  /diagnose       - (AtomCode) Run tests and auto-repair failures",
            "  /resolve [file] - Resolve merge conflicts in a file semantically using LLM",
            "  /references [s] - Find all call sites and usages of symbol s in workspace",
            "  /run <cmd>      - Execute a shell command directly (shortcut: !<cmd>)",
            "  /grep <query>   - Search for string patterns across workspace files and add them",
            "  /fork [name]    - Fork current session with history into a new session",
            "  /fork tree      - Display lineage hierarchy tree of session forks",
            "  /fork switch <id/idx> - Switch focus to specified branch session",
            "  /mode [mode]    - Switch security confirmation mode (strict, normal, auto, plan)",
            "  /ask            - Shortcut for /mode strict (read-only / high security)",
            "  /code           - Shortcut for /mode normal (default editing mode)",
            "  /copy           - Copy the last assistant response to system clipboard",
            "  /copy-context   - Copy active context files list to system clipboard",
            "  /git <args>     - Execute a git command directly in the sandbox",
            "  /tokens         - Report detailed token usage & cost for the session",
            "  /read-only <f>  - Add files to context as read-only references",
            "  /btw <q>        - Ask a quick side-question without polluting history",
            "  /memory         - View workspace memory / AGENTS.md guidelines",
            "  /commands       - List project and user custom prompt commands",
            "",
          ].join("\n");
          printOutput(helpText);
          continue;
        }

        if (command === "/commands") {
          const isZh = config.language === "zh";
          const customCommands = loadCustomCommands(
            cwd,
            BUILTIN_SLASH_COMMANDS,
          );
          if (customCommands.length === 0) {
            printOutput(
              picocolors.yellow(
                isZh
                  ? "未发现自定义命令。可在 .orbit/commands/*.md 或 ~/.orbit/commands/*.md 中创建。"
                  : "No custom commands found. Create them in .orbit/commands/*.md or ~/.orbit/commands/*.md.",
              ),
            );
            continue;
          }
          printOutput(
            [
              picocolors.bold(
                picocolors.cyan(
                  isZh
                    ? "\n=== Orbit 自定义命令 ==="
                    : "\n=== Orbit Custom Commands ===",
                ),
              ),
              ...customCommands.map(
                (customCommand) =>
                  `  /${picocolors.green(customCommand.name)}${customCommand.argumentHint ? ` ${picocolors.dim(customCommand.argumentHint)}` : ""}\n    ${customCommand.description} ${picocolors.dim(`[${customCommand.source}]`)}`,
              ),
              picocolors.cyan("============================\n"),
            ].join("\n"),
          );
          continue;
        }

        if (command === "/api" || command === "/register") {
          const wasActive = useFullscreenTui && tui.isActive;
          if (wasActive) tui.stop();
          try {
            const restoreTuiAndPrint = (msg: string) => {
              if (wasActive && !tui.isActive) {
                tui.start(config.budgetLimit);
              }
              printOutput(msg);
            };

            const providersList = [
              {
                value: "deepseek-openai",
                label: "DeepSeek (OpenAI compatible)",
              },
              {
                value: "deepseek-anthropic",
                label: "DeepSeek (Anthropic compatible)",
              },
              { value: "openai", label: "OpenAI" },
              { value: "anthropic", label: "Anthropic" },
            ];
            const providerKey = await Prompt.askSelect(
              "Select API Provider to configure:",
              providersList,
            );
            if (!providerKey) {
              restoreTuiAndPrint(
                picocolors.yellow("API configuration cancelled."),
              );
              continue;
            }

            const defaultBaseUrl =
              config.providers[providerKey]?.baseUrl ||
              (providerKey === "deepseek-openai"
                ? "https://api.deepseek.com"
                : providerKey === "deepseek-anthropic"
                  ? "https://api.deepseek.com/anthropic"
                  : providerKey === "openai"
                    ? "https://api.openai.com/v1"
                    : providerKey === "anthropic"
                      ? "https://api.anthropic.com"
                      : "");
            const baseUrl = await Prompt.askText(
              `Enter Base URL for ${providerKey}:`,
              defaultBaseUrl,
            );
            if (baseUrl === null) {
              restoreTuiAndPrint(
                picocolors.yellow("API configuration cancelled."),
              );
              continue;
            }

            const apiKey = await Prompt.askPassword(
              `Enter API Key for ${providerKey}:`,
            );
            if (apiKey === null) {
              restoreTuiAndPrint(
                picocolors.yellow("API configuration cancelled."),
              );
              continue;
            }

            const apiKeyEnv =
              providerKey === "deepseek-openai"
                ? "DEEPSEEK_API_KEY"
                : providerKey === "deepseek-anthropic"
                  ? "ANTHROPIC_AUTH_TOKEN"
                  : providerKey === "openai"
                    ? "OPENAI_API_KEY"
                    : providerKey === "anthropic"
                      ? "ANTHROPIC_API_KEY"
                      : `${providerKey.toUpperCase().replace(/-/g, "_")}_API_KEY`;

            // 1. Save API Key securely
            const credsManager = new CredentialsManager();
            credsManager.storeSecret(apiKeyEnv, apiKey);

            // 2. Save Base URL and apiKeyEnv to global config.yaml
            const {
              existsSync: fsExists,
              readFileSync: fsRead,
              writeFileSync: fsWrite,
              mkdirSync: fsMkdir,
            } = await import("fs");
            const { homedir: osHomedir } = await import("os");
            const { join: pathJoin, dirname: pathDirname } =
              await import("path");
            const { parse: yamlParse, stringify: yamlStringify } =
              await import("yaml");

            const globalConfigPath = pathJoin(
              osHomedir(),
              ".orbit",
              "config.yaml",
            );
            let globalConfig: any = {};
            if (fsExists(globalConfigPath)) {
              try {
                const raw = fsRead(globalConfigPath, "utf8");
                globalConfig = yamlParse(raw) || {};
              } catch {
                globalConfig = {};
              }
            }
            if (!globalConfig.providers) {
              globalConfig.providers = {};
            }
            globalConfig.providers[providerKey] = {
              ...globalConfig.providers[providerKey],
              baseUrl,
              apiKeyEnv,
            };
            try {
              const dir = pathDirname(globalConfigPath);
              if (!fsExists(dir)) {
                fsMkdir(dir, { recursive: true });
              }
              fsWrite(globalConfigPath, yamlStringify(globalConfig), "utf8");
              restoreTuiAndPrint(
                picocolors.green(
                  `✔ Saved provider "${providerKey}" configuration to global config at ${globalConfigPath}`,
                ),
              );
            } catch (err: any) {
              restoreTuiAndPrint(
                picocolors.red(`Failed to save global config: ${err.message}`),
              );
            }

            // 3. Update active session configuration in memory
            const activeConfig = loop.getConfig();
            if (!activeConfig.providers[providerKey]) {
              activeConfig.providers[providerKey] = {
                type: providerKey.includes("anthropic")
                  ? "anthropic-compatible"
                  : "openai-compatible",
              };
            }
            activeConfig.providers[providerKey].baseUrl = baseUrl;
            activeConfig.providers[providerKey].apiKeyEnv = apiKeyEnv;
            activeConfig.providers[providerKey].apiKey = apiKey;

            // 4. Update the active providerInstance if configuring the current active provider
            const currentProviderKey = activeConfig.provider.default;
            if (providerKey === currentProviderKey && providerInstance) {
              (providerInstance as any).apiKey = apiKey;
              (providerInstance as any).baseUrl = baseUrl;
              restoreTuiAndPrint(
                picocolors.green(
                  `✔ Instantly updated current provider "${providerKey}" session credentials.`,
                ),
              );
            }

            // 5. Ask if the user wants to switch the active provider to this provider
            if (providerKey !== currentProviderKey) {
              const switchNow = await Prompt.askApproval(
                `Would you like to switch the active provider to "${providerKey}" now?`,
              );
              if (switchNow) {
                activeConfig.provider.default = providerKey;

                // Re-create the providerInstance dynamically!
                let newProviderInstance: any;
                if (providerKey === "deepseek-anthropic") {
                  newProviderInstance = new DeepSeekAnthropicProvider(
                    apiKey,
                    baseUrl,
                  );
                } else if (providerKey === "deepseek-openai") {
                  newProviderInstance = new DeepSeekOpenAIProvider(
                    apiKey,
                    baseUrl,
                  );
                } else if (providerKey === "openai") {
                  newProviderInstance = new OpenAIProvider(apiKey, baseUrl);
                } else if (providerKey === "anthropic") {
                  newProviderInstance = new AnthropicProvider(apiKey, baseUrl);
                }

                if (newProviderInstance) {
                  providerInstance = newProviderInstance;
                  (loop as any).provider = newProviderInstance;
                  restoreTuiAndPrint(
                    picocolors.green(
                      `✔ Switched session provider to "${providerKey}".`,
                    ),
                  );
                } else {
                  restoreTuiAndPrint(
                    picocolors.red(
                      `Failed to instantiate provider for "${providerKey}".`,
                    ),
                  );
                }
              }
            }
          } finally {
            if (wasActive && !tui.isActive) {
              tui.start(config.budgetLimit);
            }
          }
          continue;
        }

        if (command === "/edit") {
          const wasActive = useFullscreenTui && tui.isActive;
          if (wasActive) tui.stop();
          try {
            const restoreTuiAndPrint = (msg: string) => {
              if (wasActive && !tui.isActive) {
                tui.start(config.budgetLimit);
              }
              printOutput(msg);
            };

            const tempFile = join(cwd, ".orbit", "orbit_prompt.md");
            try {
              const fs = await import("fs");
              const orbitDir = join(cwd, ".orbit");
              if (!fs.existsSync(orbitDir)) {
                fs.mkdirSync(orbitDir, { recursive: true });
              }
              fs.writeFileSync(
                tempFile,
                "# Describe your task or prompt here\n\n",
                "utf8",
              );
              console.log(
                picocolors.cyan(
                  `Opening editor... Please save and close the file when finished.`,
                ),
              );
              const editor =
                config.editor || process.env.EDITOR || "notepad.exe";
              const { execSync } = await import("child_process");
              execSync(`${editor} "${tempFile}"`);
              const promptContent = fs
                .readFileSync(tempFile, "utf8")
                .replace(/#.*?\n/, "") // Strip header
                .trim();
              if (fs.existsSync(tempFile)) {
                fs.unlinkSync(tempFile);
              }
              if (!promptContent) {
                restoreTuiAndPrint(
                  picocolors.yellow("Empty prompt. Aborting."),
                );
                continue;
              }
              restoreTuiAndPrint(
                picocolors.green(
                  `Loaded prompt: "${promptContent.substring(0, 60)}..."`,
                ),
              );

              // Restart TUI before running agent
              if (wasActive && !tui.isActive) {
                tui.start(config.budgetLimit);
              }

              const state = (loop as any).state;
              state.task = promptContent;
              state.done = false;
              state.attemptCount = 0;

              state.history.push({
                id: `msg_user_${Date.now()}`,
                role: "user",
                createdAt: new Date().toISOString(),
                content: [{ type: "text", text: promptContent }],
              });

              if (multi) {
                const orchestrator = new Orchestrator(
                  cwd,
                  config,
                  providerInstance,
                  promptContent,
                  tuiInteraction,
                );
                await orchestrator.run();
              } else {
                await loop.run();
              }
              tui.syncFromLoop(loop);
              tui.finishAttempt();
            } catch (err: any) {
              restoreTuiAndPrint(
                picocolors.red(`Failed to open editor: ${err.message}`),
              );
            }
          } finally {
            if (wasActive && !tui.isActive) {
              tui.start(config.budgetLimit);
            }
          }
          continue;
        }

        if (command === "/rollback") {
          const isZh = config.language === "zh";
          const args = parts.slice(1).join(" ").trim();

          if (args === "all" || args === "--all") {
            await loop.rollbackLastCheckpoint();
            continue;
          }

          const { execSync } = await import("child_process");
          let statusOut = "";
          try {
            statusOut = execSync("git status --porcelain", {
              cwd,
              stdio: ["ignore", "pipe", "ignore"],
            }).toString();
          } catch {
            await loop.rollbackLastCheckpoint();
            continue;
          }

          const lines = statusOut
            .split("\n")
            .map((l) => l.trim())
            .filter(Boolean);
          if (lines.length === 0) {
            console.log(
              isZh
                ? picocolors.yellow(
                    "当前工作区没有检测到任何未提交的代码变更。",
                  )
                : picocolors.yellow(
                    "No uncommitted changes detected in the workspace.",
                  ),
            );
            continue;
          }

          const modifiedFiles = lines.map((line) => {
            const filepath = line
              .substring(3)
              .trim()
              .replace(/^["']|["']$/g, "");
            if (filepath.includes(" -> ")) {
              const parts = filepath.split(" -> ");
              return parts[parts.length - 1].trim().replace(/^["']|["']$/g, "");
            }
            return filepath;
          });

          const wasActive = useFullscreenTui && tui.isActive;
          if (wasActive) tui.stop();

          try {
            const options = [
              {
                value: "all",
                label: isZh
                  ? "【全部回滚】 撤销所有变更"
                  : "[Rollback All] Discard all changes",
              },
              ...modifiedFiles.map((f) => ({ value: f, label: f })),
            ];

            const selected = await Prompt.askMultiSelect(
              isZh
                ? "选择要回滚（撤销变更）的文件："
                : "Select files to rollback (discard changes):",
              options,
            );

            if (selected && selected.length > 0) {
              if (selected.includes("all")) {
                await loop.rollbackLastCheckpoint();
              } else {
                for (const file of selected) {
                  const rolledBack = (loop as any).rollbackFileToCheckpoint(
                    file,
                  );
                  if (!rolledBack) {
                    try {
                      execSync(`git checkout -- "${file}"`, {
                        cwd,
                        stdio: "ignore",
                      });
                    } catch {
                      try {
                        const fs = await import("fs");
                        const fullP = resolve(cwd, file);
                        if (fs.existsSync(fullP)) {
                          fs.unlinkSync(fullP);
                        }
                      } catch {}
                    }
                  }
                }
                console.log(
                  isZh
                    ? picocolors.green(
                        `✔ 成功回滚以下文件的变更: ${selected.join(", ")}`,
                      )
                    : picocolors.green(
                        `✔ Successfully rolled back changes for: ${selected.join(", ")}`,
                      ),
                );
              }
            } else {
              console.log(
                isZh
                  ? picocolors.yellow("未选择任何文件。")
                  : picocolors.yellow("No files selected."),
              );
            }
          } catch (err: any) {
            console.log(
              isZh
                ? picocolors.red(`回滚操作失败: ${err.message}`)
                : picocolors.red(`Rollback operation failed: ${err.message}`),
            );
          } finally {
            tui.syncFromLoop(loop);
            if (wasActive) tui.start(config.budgetLimit);
          }
          continue;
        }

        if (command === "/timeline") {
          const checkpoints = loop.getCheckpoints();
          const isZh = config.language === "zh";
          if (checkpoints.length === 0) {
            printOutput(
              picocolors.yellow(
                isZh
                  ? "当前会话没有可用检查点。"
                  : "No checkpoints are available for this session.",
              ),
            );
            continue;
          }
          const lines = [
            picocolors.bold(
              picocolors.cyan(
                isZh
                  ? "\n=== Orbit 检查点时间线 ==="
                  : "\n=== Orbit Checkpoint Timeline ===",
              ),
            ),
            ...checkpoints.map((checkpoint, index) => {
              const time = new Date(checkpoint.timestamp).toLocaleString();
              return `${index + 1}. ${picocolors.green(checkpoint.id)}  ${picocolors.gray(time)}\n   ${checkpoint.files.join(", ")}  ${picocolors.dim(checkpoint.toolCallId)}`;
            }),
            picocolors.cyan("================================\n"),
          ];
          printOutput(lines.join("\n"));
          continue;
        }

        if (command === "/rewind") {
          const checkpoints = loop.getCheckpoints();
          const isZh = config.language === "zh";
          if (checkpoints.length === 0) {
            printOutput(
              picocolors.yellow(
                isZh
                  ? "当前会话没有可回退的检查点。"
                  : "No checkpoints are available to rewind.",
              ),
            );
            continue;
          }
          let target = parts.slice(1).join(" ").trim();
          if (!target) {
            const wasActive = useFullscreenTui && tui.isActive;
            if (wasActive) tui.stop();
            const options = [...checkpoints].reverse().map((checkpoint) => ({
              value: checkpoint.id,
              label: `${checkpoint.id} — ${checkpoint.files.join(", ")} — ${new Date(checkpoint.timestamp).toLocaleString()}`,
            }));
            options.push({ value: "cancel", label: isZh ? "取消" : "Cancel" });
            target =
              (await Prompt.askSelect(
                isZh
                  ? "选择要回退到的检查点："
                  : "Select a checkpoint to rewind to:",
                options,
              )) || "cancel";
            if (wasActive) tui.start(config.budgetLimit);
          }
          if (target === "cancel") continue;
          const index = Number(target);
          if (
            Number.isInteger(index) &&
            index >= 1 &&
            index <= checkpoints.length
          ) {
            target = checkpoints[index - 1].id;
          }
          await loop.rewindToCheckpoint(target);
          tui.syncFromLoop(loop);
          continue;
        }

        if (command === "/status") {
          const config = loop.getConfig();
          const provider = loop.getProvider();
          const activeModel = loop.getModelOverride() || config.models.default;
          const budgetLimit = config.budgetLimit;
          const currentCost = loop.getSessionCost();
          const mode = config.permissions.mode;

          const statusText = [
            picocolors.bold(picocolors.cyan("\n=== Orbit Session Status ===")),
            `  🆔 Session ID:   ${picocolors.green(loop.getSessionId())}`,
            `  🔌 Provider:     ${picocolors.green(provider.id)} (${provider.baseUrl || "Default URL"})`,
            `  🤖 Active Model:  ${picocolors.green(activeModel)}`,
            `  💰 Session Cost: $${currentCost.toFixed(4)} / $${budgetLimit.toFixed(2)} (Limit)`,
            `  🛡️ Security Mode: ${picocolors.green(mode.toUpperCase())}`,
            picocolors.cyan("============================\n"),
          ].join("\n");
          printOutput(statusText);
          continue;
        }

        if (command === "/config") {
          const configArg = parts.slice(1).join(" ").trim();
          const activeConfig = loop.getConfig();

          if (configArg) {
            const eqIndex = configArg.indexOf("=");
            if (eqIndex === -1) {
              printOutput(
                picocolors.yellow(
                  "Usage: /config <key>=<value> or just /config for interactive menu.",
                ),
              );
              continue;
            }
            const key = configArg.slice(0, eqIndex).trim();
            const rawVal = configArg.slice(eqIndex + 1).trim();

            const currentVal = getNestedProperty(activeConfig, key);
            if (currentVal === undefined) {
              printOutput(
                picocolors.red(`Error: Unknown configuration key "${key}".`),
              );
              continue;
            }

            let parsedVal: any = rawVal;
            if (typeof currentVal === "boolean") {
              const lowerVal = rawVal.toLowerCase();
              if (lowerVal === "true" || lowerVal === "1") parsedVal = true;
              else if (lowerVal === "false" || lowerVal === "0")
                parsedVal = false;
              else {
                printOutput(
                  picocolors.red(
                    `Error: Key "${key}" expects a boolean value (true/false).`,
                  ),
                );
                continue;
              }
            } else if (typeof currentVal === "number") {
              const num = Number(rawVal);
              if (isNaN(num)) {
                printOutput(
                  picocolors.red(
                    `Error: Key "${key}" expects a numeric value.`,
                  ),
                );
                continue;
              }
              parsedVal = num;
            } else if (Array.isArray(currentVal)) {
              parsedVal = rawVal
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean);
            }

            const testConfig = JSON.parse(JSON.stringify(activeConfig));
            setNestedProperty(testConfig, key, parsedVal);

            const parseResult = ConfigSchema.safeParse(testConfig);
            if (!parseResult.success) {
              printOutput(
                picocolors.red(
                  `Configuration validation failed: ${parseResult.error.message}`,
                ),
              );
              continue;
            }

            setNestedProperty(activeConfig, key, parsedVal);
            printOutput(
              picocolors.green(`✔ Updated "${key}" to: ${parsedVal}`),
            );
            continue;
          }

          const wasActive = useFullscreenTui && tui.isActive;
          if (wasActive) tui.stop();
          try {
            while (true) {
              const currentMode = activeConfig.permissions.mode;
              const currentBudget = activeConfig.budgetLimit;
              const currentAllowRead = activeConfig.permissions.allowRead;
              const currentApprovalWrite =
                activeConfig.permissions.requireApprovalForWrite;
              const currentApprovalBash =
                activeConfig.permissions.requireApprovalForBash;
              const currentBlockDangerous =
                activeConfig.permissions.blockDangerousCommands;
              const currentProtectSecrets =
                activeConfig.permissions.protectSecrets;
              const currentBashEnabled = activeConfig.tools.bash.enabled;
              const currentSearchEnabled = activeConfig.tools.webSearch.enabled;
              const currentMcpEnabled = activeConfig.tools.mcp.enabled;
              const currentEditor = activeConfig.editor;
              const currentAutoCommit = activeConfig.autoCommit;
              const currentProtectedPaths =
                activeConfig.permissions.protectedPaths;
              const currentIgnore = activeConfig.context.ignore;

              const choice = await Prompt.askSelect(
                "Select a configuration key to modify:",
                [
                  {
                    value: "permissions.mode",
                    label: `🛡️  permissions.mode (current: ${currentMode})`,
                  },
                  {
                    value: "budgetLimit",
                    label: `💰 budgetLimit (current: $${currentBudget})`,
                  },
                  {
                    value: "permissions.allowRead",
                    label: `📄 permissions.allowRead (current: ${currentAllowRead})`,
                  },
                  {
                    value: "permissions.requireApprovalForWrite",
                    label: `✏️  permissions.requireApprovalForWrite (current: ${currentApprovalWrite})`,
                  },
                  {
                    value: "permissions.requireApprovalForBash",
                    label: `🐚 permissions.requireApprovalForBash (current: ${currentApprovalBash})`,
                  },
                  {
                    value: "permissions.blockDangerousCommands",
                    label: `🚫 permissions.blockDangerousCommands (current: ${currentBlockDangerous})`,
                  },
                  {
                    value: "permissions.protectSecrets",
                    label: `🔑 permissions.protectSecrets (current: ${currentProtectSecrets})`,
                  },
                  {
                    value: "tools.bash.enabled",
                    label: `💻 tools.bash.enabled (current: ${currentBashEnabled})`,
                  },
                  {
                    value: "tools.webSearch.enabled",
                    label: `🌐 tools.webSearch.enabled (current: ${currentSearchEnabled})`,
                  },
                  {
                    value: "tools.mcp.enabled",
                    label: `🔌 tools.mcp.enabled (current: ${currentMcpEnabled})`,
                  },
                  {
                    value: "permissions.protectedPaths",
                    label: `🔒 permissions.protectedPaths (current: ${currentProtectedPaths.join(", ")})`,
                  },
                  {
                    value: "context.ignore",
                    label: `🗂️  context.ignore (current: ${currentIgnore.join(", ")})`,
                  },
                  {
                    value: "editor",
                    label: `📝 editor (current: ${currentEditor})`,
                  },
                  {
                    value: "autoCommit",
                    label: `🚀 autoCommit (current: ${currentAutoCommit})`,
                  },
                  { value: "exit", label: "❌ Exit Menu" },
                ],
              );

              if (choice === null || choice === "exit" || choice === "") {
                break;
              }

              const currentVal = getNestedProperty(activeConfig, choice);
              if (typeof currentVal === "boolean") {
                const nextVal = await Prompt.askSelect(`Set ${choice} to:`, [
                  { value: "true", label: "true" },
                  { value: "false", label: "false" },
                ]);
                if (nextVal !== null && nextVal !== "") {
                  const boolVal = nextVal === "true";
                  const testConfig = JSON.parse(JSON.stringify(activeConfig));
                  setNestedProperty(testConfig, choice, boolVal);
                  const parseResult = ConfigSchema.safeParse(testConfig);
                  if (parseResult.success) {
                    setNestedProperty(activeConfig, choice, boolVal);
                    console.log(
                      picocolors.green(`✔ Updated "${choice}" to: ${boolVal}`),
                    );
                  } else {
                    console.log(
                      picocolors.red(
                        `Validation error: ${parseResult.error.message}`,
                      ),
                    );
                  }
                }
              } else if (choice === "permissions.mode") {
                const nextVal = await Prompt.askSelect(
                  "Set permissions.mode to:",
                  [
                    {
                      value: "strict",
                      label:
                        "strict (High security, ask for write/exec, block dangerous)",
                    },
                    {
                      value: "normal",
                      label: "normal (Standard safety, ask for all write/exec)",
                    },
                    {
                      value: "auto",
                      label:
                        "auto (Allow write/exec automatically, block dangerous)",
                    },
                    {
                      value: "plan",
                      label: "plan (Interactive planning mode - read-only)",
                    },
                  ],
                );
                if (nextVal !== null && nextVal !== "") {
                  const testConfig = JSON.parse(JSON.stringify(activeConfig));
                  setNestedProperty(testConfig, choice, nextVal);
                  const parseResult = ConfigSchema.safeParse(testConfig);
                  if (parseResult.success) {
                    setNestedProperty(activeConfig, choice, nextVal);
                    console.log(
                      picocolors.green(`✔ Updated "${choice}" to: ${nextVal}`),
                    );
                  } else {
                    console.log(
                      picocolors.red(
                        `Validation error: ${parseResult.error.message}`,
                      ),
                    );
                  }
                }
              } else if (choice === "budgetLimit") {
                const nextValStr = await Prompt.askText(
                  `Enter new budget limit (number):`,
                  String(currentVal),
                );
                if (nextValStr !== null && nextValStr !== "") {
                  const numVal = Number(nextValStr);
                  if (isNaN(numVal)) {
                    console.log(
                      picocolors.red(
                        "Error: budgetLimit must be a valid number.",
                      ),
                    );
                  } else {
                    const testConfig = JSON.parse(JSON.stringify(activeConfig));
                    setNestedProperty(testConfig, choice, numVal);
                    const parseResult = ConfigSchema.safeParse(testConfig);
                    if (parseResult.success) {
                      setNestedProperty(activeConfig, choice, numVal);
                      console.log(
                        picocolors.green(`✔ Updated "${choice}" to: ${numVal}`),
                      );
                    } else {
                      console.log(
                        picocolors.red(
                          `Validation error: ${parseResult.error.message}`,
                        ),
                      );
                    }
                  }
                }
              } else if (Array.isArray(currentVal)) {
                const nextValStr = await Prompt.askText(
                  `Enter comma-separated values for ${choice}:`,
                  currentVal.join(", "),
                );
                if (nextValStr !== null && nextValStr !== "") {
                  const arrVal = nextValStr
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean);
                  const testConfig = JSON.parse(JSON.stringify(activeConfig));
                  setNestedProperty(testConfig, choice, arrVal);
                  const parseResult = ConfigSchema.safeParse(testConfig);
                  if (parseResult.success) {
                    setNestedProperty(activeConfig, choice, arrVal);
                    console.log(
                      picocolors.green(
                        `✔ Updated "${choice}" to: [${arrVal.join(", ")}]`,
                      ),
                    );
                  } else {
                    console.log(
                      picocolors.red(
                        `Validation error: ${parseResult.error.message}`,
                      ),
                    );
                  }
                }
              } else if (
                typeof currentVal === "string" &&
                choice !== "permissions.mode"
              ) {
                const nextValStr = await Prompt.askText(
                  `Enter value for ${choice}:`,
                  String(currentVal),
                );
                if (nextValStr !== null && nextValStr !== "") {
                  const testConfig = JSON.parse(JSON.stringify(activeConfig));
                  setNestedProperty(testConfig, choice, nextValStr);
                  const parseResult = ConfigSchema.safeParse(testConfig);
                  if (parseResult.success) {
                    setNestedProperty(activeConfig, choice, nextValStr);
                    console.log(
                      picocolors.green(
                        `✔ Updated "${choice}" to: ${nextValStr}`,
                      ),
                    );
                  } else {
                    console.log(
                      picocolors.red(
                        `Validation error: ${parseResult.error.message}`,
                      ),
                    );
                  }
                }
              }
            }
          } finally {
            if (wasActive && !tui.isActive) {
              tui.start(config.budgetLimit);
            }
          }
          continue;
        }

        if (command === "/model") {
          const modelArg = parts.slice(1).join(" ").trim();
          const config = loop.getConfig();
          const isZh = config.language === "zh";
          if (!modelArg) {
            const wasActive = useFullscreenTui && tui.isActive;
            if (wasActive) tui.stop();
            try {
              const activeModel =
                loop.getModelOverride() || config.models.default;
              let modelOptions: Array<{ value: string; label: string }> = [];
              const providerId = providerInstance.id;

              if (providerId === "anthropic") {
                modelOptions = [
                  {
                    value: "claude-3-5-sonnet-latest",
                    label:
                      "claude-3-5-sonnet-latest (Claude 3.5 Sonnet - Recommended)",
                  },
                  {
                    value: "claude-3-5-haiku-latest",
                    label: "claude-3-5-haiku-latest (Claude 3.5 Haiku)",
                  },
                  {
                    value: "claude-3-opus-latest",
                    label: "claude-3-opus-latest (Claude 3 Opus)",
                  },
                ];
              } else if (providerId === "openai") {
                modelOptions = [
                  { value: "gpt-4o", label: "gpt-4o (GPT-4o - Recommended)" },
                  { value: "gpt-4o-mini", label: "gpt-4o-mini (GPT-4o mini)" },
                  { value: "o1", label: "o1 (o1 Reasoner)" },
                  {
                    value: "o3-mini",
                    label: "o3-mini (o3-mini Fast Reasoner)",
                  },
                ];
              } else if (
                providerId === "deepseek-openai" ||
                providerId === "deepseek-anthropic"
              ) {
                modelOptions = [
                  {
                    value: "deepseek-v4-flash",
                    label:
                      "deepseek-v4-flash (DeepSeek-V4 / Fast & Flash - Recommended)",
                  },
                  {
                    value: "deepseek-v4-pro",
                    label: "deepseek-v4-pro (DeepSeek-V4 / Advanced & Pro)",
                  },
                  {
                    value: "deepseek-chat",
                    label: "deepseek-chat (DeepSeek-V3 / Chat)",
                  },
                  {
                    value: "deepseek-reasoner",
                    label: "deepseek-reasoner (DeepSeek-R1 / Reasoner)",
                  },
                ];
              } else if (providerId === "ollama") {
                modelOptions = [
                  { value: "qwen2.5-coder:7b", label: "qwen2.5-coder:7b" },
                  { value: "qwen2.5-coder:1.5b", label: "qwen2.5-coder:1.5b" },
                  { value: "llama3", label: "llama3" },
                ];
              } else {
                modelOptions = [
                  {
                    value: "deepseek-v4-flash",
                    label: "deepseek-v4-flash (DeepSeek-V4 / Fast & Flash)",
                  },
                  {
                    value: "deepseek-v4-pro",
                    label: "deepseek-v4-pro (DeepSeek-V4 / Advanced & Pro)",
                  },
                  { value: "gpt-4o", label: "gpt-4o (GPT-4o)" },
                  {
                    value: "claude-3-5-sonnet-latest",
                    label: "claude-3-5-sonnet-latest (Claude 3.5 Sonnet)",
                  },
                ];
              }

              modelOptions.push({
                value: "custom",
                label: "Custom model name...",
              });
              modelOptions.push({ value: "cancel", label: "Cancel" });

              const selectedModel = await Prompt.askSelect(
                `Current model: ${activeModel}. Select a model to switch:`,
                modelOptions,
              );
              if (!selectedModel || selectedModel === "cancel") {
                continue;
              }
              let finalModel = selectedModel;
              if (selectedModel === "custom") {
                const customModel = await Prompt.askText(
                  "Enter custom model name:",
                );
                if (customModel) {
                  finalModel = customModel;
                  loop.setModelOverride(customModel);
                  if (wasActive && !tui.isActive) {
                    tui.start(config.budgetLimit);
                  }
                  printOutput(
                    `Switched active model to: ${picocolors.green(customModel)}`,
                  );
                } else {
                  continue;
                }
              } else {
                loop.setModelOverride(selectedModel);
                if (wasActive && !tui.isActive) {
                  tui.start(config.budgetLimit);
                }
                printOutput(
                  `Switched active model to: ${picocolors.green(selectedModel)}`,
                );
              }
              saveLocalState(cwd, { lastModel: finalModel });
            } finally {
              if (wasActive && !tui.isActive) {
                tui.start(config.budgetLimit);
              }
            }
            continue;
          }

          loop.setModelOverride(modelArg);
          printOutput(
            `Switched active model to: ${picocolors.green(modelArg)}`,
          );
          saveLocalState(cwd, { lastModel: modelArg });
          continue;
        }

        if (command === "/commit") {
          const commitMsg = parts.slice(1).join(" ").trim();
          const config = loop.getConfig();
          const isZh = config.language === "zh";
          const { execSync } = await import("child_process");
          try {
            let diff = execSync("git diff --cached", { cwd }).toString().trim();
            if (!diff) {
              const unstaged = execSync("git status --porcelain", { cwd })
                .toString()
                .trim();
              if (!unstaged) {
                console.log(
                  picocolors.yellow(
                    isZh
                      ? "工作区干净，没有检测到任何已暂存或未暂存的更改。"
                      : "Workspace clean. No staged or unstaged changes found to commit.",
                  ),
                );
                continue;
              }

              const wasActive = useFullscreenTui && tui.isActive;
              if (wasActive) tui.stop();

              const autoStage = await Prompt.askApproval(
                isZh
                  ? "未检测到已暂存的修改，是否自动暂存工作区中的所有变更并生成提交？"
                  : "No staged changes found. Automatically stage all local changes and create a commit?",
              );

              if (wasActive) tui.start(config.budgetLimit);

              if (!autoStage) {
                console.log(
                  picocolors.yellow(
                    isZh
                      ? "操作已取消。请先运行 'git add' 暂存你的修改。"
                      : "Operation cancelled. Please run 'git add' to stage your changes first.",
                  ),
                );
                continue;
              }

              console.log(
                isZh ? "正在暂存所有变更..." : "Staging all changes...",
              );
              execSync("git add -A", { cwd });
              diff = execSync("git diff --cached", { cwd }).toString().trim();
              if (!diff) {
                console.log(
                  picocolors.red(
                    isZh
                      ? "✖ 暂存失败或暂存后仍无变更。"
                      : "✖ Staging failed or resulted in no diff.",
                  ),
                );
                continue;
              }
            }

            let finalMsg = commitMsg;
            if (!finalMsg) {
              console.log("Generating commit message via LLM...");
              const fastModel = config.models.fast || config.models.default;
              const stream = providerInstance.chat({
                model: fastModel,
                messages: [
                  {
                    id: `msg_commit_cmd_${Date.now()}`,
                    role: "user",
                    createdAt: new Date().toISOString(),
                    content: [
                      {
                        type: "text",
                        text: `Generate a concise, high-quality conventional git commit message (e.g. feat(cli): add autocomplete) for the following git diff. Output ONLY the commit message, no formatting, no markdown, no quotes, just the text:\n\n${diff.substring(0, 20000)}`,
                      },
                    ],
                  },
                ],
                tools: [],
              });

              let generatedMessage = "";
              for await (const event of stream) {
                if (event.type === "text_delta") {
                  generatedMessage += event.text;
                }
              }
              finalMsg = generatedMessage.trim().replace(/^["']|["']$/g, "");
              if (!finalMsg) {
                finalMsg = "chore: auto-commit";
              }
            }

            console.log(
              `Committing changes with message: "${picocolors.green(finalMsg)}"`,
            );
            const commitCmd = `git commit -m ${JSON.stringify(finalMsg)}`;
            execSync(commitCmd, { cwd });
            console.log(picocolors.green("✔ Git commit created successfully."));
          } catch (err: any) {
            console.log(picocolors.red(`✖ Commit failed: ${err.message}`));
          }
          continue;
        }

        if (command === "/diff") {
          try {
            const { execSync } = await import("child_process");
            const diffOutput = execSync("git diff --color", {
              cwd,
              stdio: ["ignore", "pipe", "ignore"],
            }).toString();
            if (!diffOutput.trim()) {
              const isZh = config.language === "zh";
              console.log(
                isZh
                  ? picocolors.yellow("\n工作区未检测到任何代码变更。")
                  : picocolors.yellow("\nNo changes detected in workspace."),
              );
            } else {
              const wasActive = useFullscreenTui && tui.isActive;
              if (wasActive) tui.stop();

              await pageText(diffOutput);

              if (wasActive) tui.start(config.budgetLimit);
            }
          } catch (err: any) {
            const isZh = config.language === "zh";
            console.log(
              isZh
                ? picocolors.red(`生成 Git 差异比对失败: ${err.message}`)
                : picocolors.red(`Failed to generate git diff: ${err.message}`),
            );
          }
          continue;
        }

        if (command === "/test") {
          let testCmd = "";
          const projectIndex = (loop as any).cachedContextPack?.projectIndex;
          if (
            projectIndex?.testCommands &&
            projectIndex.testCommands.length > 0
          ) {
            testCmd = projectIndex.testCommands[0];
          }

          if (!testCmd) {
            const pkgPath = join(cwd, "package.json");
            if (existsSync(pkgPath)) {
              try {
                const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
                if (
                  pkg.scripts &&
                  pkg.scripts.test &&
                  pkg.scripts.test !==
                    'echo "Error: no test specified" && exit 1'
                ) {
                  testCmd = "npm test";
                }
              } catch {}
            }
          }

          if (!testCmd) {
            testCmd = "npm test";
          }

          const isZh = config.language === "zh";
          console.log(
            isZh
              ? picocolors.cyan(`\n正在执行单元测试，指令: ${testCmd}...`)
              : picocolors.cyan(`\nRunning tests via: ${testCmd}...`),
          );
          try {
            const { spawn } = await import("child_process");
            const wasActive = useFullscreenTui && tui.isActive;
            if (wasActive) tui.stop();

            await new Promise<void>((resolve) => {
              const parts = testCmd.split(/\s+/);
              const child = spawn(parts[0], parts.slice(1), {
                cwd,
                stdio: "inherit",
                shell: true,
              });
              child.on("close", (code) => {
                if (code === 0) {
                  console.log(
                    isZh
                      ? picocolors.green(`\n✔ 测试顺利通过。`)
                      : picocolors.green(`\n✔ Tests completed successfully.`),
                  );
                } else {
                  console.log(
                    isZh
                      ? picocolors.red(`\n✖ 测试执行失败，退出代码: ${code}`)
                      : picocolors.red(
                          `\n✖ Tests failed with exit code ${code}`,
                        ),
                  );
                }
                resolve();
              });
              child.on("error", (err) => {
                console.log(
                  isZh
                    ? picocolors.red(`\n✖ 无法启动测试程序: ${err.message}`)
                    : picocolors.red(
                        `\n✖ Failed to start tests: ${err.message}`,
                      ),
                );
                resolve();
              });
            });

            if (wasActive) tui.start(config.budgetLimit);
          } catch (err: any) {
            console.log(
              isZh
                ? picocolors.red(`执行测试失败: ${err.message}`)
                : picocolors.red(`Failed to execute tests: ${err.message}`),
            );
          }
          continue;
        }

        if (command === "/add") {
          const fileArg = parts.slice(1).join(" ").trim();
          const isZh = config.language === "zh";
          if (!fileArg) {
            const wasActive = useFullscreenTui && tui.isActive;
            if (wasActive) tui.stop();

            try {
              if (
                !candidates ||
                !candidates.files ||
                candidates.files.length === 0
              ) {
                console.log(
                  isZh
                    ? picocolors.yellow("工作区未找到可添加的文件。")
                    : picocolors.yellow(
                        "No files found in the workspace to add.",
                      ),
                );
              } else {
                const filterQuery = await Prompt.askText(
                  isZh
                    ? "输入文件名过滤词（支持模糊匹配，直接回车列出所有）："
                    : "Enter filename filter query (fuzzy, press Enter for all):",
                );

                if (filterQuery === null) {
                  console.log(
                    isZh
                      ? picocolors.yellow("操作已取消。")
                      : picocolors.yellow("Operation cancelled."),
                  );
                  continue;
                }

                let filtered = candidates.files;
                if (filterQuery.trim()) {
                  const q = filterQuery.trim().toLowerCase();
                  filtered = candidates.files.filter((f) =>
                    f.toLowerCase().includes(q),
                  );
                }

                if (filtered.length === 0) {
                  console.log(
                    isZh
                      ? picocolors.yellow("未找到匹配过滤词的文件。")
                      : picocolors.yellow("No matching files found."),
                  );
                } else {
                  const options = filtered.map((f) => ({ value: f, label: f }));
                  const selected = await Prompt.askMultiSelect(
                    isZh
                      ? "选择要添加到上下文的文件："
                      : "Select files to add to the context:",
                    options,
                  );
                  if (selected && selected.length > 0) {
                    for (const f of selected) {
                      loop.addRelevantFilePublic(
                        f,
                        "Manually added via interactive /add",
                      );
                    }
                    console.log(
                      isZh
                        ? picocolors.green(
                            `✔ 成功添加 ${selected.length} 个文件到上下文。`,
                          )
                        : picocolors.green(
                            `✔ Added ${selected.length} file(s) to active context.`,
                          ),
                    );
                  } else {
                    console.log(
                      isZh
                        ? picocolors.yellow("未选择任何文件。")
                        : picocolors.yellow("No files selected."),
                    );
                  }
                }
              }
            } catch (err: any) {
              console.log(
                isZh
                  ? picocolors.red(`选择文件失败: ${err.message}`)
                  : picocolors.red(`Failed to select files: ${err.message}`),
              );
            } finally {
              tui.syncFromLoop(loop);
              if (wasActive) tui.start(config.budgetLimit);
            }
            continue;
          }

          const { isAbsolute, relative, resolve } = await import("path");
          const { statSync } = await import("fs");
          const absPath = isAbsolute(fileArg) ? fileArg : resolve(cwd, fileArg);
          const relPath = relative(cwd, absPath).replace(/\\/g, "/");

          if (!existsSync(absPath)) {
            const matched = (candidates?.files || []).filter(
              (f) =>
                f.toLowerCase().includes(fileArg.toLowerCase()) ||
                f.toLowerCase().endsWith("/" + fileArg.toLowerCase()),
            );
            if (matched.length === 1) {
              loop.addRelevantFilePublic(matched[0], "Fuzzy matched via /add");
              console.log(
                isZh
                  ? picocolors.green(`✔ 自动匹配并添加文件: ${matched[0]}`)
                  : picocolors.green(
                      `✔ Auto-matched and added file: ${matched[0]}`,
                    ),
              );
              tui.syncFromLoop(loop);
              continue;
            } else if (matched.length > 1) {
              console.log(
                isZh
                  ? picocolors.yellow(
                      `找到多个匹配文件，请精确输入路径或使用无参交互选择:\n${matched.map((m) => `  • ${m}`).join("\n")}`,
                    )
                  : picocolors.yellow(
                      `Multiple matches found, please specify or use interactive select:\n${matched.map((m) => `  • ${m}`).join("\n")}`,
                    ),
              );
              continue;
            }
            console.log(
              isZh
                ? picocolors.red(`文件不存在: ${fileArg}`)
                : picocolors.red(`File does not exist: ${fileArg}`),
            );
            continue;
          }

          try {
            const stat = statSync(absPath);
            if (stat.isDirectory()) {
              const files = await glob("**/*", {
                cwd: absPath,
                onlyFiles: true,
                suppressErrors: true,
              });
              for (const f of files) {
                const subRelPath = join(relPath, f).replace(/\\/g, "/");
                loop.addRelevantFilePublic(
                  subRelPath,
                  "Manually added directory via /add",
                );
              }
              console.log(
                isZh
                  ? picocolors.green(
                      `✔ 成功添加目录 ${relPath} 下的所有文件到上下文。`,
                    )
                  : picocolors.green(
                      `✔ Added all files in directory ${relPath} to active context.`,
                    ),
              );
            } else {
              loop.addRelevantFilePublic(
                relPath,
                "Manually added file via /add",
              );
              console.log(
                isZh
                  ? picocolors.green(`✔ 已将 ${relPath} 添加到上下文。`)
                  : picocolors.green(`✔ Added ${relPath} to active context.`),
              );
            }
            tui.syncFromLoop(loop);
          } catch (err: any) {
            console.log(
              isZh
                ? picocolors.red(`添加失败: ${err.message}`)
                : picocolors.red(`Failed to add: ${err.message}`),
            );
          }
          continue;
        }

        if (command === "/read-only" || command === "/readonly") {
          const fileArg = parts.slice(1).join(" ").trim();
          const isZh = config.language === "zh";
          if (!fileArg) {
            const wasActive = useFullscreenTui && tui.isActive;
            if (wasActive) tui.stop();

            try {
              if (
                !candidates ||
                !candidates.files ||
                candidates.files.length === 0
              ) {
                console.log(
                  isZh
                    ? picocolors.yellow("工作区未找到可添加的文件。")
                    : picocolors.yellow(
                        "No files found in the workspace to add.",
                      ),
                );
              } else {
                const filterQuery = await Prompt.askText(
                  isZh
                    ? "输入文件名过滤词（支持模糊匹配，直接回车列出所有）："
                    : "Enter filename filter query (fuzzy, press Enter for all):",
                );

                if (filterQuery === null) {
                  console.log(
                    isZh
                      ? picocolors.yellow("操作已取消。")
                      : picocolors.yellow("Operation cancelled."),
                  );
                  continue;
                }

                let filtered = candidates.files;
                if (filterQuery.trim()) {
                  const q = filterQuery.trim().toLowerCase();
                  filtered = candidates.files.filter((f) =>
                    f.toLowerCase().includes(q),
                  );
                }

                if (filtered.length === 0) {
                  console.log(
                    isZh
                      ? picocolors.yellow("未找到匹配过滤词的文件。")
                      : picocolors.yellow("No matching files found."),
                  );
                } else {
                  const options = filtered.map((f) => ({ value: f, label: f }));
                  const selected = await Prompt.askMultiSelect(
                    isZh
                      ? "选择要添加到上下文的只读参考文件："
                      : "Select files to add as read-only reference context:",
                    options,
                  );
                  if (selected && selected.length > 0) {
                    for (const f of selected) {
                      loop.addReadOnlyFilePublic(
                        f,
                        "Manually added via interactive /read-only",
                      );
                    }
                    console.log(
                      isZh
                        ? picocolors.green(
                            `✔ 成功添加 ${selected.length} 个只读文件到上下文。`,
                          )
                        : picocolors.green(
                            `✔ Added ${selected.length} read-only file(s) to active context.`,
                          ),
                    );
                  } else {
                    console.log(
                      isZh
                        ? picocolors.yellow("未选择任何文件。")
                        : picocolors.yellow("No files selected."),
                    );
                  }
                }
              }
            } catch (err: any) {
              console.log(
                isZh
                  ? picocolors.red(`选择文件失败: ${err.message}`)
                  : picocolors.red(`Failed to select files: ${err.message}`),
              );
            } finally {
              tui.syncFromLoop(loop);
              if (wasActive) tui.start(config.budgetLimit);
            }
            continue;
          }

          const { isAbsolute, relative, resolve } = await import("path");
          const { statSync } = await import("fs");
          const absPath = isAbsolute(fileArg) ? fileArg : resolve(cwd, fileArg);
          const relPath = relative(cwd, absPath).replace(/\\/g, "/");

          if (!existsSync(absPath)) {
            const matched = (candidates?.files || []).filter(
              (f) =>
                f.toLowerCase().includes(fileArg.toLowerCase()) ||
                f.toLowerCase().endsWith("/" + fileArg.toLowerCase()),
            );
            if (matched.length === 1) {
              loop.addReadOnlyFilePublic(
                matched[0],
                "Fuzzy matched via /read-only",
              );
              console.log(
                isZh
                  ? picocolors.green(
                      `✔ 自动匹配并添加只读参考文件: ${matched[0]}`,
                    )
                  : picocolors.green(
                      `✔ Auto-matched and added read-only reference: ${matched[0]}`,
                    ),
              );
              tui.syncFromLoop(loop);
              continue;
            } else if (matched.length > 1) {
              console.log(
                isZh
                  ? picocolors.yellow(
                      `找到多个匹配文件，请精确输入路径或使用无参交互选择:\n${matched.map((m) => `  • ${m}`).join("\n")}`,
                    )
                  : picocolors.yellow(
                      `Multiple matches found, please specify or use interactive select:\n${matched.map((m) => `  • ${m}`).join("\n")}`,
                    ),
              );
              continue;
            }
            console.log(
              isZh
                ? picocolors.red(`文件不存在: ${fileArg}`)
                : picocolors.red(`File does not exist: ${fileArg}`),
            );
            continue;
          }

          try {
            const stat = statSync(absPath);
            if (stat.isDirectory()) {
              const files = await glob("**/*", {
                cwd: absPath,
                onlyFiles: true,
                suppressErrors: true,
              });
              for (const f of files) {
                const subRelPath = join(relPath, f).replace(/\\/g, "/");
                loop.addReadOnlyFilePublic(
                  subRelPath,
                  "Manually added directory via /read-only",
                );
              }
              console.log(
                isZh
                  ? picocolors.green(
                      `✔ 成功添加目录 ${relPath} 下的所有只读文件。`,
                    )
                  : picocolors.green(
                      `✔ Added all files in directory ${relPath} as read-only references.`,
                    ),
              );
            } else {
              loop.addReadOnlyFilePublic(
                relPath,
                "Manually added file via /read-only",
              );
              console.log(
                isZh
                  ? picocolors.green(`✔ 已将只读文件 ${relPath} 添加到上下文。`)
                  : picocolors.green(
                      `✔ Added read-only reference ${relPath} to active context.`,
                    ),
              );
            }
            tui.syncFromLoop(loop);
          } catch (err: any) {
            console.log(
              isZh
                ? picocolors.red(`添加失败: ${err.message}`)
                : picocolors.red(`Failed to add: ${err.message}`),
            );
          }
          continue;
        }

        if (command === "/drop") {
          const fileArg = parts.slice(1).join(" ").trim();
          const isZh = config.language === "zh";
          if (!fileArg) {
            const wasActive = useFullscreenTui && tui.isActive;
            if (wasActive) tui.stop();

            try {
              const activeFiles = loop.getRelevantFiles();
              if (activeFiles.length === 0) {
                console.log(
                  isZh
                    ? picocolors.yellow("当前活动上下文为空，无可移除的文件。")
                    : picocolors.yellow(
                        "Active context is empty, no files to remove.",
                      ),
                );
              } else {
                const options = activeFiles.map((f) => ({
                  value: f.path,
                  label: f.path,
                }));
                const selected = await Prompt.askMultiSelect(
                  isZh
                    ? "选择要从上下文中移除的文件："
                    : "Select files to remove from the context:",
                  options,
                );
                if (selected && selected.length > 0) {
                  for (const f of selected) {
                    loop.removeRelevantFilePublic(f);
                  }
                  console.log(
                    isZh
                      ? picocolors.green(
                          `✔ 成功从上下文中移除 ${selected.length} 个文件。`,
                        )
                      : picocolors.green(
                          `✔ Removed ${selected.length} file(s) from active context.`,
                        ),
                  );
                } else {
                  console.log(
                    isZh
                      ? picocolors.yellow("未选择任何文件。")
                      : picocolors.yellow("No files selected."),
                  );
                }
              }
            } catch (err: any) {
              console.log(
                isZh
                  ? picocolors.red(`移除文件失败: ${err.message}`)
                  : picocolors.red(`Failed to remove files: ${err.message}`),
              );
            } finally {
              tui.syncFromLoop(loop);
              if (wasActive) tui.start(config.budgetLimit);
            }
            continue;
          }

          if (fileArg === "all" || fileArg === "*") {
            loop.clearRelevantFilesPublic();
            tui.syncFromLoop(loop);
            console.log(
              isZh
                ? picocolors.green(`✔ 已从上下文中清空所有文件。`)
                : picocolors.green(`✔ Cleared all files from active context.`),
            );
            continue;
          }

          const { isAbsolute, relative, resolve } = await import("path");
          const absPath = isAbsolute(fileArg) ? fileArg : resolve(cwd, fileArg);
          const relPath = relative(cwd, absPath).replace(/\\/g, "/");

          const beforeCount = loop.getRelevantFiles().length;
          loop.removeRelevantFilePublic(relPath);

          // Glob/regex fallback for dropping files by pattern
          const activeFiles = loop.getRelevantFiles().map((f) => f.path);
          const escaped = fileArg.replace(/[.+^${}()|[\]\\]/g, "\\$&");
          const globRegexStr = escaped.replace(/\*/g, ".*").replace(/\?/g, ".");
          const rx = new RegExp("^" + globRegexStr + "$", "i");

          for (const f of activeFiles) {
            if (rx.test(f) || f.startsWith(relPath)) {
              loop.removeRelevantFilePublic(f);
            }
          }

          tui.syncFromLoop(loop);
          const afterCount = loop.getRelevantFiles().length;
          const droppedCount = beforeCount - afterCount;
          if (droppedCount > 0) {
            console.log(
              isZh
                ? picocolors.green(
                    `✔ 从上下文中成功移除 ${droppedCount} 个文件。`,
                  )
                : picocolors.green(
                    `✔ Removed ${droppedCount} file(s) from active context.`,
                  ),
            );
          } else {
            console.log(
              isZh
                ? picocolors.yellow(`上下文中未找到匹配 "${fileArg}" 的文件。`)
                : picocolors.yellow(
                    `No files matching "${fileArg}" were found in active context.`,
                  ),
            );
          }
          continue;
        }

        if (command === "/context") {
          const files = loop.getRelevantFiles();
          const isZh = config.language === "zh";
          if (files.length === 0) {
            console.log(
              isZh
                ? picocolors.yellow(
                    "当前活动上下文为空。可使用 /add <file> 添加文件。",
                  )
                : picocolors.yellow(
                    "No files in the active context. Use /add <file> to add files.",
                  ),
            );
          } else {
            console.log(
              isZh
                ? picocolors.bold(
                    picocolors.cyan("\n--- 当前活动上下文文件 ---"),
                  )
                : picocolors.bold(
                    picocolors.cyan("\n--- Active Context Files ---"),
                  ),
            );

            let totalEstimatedTokens = 0;
            const fileTokensList: {
              path: string;
              reason: string;
              tokens: number;
              sizeBytes: number;
              readOnly?: boolean;
            }[] = [];
            const fs = await import("fs");

            for (const f of files) {
              let tokens = 0;
              let sizeBytes = 0;
              try {
                const fullPath = resolveSafePath(cwd, f.path);
                if (fs.existsSync(fullPath)) {
                  const stat = fs.statSync(fullPath);
                  if (stat.isFile()) {
                    sizeBytes = stat.size;
                    const content = fs.readFileSync(fullPath, "utf8");
                    // Simple heuristic: 1 token ~ 4 characters
                    tokens = Math.ceil(content.length / 4);
                  }
                }
              } catch (err) {
                // Ignore file read issues
              }

              totalEstimatedTokens += tokens;
              fileTokensList.push({
                path: f.path,
                reason: f.reason,
                tokens,
                sizeBytes,
                readOnly: (f as any).readOnly,
              });
            }

            for (const f of fileTokensList) {
              const sizeStr =
                f.sizeBytes > 1024
                  ? `${(f.sizeBytes / 1024).toFixed(1)} KB`
                  : `${f.sizeBytes} B`;
              const roLabel = (f as any).readOnly
                ? picocolors.yellow(" [RO]")
                : "";
              console.log(
                `${picocolors.green("•")} ${picocolors.white(f.path)}${roLabel} ${picocolors.gray(`(${f.reason})`)} - ${picocolors.cyan(`~${f.tokens} tokens`)} (${sizeStr})`,
              );
            }

            // Visual Progress Bar (assuming 128k context budget for reference, or customize based on model)
            const contextBudget = 128000;
            const percentage = Math.min(
              100,
              Math.ceil((totalEstimatedTokens / contextBudget) * 100),
            );
            const barWidth = 30;
            const filledWidth = Math.ceil((percentage / 100) * barWidth);
            const emptyWidth = barWidth - filledWidth;
            const progressBar = `[${"█".repeat(filledWidth)}${"░".repeat(emptyWidth)}]`;

            console.log(
              isZh
                ? `\n📊 上下文容量使用率: ${picocolors.yellow(`${percentage}%`)} ${progressBar} (预估: ${totalEstimatedTokens} / ${contextBudget} tokens)`
                : `\n📊 Context Utilization: ${picocolors.yellow(`${percentage}%`)} ${progressBar} (Estimated: ${totalEstimatedTokens} / ${contextBudget} tokens)`,
            );

            // Warnings / Suggestions
            const largeFiles = fileTokensList.filter(
              (f) => f.sizeBytes > 50 * 1024,
            );
            if (largeFiles.length > 0) {
              console.log(
                picocolors.yellow(
                  isZh ? "\n⚠️ 优化建议:" : "\n⚠️ Optimization Suggestions:",
                ),
              );
              for (const f of largeFiles) {
                console.log(
                  isZh
                    ? `  - 文件 ${picocolors.red(f.path)} 体积过大 (>${(f.sizeBytes / 1024).toFixed(1)} KB)，可能会占用大量 Prompt Token，建议使用 /drop 移除或只添加相关部分。`
                    : `  - File ${picocolors.red(f.path)} is abnormally large (>${(f.sizeBytes / 1024).toFixed(1)} KB), which may exhaust prompt tokens. Consider using /drop to remove it.`,
                );
              }
            }
            console.log("");
          }
          continue;
        }

        if (command === "/clear") {
          console.clear();
          continue;
        }

        if (command === "/compact") {
          console.log("Compacting history...");
          const history = loop.getHistory();
          if (history.length > 12) {
            const systemMsg = history[0];
            let partitionIdx = history.length - 10;
            while (partitionIdx > 1) {
              const msg = history[partitionIdx];
              if (msg.role === "tool") {
                partitionIdx--;
                continue;
              }
              const prevMsg = history[partitionIdx - 1];
              const hasToolCalls = prevMsg.content.some(
                (c: any) => c.type === "tool_call",
              );
              if (prevMsg.role === "assistant" && hasToolCalls) {
                partitionIdx--;
                continue;
              }
              break;
            }
            const discarded = history.slice(1, partitionIdx);
            const recentMsgs = history.slice(partitionIdx);

            let rawText = "";
            for (const msg of discarded) {
              rawText +=
                `[${msg.role.toUpperCase()}]: ` +
                msg.content
                  .map((c) => {
                    if (c.type === "text") return c.text;
                    if (c.type === "tool_call")
                      return `[Tool Call: ${c.toolCall?.name}]`;
                    if (c.type === "tool_result")
                      return `[Tool Result: ${c.toolResult?.name}]`;
                    return "";
                  })
                  .join(" ") +
                "\n";
            }

            console.log("Generating session summary via LLM...");
            let summaryText = "Prior dialogue history compacted.";
            try {
              const fastModel = config.models.fast || config.models.default;
              const stream = providerInstance.chat({
                model: fastModel,
                messages: [
                  {
                    id: `msg_compact_${Date.now()}`,
                    role: "user",
                    createdAt: new Date().toISOString(),
                    content: [
                      {
                        type: "text",
                        text: `Summarize the following dialog history of an AI coding session in a brief, concise paragraph (max 150 words). Focus on what files were modified, what tasks were accomplished, and any critical developer rules established. Do not include introductory text, just the summary:\n\n${rawText.substring(0, 15000)}`,
                      },
                    ],
                  },
                ],
                tools: [],
              });

              let responseContent = "";
              for await (const event of stream) {
                if (event.type === "text_delta") {
                  responseContent += event.text;
                }
              }
              if (responseContent.trim()) {
                summaryText = responseContent.trim();
              }
            } catch (err: any) {
              console.log(
                picocolors.yellow(
                  `⚠ LLM compaction query failed: ${err.message}. Using default compaction.`,
                ),
              );
            }

            const summaryMsg = {
              id: `msg_summary_${Date.now()}`,
              role: "system",
              createdAt: new Date().toISOString(),
              content: [
                {
                  type: "text",
                  text: `Prior session history summary:\n${summaryText}`,
                },
              ],
            };

            history.length = 0;
            if (systemMsg) {
              history.push(systemMsg);
            }
            history.push(summaryMsg);
            history.push(...recentMsgs);
            (loop as any).sessionManager.saveHistory(history);

            console.log(
              picocolors.green(
                `✔ History compacted! Retained first system message, generated history summary, and last 10 messages. Total: ${history.length}`,
              ),
            );
          } else {
            console.log(picocolors.yellow("History is too short to compact."));
          }
          continue;
        }

        if (command === "/history") {
          const history = loop.getHistory();
          let fullHistoryText = picocolors.bold(
            picocolors.cyan(
              "\n=== Orbit Session Complete Dialogue History ===\n\n",
            ),
          );

          for (const msg of history) {
            if (msg.role === "user") {
              const text = msg.content
                .map((c) => (c.type === "text" ? c.text : ""))
                .join("");
              fullHistoryText += `${picocolors.cyan("orbit >")} ${picocolors.bold(picocolors.white(text))}\n\n`;
            } else if (msg.role === "assistant") {
              const text = msg.content
                .map((c) => {
                  if (c.type === "text") return c.text;
                  if (c.type === "tool_call")
                    return `[Tool Call: ${c.toolCall?.name} arguments: ${c.toolCall?.arguments}]`;
                  return "";
                })
                .join("\n");
              if (text.trim()) {
                fullHistoryText += Renderer.formatMarkdown(text) + "\n\n";
              }
            } else if (msg.role === "tool") {
              const text = msg.content
                .map((c) =>
                  c.type === "tool_result"
                    ? `[Tool Result: ${c.toolResult?.name} status: ${c.toolResult?.status || "success"}]`
                    : "",
                )
                .join("\n");
              if (text.trim()) {
                fullHistoryText += picocolors.dim(text) + "\n\n";
              }
            }
          }
          fullHistoryText += picocolors.cyan(
            "================================================\n",
          );

          const wasActive = useFullscreenTui;
          if (wasActive) tui.stop();
          await pageText(fullHistoryText);
          if (wasActive) tui.start(config.budgetLimit);
          continue;
        }

        if (command === "/inspect") {
          const indexPath = join(cwd, ".orbit", "symbols.json");
          if (!existsSync(indexPath)) {
            printOutput(
              picocolors.yellow(
                "No symbols index found. Please run a task first to generate the symbol map.",
              ),
            );
            continue;
          }

          try {
            const raw = readFileSync(indexPath, "utf8");
            const index = JSON.parse(raw);
            if (index.files && typeof index.files === "object") {
              const outlineLines: string[] = [];
              outlineLines.push(
                picocolors.bold(
                  picocolors.cyan(
                    "\n=== CodeWhale Codebase Visual Outline ===",
                  ),
                ),
              );

              let totalFiles = 0;
              let totalSymbols = 0;
              let tsFiles = 0;

              for (const [file, fileData] of Object.entries(index.files)) {
                totalFiles++;
                if (file.endsWith(".ts") || file.endsWith(".tsx")) {
                  tsFiles++;
                }
                const data = fileData as any;
                if (data && Array.isArray(data.symbols)) {
                  outlineLines.push(
                    `  📄 ${picocolors.bold(picocolors.blue(file))}`,
                  );
                  for (const sym of data.symbols) {
                    totalSymbols++;
                    const symbolColor =
                      sym.type === "class"
                        ? picocolors.magenta
                        : picocolors.green;
                    outlineLines.push(
                      `     • ${symbolColor(sym.name)} (${picocolors.gray(sym.type)})`,
                    );
                  }
                }
              }

              const tsRatio =
                totalFiles > 0
                  ? ((tsFiles / totalFiles) * 100).toFixed(1)
                  : "0.0";
              outlineLines.push(
                picocolors.gray("========================================="),
              );
              outlineLines.push(`  ${picocolors.bold("Codebase Stats:")}`);
              outlineLines.push(
                `    • Total Indexed Files: ${picocolors.green(totalFiles)}`,
              );
              outlineLines.push(
                `    • TypeScript Ratio   : ${picocolors.yellow(tsRatio + "%")}`,
              );
              outlineLines.push(
                `    • Exported Symbols   : ${picocolors.magenta(totalSymbols)}`,
              );
              outlineLines.push(
                picocolors.cyan("=========================================\n"),
              );

              const wasActive = useFullscreenTui;
              if (wasActive) tui.stop();
              await pageText(outlineLines.join("\n"));
              if (wasActive) tui.start(config.budgetLimit);
            }
          } catch (err: any) {
            printOutput(
              picocolors.red(`Failed to parse symbol index: ${err.message}`),
            );
          }
          continue;
        }

        if (command === "/doc") {
          const fileArg = parts.slice(1).join(" ").trim();
          if (!fileArg) {
            printOutput(picocolors.yellow("Usage: /doc <file_path>"));
            continue;
          }

          let targetFilePath: string;
          try {
            targetFilePath = resolveSafePath(cwd, fileArg);
          } catch (err: any) {
            printOutput(picocolors.red(`Error: ${err.message}`));
            continue;
          }
          if (!existsSync(targetFilePath)) {
            printOutput(picocolors.red(`Error: File not found: ${fileArg}`));
            continue;
          }

          printOutput(
            picocolors.cyan(
              `Generating documentation for ${fileArg} via LLM...`,
            ),
          );
          try {
            const content = readFileSync(targetFilePath, "utf8");
            const fastModel = config.models.fast || config.models.default;

            const stream = providerInstance.chat({
              model: fastModel,
              messages: [
                {
                  id: `msg_doc_${Date.now()}`,
                  role: "user",
                  createdAt: new Date().toISOString(),
                  content: [
                    {
                      type: "text",
                      text: `Analyze the following code file and add clean, professional TSDoc/JSDoc comments for all exported functions, classes, interfaces, and methods. Preserve all existing logic, code, and comments exactly. Return ONLY the complete modified code file, with no markdown, no quotes, and no explanations:\n\n${content}`,
                    },
                  ],
                },
              ],
              tools: [],
            });

            let documentedCode = "";
            for await (const event of stream) {
              if (event.type === "text_delta") {
                documentedCode += event.text;
              }
            }

            documentedCode = documentedCode
              .trim()
              .replace(/^```[a-zA-Z]*\n/, "")
              .replace(/\n```$/, "");
            if (!documentedCode) {
              printOutput(
                picocolors.red("Failed to generate documented code."),
              );
              continue;
            }

            const state = (loop as any).state;
            state.task = `Add TSDoc/JSDoc comments to ${fileArg}`;
            state.done = false;
            state.attemptCount = 0;

            const writeToolCall = {
              id: `tc_doc_${Date.now()}`,
              name: "write_file",
              arguments: JSON.stringify({
                path: targetFilePath,
                content: documentedCode,
              }),
            };

            state.history.push({
              id: `msg_user_${Date.now()}`,
              role: "user",
              createdAt: new Date().toISOString(),
              content: [
                { type: "text", text: `Write JSDoc comments to ${fileArg}` },
              ],
            });

            const assistantMsg = {
              id: `msg_asst_doc_${Date.now()}`,
              role: "assistant",
              createdAt: new Date().toISOString(),
              content: [{ type: "tool_call", toolCall: writeToolCall }],
            };
            state.history.push(assistantMsg);

            await loop.run();
          } catch (err: any) {
            printOutput(
              picocolors.red(
                `Failed to generate documentation: ${err.message}`,
              ),
            );
          }
          continue;
        }

        if (command === "/diagnose") {
          const testCommand =
            (config.context?.testCommands && config.context.testCommands[0]) ||
            "npm test";
          printOutput(
            picocolors.cyan(`Running test suite: "${testCommand}"...`),
          );

          const { exec } = await import("child_process");
          const runTestPromise = () =>
            new Promise<{ stdout: string; stderr: string; code: number }>(
              (resolve) => {
                exec(testCommand, { cwd }, (err, stdout, stderr) => {
                  resolve({
                    stdout,
                    stderr,
                    code: err ? err.code || 1 : 0,
                  });
                });
              },
            );

          const testResult = await runTestPromise();
          if (testResult.code === 0) {
            printOutput(
              picocolors.green(
                `✔ All tests passed successfully! No diagnostics needed.`,
              ),
            );
            continue;
          }

          printOutput(
            picocolors.red(`✖ Tests failed! Outputting diagnostics...`),
          );
          printOutput(picocolors.gray(testResult.stdout || testResult.stderr));

          const repairPrompt = `The test command "${testCommand}" failed. The output log is:\n\n${testResult.stdout || testResult.stderr}\n\nPlease analyze the failure logs, locate the files causing assertion or syntax errors, and fix the codebase so that the test suite passes successfully.`;

          const confirmRepair = await Prompt.askApproval(
            "Launch Agent Loop to auto-repair the test failures?",
          );
          if (!confirmRepair) {
            printOutput(picocolors.yellow("Diagnostics aborted."));
            continue;
          }

          const state = (loop as any).state;
          state.task = `Auto-repair test failures for "${testCommand}"`;
          state.done = false;
          state.attemptCount = 0;

          state.history.push({
            id: `msg_user_${Date.now()}`,
            role: "user",
            createdAt: new Date().toISOString(),
            content: [{ type: "text", text: repairPrompt }],
          });

          if (multi) {
            const orchestrator = new Orchestrator(
              cwd,
              config,
              providerInstance,
              repairPrompt,
              tuiInteraction,
            );
            await orchestrator.run();
          } else {
            await loop.run();
          }
          tui.syncFromLoop(loop);
          tui.finishAttempt();
          continue;
        }

        if (command === "/chat") {
          const wasActive = useFullscreenTui && tui.isActive;
          let stoppedTui = false;
          const stopTuiIfNeeded = () => {
            if (wasActive && !stoppedTui) {
              tui.stop();
              stoppedTui = true;
            }
          };
          const restoreTuiAndPrint = (msg: string) => {
            if (wasActive && stoppedTui && !tui.isActive) {
              tui.start(config.budgetLimit);
              stoppedTui = false;
            }
            printOutput(msg);
          };

          try {
            const subCommand = parts[1]?.toLowerCase();
            const arg = parts.slice(2).join(" ").trim();

            const sessions = loop.getSessions();

            // Function to delete session and adjust active session if needed
            const handleDelete = (idToDelete: string) => {
              loop.deleteSession(idToDelete);
              restoreTuiAndPrint(
                picocolors.green(
                  `✔ Session ${idToDelete} deleted successfully.`,
                ),
              );

              // If deleted the current session, switch to the most recent one remaining, or a new one
              const activeSession =
                (loop as any).state?.sessionId ||
                (loop as any).sessionManager.getActiveSession()?.id;
              if (activeSession === idToDelete) {
                const remaining = loop.getSessions();
                if (remaining.length > 0) {
                  const targetSession = remaining[0];
                  const success = loop.resumeSession(targetSession.id);
                  if (success) {
                    tui.loadHistory(loop.getHistory());
                    restoreTuiAndPrint(
                      picocolors.green(
                        `✔ Automatically switched to session: ${targetSession.id}`,
                      ),
                    );
                    saveLocalState(cwd, {
                      lastSessionId: targetSession.id,
                      lastModel:
                        loop.getModelOverride() || config.models.default,
                    });
                  }
                } else {
                  // No sessions left, start a new one
                  const activeModel =
                    loop.getModelOverride() || config.models.default;
                  const newSessionId = loop.startNewSession(
                    providerInstance.id,
                    activeModel,
                  );
                  tui.loadHistory([]);
                  restoreTuiAndPrint(
                    picocolors.green(
                      `✔ Automatically started new session: ${newSessionId}`,
                    ),
                  );
                  saveLocalState(cwd, {
                    lastSessionId: newSessionId,
                    lastModel: activeModel,
                  });
                }
              }
            };

            // CLI subcommand: /chat list / ls
            if (subCommand === "list" || subCommand === "ls") {
              if (sessions.length === 0) {
                restoreTuiAndPrint(
                  picocolors.yellow("No active or saved sessions found."),
                );
              } else {
                let listMsg = picocolors.bold(
                  picocolors.cyan("\n=== Orbit Saved Sessions ===\n\n"),
                );
                const activeSessionId =
                  (loop as any).state?.sessionId ||
                  (loop as any).sessionManager.getActiveSession()?.id;
                sessions.forEach((s: any, idx: number) => {
                  const formattedDate = new Date(s.createdAt).toLocaleString();
                  const isActive = s.id === activeSessionId;
                  const prefixStr = isActive
                    ? picocolors.green("● (active)")
                    : " ";
                  listMsg += `  ${prefixStr} [${idx + 1}] ${picocolors.blue(s.id)} - ${s.title || "Untitled"} (${formattedDate}) [${s.model}]\n`;
                });
                listMsg += picocolors.cyan("============================\n");
                restoreTuiAndPrint(listMsg);
              }
              continue;
            }

            // CLI subcommand: /chat delete / rm / del
            if (
              subCommand === "delete" ||
              subCommand === "rm" ||
              subCommand === "del"
            ) {
              let idToDelete = arg;
              if (!idToDelete) {
                if (sessions.length === 0) {
                  restoreTuiAndPrint(
                    picocolors.yellow(
                      "No active or saved sessions found to delete.",
                    ),
                  );
                  continue;
                }
                const deleteOptions = sessions.map((s: any) => {
                  const formattedDate = new Date(s.createdAt).toLocaleString();
                  return {
                    value: s.id,
                    label: `${s.id} - ${s.title || "Untitled"} (${formattedDate}) [${s.model}]`,
                  };
                });
                deleteOptions.push({
                  value: "cancel",
                  label: "Cancel",
                });
                stopTuiIfNeeded();
                idToDelete = await Prompt.askSelect(
                  "Choose a session to delete:",
                  deleteOptions,
                );
              } else {
                // Check if index was provided instead of full id
                const idx = parseInt(idToDelete, 10);
                if (!isNaN(idx) && idx >= 1 && idx <= sessions.length) {
                  idToDelete = sessions[idx - 1].id;
                } else {
                  // check if it's a valid session ID
                  const found = sessions.find((s: any) => s.id === idToDelete);
                  if (!found) {
                    restoreTuiAndPrint(
                      picocolors.red(`✖ Session not found: ${idToDelete}`),
                    );
                    continue;
                  }
                }
              }

              if (!idToDelete || idToDelete === "cancel") {
                continue;
              }

              // confirm deletion only if no arg was specified
              let confirm = "yes";
              if (!arg) {
                stopTuiIfNeeded();
                confirm = await Prompt.askSelect(
                  `Are you sure you want to delete session ${idToDelete}?`,
                  [
                    { value: "yes", label: "Yes, delete it" },
                    { value: "no", label: "No, cancel" },
                  ],
                );
              }

              if (confirm === "yes") {
                handleDelete(idToDelete);
              }
              continue;
            }

            // CLI subcommand: /chat new / create
            if (subCommand === "new" || subCommand === "create") {
              const activeModel =
                loop.getModelOverride() || config.models.default;
              const newSessionId = loop.startNewSession(
                providerInstance.id,
                activeModel,
              );
              tui.loadHistory([]);
              restoreTuiAndPrint(
                picocolors.green(`✔ Started new session: ${newSessionId}`),
              );

              saveLocalState(cwd, {
                lastSessionId: newSessionId,
                lastModel: activeModel,
              });
              continue;
            }

            // CLI subcommand: /chat switch / load
            if (
              subCommand === "switch" ||
              subCommand === "load" ||
              (subCommand &&
                (sessions.some((s: any) => s.id === subCommand) ||
                  !isNaN(parseInt(subCommand, 10))))
            ) {
              let targetId =
                subCommand === "switch" || subCommand === "load"
                  ? arg
                  : subCommand;
              if (!targetId) {
                restoreTuiAndPrint(
                  picocolors.yellow("Usage: /chat switch <session_id | index>"),
                );
                continue;
              }
              const idx = parseInt(targetId, 10);
              if (!isNaN(idx) && idx >= 1 && idx <= sessions.length) {
                targetId = sessions[idx - 1].id;
              }
              const found = sessions.find((s: any) => s.id === targetId);
              if (!found) {
                restoreTuiAndPrint(
                  picocolors.red(`✖ Session not found: ${targetId}`),
                );
                continue;
              }

              const success = loop.resumeSession(targetId);
              if (success) {
                tui.loadHistory(loop.getHistory());
                restoreTuiAndPrint(
                  picocolors.green(`✔ Switched to session: ${targetId}`),
                );

                saveLocalState(cwd, {
                  lastSessionId: targetId,
                  lastModel: loop.getModelOverride() || config.models.default,
                });
              } else {
                restoreTuiAndPrint(
                  picocolors.red(`✖ Failed to resume session: ${targetId}`),
                );
              }
              continue;
            }

            // Fallback: If no subcommands, show the interactive select menu
            if (sessions.length === 0) {
              // start a new session since none exist
              const activeModel =
                loop.getModelOverride() || config.models.default;
              const newSessionId = loop.startNewSession(
                providerInstance.id,
                activeModel,
              );
              tui.loadHistory([]);
              restoreTuiAndPrint(
                picocolors.green(`✔ Started new session: ${newSessionId}`),
              );
              saveLocalState(cwd, {
                lastSessionId: newSessionId,
                lastModel: activeModel,
              });
              continue;
            }

            const sessionOptions = sessions.map((s: any) => {
              const formattedDate = new Date(s.createdAt).toLocaleString();
              return {
                value: s.id,
                label: `${s.id} - ${s.title || "Untitled"} (${formattedDate}) [${s.model}]`,
              };
            });

            sessionOptions.unshift({
              value: "new",
              label: picocolors.green("+ Start a new session"),
            });
            sessionOptions.unshift({
              value: "delete_menu",
              label: picocolors.red("- Delete a session..."),
            });
            sessionOptions.push({
              value: "cancel",
              label: "Cancel",
            });

            const selectedSessionId = await Prompt.askSelect(
              "Choose a session to load:",
              sessionOptions,
            );

            if (!selectedSessionId || selectedSessionId === "cancel") {
              continue;
            }

            if (selectedSessionId === "delete_menu") {
              const deleteOptions = sessions.map((s: any) => {
                const formattedDate = new Date(s.createdAt).toLocaleString();
                return {
                  value: s.id,
                  label: `${s.id} - ${s.title || "Untitled"} (${formattedDate}) [${s.model}]`,
                };
              });
              deleteOptions.push({
                value: "cancel",
                label: "Cancel",
              });
              const idToDelete = await Prompt.askSelect(
                "Choose a session to delete:",
                deleteOptions,
              );

              if (idToDelete && idToDelete !== "cancel") {
                const confirm = await Prompt.askSelect(
                  `Are you sure you want to delete session ${idToDelete}?`,
                  [
                    { value: "yes", label: "Yes, delete it" },
                    { value: "no", label: "No, cancel" },
                  ],
                );

                if (confirm === "yes") {
                  handleDelete(idToDelete);
                }
              }
            } else if (selectedSessionId === "new") {
              const activeModel =
                loop.getModelOverride() || config.models.default;
              const newSessionId = loop.startNewSession(
                providerInstance.id,
                activeModel,
              );
              tui.loadHistory([]);
              console.log(
                picocolors.green(`✔ Started new session: ${newSessionId}`),
              );

              saveLocalState(cwd, {
                lastSessionId: newSessionId,
                lastModel: activeModel,
              });
            } else {
              const success = loop.resumeSession(selectedSessionId);
              if (success) {
                tui.loadHistory(loop.getHistory());
                console.log(
                  picocolors.green(
                    `✔ Switched to session: ${selectedSessionId}`,
                  ),
                );

                saveLocalState(cwd, {
                  lastSessionId: selectedSessionId,
                  lastModel: loop.getModelOverride() || config.models.default,
                });
              } else {
                console.log(
                  picocolors.red(
                    `Failed to resume session: ${selectedSessionId}`,
                  ),
                );
              }
            }
          } finally {
            try {
              tui.setCandidates(await getAutocompleteCandidates(cwd, config));
            } catch {}
            if (wasActive) tui.start(config.budgetLimit);
          }
          continue;
        }

        if (command === "/resolve") {
          const fileArg = parts.slice(1).join(" ").trim();
          if (!fileArg) {
            console.log(picocolors.yellow("Usage: /resolve <file_path>"));
            continue;
          }

          let targetFilePath: string;
          try {
            targetFilePath = resolveSafePath(cwd, fileArg);
          } catch (err: any) {
            console.log(picocolors.red(`Error: ${err.message}`));
            continue;
          }
          if (!existsSync(targetFilePath)) {
            console.log(picocolors.red(`Error: File not found: ${fileArg}`));
            continue;
          }

          try {
            const content = readFileSync(targetFilePath, "utf8");
            if (
              !content.includes("<<<<<<<") ||
              !content.includes("=======") ||
              !content.includes(">>>>>>>")
            ) {
              console.log(
                picocolors.yellow(
                  "No git merge conflict markers found in this file.",
                ),
              );
              continue;
            }

            console.log(
              picocolors.cyan(`Resolving conflicts in ${fileArg} via LLM...`),
            );
            const fastModel = config.models.fast || config.models.default;

            const stream = providerInstance.chat({
              model: fastModel,
              messages: [
                {
                  id: `msg_resolve_${Date.now()}`,
                  role: "user",
                  createdAt: new Date().toISOString(),
                  content: [
                    {
                      type: "text",
                      text: `Resolve the git merge conflict markers in this file. Merge the changes logically. Preserve all other code structure and logic exactly. Return ONLY the complete resolved code file, with no markdown, no quotes, and no explanations:\n\n${content}`,
                    },
                  ],
                },
              ],
              tools: [],
            });

            let resolvedCode = "";
            for await (const event of stream) {
              if (event.type === "text_delta") {
                resolvedCode += event.text;
              }
            }

            resolvedCode = resolvedCode
              .trim()
              .replace(/^```[a-zA-Z]*\n/, "")
              .replace(/\n```$/, "");
            if (!resolvedCode) {
              console.log(picocolors.red("Failed to generate resolved code."));
              continue;
            }

            const state = (loop as any).state;
            state.task = `Resolve git merge conflicts in ${fileArg}`;
            state.done = false;
            state.attemptCount = 0;

            const writeToolCall = {
              id: `tc_resolve_${Date.now()}`,
              name: "write_file",
              arguments: JSON.stringify({
                path: targetFilePath,
                content: resolvedCode,
              }),
            };

            state.history.push({
              id: `msg_user_${Date.now()}`,
              role: "user",
              createdAt: new Date().toISOString(),
              content: [
                {
                  type: "text",
                  text: `Resolve git merge conflicts in ${fileArg}`,
                },
              ],
            });

            const assistantMsg = {
              id: `msg_asst_resolve_${Date.now()}`,
              role: "assistant",
              createdAt: new Date().toISOString(),
              content: [{ type: "tool_call", toolCall: writeToolCall }],
            };
            state.history.push(assistantMsg);

            await loop.run();
            tui.syncFromLoop(loop);
            tui.finishAttempt();
          } catch (err: any) {
            console.log(
              picocolors.red(`Failed to resolve conflicts: ${err.message}`),
            );
          }
          continue;
        }

        if (command === "/references") {
          const symbolArg = parts.slice(1).join(" ").trim();
          if (!symbolArg) {
            printOutput(picocolors.yellow("Usage: /references <symbol_name>"));
            continue;
          }

          const indexPath = join(cwd, ".orbit", "symbols.json");
          if (!existsSync(indexPath)) {
            printOutput(
              picocolors.yellow(
                "No symbols index found. Please run a task first to generate the symbol map.",
              ),
            );
            continue;
          }

          try {
            const raw = readFileSync(indexPath, "utf8");
            const index = JSON.parse(raw);
            let exportedFile: string | null = null;
            if (index.files && typeof index.files === "object") {
              for (const [file, fileData] of Object.entries(index.files)) {
                const data = fileData as any;
                if (data && Array.isArray(data.symbols)) {
                  if (data.symbols.some((s: any) => s.name === symbolArg)) {
                    exportedFile = file;
                    break;
                  }
                }
              }

              const refLines: string[] = [];
              refLines.push(
                picocolors.bold(
                  picocolors.cyan(
                    `\n=== Symbol References Finder: ${symbolArg} ===`,
                  ),
                ),
              );
              if (exportedFile) {
                refLines.push(
                  `  🔑 Exported by: ${picocolors.green(exportedFile)}`,
                );
              } else {
                refLines.push(
                  `  🔑 Exported by: ${picocolors.gray("Unknown (Internal / Not exported)")}`,
                );
              }
              refLines.push(
                picocolors.gray(
                  "===========================================================",
                ),
              );

              let refCount = 0;
              const symbolRegex = new RegExp(`\\b${symbolArg}\\b`);
              for (const [file, fileData] of Object.entries(index.files)) {
                const absPath = join(cwd, file);
                if (existsSync(absPath)) {
                  const lines = readFileSync(absPath, "utf8").split("\n");
                  for (let idx = 0; idx < lines.length; idx++) {
                    const line = lines[idx];
                    const trimmed = line.trim();

                    if (
                      trimmed.startsWith("//") ||
                      trimmed.startsWith("*") ||
                      trimmed.startsWith("/*")
                    ) {
                      continue;
                    }

                    if (
                      symbolRegex.test(line) &&
                      !line.includes("export ") &&
                      !line.includes("symbols.some")
                    ) {
                      refCount++;
                      refLines.push(
                        `  📁 ${picocolors.blue(file)}:${picocolors.yellow(idx + 1)}`,
                      );
                      refLines.push(
                        `     ${picocolors.gray(line.trim().substring(0, 80))}`,
                      );
                    }
                  }
                }
              }

              refLines.push(
                picocolors.gray(
                  "===========================================================",
                ),
              );
              refLines.push(
                `  Total Usages Found: ${picocolors.green(refCount)}`,
              );
              refLines.push(
                picocolors.cyan(
                  "===========================================================\n",
                ),
              );

              const wasActive = useFullscreenTui;
              if (wasActive) tui.stop();
              await pageText(refLines.join("\n"));
              if (wasActive) tui.start(config.budgetLimit);
            }
          } catch (err: any) {
            printOutput(
              picocolors.red(`Failed to search references: ${err.message}`),
            );
          }
          continue;
        }

        if (command === "/grep") {
          const query = parts.slice(1).join(" ").trim();
          const isZh = config.language === "zh";
          if (!query) {
            printOutput(
              isZh
                ? picocolors.yellow("用法: /grep <搜索内容>")
                : picocolors.yellow("Usage: /grep <query_pattern>"),
            );
            continue;
          }

          const wasActive = useFullscreenTui && tui.isActive;
          if (wasActive) tui.stop();

          console.log(
            isZh
              ? picocolors.cyan(`\n正在搜索: "${query}"...`)
              : picocolors.cyan(`\nSearching for: "${query}"...`),
          );

          let matches: Array<{ file: string; line: number; content: string }> =
            [];

          try {
            // Try Ripgrep first
            try {
              const { execSync } = await import("child_process");
              const rgOutput = execSync(
                `rg --line-number --color=never --no-heading --glob "!.git/**" --glob "!node_modules/**" --glob "!dist/**" --glob "!build/**" --glob "!.orbit/**" "${query}"`,
                {
                  cwd,
                  stdio: ["ignore", "pipe", "ignore"],
                },
              ).toString();

              const lines = rgOutput.split("\n");
              for (const line of lines) {
                if (matches.length >= 100) break;
                if (!line.trim()) continue;
                const parts = line.split(":");
                if (parts.length >= 3) {
                  const filePath = parts[0].replace(/\\/g, "/");
                  const lineNum = parseInt(parts[1], 10);
                  const content = parts.slice(2).join(":");
                  matches.push({ file: filePath, line: lineNum, content });
                }
              }
            } catch {
              // Fallback to JS search
              const ignorePatterns = config.context?.ignore || [];
              const allFiles = await glob("**/*", {
                cwd,
                ignore: ignorePatterns,
                onlyFiles: true,
                dot: true,
                suppressErrors: true,
              });

              for (const file of allFiles) {
                if (matches.length >= 100) break;
                const filePath = join(cwd, file);
                const content = readFileSync(filePath, "utf8");
                if (content.includes(query)) {
                  const lines = content.split("\n");
                  for (let i = 0; i < lines.length; i++) {
                    if (lines[i].includes(query)) {
                      matches.push({
                        file: file.replace(/\\/g, "/"),
                        line: i + 1,
                        content: lines[i],
                      });
                      if (matches.length >= 100) break;
                    }
                  }
                }
              }
            }

            if (matches.length === 0) {
              console.log(
                isZh
                  ? picocolors.yellow("未找到匹配的代码行。")
                  : picocolors.yellow("No matches found."),
              );
            } else {
              let resultsText = isZh
                ? picocolors.bold(
                    picocolors.cyan(
                      `\n── 🔍 搜索结果 (共 ${matches.length} 项) ──\n`,
                    ),
                  )
                : picocolors.bold(
                    picocolors.cyan(
                      `\n── 🔍 Search Results (${matches.length} found) ──\n`,
                    ),
                  );

              const matchedFiles = Array.from(
                new Set(matches.map((m) => m.file)),
              );

              for (const m of matches) {
                resultsText += `${picocolors.green(m.file)}:${picocolors.yellow(m.line)}\n`;
                resultsText += `  ${picocolors.gray(m.content.trim().substring(0, 100))}\n`;
              }

              await pageText(resultsText);

              console.log("");
              const confirmAdd = await Prompt.askApproval(
                isZh
                  ? `发现 ${matchedFiles.length} 个相关文件。是否将它们全部添加到活动上下文中？`
                  : `Found ${matchedFiles.length} file(s). Add all of them to the active context?`,
              );

              if (confirmAdd) {
                for (const f of matchedFiles) {
                  loop.addRelevantFilePublic(
                    f,
                    `Matched query via /grep "${query}"`,
                  );
                }
                console.log(
                  isZh
                    ? picocolors.green(
                        `✔ 成功添加 ${matchedFiles.length} 个文件到上下文。`,
                      )
                    : picocolors.green(
                        `✔ Added ${matchedFiles.length} file(s) to active context.`,
                      ),
                );
              }
            }

            await Prompt.askText(
              isZh
                ? "按 Enter 键返回 Orbit..."
                : "Press Enter to return to Orbit...",
            );
          } catch (err: any) {
            console.log(
              isZh
                ? picocolors.red(`搜索失败: ${err.message}`)
                : picocolors.red(`Search failed: ${err.message}`),
            );
          } finally {
            tui.syncFromLoop(loop);
            if (wasActive) tui.start(config.budgetLimit);
          }
          continue;
        }

        if (command === "/language") {
          const langArg = parts.slice(1).join(" ").trim().toLowerCase();
          const activeConfig = loop.getConfig();
          let targetLang: "en" | "zh";

          if (langArg === "zh" || langArg === "cn" || langArg === "chinese") {
            targetLang = "zh";
          } else if (
            langArg === "en" ||
            langArg === "us" ||
            langArg === "english"
          ) {
            targetLang = "en";
          } else if (!langArg) {
            targetLang = activeConfig.language === "en" ? "zh" : "en";
          } else {
            const isZh = activeConfig.language === "zh";
            printOutput(
              isZh
                ? picocolors.red("无效的语言参数。请使用: /language [en|zh]")
                : picocolors.red(
                    "Invalid language argument. Use: /language [en|zh]",
                  ),
            );
            continue;
          }

          activeConfig.language = targetLang;
          config.language = targetLang;
          if (tui && (tui as any).config) {
            (tui as any).config.language = targetLang;
          }

          const {
            existsSync: fsExists,
            readFileSync: fsRead,
            writeFileSync: fsWrite,
            mkdirSync: fsMkdir,
          } = await import("fs");
          const { homedir: osHomedir } = await import("os");
          const { join: pathJoin, dirname: pathDirname } = await import("path");
          const { parse: yamlParse, stringify: yamlStringify } =
            await import("yaml");

          const globalConfigPath = pathJoin(
            osHomedir(),
            ".orbit",
            "config.yaml",
          );
          let globalConfig: any = {};
          if (fsExists(globalConfigPath)) {
            try {
              const raw = fsRead(globalConfigPath, "utf8");
              globalConfig = yamlParse(raw) || {};
            } catch {
              globalConfig = {};
            }
          }
          globalConfig.language = targetLang;
          try {
            const dir = pathDirname(globalConfigPath);
            if (!fsExists(dir)) {
              fsMkdir(dir, { recursive: true });
            }
            fsWrite(globalConfigPath, yamlStringify(globalConfig), "utf8");

            const isZh = targetLang === "zh";
            printOutput(
              isZh
                ? picocolors.green(
                    `✔ 语言已成功切换为：中文 (zh) 并保存至全局配置。`,
                  )
                : picocolors.green(
                    `✔ Language successfully switched to: English (en) and saved to global config.`,
                  ),
            );
          } catch (err: any) {
            const isZh = targetLang === "zh";
            printOutput(
              isZh
                ? picocolors.red(`无法保存全局配置: ${err.message}`)
                : picocolors.red(
                    `Failed to save global config: ${err.message}`,
                  ),
            );
          }
          continue;
        }

        if (command === "/fork") {
          const wasActive = useFullscreenTui && tui.isActive;
          if (wasActive) tui.stop();
          try {
            const isZh = config.language === "zh";
            const activeSessionId =
              (loop as any).state?.sessionId ||
              loop.sessionManager.getActiveSession()?.id;
            if (!activeSessionId) {
              console.log(
                isZh
                  ? picocolors.red("✖ 没有活跃的会话可以 fork。")
                  : picocolors.red("✖ No active session to fork."),
              );
              continue;
            }

            const sub = parts[1]?.toLowerCase();

            const {
              copyFileSync,
              existsSync,
              readdirSync,
              mkdirSync,
              readFileSync,
              writeFileSync,
            } = await import("fs");
            const { join } = await import("path");
            const sessionsDir = join(cwd, ".orbit", "sessions");

            if (sub === "tree") {
              const sessions: any[] = [];
              if (existsSync(sessionsDir)) {
                const dirs = readdirSync(sessionsDir);
                for (const dir of dirs) {
                  const sessionFile = join(sessionsDir, dir, "session.json");
                  if (existsSync(sessionFile)) {
                    try {
                      const data = JSON.parse(
                        readFileSync(sessionFile, "utf8"),
                      );
                      sessions.push(data);
                    } catch {}
                  }
                }
              }

              if (sessions.length === 0) {
                console.log(
                  isZh
                    ? picocolors.yellow("没有找到任何会话。")
                    : picocolors.yellow("No sessions found."),
                );
                continue;
              }

              interface ExtendedNode {
                id: string;
                title: string;
                parentId?: string;
                model: string;
                createdAt: string;
                children: ExtendedNode[];
                isActive: boolean;
              }

              const nodeMap = new Map<string, ExtendedNode>();
              for (const s of sessions) {
                nodeMap.set(s.id, {
                  id: s.id,
                  title: s.title || "Untitled",
                  parentId: s.parentId,
                  model: s.model || "",
                  createdAt: s.createdAt || "",
                  children: [],
                  isActive: s.id === activeSessionId,
                });
              }

              const roots: ExtendedNode[] = [];
              for (const node of nodeMap.values()) {
                if (node.parentId && nodeMap.has(node.parentId)) {
                  nodeMap.get(node.parentId)!.children.push(node);
                } else {
                  roots.push(node);
                }
              }

              const sortNodes = (nodes: ExtendedNode[]) => {
                nodes.sort(
                  (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt),
                );
                for (const node of nodes) {
                  sortNodes(node.children);
                }
              };
              sortNodes(roots);

              console.log(
                isZh
                  ? picocolors.bold(
                      picocolors.cyan("\n=== Orbit 会话分支树 ===\n"),
                    )
                  : picocolors.bold(
                      picocolors.cyan("\n=== Orbit Session Branch Tree ===\n"),
                    ),
              );

              const printTreeNode = (
                node: ExtendedNode,
                prefix: string,
                isLast: boolean,
              ) => {
                const marker = node.isActive
                  ? picocolors.green("● (active) ")
                  : "  ";
                const branchChar =
                  prefix === "" ? "" : isLast ? "└── " : "├── ";
                const line = `${prefix}${branchChar}${marker}${picocolors.blue(node.id)} - ${node.title || "Untitled"} (${node.model})`;
                console.log(line);

                const nextPrefix =
                  prefix + (prefix === "" ? "" : isLast ? "    " : "│   ");
                for (let i = 0; i < node.children.length; i++) {
                  printTreeNode(
                    node.children[i],
                    nextPrefix,
                    i === node.children.length - 1,
                  );
                }
              };

              for (let i = 0; i < roots.length; i++) {
                printTreeNode(roots[i], "", i === roots.length - 1);
              }
              console.log(picocolors.cyan("=========================\n"));
              continue;
            }

            if (sub === "switch") {
              const sessions = loop.getSessions();
              let targetId = parts.slice(2).join(" ").trim();
              if (!targetId) {
                console.log(
                  isZh
                    ? picocolors.yellow("用法: /fork switch <会话ID | 索引>")
                    : picocolors.yellow(
                        "Usage: /fork switch <session_id | index>",
                      ),
                );
                continue;
              }
              const idx = parseInt(targetId, 10);
              if (!isNaN(idx) && idx >= 1 && idx <= sessions.length) {
                targetId = sessions[idx - 1].id;
              }
              const found = sessions.find((s: any) => s.id === targetId);
              if (!found) {
                console.log(
                  isZh
                    ? picocolors.red(`✖ 会话不存在: ${targetId}`)
                    : picocolors.red(`✖ Session not found: ${targetId}`),
                );
                continue;
              }

              const success = loop.resumeSession(targetId);
              if (success) {
                tui.loadHistory(loop.getHistory());
                console.log(
                  isZh
                    ? picocolors.green(`✔ 已切换到会话: ${targetId}`)
                    : picocolors.green(`✔ Switched to session: ${targetId}`),
                );

                saveLocalState(cwd, {
                  lastSessionId: targetId,
                  lastModel: loop.getModelOverride() || config.models.default,
                });
              } else {
                console.log(
                  isZh
                    ? picocolors.red(`✖ 切换会话失败: ${targetId}`)
                    : picocolors.red(`✖ Failed to resume session: ${targetId}`),
                );
              }
              continue;
            }

            // Default Fork Logic
            const forkName = parts.slice(1).join(" ").trim();
            const newSessionId = generateId("sess");
            const srcDir = join(sessionsDir, activeSessionId);
            const destDir = join(sessionsDir, newSessionId);

            if (!existsSync(srcDir)) {
              console.log(
                isZh
                  ? picocolors.red(`✖ 会话目录不存在: ${srcDir}`)
                  : picocolors.red(`✖ Session directory not found: ${srcDir}`),
              );
              continue;
            }

            mkdirSync(destDir, { recursive: true });

            const files = readdirSync(srcDir);
            for (const file of files) {
              const srcFile = join(srcDir, file);
              const destFile = join(destDir, file);
              copyFileSync(srcFile, destFile);
            }

            const sessionJsonFile = join(destDir, "session.json");
            if (existsSync(sessionJsonFile)) {
              try {
                const sessionData = JSON.parse(
                  readFileSync(sessionJsonFile, "utf8"),
                );
                sessionData.id = newSessionId;
                sessionData.title = forkName || `Fork of ${activeSessionId}`;
                sessionData.parentId = activeSessionId; // Save parent lineage
                sessionData.createdAt = new Date().toISOString();
                sessionData.updatedAt = new Date().toISOString();
                writeFileSync(
                  sessionJsonFile,
                  JSON.stringify(sessionData, null, 2),
                  "utf8",
                );
              } catch (err: any) {
                console.log(
                  isZh
                    ? picocolors.yellow(
                        `警告: 更新 session.json 失败: ${err.message}`,
                      )
                    : picocolors.yellow(
                        `Warning: Failed to update session.json: ${err.message}`,
                      ),
                );
              }
            }

            const success = loop.resumeSession(newSessionId);
            if (success) {
              tui.loadHistory(loop.getHistory());
              console.log(
                isZh
                  ? picocolors.green(
                      `✔ 成功 Fork 并切换到新会话: ${newSessionId}`,
                    )
                  : picocolors.green(
                      `✔ Successfully forked and switched to new session: ${newSessionId}`,
                    ),
              );
              saveLocalState(cwd, {
                lastSessionId: newSessionId,
                lastModel: loop.getModelOverride() || config.models.default,
              });
            } else {
              console.log(
                isZh
                  ? picocolors.red(`✖ 切换到新会话 ${newSessionId} 失败。`)
                  : picocolors.red(
                      `✖ Failed to resume new session ${newSessionId}.`,
                    ),
              );
            }
          } catch (err: any) {
            console.log(
              picocolors.red(`Error forking session: ${err.message}`),
            );
          } finally {
            try {
              tui.setCandidates(await getAutocompleteCandidates(cwd, config));
            } catch {}
            tui.syncFromLoop(loop);
            if (wasActive) tui.start(config.budgetLimit);
          }
          continue;
        }

        if (command === "/mode" || command === "/ask" || command === "/code") {
          const isZh = config.language === "zh";
          let targetMode = "";
          if (command === "/ask") {
            targetMode = "strict";
          } else if (command === "/code") {
            targetMode = "normal";
          } else {
            targetMode = parts.slice(1).join(" ").trim().toLowerCase();
          }

          if (!targetMode) {
            console.log(
              isZh
                ? picocolors.yellow("用法: /mode <strict|normal|auto|plan>")
                : picocolors.yellow("Usage: /mode <strict|normal|auto|plan>"),
            );
            continue;
          }

          const validModes = ["strict", "normal", "auto", "plan"];
          if (!validModes.includes(targetMode)) {
            console.log(
              isZh
                ? picocolors.red(
                    `✖ 无效的安全模式: ${targetMode}。可选模式: ${validModes.join(", ")}`,
                  )
                : picocolors.red(
                    `✖ Invalid security mode: ${targetMode}. Valid modes: ${validModes.join(", ")}`,
                  ),
            );
            continue;
          }

          loop.getConfig().permissions.mode = targetMode as any;
          console.log(
            isZh
              ? picocolors.green(
                  `✔ 已切换安全模式至: ${targetMode.toUpperCase()}`,
                )
              : picocolors.green(
                  `✔ Switched security mode to: ${targetMode.toUpperCase()}`,
                ),
          );
          tui.syncFromLoop(loop);
          continue;
        }

        if (command === "/copy") {
          const isZh = config.language === "zh";
          const history = loop.getHistory();
          const lastAssistantMsg = [...history]
            .reverse()
            .find((msg) => msg.role === "assistant");

          if (!lastAssistantMsg) {
            console.log(
              isZh
                ? picocolors.yellow("没有找到 AI 的最近回复。")
                : picocolors.yellow(
                    "No recent assistant response found to copy.",
                  ),
            );
            continue;
          }

          let textToCopy = "";
          if (typeof lastAssistantMsg.content === "string") {
            textToCopy = lastAssistantMsg.content;
          } else if (Array.isArray(lastAssistantMsg.content)) {
            textToCopy = lastAssistantMsg.content
              .map((c: any) => (c.type === "text" ? c.text : ""))
              .join("");
          }

          if (!textToCopy) {
            console.log(
              isZh
                ? picocolors.yellow("AI 的最近回复内容为空。")
                : picocolors.yellow("Recent assistant response is empty."),
            );
            continue;
          }

          const copied = copyToClipboard(textToCopy);
          if (copied) {
            console.log(
              isZh
                ? picocolors.green("✔ 已成功复制 AI 最近回复到剪贴板！")
                : picocolors.green(
                    "✔ Successfully copied recent AI response to clipboard!",
                  ),
            );
          } else {
            console.log(
              isZh
                ? picocolors.red(
                    "✖ 复制到剪贴板失败，系统未配置剪贴板工具（如 pbcopy/clip/xclip）。",
                  )
                : picocolors.red(
                    "✖ Failed to copy to clipboard. Ensure pbcopy/clip/xclip is installed.",
                  ),
            );
          }
          continue;
        }

        if (command === "/copy-context") {
          const isZh = config.language === "zh";
          const files = loop.getRelevantFiles();
          if (files.length === 0) {
            console.log(
              isZh
                ? picocolors.yellow("当前活动上下文为空，无可复制的内容。")
                : picocolors.yellow("No files in the active context to copy."),
            );
            continue;
          }

          const fileListStr = files.map((f) => f.path).join("\n");
          const copied = copyToClipboard(fileListStr);
          if (copied) {
            console.log(
              isZh
                ? picocolors.green("✔ 已成功复制上下文文件列表到剪贴板！")
                : picocolors.green(
                    "✔ Successfully copied context file list to clipboard!",
                  ),
            );
          } else {
            console.log(
              isZh
                ? picocolors.red("✖ 复制到剪贴板失败。")
                : picocolors.red("✖ Failed to copy to clipboard."),
            );
          }
          continue;
        }

        if (command === "/git") {
          const wasActive = useFullscreenTui && tui.isActive;
          if (wasActive) tui.stop();

          const gitArgs = parts.slice(1).join(" ").trim();
          const isZh = config.language === "zh";

          if (!gitArgs) {
            console.log(
              isZh
                ? picocolors.yellow("用法: /git <git_arguments>，如: /git diff")
                : picocolors.yellow(
                    "Usage: /git <git_arguments>, e.g.: /git diff",
                  ),
            );
            if (wasActive) tui.start(config.budgetLimit);
            continue;
          }

          const shellCmd = `git ${gitArgs}`;
          const permissionEngine = new PermissionEngine(config);
          const decision = permissionEngine.evaluate(
            "bash",
            { command: shellCmd },
            "execute",
          );
          if (decision.action === "deny") {
            console.log(
              picocolors.red(
                isZh
                  ? `✖ Git 命令已被安全策略阻止: ${decision.reason}`
                  : `✖ Git command blocked by safety policy: ${decision.reason}`,
              ),
            );
            if (wasActive) tui.start(config.budgetLimit);
            continue;
          }
          if (decision.action === "ask") {
            const approved = await Prompt.askApproval(
              isZh
                ? `Git 命令需要 ${decision.risk} 权限：${shellCmd}`
                : `Git command requires ${decision.risk} permission: ${shellCmd}`,
            );
            if (!approved) {
              console.log(
                picocolors.yellow(
                  isZh ? "已取消 Git 命令。" : "Git command cancelled.",
                ),
              );
              if (wasActive) tui.start(config.budgetLimit);
              continue;
            }
          }
          console.log(
            isZh
              ? picocolors.cyan(`\n正在执行 Git 命令: ${shellCmd}...`)
              : picocolors.cyan(`\nRunning Git command: ${shellCmd}...`),
          );

          try {
            const { spawnSync } = await import("child_process");
            const result = spawnSync(shellCmd, {
              cwd,
              stdio: "inherit",
              shell: true,
            });

            if (result.status === 0) {
              console.log(
                isZh
                  ? picocolors.green(`\n✔ 命令执行成功。`)
                  : picocolors.green(`\n✔ Command completed successfully.`),
              );
            } else {
              console.log(
                isZh
                  ? picocolors.red(
                      `\n✖ 命令执行失败，退出代码: ${result.status}`,
                    )
                  : picocolors.red(
                      `\n✖ Command failed with exit code ${result.status}`,
                    ),
              );
            }
            await Prompt.askText(
              isZh
                ? "按 Enter 键返回 Orbit..."
                : "Press Enter to return to Orbit...",
            );
          } catch (err: any) {
            console.log(
              isZh
                ? picocolors.red(`无法执行 Git 命令: ${err.message}`)
                : picocolors.red(
                    `Failed to execute Git command: ${err.message}`,
                  ),
            );
          } finally {
            tui.syncFromLoop(loop);
            if (wasActive) tui.start(config.budgetLimit);
          }
          continue;
        }

        if (command === "/btw") {
          const isZh = config.language === "zh";
          let question = parts.slice(1).join(" ").trim();
          if (!question) {
            const wasActive = useFullscreenTui && tui.isActive;
            if (wasActive) tui.stop();
            question =
              (await Prompt.askText(
                isZh
                  ? "输入你要咨询的快捷问题（不会记入当前会话历史）:"
                  : "Enter your quick side-question (won't be saved to session history):",
              )) || "";
            if (wasActive) tui.start(config.budgetLimit);
          }

          if (!question.trim()) {
            continue;
          }

          console.log(isZh ? "\n正在查询回答..." : "\nQuerying answer...");
          try {
            const fastModel = config.models.fast || config.models.default;
            const stream = providerInstance.chat({
              model: fastModel,
              messages: [
                {
                  id: `msg_btw_${Date.now()}`,
                  role: "user",
                  createdAt: new Date().toISOString(),
                  content: [
                    {
                      type: "text",
                      text: question,
                    },
                  ],
                },
              ],
              tools: [],
            });

            let fullAnswer = "";
            for await (const event of stream) {
              if (event.type === "text_delta") {
                process.stdout.write(event.text);
                fullAnswer += event.text;
              }
            }
            console.log("\n");
            console.log(
              picocolors.dim(
                isZh
                  ? "💡 [提示：此快捷问答未记入会话历史，不消耗后续 Token]"
                  : "💡 [BTW: This side-question turn was not saved to session history to save tokens.]",
              ),
            );
            console.log("");
          } catch (err: any) {
            console.log(picocolors.red(`✖ Failed: ${err.message}`));
          }
          continue;
        }

        if (command === "/memory") {
          const isZh = config.language === "zh";
          const { existsSync, readFileSync } = await import("fs");

          const candidates = [
            join(cwd, "ORBIT.md"),
            join(cwd, ".agents", "AGENTS.md"),
            join(cwd, "AGENTS.md"),
            join(cwd, "CLAUDE.md"),
            join(cwd, "RUNE.md"),
            join(cwd, ".cursorrules"),
            join(cwd, ".copilotrules"),
            join(cwd, "README.md"),
          ];

          let foundPath = "";
          for (const p of candidates) {
            if (existsSync(p)) {
              foundPath = p;
              break;
            }
          }

          if (foundPath) {
            console.log(
              picocolors.cyan(
                isZh
                  ? `\n=== 当前项目规则与记忆 (${foundPath}) ===\n`
                  : `\n=== Active Project Guidelines & Memory (${foundPath}) ===\n`,
              ),
            );
            const content = readFileSync(foundPath, "utf8");
            console.log(content);
            console.log(
              picocolors.cyan(
                "========================================================\n",
              ),
            );
          } else {
            console.log(
              picocolors.yellow(
                isZh
                  ? "未找到本地项目规则文件（ORBIT.md, AGENTS.md, CLAUDE.md, RUNE.md, .cursorrules 或 .copilotrules）。"
                  : "No active project memory/rules file found (ORBIT.md, AGENTS.md, CLAUDE.md, RUNE.md, .cursorrules or .copilotrules).",
              ),
            );

            const wasActive = useFullscreenTui && tui.isActive;
            if (wasActive) tui.stop();
            const create = await Prompt.askApproval(
              isZh
                ? "是否在当前项目根目录下自动创建 .agents/AGENTS.md 规则记忆文件？"
                : "Create a standard .agents/AGENTS.md project memory file?",
            );
            if (wasActive) tui.start(config.budgetLimit);

            if (create) {
              const fs = await import("fs");
              const dir = join(cwd, ".agents");
              if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
              }
              const template = [
                "# Project Guidelines & Memory",
                "",
                "## Technology Stack",
                "- Node.js & TypeScript",
                "",
                "## Coding Standards",
                "- Write clean, type-safe ES Modules",
                "- Ensure all tests compile and pass",
                "",
              ].join("\n");
              fs.writeFileSync(join(dir, "AGENTS.md"), template, "utf8");
              console.log(
                picocolors.green(
                  isZh
                    ? "✔ 成功创建 .agents/AGENTS.md。你可以随时修改以自定义 Agent 行为。"
                    : "✔ Successfully created .agents/AGENTS.md. You can edit it to guide the agent.",
                ),
              );
            }
          }
          continue;
        }

        if (command === "/tokens") {
          const isZh = config.language === "zh";
          const inputTokens = (loop as any).totalInputTokens || 0;
          const outputTokens = (loop as any).totalOutputTokens || 0;
          const cacheReadTokens = (loop as any).totalCacheReadTokens || 0;
          const currentCost = loop.getSessionCost();
          const budgetLimit = loop.getConfig().budgetLimit;

          const tokensText = [
            picocolors.bold(
              picocolors.cyan("\n=== Orbit Session Token Usage & Cost ==="),
            ),
            `  📥 Input Tokens:       ${picocolors.green(inputTokens.toLocaleString())}`,
            `  💾 Cache Read Tokens:  ${picocolors.green(cacheReadTokens.toLocaleString())}`,
            `  📤 Output Tokens:      ${picocolors.green(outputTokens.toLocaleString())}`,
            `  💰 Session Cost:       ${picocolors.green(`$${currentCost.toFixed(4)}`)} / $${budgetLimit.toFixed(2)} (Limit)`,
            picocolors.cyan("========================================\n"),
          ].join("\n");
          printOutput(tokensText);
          continue;
        }

        if (command === "/new" || command === "/reset") {
          const wasActive = useFullscreenTui && tui.isActive;
          try {
            const activeModel =
              loop.getModelOverride() || config.models.default;
            const newSessionId = loop.startNewSession(
              providerInstance.id,
              activeModel,
            );
            tui.loadHistory([]);

            if (wasActive && !tui.isActive) {
              tui.start(config.budgetLimit);
            }

            printOutput(
              picocolors.green(
                config.language === "zh"
                  ? `✔ 成功创建并启动新会话: ${newSessionId}`
                  : `✔ Started new session: ${newSessionId}`,
              ),
            );

            saveLocalState(cwd, {
              lastSessionId: newSessionId,
              lastModel: activeModel,
            });
          } catch (err: any) {
            if (wasActive && !tui.isActive) {
              tui.start(config.budgetLimit);
            }
            printOutput(
              picocolors.red(`Error starting new session: ${err.message}`),
            );
          } finally {
            try {
              tui.setCandidates(await getAutocompleteCandidates(cwd, config));
            } catch {}
            tui.syncFromLoop(loop);
          }
          continue;
        }

        if (command === "/delete" || command === "/rm" || command === "/del") {
          const wasActive = useFullscreenTui && tui.isActive;
          let stoppedTui = false;
          const stopTuiIfNeeded = () => {
            if (wasActive && !stoppedTui) {
              tui.stop();
              stoppedTui = true;
            }
          };
          const restoreTuiAndPrint = (msg: string) => {
            if (wasActive && stoppedTui && !tui.isActive) {
              tui.start(config.budgetLimit);
              stoppedTui = false;
            }
            printOutput(msg);
          };

          try {
            const isZh = config.language === "zh";
            const sessions = loop.getSessions();
            let idToDelete = parts.slice(1).join(" ").trim();

            if (!idToDelete) {
              if (sessions.length === 0) {
                restoreTuiAndPrint(
                  picocolors.yellow(
                    isZh
                      ? "没有找到任何保存的会话来删除。"
                      : "No active or saved sessions found to delete.",
                  ),
                );
                continue;
              }
              const deleteOptions = sessions.map((s: any) => {
                const formattedDate = new Date(s.createdAt).toLocaleString();
                return {
                  value: s.id,
                  label: `${s.id} - ${s.title || "Untitled"} (${formattedDate}) [${s.model}]`,
                };
              });
              deleteOptions.push({
                value: "cancel",
                label: "Cancel",
              });
              stopTuiIfNeeded();
              idToDelete = await Prompt.askSelect(
                isZh ? "选择要删除的会话：" : "Choose a session to delete:",
                deleteOptions,
              );
            } else {
              const idx = parseInt(idToDelete, 10);
              if (!isNaN(idx) && idx >= 1 && idx <= sessions.length) {
                idToDelete = sessions[idx - 1].id;
              } else {
                const found = sessions.find((s: any) => s.id === idToDelete);
                if (!found) {
                  restoreTuiAndPrint(
                    picocolors.red(
                      isZh
                        ? `✖ 未找到该会话: ${idToDelete}`
                        : `✖ Session not found: ${idToDelete}`,
                    ),
                  );
                  continue;
                }
              }
            }

            if (!idToDelete || idToDelete === "cancel") {
              continue;
            }

            // Only ask for confirmation if no argument was passed (interactive mode)
            let confirm = "yes";
            const hasArg = !!parts.slice(1).join(" ").trim();
            if (!hasArg) {
              stopTuiIfNeeded();
              confirm = await Prompt.askSelect(
                isZh
                  ? `您确定要删除会话 ${idToDelete} 吗？`
                  : `Are you sure you want to delete session ${idToDelete}?`,
                [
                  {
                    value: "yes",
                    label: isZh ? "是，删除它" : "Yes, delete it",
                  },
                  { value: "no", label: isZh ? "否，取消" : "No, cancel" },
                ],
              );
            }

            if (confirm === "yes") {
              loop.deleteSession(idToDelete);

              const activeSession =
                (loop as any).state?.sessionId ||
                (loop as any).sessionManager.getActiveSession()?.id;
              let switchMsg = "";
              if (activeSession === idToDelete) {
                const remaining = loop.getSessions();
                if (remaining.length > 0) {
                  const targetSession = remaining[0];
                  const success = loop.resumeSession(targetSession.id);
                  if (success) {
                    tui.loadHistory(loop.getHistory());
                    switchMsg = isZh
                      ? `✔ 已自动切换到会话: ${targetSession.id}`
                      : `✔ Automatically switched to session: ${targetSession.id}`;
                    saveLocalState(cwd, {
                      lastSessionId: targetSession.id,
                      lastModel:
                        loop.getModelOverride() || config.models.default,
                    });
                  }
                } else {
                  const activeModel =
                    loop.getModelOverride() || config.models.default;
                  const newSessionId = loop.startNewSession(
                    providerInstance.id,
                    activeModel,
                  );
                  tui.loadHistory([]);
                  switchMsg = isZh
                    ? `✔ 已自动启动新会话: ${newSessionId}`
                    : `✔ Automatically started new session: ${newSessionId}`;
                  saveLocalState(cwd, {
                    lastSessionId: newSessionId,
                    lastModel: activeModel,
                  });
                }
              }

              // Restore TUI and print success
              restoreTuiAndPrint(
                picocolors.green(
                  isZh
                    ? `✔ 会话 ${idToDelete} 已成功删除。`
                    : `✔ Session ${idToDelete} deleted successfully.`,
                ),
              );
              if (switchMsg) {
                restoreTuiAndPrint(picocolors.green(switchMsg));
              }
            }
          } catch (err: any) {
            restoreTuiAndPrint(
              picocolors.red(`Error deleting session: ${err.message}`),
            );
          } finally {
            if (wasActive && stoppedTui && !tui.isActive) {
              tui.start(config.budgetLimit);
            }
            try {
              tui.setCandidates(await getAutocompleteCandidates(cwd, config));
            } catch {}
            tui.syncFromLoop(loop);
          }
          continue;
        }

        printOutput(
          picocolors.red(
            `Unknown command: ${command}. Type /help for available commands.`,
          ),
        );
        continue;
      }

      const state = (loop as any).state;
      state.task = trimmed;
      state.done = false;
      state.attemptCount = 0;

      state.history.push({
        id: `msg_user_${Date.now()}`,
        role: "user",
        createdAt: new Date().toISOString(),
        content: [{ type: "text", text: trimmed }],
      });

      // Auto-generate session title if it's the default title
      const activeSession = loop.sessionManager.getActiveSession();
      if (
        activeSession &&
        (activeSession.title === "New Orbit Session" || !activeSession.title)
      ) {
        const fastModel = config.models.fast || config.models.default;
        const firstPrompt = trimmed;
        Promise.resolve().then(async () => {
          try {
            const stream = providerInstance.chat({
              model: fastModel,
              messages: [
                {
                  id: `msg_title_gen_${Date.now()}`,
                  role: "user",
                  createdAt: new Date().toISOString(),
                  content: [
                    {
                      type: "text",
                      text: `Summarize the following user task into a very concise title (max 5 words, e.g. "Fix button layout" or "Add login unit tests"). Output ONLY the title, no markdown, no punctuation, no quotes:\n\n${firstPrompt.substring(0, 1000)}`,
                    },
                  ],
                },
              ],
              tools: [],
            });
            let title = "";
            for await (const event of stream) {
              if (event.type === "text_delta") {
                title += event.text;
              }
            }
            const finalTitle = title.trim().replace(/^["']|["']$/g, "");
            if (
              finalTitle &&
              activeSession.id === loop.sessionManager.getActiveSession()?.id
            ) {
              activeSession.title = finalTitle;
              loop.sessionManager
                .getSessionStore()
                .updateSession(activeSession);
            }
          } catch {
            // Ignore background title generation errors
          }
        });
      }

      let orchestratorInstance: Orchestrator | null = null;
      if (multi) {
        orchestratorInstance = new Orchestrator(
          cwd,
          config,
          providerInstance,
          trimmed,
          tuiInteraction,
        );
        tui.setActiveRunnable(orchestratorInstance);
      } else {
        tui.setActiveRunnable(loop);
      }

      tui.startThinkingInput();

      try {
        if (orchestratorInstance) {
          await orchestratorInstance.run();
        } else {
          await loop.run();
        }
      } finally {
        tui.stopThinkingInput();
        tui.setActiveRunnable(null);
      }

      // If a guided correction was entered during execution, loop to append and rerun
      while (tui.pendingGuidedStatement) {
        const guidedTask = tui.pendingGuidedStatement;
        tui.pendingGuidedStatement = null;

        const isZh = config.language === "zh";
        tuiInteraction.showText(
          isZh
            ? `\n● 收到引导指令。正在重新规划思考...`
            : `\n● Guided instruction received. Replanning execution...`,
        );

        state.task = guidedTask;
        state.done = false;
        state.attemptCount = 0;
        state.history.push({
          id: `msg_user_${Date.now()}`,
          role: "user",
          createdAt: new Date().toISOString(),
          content: [{ type: "text", text: guidedTask }],
        });

        tui.syncFromLoop(loop);

        let subOrchestrator: Orchestrator | null = null;
        if (multi) {
          subOrchestrator = new Orchestrator(
            cwd,
            config,
            providerInstance,
            guidedTask,
            tuiInteraction,
          );
          tui.setActiveRunnable(subOrchestrator);
        } else {
          tui.setActiveRunnable(loop);
        }

        tui.startThinkingInput();

        try {
          if (subOrchestrator) {
            await subOrchestrator.run();
          } else {
            await loop.run();
          }
        } finally {
          tui.stopThinkingInput();
          tui.setActiveRunnable(null);
        }
      }
      tui.syncFromLoop(loop);
      tui.finishAttempt();

      // Refresh candidates in the background asynchronously
      getAutocompleteCandidates(cwd, config)
        .then((c) => {
          candidates = c;
          tui.setCandidates(c);
        })
        .catch(() => {});
    }
  } finally {
    process.off("SIGINT", sigintHandler);
    watcher?.close();
    if (watchTimeout) clearTimeout(watchTimeout);
    eventBus.off("model_delta", onModelDelta);
    eventBus.off("loop_start", onLoopStart);
    eventBus.off("cost_update", onCostUpdate);
    eventBus.off("thinking_delta", onThinkingDelta);
    tui.dispose();
    autocompleteServer?.close();
    currentTui = null;
  }
}

async function getAutocompleteCandidates(
  cwd: string,
  config: any,
): Promise<{
  commands: string[];
  files: string[];
  symbols: string[];
  sessions: string[];
}> {
  const customCommands = loadCustomCommands(cwd, BUILTIN_SLASH_COMMANDS);
  const commands = [
    ...BUILTIN_SLASH_COMMANDS,
    ...customCommands.map((command) => `/${command.name}`),
  ];
  const files: string[] = [];
  const symbols: string[] = [];
  const sessions: string[] = [];

  const normCwd = resolve(cwd).toLowerCase().replace(/\\/g, "/");
  const normHome = resolve(homedir()).toLowerCase().replace(/\\/g, "/");
  const isHomeOrRoot =
    normCwd === normHome ||
    normCwd === "/" ||
    /^[a-zA-Z]:\/$/.test(normCwd) ||
    dirname(normCwd) === normCwd;

  if (isHomeOrRoot) {
    return {
      commands,
      files,
      symbols,
      sessions,
    };
  }

  try {
    const ignorePatterns = config.context?.ignore || [];
    const globbedFiles = await glob("**/*", {
      cwd,
      ignore: ignorePatterns,
      onlyFiles: true,
      dot: true,
      suppressErrors: true,
    });
    files.push(...globbedFiles);
  } catch {
    // Ignored
  }

  try {
    const indexPath = join(cwd, ".orbit", "symbols.json");
    if (existsSync(indexPath)) {
      const raw = readFileSync(indexPath, "utf8");
      const index = JSON.parse(raw);
      if (index.files && typeof index.files === "object") {
        for (const fileData of Object.values(index.files)) {
          const data = fileData as any;
          if (data && Array.isArray(data.symbols)) {
            for (const sym of data.symbols) {
              if (sym.name) {
                symbols.push(sym.name);
              }
            }
          }
        }
      }
    }
  } catch {
    // Ignored
  }

  try {
    const sessionDir = join(cwd, ".orbit", "sessions");
    if (existsSync(sessionDir)) {
      const { readdirSync: fsReaddir, existsSync: fsExists } =
        await import("fs");
      const dirs = fsReaddir(sessionDir);
      for (const dir of dirs) {
        const sessionFile = join(sessionDir, dir, "session.json");
        if (fsExists(sessionFile)) {
          sessions.push(dir);
        }
      }
    }
  } catch {
    // Ignored
  }

  return {
    commands,
    files,
    symbols: Array.from(new Set(symbols)),
    sessions,
  };
}

function makeCompleter(candidates: {
  commands: string[];
  files: string[];
  symbols: string[];
  sessions: string[];
}) {
  return (line: string): [string[], string] => {
    if (line.startsWith("/")) {
      const hits = candidates.commands.filter((c) => c.startsWith(line));
      return [hits.length ? hits : candidates.commands, line];
    }

    const words = line.split(/\s+/);
    const lastWord = words[words.length - 1] || "";

    if (!lastWord) {
      return [[], lastWord];
    }

    const fileHits = candidates.files.filter((f) => f.startsWith(lastWord));
    const symbolHits = candidates.symbols.filter((s) => s.startsWith(lastWord));
    const allHits = [...fileHits, ...symbolHits];

    return [allHits, lastWord];
  };
}

function getNestedProperty(obj: any, path: string): any {
  const parts = path.split(".");
  let current = obj;
  for (const part of parts) {
    if (current == null || typeof current !== "object") {
      return undefined;
    }
    current = current[part];
  }
  return current;
}

function setNestedProperty(obj: any, path: string, value: any): void {
  const parts = path.split(".");
  let current = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (
      !(part in current) ||
      current[part] == null ||
      typeof current[part] !== "object"
    ) {
      current[part] = {};
    }
    current = current[part];
  }
  current[parts[parts.length - 1]] = value;
}

function copyToClipboard(text: string): boolean {
  const { execSync } = require("child_process");
  try {
    if (process.platform === "win32") {
      execSync("clip", { input: text });
      return true;
    } else if (process.platform === "darwin") {
      execSync("pbcopy", { input: text });
      return true;
    } else {
      try {
        execSync("xclip -selection clipboard", { input: text });
        return true;
      } catch {
        try {
          execSync("xsel -ib", { input: text });
          return true;
        } catch {
          try {
            execSync("wl-copy", { input: text });
            return true;
          } catch {
            return false;
          }
        }
      }
    }
  } catch (err) {
    return false;
  }
}
