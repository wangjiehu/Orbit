import { AgentLoop, UserInteraction } from "@orbit-build/core";
import { FullscreenTui } from "../tui/FullscreenTui.js";
import { ConfigSchema } from "@orbit-build/config";
import { Prompt, type PromptOption } from "@orbit-build/tui";
import picocolors from "picocolors";
import glob from "fast-glob";
import { existsSync, readFileSync, readdirSync, rmSync } from "fs";
import { join, dirname, resolve, relative, isAbsolute } from "path";
import { homedir } from "os";
import { PermissionEngine } from "@orbit-build/permissions";
import {
  expandCustomCommand,
  loadCustomCommands,
} from "../commands/customCommands.js";
import {
  formatModelOptionLabel,
  getProviderModelCandidates,
} from "./ModelCatalog.js";
import { createRequire } from "module";

const require = createRequire(import.meta.url);

export const BUILTIN_SLASH_COMMANDS = [
  "/help",
  "/status",
  "/config",
  "/model",
  "/chat",
  "/commit",
  "/exit",
  "/quit",
  "/rollback",
  "/clear",
  "/add",
  "/drop",
  "/mode",
  "/copy",
  "/run",
  "/update",
] as const;

export class CommandRouter {
  constructor(
    private cwd: string,
    private config: any,
    private providerInstance: any,
    private setProviderInstance: (newProvider: any) => void,
    private loop: AgentLoop,
    private tui: FullscreenTui,
    private useFullscreenTui: boolean,
    private getCandidates: () => any,
    private setCandidates: (candidates: any) => void,
    private getLocalState: () => any,
    private saveLocalState: (state: any) => void,
    private tuiInteraction: UserInteraction,
    private multi?: boolean,
  ) {}

  private printOutput(text: string, raw = false) {
    if (this.tui && this.tui.isActive) {
      this.tui.addSystemMessage(text, raw);
    } else {
      console.log(text);
    }
  }

  public async route(
    input: string,
  ): Promise<{ shouldExit: boolean; processed: boolean }> {
    let trimmed = input.trim();
    if (!trimmed) return { shouldExit: false, processed: false };

    const useFullscreenTui = this.useFullscreenTui;
    const tui = this.tui;
    const config = this.config;
    const loop = this.loop;
    const cwd = this.cwd;

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

    if (
      trimmed.startsWith("!") ||
      trimmed === "/run" ||
      trimmed.startsWith("/run ")
    ) {
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
        return { shouldExit: false, processed: true };
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
        return { shouldExit: false, processed: true };
      }
      if (decision.action === "ask") {
        const approved = await Prompt.askApproval(
          isZh
            ? `命令需要 ${decision.risk} 权限：${shellCmd}`
            : `Command requires ${decision.risk} permission: ${shellCmd}`,
        );
        if (!approved) {
          console.log(
            isZh ? "已取消命令执行。" : "Command execution cancelled.",
          );
          if (wasActive) tui.start(config.budgetLimit);
          return { shouldExit: false, processed: true };
        }
      }

      console.log(
        isZh
          ? picocolors.cyan(`\n正在执行 Shell 命令: ${shellCmd}...`)
          : picocolors.cyan(`\nRunning shell command: ${shellCmd}...`),
      );

      try {
        const { spawnSync } = await import("child_process");
        // NOTE: shell:true is intentional here — the user explicitly typed a shell command.
        // The PermissionEngine above already evaluated and optionally prompted approval.
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
      return { shouldExit: false, processed: true };
    }

    if (trimmed.startsWith("/")) {
      const parts = trimmed.split(" ");
      const command = parts[0].toLowerCase();

      if (command === "/exit" || command === "/quit") {
        console.log(
          picocolors.yellow("Exiting Orbit Interactive Shell. Goodbye!"),
        );
        return { shouldExit: true, processed: true };
      }

      if (command === "/help") {
        const isZh = config.language === "zh";
        let helpText = "";

        if (isZh) {
          helpText = [
            picocolors.bold(picocolors.yellow("[ 上下文管理 (Context) ]")),
            `  ${picocolors.green("/add")}   ${picocolors.cyan("<file>")}     - 添加文件/目录至上下文 (使用 -r 设为只读)`,
            `  ${picocolors.green("/drop")}  ${picocolors.cyan("<file>")}     - 从活动上下文中移除指定文件或通配符`,
            `  ${picocolors.green("/clear")}            - 重置对话历史与屏幕缓存`,
            "",
            picocolors.bold(picocolors.yellow("[ 会话与历史 (Session) ]")),
            `  ${picocolors.green("/chat")}   ${picocolors.cyan("[action]")}   - 管理对话会话 (list/ls, new, delete/rm, switch)`,
            `  ${picocolors.green("/rollback")}         - 回滚最近的文件修改检查点`,
            `  ${picocolors.green("/copy")}             - 拷贝 AI 的最新回复至系统剪贴板`,
            "",
            picocolors.bold(picocolors.yellow("[ 配置与状态 (Settings) ]")),
            `  ${picocolors.green("/status")}           - 诊断并展示当前会话、模型与消耗`,
            `  ${picocolors.green("/config")}   ${picocolors.cyan("[k=v]")}    - 查看或直接修改配置参数`,
            `  ${picocolors.green("/model")}    ${picocolors.cyan("[name]")}   - 动态查询或切换正在使用的语言大模型`,
            `  ${picocolors.green("/mode")}     ${picocolors.cyan("[mode]")}   - 切换安全确认模式 (strict, normal, auto, plan)`,
            `  ${picocolors.green("/update")}           - 检测并更新项目依赖包`,
            "",
            picocolors.bold(picocolors.yellow("[ Git 提交 (Git) ]")),
            `  ${picocolors.green("/commit")}   ${picocolors.cyan("[msg]")}    - 暂存工作区修改并生成提交`,
            "",
            picocolors.bold(picocolors.yellow("[ 系统控制 (System) ]")),
            `  ${picocolors.green("/help")}             - 显示此帮助信息`,
            `  ${picocolors.green("/exit")} / ${picocolors.green("/quit")}     - 安全退出交互式终端`,
            `  ${picocolors.green("!<cmd>")} / ${picocolors.green("/run")} ${picocolors.cyan("<cmd>")} - 直接执行系统原生 Shell 命令`,
          ].join("\n");
        } else {
          helpText = [
            picocolors.bold(picocolors.yellow("[ Context Management ]")),
            `  ${picocolors.green("/add")}   ${picocolors.cyan("<file>")}     - Add file/directory to context (use -r for read-only)`,
            `  ${picocolors.green("/drop")}  ${picocolors.cyan("<file>")}     - Drop file/pattern from active context`,
            `  ${picocolors.green("/clear")}            - Reset dialogue history and clear TUI screen`,
            "",
            picocolors.bold(picocolors.yellow("[ Session & History ]")),
            `  ${picocolors.green("/chat")}   ${picocolors.cyan("[action]")}   - Manage sessions (list/ls, new, delete/rm, switch)`,
            `  ${picocolors.green("/rollback")}         - Rollback to last file modification checkpoint`,
            `  ${picocolors.green("/copy")}             - Copy last AI message to clipboard`,
            "",
            picocolors.bold(picocolors.yellow("[ Configuration & Status ]")),
            `  ${picocolors.green("/status")}           - Show current session, model, and cost`,
            `  ${picocolors.green("/config")}   ${picocolors.cyan("[k=v]")}    - View or modify configurations`,
            `  ${picocolors.green("/model")}    ${picocolors.cyan("[name]")}   - Show or switch active model`,
            `  ${picocolors.green("/mode")}     ${picocolors.cyan("[mode]")}   - Switch permission mode (strict, normal, auto, plan)`,
            `  ${picocolors.green("/update")}           - Check and update dependencies`,
            "",
            picocolors.bold(picocolors.yellow("[ Git Version Control ]")),
            `  ${picocolors.green("/commit")}   ${picocolors.cyan("[msg]")}    - Stage files and commit with auto-generated message`,
            "",
            picocolors.bold(picocolors.yellow("[ System Control ]")),
            `  ${picocolors.green("/help")}             - Show this help screen`,
            `  ${picocolors.green("/exit")} / ${picocolors.green("/quit")}     - Exit interactive shell`,
            `  ${picocolors.green("!<cmd>")} / ${picocolors.green("/run")} ${picocolors.cyan("<cmd>")} - Execute native shell command`,
          ].join("\n");
        }

        this.printOutput(helpText);
        return { shouldExit: false, processed: true };
      }

      if (command === "/rollback") {
        const isZh = config.language === "zh";
        const args = parts.slice(1).join(" ").trim();

        if (args === "all" || args === "--all") {
          await loop.rollbackLastCheckpoint();
          return { shouldExit: false, processed: true };
        }

        const { execFileSync, execSync } = await import("child_process");
        let statusOut = "";
        try {
          statusOut = execSync("git status --porcelain", {
            cwd,
            stdio: ["ignore", "pipe", "ignore"],
          }).toString();
        } catch {
          await loop.rollbackLastCheckpoint();
          return { shouldExit: false, processed: true };
        }

        const lines = statusOut
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean);
        if (lines.length === 0) {
          console.log(
            isZh
              ? picocolors.yellow("当前工作区没有检测到任何未提交的代码变更。")
              : picocolors.yellow(
                  "No uncommitted changes detected in the workspace.",
                ),
          );
          return { shouldExit: false, processed: true };
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

        const wasActive = false;
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
                const rolledBack = (loop as any).rollbackFileToCheckpoint(file);
                if (!rolledBack) {
                  try {
                    execFileSync("git", ["checkout", "--", file], {
                      cwd,
                      stdio: "ignore",
                    });
                  } catch {
                    try {
                      const fullP = resolve(cwd, file);
                      const rel = relative(cwd, fullP);
                      const staysInWorkspace =
                        rel && !rel.startsWith("..") && !isAbsolute(rel);
                      if (existsSync(fullP) && staysInWorkspace) {
                        rmSync(fullP, { recursive: true, force: true });
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
        return { shouldExit: false, processed: true };
      }

      if (command === "/update") {
        const isZh = config.language === "zh";
        const wasActive = useFullscreenTui && tui.isActive;

        // 1. Check if package.json exists
        const packageJsonPath = join(cwd, "package.json");
        if (!existsSync(packageJsonPath)) {
          console.log(
            isZh
              ? picocolors.yellow(
                  "当前工作区没有检测到 package.json，不支持 npm 更新。",
                )
              : picocolors.yellow(
                  "No package.json found in the workspace. npm update not supported.",
                ),
          );
          return { shouldExit: false, processed: true };
        }

        // 2. Determine command to use
        let installCmd = "npm install";
        if (existsSync(join(cwd, "pnpm-lock.yaml"))) {
          installCmd = "pnpm install";
        } else if (existsSync(join(cwd, "yarn.lock"))) {
          installCmd = "yarn install";
        } else if (existsSync(join(cwd, "bun.lockb"))) {
          installCmd = "bun install";
        }

        if (wasActive) tui.stop();

        try {
          const approved = await Prompt.askApproval(
            isZh
              ? `检测到项目依赖需要更新，是否运行 "${installCmd}"？`
              : `NPM dependencies need update. Run "${installCmd}"?`,
          );

          if (approved) {
            console.log(picocolors.cyan(`\n● Running "${installCmd}"...`));
            const { execSync } = await import("child_process");
            execSync(installCmd, { cwd, stdio: "inherit" });
            console.log(
              picocolors.green(`✔ Dependencies updated successfully.\n`),
            );

            // Force clear TUI's cached npm check status so the heart turns red immediately
            (tui as any).npmNeedsUpdate = false;
            (tui as any).lastNpmCheckTime = Date.now();
          } else {
            console.log(picocolors.yellow(`\n✖ Update cancelled by user.\n`));
          }
        } catch (err: any) {
          console.log(picocolors.red(`\n✖ Update failed: ${err.message}\n`));
        } finally {
          tui.syncFromLoop(loop);
          if (wasActive) tui.start(config.budgetLimit);
        }
        return { shouldExit: false, processed: true };
      }

      if (command === "/status") {
        const isZh = config.language === "zh";
        const activeConfig = loop.getConfig();
        const activeModel =
          loop.getModelOverride() || activeConfig.models.default;
        const budgetLimit = activeConfig.budgetLimit;
        const currentCost = loop.getSessionCost();
        const mode = activeConfig.permissions.mode;
        const costPct =
          budgetLimit > 0
            ? Math.min(100, (currentCost / budgetLimit) * 100).toFixed(1)
            : "N/A";
        const barLen = 24;
        const filledLen =
          budgetLimit > 0
            ? Math.round((currentCost / budgetLimit) * barLen)
            : 0;
        const bar =
          picocolors.green("█".repeat(filledLen)) +
          picocolors.gray("░".repeat(Math.max(0, barLen - filledLen)));

        const statusLines = isZh
          ? [
              picocolors.bold("会话概况"),
              "",
              `  🆔  ${picocolors.gray("Session ID")}    ${picocolors.cyan(loop.getSessionId())}`,
              `  🔌  ${picocolors.gray("Provider")}      ${picocolors.cyan(this.providerInstance.id)}`,
              `  🤖  ${picocolors.gray("Active Model")}  ${picocolors.cyan(activeModel)}`,
              `  🛡️  ${picocolors.gray("Security Mode")} ${picocolors.green(mode.toUpperCase())}`,
              "",
              picocolors.bold("费用与预算"),
              "",
              `  💰  $${picocolors.yellow(currentCost.toFixed(4))} / $${picocolors.gray(budgetLimit.toFixed(2))}  (${costPct}%)`,
              `       ${bar}`,
            ]
          : [
              picocolors.bold("Session Overview"),
              "",
              `  🆔  ${picocolors.gray("Session ID")}    ${picocolors.cyan(loop.getSessionId())}`,
              `  🔌  ${picocolors.gray("Provider")}      ${picocolors.cyan(this.providerInstance.id)}`,
              `  🤖  ${picocolors.gray("Active Model")}  ${picocolors.cyan(activeModel)}`,
              `  🛡️  ${picocolors.gray("Security Mode")} ${picocolors.green(mode.toUpperCase())}`,
              "",
              picocolors.bold("Budget & Cost"),
              "",
              `  💰  $${picocolors.yellow(currentCost.toFixed(4))} / $${picocolors.gray(budgetLimit.toFixed(2))}  (${costPct}%)`,
              `       ${bar}`,
            ];

        this.printOutput(statusLines.join("\n"));
        return { shouldExit: false, processed: true };
      }

      if (command === "/config") {
        const configArg = parts.slice(1).join(" ").trim();
        const activeConfig = loop.getConfig();

        if (configArg) {
          const eqIndex = configArg.indexOf("=");
          if (eqIndex === -1) {
            this.printOutput(
              picocolors.yellow(
                "Usage: /config <key>=<value> or just /config for interactive menu.",
              ),
            );
            return { shouldExit: false, processed: true };
          }
          const key = configArg.slice(0, eqIndex).trim();
          const rawVal = configArg.slice(eqIndex + 1).trim();

          const currentVal = this.getNestedProperty(activeConfig, key);
          if (currentVal === undefined) {
            this.printOutput(
              picocolors.red(`Error: Unknown configuration key "${key}".`),
            );
            return { shouldExit: false, processed: true };
          }

          let parsedVal: any = rawVal;
          if (typeof currentVal === "boolean") {
            const lowerVal = rawVal.toLowerCase();
            if (lowerVal === "true" || lowerVal === "1") parsedVal = true;
            else if (lowerVal === "false" || lowerVal === "0")
              parsedVal = false;
            else {
              this.printOutput(
                picocolors.red(
                  `Error: Key "${key}" expects a boolean value (true/false).`,
                ),
              );
              return { shouldExit: false, processed: true };
            }
          } else if (typeof currentVal === "number") {
            const num = Number(rawVal);
            if (isNaN(num)) {
              this.printOutput(
                picocolors.red(`Error: Key "${key}" expects a numeric value.`),
              );
              return { shouldExit: false, processed: true };
            }
            parsedVal = num;
          } else if (Array.isArray(currentVal)) {
            parsedVal = rawVal
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean);
          }

          const testConfig = JSON.parse(JSON.stringify(activeConfig));
          this.setNestedProperty(testConfig, key, parsedVal);

          const parseResult = ConfigSchema.safeParse(testConfig);
          if (!parseResult.success) {
            this.printOutput(
              picocolors.red(
                `Configuration validation failed: ${parseResult.error.message}`,
              ),
            );
            return { shouldExit: false, processed: true };
          }

          this.setNestedProperty(activeConfig, key, parsedVal);
          this.printOutput(
            picocolors.green(`✔ Updated "${key}" to: ${parsedVal}`),
          );
          return { shouldExit: false, processed: true };
        }

        const wasActive = false;
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
            const currentSearchProvider = activeConfig.tools.webSearch.provider;
            const currentSearchUrls = activeConfig.tools.webSearch.searxngUrls;
            const currentSearchTimeout = activeConfig.tools.webSearch.timeoutMs;
            const currentSearchMaxResults =
              activeConfig.tools.webSearch.maxResults;
            const currentAgentMaxIterations =
              (activeConfig as any).agent?.maxIterations || 8;
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
                  value: "tools.webSearch.provider",
                  label: `🔎 tools.webSearch.provider (current: ${currentSearchProvider})`,
                },
                {
                  value: "tools.webSearch.searxngUrls",
                  label: `🧭 tools.webSearch.searxngUrls (current: ${currentSearchUrls.join(", ") || "auto/env/local"})`,
                },
                {
                  value: "tools.webSearch.timeoutMs",
                  label: `⏱️  tools.webSearch.timeoutMs (current: ${currentSearchTimeout})`,
                },
                {
                  value: "tools.webSearch.maxResults",
                  label: `📚 tools.webSearch.maxResults (current: ${currentSearchMaxResults})`,
                },
                {
                  value: "agent.maxIterations",
                  label: `🔁 agent.maxIterations (current: ${currentAgentMaxIterations})`,
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

            const currentVal = this.getNestedProperty(activeConfig, choice);
            if (typeof currentVal === "boolean") {
              const nextVal = await Prompt.askSelect(`Set ${choice} to:`, [
                { value: "true", label: "true" },
                { value: "false", label: "false" },
              ]);
              if (nextVal !== null && nextVal !== "") {
                const boolVal = nextVal === "true";
                const testConfig = JSON.parse(JSON.stringify(activeConfig));
                this.setNestedProperty(testConfig, choice, boolVal);
                const parseResult = ConfigSchema.safeParse(testConfig);
                if (parseResult.success) {
                  this.setNestedProperty(activeConfig, choice, boolVal);
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
                this.setNestedProperty(testConfig, choice, nextVal);
                const parseResult = ConfigSchema.safeParse(testConfig);
                if (parseResult.success) {
                  this.setNestedProperty(activeConfig, choice, nextVal);
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
            } else if (choice === "tools.webSearch.provider") {
              const nextVal = await Prompt.askSelect(
                "Set tools.webSearch.provider to:",
                [
                  {
                    value: "auto",
                    label:
                      "auto (SearXNG/Tavily first, Bing/DuckDuckGo fallback)",
                  },
                  {
                    value: "searxng",
                    label: "searxng (configured/self-hosted JSON endpoint)",
                  },
                  {
                    value: "tavily",
                    label: "tavily (requires TAVILY_API_KEY)",
                  },
                  {
                    value: "bing",
                    label: "bing (no-key HTML fallback, broadly reachable)",
                  },
                  {
                    value: "duckduckgo",
                    label: "duckduckgo (no-key HTML fallback)",
                  },
                ],
              );
              if (nextVal !== null && nextVal !== "") {
                const testConfig = JSON.parse(JSON.stringify(activeConfig));
                this.setNestedProperty(testConfig, choice, nextVal);
                const parseResult = ConfigSchema.safeParse(testConfig);
                if (parseResult.success) {
                  this.setNestedProperty(activeConfig, choice, nextVal);
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
            } else if (typeof currentVal === "number") {
              const nextValStr = await Prompt.askText(
                `Enter numeric value for ${choice}:`,
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
                  this.setNestedProperty(testConfig, choice, numVal);
                  const parseResult = ConfigSchema.safeParse(testConfig);
                  if (parseResult.success) {
                    this.setNestedProperty(activeConfig, choice, numVal);
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
                this.setNestedProperty(testConfig, choice, arrVal);
                const parseResult = ConfigSchema.safeParse(testConfig);
                if (parseResult.success) {
                  this.setNestedProperty(activeConfig, choice, arrVal);
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
                this.setNestedProperty(testConfig, choice, nextValStr);
                const parseResult = ConfigSchema.safeParse(testConfig);
                if (parseResult.success) {
                  this.setNestedProperty(activeConfig, choice, nextValStr);
                  console.log(
                    picocolors.green(`✔ Updated "${choice}" to: ${nextValStr}`),
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
        return { shouldExit: false, processed: true };
      }

      if (command === "/model") {
        const modelArg = parts.slice(1).join(" ").trim();
        const activeConfig = loop.getConfig();
        if (!modelArg) {
          const wasActive = false;
          if (wasActive) tui.stop();
          try {
            const activeModel =
              loop.getModelOverride() || activeConfig.models.default;
            const providerId = this.providerInstance.id;
            const modelOptions: Array<{ value: string; label: string }> =
              getProviderModelCandidates(activeConfig, providerId).map(
                (model) => ({
                  value: model,
                  label: formatModelOptionLabel(model),
                }),
              );

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
              return { shouldExit: false, processed: true };
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
                this.printOutput(
                  `Switched active model to: ${picocolors.green(customModel)}`,
                );
              } else {
                return { shouldExit: false, processed: true };
              }
            } else {
              loop.setModelOverride(selectedModel);
              if (wasActive && !tui.isActive) {
                tui.start(config.budgetLimit);
              }
              this.printOutput(
                `Switched active model to: ${picocolors.green(selectedModel)}`,
              );
            }
            this.saveLocalState({ lastModel: finalModel });
          } finally {
            if (wasActive && !tui.isActive) {
              tui.start(config.budgetLimit);
            }
          }
          return { shouldExit: false, processed: true };
        }

        loop.setModelOverride(modelArg);
        this.printOutput(
          `Switched active model to: ${picocolors.green(modelArg)}`,
        );
        this.saveLocalState({ lastModel: modelArg });
        return { shouldExit: false, processed: true };
      }

      if (command === "/commit") {
        const commitMsg = parts.slice(1).join(" ").trim();
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
              return { shouldExit: false, processed: true };
            }

            const wasActive = false;
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
              return { shouldExit: false, processed: true };
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
              return { shouldExit: false, processed: true };
            }
          }

          let finalMsg = commitMsg;
          if (!finalMsg) {
            console.log("Generating commit message via LLM...");
            const fastModel = config.models.fast || config.models.default;
            const stream = this.providerInstance.chat({
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
        return { shouldExit: false, processed: true };
      }

      if (command === "/add") {
        let fileArg = parts.slice(1).join(" ").trim();
        const isZh = config.language === "zh";
        const candidates = this.getCandidates();

        let readOnly = false;
        if (
          fileArg.startsWith("--read-only ") ||
          fileArg.startsWith("--readonly ") ||
          fileArg.startsWith("-r ")
        ) {
          readOnly = true;
          fileArg = fileArg
            .replace(/^(--read-only|--readonly|-r)\s+/, "")
            .trim();
        } else if (
          fileArg === "--read-only" ||
          fileArg === "--readonly" ||
          fileArg === "-r"
        ) {
          readOnly = true;
          fileArg = "";
        }

        if (!fileArg) {
          const wasActive = false;
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
                return { shouldExit: false, processed: true };
              }

              let filtered = candidates.files;
              if (filterQuery.trim()) {
                const q = filterQuery.trim().toLowerCase();
                filtered = candidates.files.filter((f: string) =>
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
                const options = filtered.map((f: string) => ({
                  value: f,
                  label: f,
                }));
                const selected = await Prompt.askMultiSelect(
                  isZh
                    ? readOnly
                      ? "选择要添加到上下文的只读参考文件："
                      : "选择要添加到上下文的文件："
                    : readOnly
                      ? "Select files to add as read-only reference context:"
                      : "Select files to add to the context:",
                  options,
                );
                if (selected && selected.length > 0) {
                  for (const f of selected) {
                    if (readOnly) {
                      loop.addReadOnlyFilePublic(
                        f,
                        "Manually added via interactive /add --read-only",
                      );
                    } else {
                      loop.addRelevantFilePublic(
                        f,
                        "Manually added via interactive /add",
                      );
                    }
                  }
                  console.log(
                    isZh
                      ? readOnly
                        ? picocolors.green(
                            `✔ 成功添加 ${selected.length} 个只读文件到上下文。`,
                          )
                        : picocolors.green(
                            `✔ 成功添加 ${selected.length} 个文件到上下文。`,
                          )
                      : readOnly
                        ? picocolors.green(
                            `✔ Added ${selected.length} read-only file(s) to active context.`,
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
          return { shouldExit: false, processed: true };
        }

        const {
          isAbsolute,
          relative,
          resolve: pathResolve,
        } = await import("path");
        const { statSync } = await import("fs");
        const absPath = isAbsolute(fileArg)
          ? fileArg
          : pathResolve(cwd, fileArg);
        const relPath = relative(cwd, absPath).replace(/\\/g, "/");

        if (!existsSync(absPath)) {
          if (fileArg.includes("*") || fileArg.includes("?")) {
            const escaped = fileArg
              .replace(/[.+^${}()|[\]\\]/g, "\\$&")
              .replace(/\*\*/g, "__DOUBLE_STAR__")
              .replace(/\*/g, "[^/]*")
              .replace(/__DOUBLE_STAR__\/?/g, "(?:|.*/)");
            const rx = new RegExp("^" + escaped + "$", "i");
            const matched = (candidates?.files || []).filter((f: string) =>
              rx.test(f),
            );
            if (matched.length > 0) {
              for (const f of matched) {
                if (readOnly) {
                  loop.addReadOnlyFilePublic(f, "Matched via glob /add");
                } else {
                  loop.addRelevantFilePublic(f, "Matched via glob /add");
                }
              }
              console.log(
                isZh
                  ? readOnly
                    ? picocolors.green(
                        `✔ 已通过通配符自动添加 ${matched.length} 个只读文件到上下文。`,
                      )
                    : picocolors.green(
                        `✔ 已通过通配符自动添加 ${matched.length} 个文件到上下文。`,
                      )
                  : readOnly
                    ? picocolors.green(
                        `✔ Automatically added ${matched.length} read-only file(s) via wildcard.`,
                      )
                    : picocolors.green(
                        `✔ Automatically added ${matched.length} file(s) via wildcard.`,
                      ),
              );
              tui.syncFromLoop(loop);
            } else {
              console.log(
                isZh
                  ? picocolors.yellow(
                      `没有找到匹配通配符 "${fileArg}" 的文件。`,
                    )
                  : picocolors.yellow(
                      `No files matching wildcard "${fileArg}" were found.`,
                    ),
              );
            }
            return { shouldExit: false, processed: true };
          }

          const matched = (candidates?.files || []).filter(
            (f: string) =>
              f.toLowerCase().includes(fileArg.toLowerCase()) ||
              f.toLowerCase().endsWith("/" + fileArg.toLowerCase()),
          );
          if (matched.length === 1) {
            if (readOnly) {
              loop.addReadOnlyFilePublic(
                matched[0],
                "Fuzzy matched via /add --read-only",
              );
              console.log(
                isZh
                  ? picocolors.green(`✔ 自动匹配并添加只读文件: ${matched[0]}`)
                  : picocolors.green(
                      `✔ Auto-matched and added read-only file: ${matched[0]}`,
                    ),
              );
            } else {
              loop.addRelevantFilePublic(matched[0], "Fuzzy matched via /add");
              console.log(
                isZh
                  ? picocolors.green(`✔ 自动匹配并添加文件: ${matched[0]}`)
                  : picocolors.green(
                      `✔ Auto-matched and added file: ${matched[0]}`,
                    ),
              );
            }
            tui.syncFromLoop(loop);
            return { shouldExit: false, processed: true };
          } else if (matched.length > 1) {
            console.log(
              isZh
                ? picocolors.yellow(
                    `找到多个匹配文件，请精确输入路径或使用无参交互选择:\n${matched.map((m: string) => `  • ${m}`).join("\n")}`,
                  )
                : picocolors.yellow(
                    `Multiple matches found, please specify or use interactive select:\n${matched.map((m: string) => `  • ${m}`).join("\n")}`,
                  ),
            );
            return { shouldExit: false, processed: true };
          }
          console.log(
            isZh
              ? picocolors.red(`文件不存在: ${fileArg}`)
              : picocolors.red(`File does not exist: ${fileArg}`),
          );
          return { shouldExit: false, processed: true };
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
              if (readOnly) {
                loop.addReadOnlyFilePublic(
                  subRelPath,
                  "Manually added directory via /add --read-only",
                );
              } else {
                loop.addRelevantFilePublic(
                  subRelPath,
                  "Manually added directory via /add",
                );
              }
            }
            console.log(
              isZh
                ? readOnly
                  ? picocolors.green(
                      `✔ 成功添加目录 ${relPath} 下的所有只读文件到上下文。`,
                    )
                  : picocolors.green(
                      `✔ 成功添加目录 ${relPath} 下的所有文件到上下文。`,
                    )
                : readOnly
                  ? picocolors.green(
                      `✔ Added all files in directory ${relPath} as read-only to active context.`,
                    )
                  : picocolors.green(
                      `✔ Added all files in directory ${relPath} to active context.`,
                    ),
            );
          } else {
            if (readOnly) {
              loop.addReadOnlyFilePublic(
                relPath,
                "Manually added file via /add --read-only",
              );
              console.log(
                isZh
                  ? picocolors.green(`✔ 已将只读文件 ${relPath} 添加到上下文。`)
                  : picocolors.green(
                      `✔ Added read-only file ${relPath} to active context.`,
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
          }
          tui.syncFromLoop(loop);
        } catch (err: any) {
          console.log(
            isZh
              ? picocolors.red(`添加失败: ${err.message}`)
              : picocolors.red(`Failed to add: ${err.message}`),
          );
        }
        return { shouldExit: false, processed: true };
      }

      if (command === "/drop") {
        const fileArg = parts.slice(1).join(" ").trim();
        const isZh = config.language === "zh";
        if (!fileArg) {
          const wasActive = false;
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
          return { shouldExit: false, processed: true };
        }

        if (fileArg === "all" || fileArg === "*") {
          loop.clearRelevantFilesPublic();
          tui.syncFromLoop(loop);
          console.log(
            isZh
              ? picocolors.green(`✔ 已从上下文中清空所有文件。`)
              : picocolors.green(`✔ Cleared all files from active context.`),
          );
          return { shouldExit: false, processed: true };
        }

        const {
          isAbsolute,
          relative,
          resolve: pathResolve,
        } = await import("path");
        const absPath = isAbsolute(fileArg)
          ? fileArg
          : pathResolve(cwd, fileArg);
        const relPath = relative(cwd, absPath).replace(/\\/g, "/");

        const beforeCount = loop.getRelevantFiles().length;
        loop.removeRelevantFilePublic(relPath);

        // Glob/regex fallback for dropping files by pattern
        const activeFiles = loop.getRelevantFiles().map((f) => f.path);
        const escaped = fileArg
          .replace(/[.+^${}()|[\]\\]/g, "\\$&")
          .replace(/\*\*/g, "__DOUBLE_STAR__")
          .replace(/\*/g, "[^/]*")
          .replace(/__DOUBLE_STAR__\/?/g, "(?:|.*/)");
        const rx = new RegExp("^" + escaped + "$", "i");

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
        return { shouldExit: false, processed: true };
      }

      if (command === "/clear") {
        loop.clearHistoryPublic();
        tui.loadHistory([]);
        if (!useFullscreenTui) {
          console.clear();
        }
        return { shouldExit: false, processed: true };
      }

      if (command === "/chat") {
        const wasActive = false;
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
          this.printOutput(msg);
        };

        try {
          const subCommand = parts[1]?.toLowerCase();
          const arg = parts.slice(2).join(" ").trim();
          const isZh = config.language === "zh";

          let sessions = loop.getSessions();

          // Function to delete session and adjust active session if needed
          const handleDelete = (
            idToDelete: string,
            options: { quiet?: boolean } = {},
          ) => {
            loop.deleteSession(idToDelete);
            if (!options.quiet) {
              restoreTuiAndPrint(
                picocolors.green(
                  `✔ Session ${idToDelete} deleted successfully.`,
                ),
              );
            }

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
                  tui.loadHistory(loop.getHistory(), {
                    silent: options.quiet && useFullscreenTui,
                  });
                  if (!options.quiet) {
                    restoreTuiAndPrint(
                      picocolors.green(
                        `✔ Automatically switched to session: ${targetSession.id}`,
                      ),
                    );
                  }
                  this.saveLocalState({
                    lastSessionId: targetSession.id,
                    lastModel: loop.getModelOverride() || config.models.default,
                  });
                }
              } else {
                // No sessions left, start a new one
                const activeModel =
                  loop.getModelOverride() || config.models.default;
                const newSessionId = loop.startNewSession(
                  this.providerInstance.id,
                  activeModel,
                );
                tui.loadHistory([], {
                  silent: options.quiet && useFullscreenTui,
                });
                if (!options.quiet) {
                  restoreTuiAndPrint(
                    picocolors.green(
                      `✔ Automatically started new session: ${newSessionId}`,
                    ),
                  );
                }
                this.saveLocalState({
                  lastSessionId: newSessionId,
                  lastModel: activeModel,
                });
              }
            }
          };

          const getNextSelectionAfterDelete = (
            sessionsBeforeDelete: any[],
            deletedId: string,
            emptyFallback?: string,
          ): string | undefined => {
            const deletedIndex = sessionsBeforeDelete.findIndex(
              (session: any) => session.id === deletedId,
            );
            const remaining = sessionsBeforeDelete.filter(
              (session: any) => session.id !== deletedId,
            );
            if (remaining.length === 0) {
              return emptyFallback;
            }
            const nextIndex =
              deletedIndex < 0
                ? 0
                : Math.min(deletedIndex, remaining.length - 1);
            return remaining[nextIndex]?.id;
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
            return { shouldExit: false, processed: true };
          }

          // CLI subcommand: /chat delete / rm / del
          if (
            subCommand === "delete" ||
            subCommand === "rm" ||
            subCommand === "del"
          ) {
            let idToDelete = arg;
            if (!idToDelete) {
              let deletePickerInitialSelectedValue: string | undefined;
              while (true) {
                sessions = loop.getSessions();
                if (sessions.length === 0) {
                  restoreTuiAndPrint(
                    picocolors.yellow(
                      "No active or saved sessions found to delete.",
                    ),
                  );
                  return { shouldExit: false, processed: true };
                }
                const deleteOptions: PromptOption[] = sessions.map((s: any) => {
                  const formattedDate = new Date(s.createdAt).toLocaleString();
                  return {
                    value: s.id,
                    label: `${s.id} - ${s.title || "Untitled"} (${formattedDate}) [${s.model}]`,
                  };
                });
                deleteOptions.push({
                  value: "cancel",
                  label: isZh ? "取消" : "Cancel",
                  deleteDisabled: true,
                });
                stopTuiIfNeeded();
                const deleteSelection = await Prompt.askSelectWithDelete(
                  isZh
                    ? "选择会话，按 Del 标记，再按 Del 确认删除；Esc 退出:"
                    : "Choose a session, press Del once to mark and Del again to delete; Esc exits:",
                  deleteOptions,
                  {
                    initialSelectedValue: deletePickerInitialSelectedValue,
                    suppressCloseRenderOnDelete: useFullscreenTui,
                  },
                );
                if (deleteSelection.action === "delete") {
                  const sessionsBeforeDelete = sessions;
                  idToDelete = deleteSelection.value;
                  deletePickerInitialSelectedValue =
                    getNextSelectionAfterDelete(
                      sessionsBeforeDelete,
                      idToDelete,
                    );
                  handleDelete(idToDelete, { quiet: useFullscreenTui });
                  continue;
                }
                if (deleteSelection.action === "select") {
                  restoreTuiAndPrint(
                    picocolors.yellow(
                      isZh
                        ? "删除会话需要按 Del 标记，再按 Del 确认。"
                        : "Press Del once to mark the session and Del again to delete it.",
                    ),
                  );
                  continue;
                }
                return { shouldExit: false, processed: true };
              }
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
                  return { shouldExit: false, processed: true };
                }
              }
            }

            if (!idToDelete || idToDelete === "cancel") {
              return { shouldExit: false, processed: true };
            }

            handleDelete(idToDelete);
            return { shouldExit: false, processed: true };
          }

          // CLI subcommand: /chat new / create
          if (subCommand === "new" || subCommand === "create") {
            const activeModel =
              loop.getModelOverride() || config.models.default;
            const newSessionId = loop.startNewSession(
              this.providerInstance.id,
              activeModel,
            );
            tui.loadHistory([]);
            restoreTuiAndPrint(
              picocolors.green(`✔ Started new session: ${newSessionId}`),
            );

            this.saveLocalState({
              lastSessionId: newSessionId,
              lastModel: activeModel,
            });
            return { shouldExit: false, processed: true };
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
              return { shouldExit: false, processed: true };
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
              return { shouldExit: false, processed: true };
            }

            const success = loop.resumeSession(targetId);
            if (success) {
              tui.loadHistory(loop.getHistory());
              restoreTuiAndPrint(
                picocolors.green(`✔ Switched to session: ${targetId}`),
              );

              this.saveLocalState({
                lastSessionId: targetId,
                lastModel: loop.getModelOverride() || config.models.default,
              });
            } else {
              restoreTuiAndPrint(
                picocolors.red(`✖ Failed to resume session: ${targetId}`),
              );
            }
            return { shouldExit: false, processed: true };
          }

          // Fallback: If no subcommands, show the interactive select menu
          if (sessions.length === 0) {
            // start a new session since none exist
            const activeModel =
              loop.getModelOverride() || config.models.default;
            const newSessionId = loop.startNewSession(
              this.providerInstance.id,
              activeModel,
            );
            tui.loadHistory([]);
            restoreTuiAndPrint(
              picocolors.green(`✔ Started new session: ${newSessionId}`),
            );
            this.saveLocalState({
              lastSessionId: newSessionId,
              lastModel: activeModel,
            });
            return { shouldExit: false, processed: true };
          }

          let chatMenuInitialSelectedValue: string | undefined;
          while (true) {
            sessions = loop.getSessions();
            if (sessions.length === 0) {
              const activeModel =
                loop.getModelOverride() || config.models.default;
              const newSessionId = loop.startNewSession(
                this.providerInstance.id,
                activeModel,
              );
              tui.loadHistory([]);
              restoreTuiAndPrint(
                picocolors.green(`✔ Started new session: ${newSessionId}`),
              );
              this.saveLocalState({
                lastSessionId: newSessionId,
                lastModel: activeModel,
              });
              return { shouldExit: false, processed: true };
            }

            const sessionOptions: PromptOption[] = sessions.map((s: any) => {
              const formattedDate = new Date(s.createdAt).toLocaleString();
              return {
                value: s.id,
                label: `${s.id} - ${s.title || "Untitled"} (${formattedDate}) [${s.model}]`,
              };
            });

            sessionOptions.unshift({
              value: "new",
              label: picocolors.green(
                isZh ? "+ 新建会话" : "+ Start a new session",
              ),
              deleteDisabled: true,
            });
            sessionOptions.push({
              value: "cancel",
              label: isZh ? "取消" : "Cancel",
              deleteDisabled: true,
            });

            stopTuiIfNeeded();
            const sessionSelection = await Prompt.askSelectWithDelete(
              isZh
                ? "选择会话，Enter 打开；会话行可按 Del 标记，再按 Del 删除；Esc 退出:"
                : "Choose a session. Enter opens it; Del marks a session and Del again deletes it; Esc exits:",
              sessionOptions,
              {
                initialSelectedValue: chatMenuInitialSelectedValue,
                suppressCloseRenderOnDelete: useFullscreenTui,
              },
            );

            if (sessionSelection.action === "delete") {
              const sessionsBeforeDelete = sessions;
              chatMenuInitialSelectedValue = getNextSelectionAfterDelete(
                sessionsBeforeDelete,
                sessionSelection.value,
                "new",
              );
              handleDelete(sessionSelection.value, { quiet: useFullscreenTui });
              continue;
            }

            const selectedSessionId =
              sessionSelection.action === "select"
                ? sessionSelection.value
                : "";

            if (!selectedSessionId || selectedSessionId === "cancel") {
              return { shouldExit: false, processed: true };
            }

            if (selectedSessionId === "new") {
              const activeModel =
                loop.getModelOverride() || config.models.default;
              const newSessionId = loop.startNewSession(
                this.providerInstance.id,
                activeModel,
              );
              tui.loadHistory([]);
              restoreTuiAndPrint(
                picocolors.green(`✔ Started new session: ${newSessionId}`),
              );

              this.saveLocalState({
                lastSessionId: newSessionId,
                lastModel: activeModel,
              });
            } else {
              const success = loop.resumeSession(selectedSessionId);
              if (success) {
                tui.loadHistory(loop.getHistory());
                restoreTuiAndPrint(
                  picocolors.green(
                    `✔ Switched to session: ${selectedSessionId}`,
                  ),
                );

                this.saveLocalState({
                  lastSessionId: selectedSessionId,
                  lastModel: loop.getModelOverride() || config.models.default,
                });
              } else {
                restoreTuiAndPrint(
                  picocolors.red(
                    `Failed to resume session: ${selectedSessionId}`,
                  ),
                );
              }
            }
            return { shouldExit: false, processed: true };
          }
        } finally {
          try {
            tui.setCandidates(await getAutocompleteCandidates(cwd, config));
          } catch {}
          if (wasActive) tui.start(config.budgetLimit);
        }
        return { shouldExit: false, processed: true };
      }

      if (command === "/mode") {
        const isZh = config.language === "zh";
        const targetMode = parts.slice(1).join(" ").trim().toLowerCase();
        const currentMode = loop.getConfig().permissions.mode;

        const modeDescriptions: Record<string, string> = isZh
          ? {
              strict: "Strict  — 所有工具调用必须逐一确认",
              normal: "Normal  — 写入/执行操作需要确认",
              auto: "Auto    — 完全自动执行，仅阻止危险操作",
              plan: "Plan    — 规划模式，无实际文件修改",
            }
          : {
              strict: "Strict  — Confirm every tool call before execution",
              normal: "Normal  — Confirm write/exec operations only",
              auto: "Auto    — Fully autonomous, blocks dangerous cmds only",
              plan: "Plan    — Planning mode, no actual file changes",
            };

        if (!targetMode) {
          // No arg: show interactive overlay picker
          if (useFullscreenTui && tui.isActive) {
            const question = isZh
              ? `当前模式: ${picocolors.cyan(currentMode.toUpperCase())}\n\n选择新的安全模式:`
              : `Current mode: ${picocolors.cyan(currentMode.toUpperCase())}\n\nSelect a security mode:`;
            const choice = await Prompt.askSelect(question, [
              { value: "strict", label: modeDescriptions.strict },
              { value: "normal", label: modeDescriptions.normal },
              { value: "auto", label: modeDescriptions.auto },
              { value: "plan", label: modeDescriptions.plan },
            ]);
            if (choice && choice !== currentMode) {
              loop.getConfig().permissions.mode = choice as any;
              tui.syncFromLoop(loop);
            }
          } else {
            console.log(
              isZh
                ? picocolors.yellow("用法: /mode <strict|normal|auto|plan>")
                : picocolors.yellow("Usage: /mode <strict|normal|auto|plan>"),
            );
          }
          return { shouldExit: false, processed: true };
        }

        const validModes = ["strict", "normal", "auto", "plan"];
        if (!validModes.includes(targetMode)) {
          this.printOutput(
            isZh
              ? picocolors.red(
                  `✖ 无效的安全模式: ${targetMode}。可选模式: ${validModes.join(", ")}`,
                )
              : picocolors.red(
                  `✖ Invalid security mode: ${targetMode}. Valid modes: ${validModes.join(", ")}`,
                ),
          );
          return { shouldExit: false, processed: true };
        }

        loop.getConfig().permissions.mode = targetMode as any;
        tui.syncFromLoop(loop);
        if (useFullscreenTui && tui.isActive) {
          const msg = isZh
            ? `当前模式: ${picocolors.cyan(currentMode.toUpperCase())}\n\n${picocolors.green("✔")} 已切换安全模式至: ${picocolors.green(targetMode.toUpperCase())}`
            : `Previous mode: ${picocolors.cyan(currentMode.toUpperCase())}\n\n${picocolors.green("✔")} Switched security mode to: ${picocolors.green(targetMode.toUpperCase())}`;
          await Prompt.askSelect(msg, [
            { value: "ok", label: isZh ? "返回对话" : "Return to Chat" },
          ]);
        } else {
          this.printOutput(
            isZh
              ? picocolors.green(
                  `✔ 已切换安全模式至: ${targetMode.toUpperCase()}`,
                )
              : picocolors.green(
                  `✔ Switched security mode to: ${targetMode.toUpperCase()}`,
                ),
          );
        }
        return { shouldExit: false, processed: true };
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
          return { shouldExit: false, processed: true };
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
          return { shouldExit: false, processed: true };
        }

        const copied = this.copyToClipboard(textToCopy);
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
        return { shouldExit: false, processed: true };
      }

      this.printOutput(
        picocolors.red(
          `Unknown command: ${trimmed}. Type /help for available commands.`,
        ),
      );
      return { shouldExit: false, processed: true };
    }

    return { shouldExit: false, processed: false };
  }

  private getNestedProperty(obj: any, path: string): any {
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

  private setNestedProperty(obj: any, path: string, value: any): void {
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

  private copyToClipboard(text: string): boolean {
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
    } catch {
      return false;
    }
  }
}

export async function getAutocompleteCandidates(
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
      const dirs = readdirSync(sessionDir);
      for (const dir of dirs) {
        const sessionFile = join(sessionDir, dir, "session.json");
        if (existsSync(sessionFile)) {
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
