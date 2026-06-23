import { AgentLoop, UserInteraction } from "@orbit-build/core";
import { FullscreenTui } from "../tui/FullscreenTui.js";
import { ConfigSchema } from "@orbit-build/config";
import { Prompt } from "@orbit-build/tui";
import picocolors from "picocolors";
import glob from "fast-glob";
import { existsSync, readFileSync, readdirSync, unlinkSync } from "fs";
import { join, dirname, resolve } from "path";
import { homedir } from "os";
import { PermissionEngine } from "@orbit-build/permissions";
import { expandCustomCommand, loadCustomCommands } from "../commands/customCommands.js";
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
    private multi?: boolean
  ) {}

  private printOutput(text: string, raw = false) {
    if (this.tui && this.tui.isActive) {
      this.tui.addSystemMessage(text, raw);
    } else {
      console.log(text);
    }
  }

  public async route(input: string): Promise<{ shouldExit: boolean; processed: boolean }> {
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
            "",
            picocolors.bold(picocolors.cyan("● Orbit 交互式终端指令指南")),
            "",
            picocolors.bold(picocolors.yellow("  [ 上下文管理 (Context) ]")),
            `    ${picocolors.green("/add")}   ${picocolors.cyan("<file>")}     - 添加文件/目录至当前上下文 (使用 -r 设为只读)`,
            `    ${picocolors.green("/drop")}  ${picocolors.cyan("<file>")}     - 从活动上下文中移除指定文件或通配符模式`,
            `    ${picocolors.green("/clear")}            - 清空终端屏幕和滚动缓冲`,
            "",
            picocolors.bold(picocolors.yellow("  [ 会话与历史 (Session) ]")),
            `    ${picocolors.green("/chat")}   ${picocolors.cyan("[action]")}   - 管理对话会话 (子命令: list/ls, new, delete/rm, switch)`,
            `    ${picocolors.green("/rollback")}         - 回滚最近的文件修改检查点`,
            `    ${picocolors.green("/copy")}             - 拷贝 AI 的最新回复至系统剪贴板`,
            "",
            picocolors.bold(picocolors.yellow("  [ 配置与状态 (Settings) ]")),
            `    ${picocolors.green("/status")}           - 诊断并展示当前会话、模型、Token 消耗和限额`,
            `    ${picocolors.green("/config")}   ${picocolors.cyan("[k=v]")}    - 查看或交互式/直接修改配置参数`,
            `    ${picocolors.green("/model")}    ${picocolors.cyan("[name]")}   - 动态查询或切换正在使用的 AI 语言大模型`,
            `    ${picocolors.green("/mode")}     ${picocolors.cyan("[mode]")}   - 切换安全确认模式 (strict, normal, auto, plan)`,
            `    ${picocolors.green("/update")}           - 检测并更新项目依赖包 (如 npm install)`,
            "",
            picocolors.bold(picocolors.yellow("  [ Git 提交 (Git) ]")),
            `    ${picocolors.green("/commit")}   ${picocolors.cyan("[msg]")}    - 暂存工作区修改并生成提交 (空消息时使用 LLM 自动生成)`,
            "",
            picocolors.bold(picocolors.yellow("  [ 系统控制 (System) ]")),
            `    ${picocolors.green("/help")}             - 显示此帮助信息`,
            `    ${picocolors.green("/exit")} / ${picocolors.green("/quit")}     - 安全退出交互式终端`,
            "",
            picocolors.bold(picocolors.cyan("  [ 系统控制 (System) ]")),
            `    ${picocolors.green("!<cmd>")}            - 直接执行系统原生 Shell 命令 (例如: !git diff)`,
            "",
          ].join("\n");
        } else {
          helpText = [
            "",
            picocolors.bold(picocolors.cyan("● Orbit Interactive Shell Commands Guide")),
            "",
            picocolors.bold(picocolors.yellow("  [ Context Management ]")),
            `    ${picocolors.green("/add")}   ${picocolors.cyan("<file>")}     - Add files/dirs to prompt context (use -r for read-only)`,
            `    ${picocolors.green("/drop")}  ${picocolors.cyan("<file>")}     - Remove files/patterns from active prompt context`,
            `    ${picocolors.green("/clear")}            - Clear the terminal screen and scrollback buffer`,
            "",
            picocolors.bold(picocolors.yellow("  [ Session & History ]")),
            `    ${picocolors.green("/chat")}   ${picocolors.cyan("[action]")}   - Manage sessions (subcommands: list/ls, new, delete/rm, switch)`,
            `    ${picocolors.green("/rollback")}         - Revert the last file edits checkpoint`,
            `    ${picocolors.green("/copy")}             - Copy last assistant response to system clipboard`,
            "",
            picocolors.bold(picocolors.yellow("  [ Configuration & Status ]")),
            `    ${picocolors.green("/status")}           - Display active session info, token usage, and budget limits`,
            `    ${picocolors.green("/config")}   ${picocolors.cyan("[k=v]")}    - View or modify configurations interactively or via key=value`,
            `    ${picocolors.green("/model")}    ${picocolors.cyan("[name]")}   - Query or dynamically swap the active AI model`,
            `    ${picocolors.green("/mode")}     ${picocolors.cyan("[mode]")}   - Switch permission safety mode (strict, normal, auto, plan)`,
            `    ${picocolors.green("/update")}           - Detect and update project dependencies (npm/pnpm/yarn install)`,
            "",
            picocolors.bold(picocolors.yellow("  [ Git Operations ]")),
            `    ${picocolors.green("/commit")}   ${picocolors.cyan("[msg]")}    - Stage all changes and commit (generates message via LLM if empty)`,
            "",
            picocolors.bold(picocolors.yellow("  [ System Commands ]")),
            `    ${picocolors.green("/help")}             - Show this commands guide`,
            `    ${picocolors.green("/exit")} / ${picocolors.green("/quit")}     - Terminate the interactive session`,
            "",
            picocolors.bold(picocolors.cyan("  [ Direct Shell Execution ]")),
            `    ${picocolors.green("!<cmd>")}            - Run a raw shell command directly on the host machine (e.g. !git status)`,
            "",
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

        const { execSync } = await import("child_process");
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
              ? picocolors.yellow(
                  "当前工作区没有检测到任何未提交的代码变更。",
                )
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
                      const fullP = resolve(cwd, file);
                      // Use the statically-imported unlinkSync (avoids fire-and-forget async import)
                      if (existsSync(fullP)) {
                        unlinkSync(fullP);
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
              ? picocolors.yellow("当前工作区没有检测到 package.json，不支持 npm 更新。")
              : picocolors.yellow("No package.json found in the workspace. npm update not supported."),
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
            console.log(picocolors.green(`✔ Dependencies updated successfully.\n`));

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
        const activeConfig = loop.getConfig();
        const activeModel = loop.getModelOverride() || activeConfig.models.default;
        const budgetLimit = activeConfig.budgetLimit;
        const currentCost = loop.getSessionCost();
        const mode = activeConfig.permissions.mode;

        const statusText = [
          picocolors.bold(picocolors.cyan("\n=== Orbit Session Status ===")),
          `  🆔 Session ID:   ${picocolors.green(loop.getSessionId())}`,
          `  🔌 Provider:     ${picocolors.green(this.providerInstance.id)} (${this.providerInstance.baseUrl || "Default URL"})`,
          `  🤖 Active Model:  ${picocolors.green(activeModel)}`,
          `  💰 Session Cost: $${currentCost.toFixed(4)} / $${budgetLimit.toFixed(2)} (Limit)`,
          `  🛡️ Security Mode: ${picocolors.green(mode.toUpperCase())}`,
          picocolors.cyan("============================\n"),
        ].join("\n");
        this.printOutput(statusText);
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
                picocolors.red(
                  `Error: Key "${key}" expects a numeric value.`,
                ),
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
        return { shouldExit: false, processed: true };
      }

      if (command === "/model") {
        const modelArg = parts.slice(1).join(" ").trim();
        const activeConfig = loop.getConfig();
        if (!modelArg) {
          const wasActive = useFullscreenTui && tui.isActive;
          if (wasActive) tui.stop();
          try {
            const activeModel =
              loop.getModelOverride() || activeConfig.models.default;
            let modelOptions: Array<{ value: string; label: string }> = [];
            const providerId = this.providerInstance.id;

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
          fileArg = fileArg.replace(/^(--read-only|--readonly|-r)\s+/, "").trim();
        } else if (
          fileArg === "--read-only" ||
          fileArg === "--readonly" ||
          fileArg === "-r"
        ) {
          readOnly = true;
          fileArg = "";
        }

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
                const options = filtered.map((f: string) => ({ value: f, label: f }));
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

        const { isAbsolute, relative, resolve: pathResolve } = await import("path");
        const { statSync } = await import("fs");
        const absPath = isAbsolute(fileArg) ? fileArg : pathResolve(cwd, fileArg);
        const relPath = relative(cwd, absPath).replace(/\\/g, "/");

        if (!existsSync(absPath)) {
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

        const { isAbsolute, relative, resolve: pathResolve } = await import("path");
        const absPath = isAbsolute(fileArg) ? fileArg : pathResolve(cwd, fileArg);
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
        return { shouldExit: false, processed: true };
      }

      if (command === "/clear") {
        console.clear();
        return { shouldExit: false, processed: true };
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
          this.printOutput(msg);
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
                  this.saveLocalState({
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
                  this.providerInstance.id,
                  activeModel,
                );
                tui.loadHistory([]);
                restoreTuiAndPrint(
                  picocolors.green(
                    `✔ Automatically started new session: ${newSessionId}`,
                  ),
                );
                this.saveLocalState({
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
              if (sessions.length === 0) {
                restoreTuiAndPrint(
                  picocolors.yellow(
                    "No active or saved sessions found to delete.",
                  ),
                );
                return { shouldExit: false, processed: true };
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
              idToDelete = (await Prompt.askSelect(
                "Choose a session to delete:",
                deleteOptions,
              )) ?? "";
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

            // confirm deletion only if no arg was specified
            let confirm = "yes";
            if (!arg) {
              stopTuiIfNeeded();
              confirm = (await Prompt.askSelect(
                `Are you sure you want to delete session ${idToDelete}?`,
                [
                  { value: "yes", label: "Yes, delete it" },
                  { value: "no", label: "No, cancel" },
                ],
              )) ?? "no";
            }

            if (confirm === "yes") {
              handleDelete(idToDelete);
            }
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

          stopTuiIfNeeded();
          const selectedSessionId = await Prompt.askSelect(
            "Choose a session to load:",
            sessionOptions,
          );

          if (!selectedSessionId || selectedSessionId === "cancel") {
            return { shouldExit: false, processed: true };
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
              this.providerInstance.id,
              activeModel,
            );
            tui.loadHistory([]);
            console.log(
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
              console.log(
                picocolors.green(
                  `✔ Switched to session: ${selectedSessionId}`,
                ),
              );

              this.saveLocalState({
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
        return { shouldExit: false, processed: true };
      }

      if (command === "/mode") {
        const isZh = config.language === "zh";
        const targetMode = parts.slice(1).join(" ").trim().toLowerCase();

        if (!targetMode) {
          console.log(
            isZh
              ? picocolors.yellow("用法: /mode <strict|normal|auto|plan>")
              : picocolors.yellow("Usage: /mode <strict|normal|auto|plan>"),
          );
          return { shouldExit: false, processed: true };
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
          return { shouldExit: false, processed: true };
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
