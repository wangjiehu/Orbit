import { OrbitConfig } from "@orbit-build/config";
import {
  ModelProvider,
  OrbitMessage,
  OrbitContentBlock,
  OrbitToolCall,
} from "@orbit-build/model-providers";
import { PermissionEngine } from "@orbit-build/permissions";
import { CheckpointManager, RollbackManager } from "@orbit-build/sandbox";
import {
  ContextPackBuilder,
  SymbolIndexer,
  ContextPack,
} from "@orbit-build/context-engine";
import { SessionManager, Session } from "@orbit-build/session";
import { toolRegistry } from "@orbit-build/tools";
import { StatusBar, Prompt, Renderer } from "@orbit-build/tui";
import { AgentState, createInitialState } from "./AgentState.js";
import { z } from "zod";
import { MessageBuilder } from "./MessageBuilder.js";
import { PromptCacheSlab, PromptCacheSlabBuilder } from "./PromptCacheSlab.js";
import { StepRunner } from "./StepRunner.js";
import { Planner } from "./Planner.js";
import { eventBus } from "../events/EventBus.js";
import picocolors from "picocolors";
import path from "path";
import fs from "fs";
import { createHash } from "crypto";
import { exec } from "child_process";
import { promisify } from "util";
const execPromise = promisify(exec);
import { MCPClient, DynamicMCPTool } from "@orbit-build/mcp";
import { resolveSafePath } from "@orbit-build/shared";
import { VerificationContractManager } from "../verification/VerificationContractManager.js";

const DEEPSEEK_CACHE_PRIMER_ROUNDS = 2;
const DEEPSEEK_CACHE_PRIMER_TTL_MS = 240000;
const DEEPSEEK_CACHE_REPAIR_HIT_RATE = 0.85;
const DEEPSEEK_FLASH_CACHE_PRIMER_LATENCY_BUDGET_MS = 800;
const DEEPSEEK_REASONING_CACHE_PRIMER_LATENCY_BUDGET_MS = 1500;
const DEEPSEEK_CACHE_KEEPALIVE_INTERVAL_MS = 210000;
const DEEPSEEK_CACHE_KEEPALIVE_PROMPT = "0";
const DEEPSEEK_VERBOSE_CACHE_ENV = "ORBIT_DEEPSEEK_VERBOSE_CACHE";
const NETWORK_TOOL_RESULT_MAX_RESULTS = 10;
const NETWORK_TOOL_RESULT_SUMMARY_CHARS = 280;
const NETWORK_TOOL_RESULT_MAX_CHARS = 6000;

export interface UserInteraction {
  askApproval(reason: string, preview?: string): Promise<boolean>;
  showText(text: string): void;
  showDiff(
    filePath: string,
    before: string | null,
    after: string,
  ): void | Promise<void>;
}

export class AgentLoop {
  private state: AgentState;
  public sessionManager: SessionManager;
  private checkpointManager: CheckpointManager;
  private rollbackManager: RollbackManager;
  private permissionEngine: PermissionEngine;
  private contextBuilder: ContextPackBuilder;
  private stepRunner: StepRunner;
  private verificationManager: VerificationContractManager;
  private mcpClients: MCPClient[] = [];
  private abortController: AbortController | null = null;
  private sessionCost = 0;
  private totalInputTokens = 0;
  private totalCacheReadTokens = 0;
  private totalOutputTokens = 0;
  private statusBar: StatusBar;
  private gitCheckpoints: Array<{ hash: string; isTemporary: boolean }> = [];
  private cachedRepoMapText = "";
  private lastSymbolsMtime = 0;
  private cachedContextPack: ContextPack | null = null;
  private cachedRepoMapTextForRun: string | null = null;
  private activeModelForRun: string | null = null;
  private primedCacheSlabs = new Set<string>();
  private pendingCacheSlabs = new Set<string>();
  private approvedToolScopes = new Set<string>();
  private userId: string;
  private keepaliveTimer: NodeJS.Timeout | null = null;
  private lastChatParams: {
    model: string;
    system: string;
  } | null = null;
  private cacheKeepaliveInFlight = false;

  constructor(
    private cwd: string,
    private config: OrbitConfig,
    private provider: ModelProvider,
    task: string,
    private interaction: UserInteraction,
    private options?: {
      modelOverride?: string;
      systemPromptOverride?: string;
      allowedTools?: string[];
      disableStatusBar?: boolean;
      detachBackgroundCachePrimer?: boolean;
      sessionId?: string;
    },
  ) {
    this.statusBar = new StatusBar(!!this.options?.disableStatusBar);
    this.sessionManager = new SessionManager(cwd);
    this.userId = createHash("sha256").update(cwd).digest("hex");

    let session;
    if (options?.sessionId) {
      session = this.sessionManager.resumeSession(options.sessionId);
    }
    if (!session) {
      session = this.sessionManager.startNewSession(
        provider.id,
        options?.modelOverride || config.models.default,
      );
    } else {
      this.sessionCost = session.totalCostEstimate || 0;
      this.totalInputTokens = session.totalInputTokens || 0;
      this.totalOutputTokens = session.totalOutputTokens || 0;
      this.totalCacheReadTokens = session.totalCacheReadTokens || 0;
    }

    this.state = createInitialState(
      session.id,
      task,
      this.getMaxLoopAttempts(),
    );

    if (options?.sessionId) {
      const savedHistory = this.sessionManager.getHistory();
      if (savedHistory && savedHistory.length > 0) {
        this.state.history = savedHistory;
        const lastUser = [...savedHistory]
          .reverse()
          .find((m) => m.role === "user");
        if (lastUser) {
          const userText = lastUser.content
            .map((c: any) => (c.type === "text" ? c.text : ""))
            .join("");
          this.state.task = userText;
        }
      }
    }

    this.checkpointManager = new CheckpointManager(cwd, session.id);
    this.rollbackManager = new RollbackManager(cwd);
    this.permissionEngine = new PermissionEngine(config);
    this.contextBuilder = new ContextPackBuilder(cwd);
    this.stepRunner = new StepRunner(cwd, session.id, config);
    this.verificationManager = new VerificationContractManager(
      cwd,
      session.id,
      this.checkpointManager,
    );
  }

  public abort(): void {
    if (this.abortController) {
      this.abortController.abort();
    }
  }

  private getMaxLoopAttempts(): number {
    const raw = (this.config as any).agent?.maxIterations;
    if (!Number.isFinite(raw)) {
      return 8;
    }
    return Math.max(1, Math.min(50, Math.floor(raw)));
  }

  private getRunawayPromptInterval(): number {
    if (this.state.maxAttempts <= 10) {
      return Number.POSITIVE_INFINITY;
    }
    return Math.max(10, Math.min(20, Math.floor(this.state.maxAttempts / 2)));
  }

  private getReusableApprovalScope(
    toolName: string,
    risk?: string,
  ): string | null {
    if (toolName === "web_search" && risk === "network") {
      return "network:web_search";
    }
    return null;
  }

  private buildToolResultContent(toolName: string, result: any): string {
    const content = result.ok
      ? typeof result.data === "string"
        ? result.data
        : JSON.stringify(result.data)
      : result.error || "Unknown error";

    if (!result.ok || toolName !== "web_search") {
      return content;
    }

    return this.compactNetworkToolResult(
      toolName,
      content,
      result.display || "",
    );
  }

  private compactNetworkToolResult(
    toolName: string,
    content: string,
    display: string,
  ): string {
    const normalized = content.replace(/\r\n/g, "\n").trim();
    const header = display
      ? `${toolName} result: ${display}`
      : `${toolName} result`;

    if (!normalized) {
      return header;
    }

    if (normalized.startsWith("Source: Open-Meteo weather API")) {
      return this.truncateToolResultText(`${header}\n${normalized}`);
    }

    const parsedResults = this.parseSearchResultBlocks(normalized);
    if (parsedResults.length === 0) {
      return this.truncateToolResultText(`${header}\n${normalized}`);
    }

    const keep = parsedResults.slice(0, NETWORK_TOOL_RESULT_MAX_RESULTS);
    const lines = [
      `${header}`,
      `Results kept for reasoning: ${keep.length}/${parsedResults.length}. Use another live lookup only if these results are insufficient or stale.`,
    ];

    for (const result of keep) {
      lines.push(
        `[${result.index}] ${result.title}`,
        `Link: ${result.link}`,
        `Summary: ${this.truncatePlain(result.summary, NETWORK_TOOL_RESULT_SUMMARY_CHARS)}`,
      );
    }

    return this.truncateToolResultText(lines.join("\n"));
  }

  private parseSearchResultBlocks(content: string): Array<{
    index: string;
    title: string;
    link: string;
    summary: string;
  }> {
    const results: Array<{
      index: string;
      title: string;
      link: string;
      summary: string;
    }> = [];
    const regex =
      /\[(\d+)\]\s+Title:\s*([\s\S]*?)\n\s*Link:\s*([^\n]+)\n\s*Summary:\s*([\s\S]*?)(?=\n\n\[\d+\]\s+Title:|\s*$)/g;

    let match;
    while ((match = regex.exec(content)) !== null) {
      results.push({
        index: match[1],
        title: this.truncatePlain(match[2], 180),
        link: match[3].trim(),
        summary: match[4].replace(/\s+/g, " ").trim(),
      });
    }

    return results;
  }

  private truncateToolResultText(text: string): string {
    return this.truncatePlain(text, NETWORK_TOOL_RESULT_MAX_CHARS);
  }

  private truncatePlain(text: string, maxChars: number): string {
    if (text.length <= maxChars) return text;
    return `${text.slice(0, Math.max(0, maxChars - 32)).trimEnd()}\n... [truncated for context budget]`;
  }

  public async run(): Promise<void> {
    try {
      eventBus.emitEvent("agent_start", {
        taskId: this.state.sessionId,
        task: this.state.task,
      });
      this.cachedContextPack = null;
      this.cachedRepoMapTextForRun = null;
      this.activeModelForRun = null;
      this.approvedToolScopes.clear();
      this.sessionManager.saveHistory(this.state.history);

      // Start workspace symbol indexing in the background asynchronously
      const symbolIndexer = new SymbolIndexer(this.cwd);
      symbolIndexer.index().catch(() => {});

      // Initialize MCP Servers if enabled
      if (this.config.tools.mcp.enabled && this.config.mcpServers) {
        this.interaction.showText(`● Initializing MCP servers...`);
        for (const [serverName, serverConfig] of Object.entries(
          this.config.mcpServers,
        )) {
          try {
            const client = new MCPClient(
              serverName,
              serverConfig.command,
              serverConfig.args || [],
              serverConfig.env || {},
            );
            const tools = await client.start();
            this.mcpClients.push(client);

            for (const toolDef of tools) {
              const configuredTool = serverConfig.tools?.[toolDef.name];
              const risk = configuredTool?.risk || "execute";

              const dynamicTool = new DynamicMCPTool(
                serverName,
                toolDef,
                risk,
                client,
              );
              toolRegistry.register(dynamicTool);
              this.interaction.showText(
                `  ✔ Registered MCP tool: ${dynamicTool.name} (${risk})`,
              );
            }
          } catch (err: any) {
            this.interaction.showText(
              `  ✖ Failed to start MCP server "${serverName}": ${err.message}`,
            );
          }
        }
      }

      const sigintListener = () => {
        if (this.abortController) {
          this.interaction.showText(
            "\n● Interrupt received. Aborting current execution...",
          );
          this.abortController.abort();
        }
      };
      process.on("SIGINT", sigintListener);

      const exitListener = () => {
        for (const client of this.mcpClients) {
          try {
            client.stop().catch(() => {});
          } catch {
            // Ignore
          }
        }
      };
      process.on("exit", exitListener);

      try {
        if (this.state.history.length === 0) {
          const initPack = await this.contextBuilder.build([]);
          this.interaction.showText(
            `● Workspace profiles: ${initPack.projectIndex.detectedLanguages.join(", ")} project detected.`,
          );
          this.state.history.push({
            id: `msg_user_init_${Date.now()}`,
            role: "user",
            createdAt: new Date().toISOString(),
            content: [{ type: "text", text: this.state.task }],
          });
          this.sessionManager.saveHistory(this.state.history);
        }

        while (
          !this.state.done &&
          this.state.attemptCount < this.state.maxAttempts
        ) {
          // Auto-compact dialogue history if length exceeds 40
          if (
            this.config.context.autoCompact &&
            this.state.history.length > 40
          ) {
            this.interaction.showText(
              "● Dialogue history is too long. Auto-compacting older history to save tokens...",
            );
            await this.autoCompactHistory();
          }

          if (this.sessionCost > this.config.budgetLimit) {
            this.interaction.showText(
              picocolors.red(
                `\n✖ Budget Exceeded: The session cost has reached $${this.sessionCost.toFixed(4)}, which exceeds the limit of $${this.config.budgetLimit.toFixed(2)}.`,
              ),
            );
            const confirm = await this.interaction.askApproval(
              `Session cost limit reached. Do you want to increase the budget limit by $10.00 and continue?`,
            );
            if (confirm) {
              this.config.budgetLimit += 10.0;
            } else {
              this.state.done = true;
              break;
            }
          }

          this.state.attemptCount++;
          eventBus.emitEvent("loop_start", {
            attempt: this.state.attemptCount,
          });

          // Runaway Iteration Guard
          if (
            this.state.attemptCount > 1 &&
            Number.isFinite(this.getRunawayPromptInterval()) &&
            (this.state.attemptCount - 1) % this.getRunawayPromptInterval() ===
              0
          ) {
            const continueExec = await this.interaction.askApproval(
              `Agent loop has run for ${this.state.attemptCount - 1} iterations. Continue executing to prevent runaway costs?`,
            );
            if (!continueExec) {
              this.interaction.showText(
                "● Terminated by user to prevent runaway iterations.",
              );
              this.state.done = true;
              break;
            }
          }

          // Repository Tree builder (Hierarchical Summary via PageRank Repo Map)
          let repoMapText = "";
          if (this.cachedRepoMapTextForRun !== null) {
            repoMapText = this.cachedRepoMapTextForRun;
          } else {
            try {
              const indexPath = path.join(this.cwd, ".orbit", "symbols.json");
              const indexer = new SymbolIndexer(this.cwd);
              if (!fs.existsSync(indexPath)) {
                await indexer.index();
              }
              if (fs.existsSync(indexPath)) {
                const stat = fs.statSync(indexPath);
                if (
                  stat.mtimeMs === this.lastSymbolsMtime &&
                  this.cachedRepoMapText
                ) {
                  repoMapText = this.cachedRepoMapText;
                } else {
                  const landmarkMap = await indexer.getRepoMapText(2048);
                  if (landmarkMap) {
                    repoMapText = `\n\n${landmarkMap}\n\nNote: To find where a symbol (class, function, etc.) is declared or referenced, use the "search_symbols" and "find_symbol_references" tools dynamically.`;
                    this.cachedRepoMapText = repoMapText;
                    this.lastSymbolsMtime = stat.mtimeMs;
                  }
                }
              }
            } catch {
              // Ignore
            }
            this.cachedRepoMapTextForRun = repoMapText;
          }

          // 1. Dynamic routing selection
          // Explore vs. Write/Repair phase detection
          let nextModel =
            this.options?.modelOverride || this.config.models.default;

          // If it's a verification failure (Auto-Repair), it MUST be R1/Pro
          const isRepairTurn =
            this.state.history.length > 0 &&
            this.state.history[this.state.history.length - 1].role === "user" &&
            this.state.history[this.state.history.length - 1].content.some(
              (b) =>
                b.type === "text" && b.text.includes("[Verification Failed]"),
            );

          // Get user query input for heuristic routing
          const userQueryText = (
            this.state.history
              .filter((m) => m.role === "user")
              .map((m) =>
                m.content
                  .filter((b) => b.type === "text")
                  .map((b: any) => b.text)
                  .join("\n"),
              )
              .join("\n") || this.state.task
          ).toLowerCase();

          // Heuristic task classification: High complexity vs Trivial
          const highComplexityKeywords = [
            "debug",
            "investigate",
            "root cause",
            "why does",
            "race condition",
            "architecture",
            "refactor",
            "migrate",
            "design",
            "tradeoff",
            "optimize",
            "security",
            "vulnerability",
            "concurrency",
            "deadlock",
            "memory leak",
            "reason",
            "think",
            "explain why",
            "diagnose",
            "trace",
            "why does",
            "what's wrong",
            "compare",
            "evaluate",
            "assess",
            "decide",
            "choose",
            "推理",
            "分析",
            "诊断",
            "调试",
            "设计",
            "评估",
            "原因",
            "为什么",
            "调查",
            "死锁",
            "内存泄漏",
            "并发",
            "优化",
            "重构",
            "安全",
            "漏洞",
            "架构",
            "异常",
            "报错",
            "崩溃",
            "故障",
          ];

          const trivialKeywords = [
            "what is",
            "list",
            "show",
            "echo",
            "print",
            "rename",
            "lint",
            "format",
            "ty",
            "thanks",
            "yes",
            "no",
            "ok",
            "continue",
            "search",
            "find",
            "什么是",
            "列出",
            "显示",
            "输出",
            "打印",
            "重命名",
            "格式化",
            "谢谢",
            "继续",
            "是",
            "否",
            "好的",
          ];

          const isComplexTask =
            isRepairTurn ||
            highComplexityKeywords.some((kw) => userQueryText.includes(kw));

          const isSimpleTask =
            !isRepairTurn &&
            (trivialKeywords.some((kw) => userQueryText.includes(kw)) ||
              userQueryText.length < 50) &&
            !highComplexityKeywords.some((kw) => userQueryText.includes(kw));

          // Check if the user request has tool execution or is complex
          const hasWrittenFiles = this.state.history.some(
            (msg) =>
              msg.role === "assistant" &&
              msg.content.some(
                (b) =>
                  b.type === "tool_call" &&
                  (b.toolCall.name === "write_file" ||
                    b.toolCall.name === "edit_file"),
              ),
          );

          if (this.options?.modelOverride) {
            nextModel = this.options.modelOverride;
          } else {
            if (!this.activeModelForRun) {
              if (isComplexTask) {
                nextModel = this.config.models.default;
              } else if (isSimpleTask && this.config.models.fast) {
                nextModel = this.config.models.fast;
              } else {
                if (!hasWrittenFiles && this.config.models.fast) {
                  nextModel = this.config.models.fast;
                } else {
                  nextModel = this.config.models.default;
                }
              }
              this.activeModelForRun = nextModel;
            } else {
              if (
                this.activeModelForRun === this.config.models.fast &&
                this.config.models.default
              ) {
                if (isComplexTask || hasWrittenFiles) {
                  this.activeModelForRun = this.config.models.default;
                }
              }
              nextModel = this.activeModelForRun;
            }
          }

          const activeModel = nextModel;
          if (!this.cachedContextPack) {
            // Find the initiating user message of the current turn (the last user message in history)
            let latestUserQuery = this.state.task;
            for (let i = this.state.history.length - 1; i >= 0; i--) {
              if (this.state.history[i].role === "user") {
                const text = this.state.history[i].content
                  .filter((b) => b.type === "text")
                  .map((b: any) => b.text)
                  .join("\n");
                if (text.trim()) {
                  latestUserQuery = text;
                  break;
                }
              }
            }

            this.cachedContextPack = await this.contextBuilder.build(
              this.state.relevantFiles,
              latestUserQuery,
            );
          }
          let toolDefs = toolRegistry.getDefinitions();
          if (!this.config.tools.webSearch.enabled) {
            toolDefs = toolDefs.filter((tool) => tool.name !== "web_search");
          }
          if (!this.config.tools.bash.enabled) {
            toolDefs = toolDefs.filter(
              (tool) => tool.name !== "bash" && tool.name !== "run_tests",
            );
          }
          if (this.options?.allowedTools) {
            toolDefs = toolDefs.filter((t) =>
              this.options!.allowedTools!.includes(t.name),
            );
          }
          toolDefs.sort((a, b) => a.name.localeCompare(b.name));

          // DeepSeek cache-first layering:
          // Stable slab: core rules + canonical tool prompt + repo profile/map.
          // Volatile suffix: RAG snippets, selected file excerpts, current history.
          const baseSystemPrompt =
            this.options?.systemPromptOverride ||
            Planner.makeSystemPrompt(activeModel, this.config.language);
          const toolsPrompt = generateXMLToolsPrompt(toolDefs);
          const contextPack = this.cachedContextPack;
          const cacheSlab = PromptCacheSlabBuilder.build({
            cwd: this.cwd,
            model: activeModel,
            baseSystemPrompt,
            toolsPrompt,
            repoMapText,
            contextPack,
          });
          const cachePrimer = await this.primeDeepSeekCache(
            activeModel,
            cacheSlab,
          );
          const { system, messages } = MessageBuilder.build(
            cacheSlab.text,
            this.state,
            contextPack,
          );

          const capabilities = (typeof this.provider.getModelCapabilities ===
          "function"
            ? this.provider.getModelCapabilities(activeModel)
            : this.provider?.capabilities) || {
            streaming: true,
            toolCalls: true,
            jsonMode: true,
            thinking:
              activeModel.toLowerCase().includes("reasoner") ||
              activeModel.toLowerCase().includes("r1") ||
              activeModel.toLowerCase().includes("v4-pro"),
            vision: false,
            promptCaching: true,
          };

          const isReasoner = capabilities.thinking;

          this.statusBar.start(
            `Calling ${activeModel}... | Cost: $${this.sessionCost.toFixed(4)}`,
          );

          this.abortController = new AbortController();

          // 2. Dynamic thinking budget configuration based on complexity
          let thinkingBudget = 1024;
          if (isRepairTurn) {
            thinkingBudget = 8192; // Max thinking budget for repair
          } else if (isComplexTask) {
            thinkingBudget = 4096; // Standard high thinking budget
          }

          this.stopKeepaliveTimer();
          this.lastChatParams = this.isDeepSeekCacheProvider(activeModel)
            ? { model: activeModel, system: cacheSlab.text }
            : null;

          eventBus.emitEvent("model_request", {
            model: activeModel,
            messages: messages.map((m: any) => ({
              role: m.role,
              content: m.content,
            })),
          });

          const stream = this.provider.chat({
            model: activeModel,
            messages,
            system,
            tools: toolDefs,
            stream: true,
            abortSignal: this.abortController.signal,
            thinking: isReasoner
              ? { enabled: true, budgetTokens: thinkingBudget }
              : undefined,
          });

          let responseText = "";
          let thinkingText = "";
          let thinkingSignature = "";
          let finalUsage: any = undefined;
          const toolCallsToExecute: OrbitToolCall[] = [];

          try {
            for await (const event of stream) {
              this.statusBar.stop();
              if (event.type === "text_delta") {
                responseText += event.text;
                eventBus.emitEvent("model_delta", { text: event.text });
              } else if (event.type === "thinking_delta") {
                if (event.text) {
                  thinkingText += event.text;
                  eventBus.emitEvent("thinking_delta", { text: event.text });
                }
                if (event.signature) {
                  thinkingSignature = event.signature;
                }
              } else if (event.type === "usage") {
                this.accumulateCost(activeModel, event.usage);
                finalUsage = event.usage;
                this.emitCacheTelemetry(
                  activeModel,
                  cacheSlab,
                  event.usage,
                  cachePrimer.primed,
                );
              } else if (event.type === "tool_call") {
                toolCallsToExecute.push(event.toolCall);
              } else if (event.type === "error") {
                throw event.error;
              }
            }
          } catch (chatError: any) {
            if (
              chatError.name === "AbortError" ||
              this.abortController?.signal.aborted
            ) {
              // Aborted, handled below
            } else {
              this.interaction.showText(
                `[Error] LLM Call failed: ${chatError.message}`,
              );
              this.state.done = true;
              break;
            }
          } finally {
            this.statusBar.stop();
            this.startKeepaliveTimer();
          }

          if (toolCallsToExecute.length === 0 && responseText) {
            const xmlToolCalls = parseXMLToolCalls(responseText);
            if (xmlToolCalls.length > 0) {
              toolCallsToExecute.push(...xmlToolCalls);
            } else {
              const srBlocks = parseSearchReplaceBlocks(responseText);
              let idCounter = 1;
              for (const block of srBlocks) {
                toolCallsToExecute.push({
                  id: `sr_call_${idCounter++}_${Date.now()}`,
                  name: "edit_file",
                  arguments: JSON.stringify({
                    path: block.filePath,
                    oldText: block.oldText,
                    newText: block.newText,
                  }),
                });
              }
            }
          }

          eventBus.emitEvent("model_response", {
            model: activeModel,
            text: responseText || undefined,
            reasoning_content: thinkingText || undefined,
            usage: finalUsage
              ? {
                  inputTokens: finalUsage.inputTokens,
                  outputTokens: finalUsage.outputTokens,
                  cacheReadTokens: finalUsage.cacheReadTokens,
                  cacheWriteTokens: finalUsage.cacheWriteTokens,
                }
              : undefined,
            toolCalls:
              toolCallsToExecute.length > 0 ? toolCallsToExecute : undefined,
          });

          if (this.abortController?.signal.aborted) {
            const action = await this.handleInterrupt();
            if (action === "continue") {
              this.interaction.showText("● Resuming execution...");
              this.abortController = null;
              continue;
            } else if (action === "rollback_exit") {
              await this.rollbackLastCheckpoint();
              this.state.done = true;
              process.exit(0);
            } else {
              this.interaction.showText("● Aborted. Returning to REPL prompt.");
              this.state.done = true;
              break;
            }
          }

          const assistantBlocks: OrbitContentBlock[] = [];
          if (thinkingText) {
            assistantBlocks.push({
              type: "thinking",
              text: thinkingText,
              ...(thinkingSignature ? { signature: thinkingSignature } : {}),
            });
          }
          if (responseText) {
            assistantBlocks.push({ type: "text", text: responseText });
          }
          for (const tc of toolCallsToExecute) {
            assistantBlocks.push({ type: "tool_call", toolCall: tc });
          }

          const assistantMsg: OrbitMessage = {
            id: `msg_asst_${Date.now()}`,
            role: "assistant",
            createdAt: new Date().toISOString(),
            content: assistantBlocks,
            metadata: { model: activeModel },
          };
          this.state.history.push(assistantMsg);
          this.sessionManager.saveHistory(this.state.history);

          if (responseText) {
            if (toolCallsToExecute.length > 0) {
              Renderer.printThought(responseText);
            } else {
              this.interaction.showText(
                `\nOrbit: ${Renderer.formatMarkdown(responseText)}`,
              );
            }
          }

          if (toolCallsToExecute.length === 0) {
            const hasEdits = this.state.history.some(
              (msg) =>
                msg.role === "assistant" &&
                msg.content.some(
                  (b) =>
                    b.type === "tool_call" &&
                    (b.toolCall.name === "write_file" ||
                      b.toolCall.name === "edit_file" ||
                      b.toolCall.name === "replace_file_content" ||
                      b.toolCall.name === "multi_replace_file_content"),
                ),
            );

            if (hasEdits) {
              if (this.verificationManager.hasContract()) {
                this.interaction.showText(
                  "\n● Verification: Running contract verification checks...",
                );
                const verifyResult =
                  await this.verificationManager.runVerification();
                if (!verifyResult.success) {
                  const repairAttempts = this.state.history.filter(
                    (m) =>
                      m.role === "user" &&
                      m.content.some(
                        (b) =>
                          b.type === "text" &&
                          b.text.includes("[Verification Failed]"),
                      ),
                  ).length;

                  if (
                    repairAttempts >= 3 ||
                    !(this.config.context as any)?.autoRepair
                  ) {
                    this.interaction.showText(
                      picocolors.red(
                        `\n✖ Verification Failed: Workspace violates contract. Rolling back all changes for safety...`,
                      ),
                    );
                    await this.rollbackLastCheckpoint();
                    this.state.done = true;
                    break;
                  }

                  this.interaction.showText(
                    picocolors.red(
                      `✖ Verification failed! Entering auto-repair loop (Attempt ${repairAttempts + 1}/3)...`,
                    ),
                  );

                  const feedbackPrompt = `[Verification Failed] The changes made failed the verification contract. Details:\n\n${verifyResult.error}\n\nPlease analyze this failure, fix the codebase, and ensure it passes the verification contract.`;

                  const systemMsg: OrbitMessage = {
                    id: `msg_validation_err_${Date.now()}`,
                    role: "user",
                    createdAt: new Date().toISOString(),
                    content: [{ type: "text", text: feedbackPrompt }],
                  };
                  this.state.history.push(systemMsg);
                  this.sessionManager.saveHistory(this.state.history);
                  continue;
                } else {
                  this.interaction.showText(
                    picocolors.green(
                      `✔ Verification contract passed successfully.`,
                    ),
                  );
                }
              } else if ((this.config.context as any)?.autoRepair) {
                const testTool = toolRegistry.get("run_tests");
                if (testTool) {
                  this.interaction.showText(
                    "\n● Auto-Repair: Running project tests to verify changes...",
                  );
                  const preferredCommand = (this.config.context as any)
                    ?.testCommands?.[0];
                  const result = await testTool.execute(
                    { command: preferredCommand },
                    {
                      cwd: this.cwd,
                      sessionId: this.state.sessionId,
                      abortSignal: this.abortController?.signal,
                    },
                  );

                  if (!result.ok) {
                    const repairAttempts = this.state.history.filter(
                      (m) =>
                        m.role === "user" &&
                        m.content.some(
                          (b) =>
                            b.type === "text" &&
                            b.text.includes("[Verification Failed]"),
                        ),
                    ).length;

                    if (repairAttempts >= 3) {
                      this.interaction.showText(
                        picocolors.red(
                          `\n✖ Auto-Repair: Max attempts (3) reached. Codebase is unstable. Rolling back all changes for safety...`,
                        ),
                      );
                      await this.rollbackLastCheckpoint();
                      this.state.done = true;
                      break;
                    }

                    this.interaction.showText(
                      picocolors.red(
                        `✖ Tests failed! Entering auto-repair loop (Attempt ${repairAttempts + 1}/3)...`,
                      ),
                    );
                    const rawLog =
                      result.error || (result as any).display || "";
                    let errLog = cleanAndTruncateTestLog(rawLog);

                    // 3. Pre-Analysis Error Distillation via V4-Flash
                    if (this.config.models.fast) {
                      this.interaction.showText(
                        `● Auto-Repair: Compressing test failure logs using ${this.config.models.fast}...`,
                      );
                      try {
                        const fastModel = this.config.models.fast;
                        const distillationPrompt = `Extract and summarize the core compile error or assertion failure from the following test logs. Keep the output extremely dense and precise. Specify only:
1. The exact file path and line number of the failure.
2. The failing test description.
3. The assert details (e.g. Expected X, Got Y).
Do not include any other markdown formatting or conversational text. Output ONLY the summary:

${errLog}`;
                        const distStream = this.provider.chat({
                          model: fastModel,
                          messages: [
                            {
                              id: `msg_distill_${Date.now()}`,
                              role: "user",
                              createdAt: new Date().toISOString(),
                              content: [
                                { type: "text", text: distillationPrompt },
                              ],
                            },
                          ],
                          tools: [],
                        });
                        let distilledLog = "";
                        for await (const event of distStream) {
                          if (event.type === "text_delta") {
                            distilledLog += event.text;
                          }
                        }
                        if (distilledLog.trim()) {
                          errLog = distilledLog.trim();
                          this.interaction.showText(
                            picocolors.gray(`● Compressed logs:\n${errLog}`),
                          );
                        }
                      } catch {
                        // Fallback to normal cleaned log on distillation failure
                      }
                    }

                    const feedbackPrompt = `[Verification Failed] The changes made caused test failures. Test command: "${preferredCommand || "auto-detected runner"}". Output:\n\n${errLog}\n\nPlease analyze this failure log, locate the files causing assertion or compile errors, and fix the codebase so that the tests pass successfully.`;

                    const systemMsg: OrbitMessage = {
                      id: `msg_validation_err_${Date.now()}`,
                      role: "user",
                      createdAt: new Date().toISOString(),
                      content: [{ type: "text", text: feedbackPrompt }],
                    };
                    this.state.history.push(systemMsg);
                    this.sessionManager.saveHistory(this.state.history);
                    continue;
                  } else {
                    this.interaction.showText(
                      picocolors.green(
                        `✔ All tests passed successfully! Verification green.`,
                      ),
                    );
                  }
                }
              }
            }

            this.state.done = true;
            break;
          }

          const toolResultBlocks: OrbitContentBlock[] = [];
          for (const tc of toolCallsToExecute) {
            let argSummary = "";
            try {
              const parsed = JSON.parse(tc.arguments);
              if (
                tc.name === "write_file" ||
                tc.name === "edit_file" ||
                tc.name === "replace_file_content"
              ) {
                argSummary =
                  parsed.path ||
                  parsed.TargetFile ||
                  parsed.filePath ||
                  parsed.file ||
                  "";
              } else if (tc.name === "multi_replace_file_content") {
                argSummary = parsed.TargetFile || "";
              } else if (tc.name === "read_file") {
                argSummary = parsed.path || parsed.AbsolutePath || "";
              } else if (tc.name === "bash") {
                argSummary = parsed.command || parsed.CommandLine || "";
              } else if (tc.name === "run_tests") {
                argSummary = parsed.command || "";
              } else if (tc.name === "grep") {
                argSummary = `"${parsed.query || parsed.Query}" in ${parsed.path || parsed.SearchPath || ""}`;
              } else if (tc.name === "glob") {
                argSummary = `"${parsed.pattern || parsed.Pattern}" in ${parsed.path || parsed.DirectoryPath || ""}`;
              } else if (tc.name === "web_search") {
                argSummary = parsed.query || "";
              } else {
                argSummary = tc.arguments;
              }
            } catch {
              argSummary = tc.arguments;
            }

            if (argSummary.length > 80) {
              argSummary = argSummary.substring(0, 77) + "...";
            }
            this.interaction.showText(
              `\n  ${picocolors.cyan("✦")} ${picocolors.bold(picocolors.white(tc.name))} ${picocolors.gray(argSummary)}`,
            );

            const registeredTool = toolRegistry.get(tc.name);
            const declaredRisk = registeredTool?.risk;
            const evalArgs = JSON.parse(tc.arguments);

            eventBus.emitEvent("tool_proposal", {
              toolCallId: tc.id,
              toolName: tc.name,
              arguments: evalArgs,
            });

            let decision = this.permissionEngine.evaluate(
              tc.name,
              evalArgs,
              declaredRisk,
            );

            if (
              tc.name === "write_file" ||
              tc.name === "edit_file" ||
              tc.name === "replace_file_content" ||
              tc.name === "multi_replace_file_content"
            ) {
              const targetPath =
                evalArgs.path ||
                evalArgs.TargetFile ||
                evalArgs.filePath ||
                evalArgs.file;
              if (targetPath) {
                const relPath = path
                  .relative(this.cwd, path.resolve(this.cwd, targetPath))
                  .replace(/\\/g, "/");
                const foundFile = this.state.relevantFiles.find(
                  (f) => f.path === relPath,
                );
                if (foundFile && foundFile.readOnly) {
                  decision = {
                    action: "deny",
                    reason: `File "${relPath}" is marked as READ-ONLY reference and cannot be modified.`,
                    risk: "write",
                  };
                }
              }
            }

            const reusableApprovalScope = this.getReusableApprovalScope(
              tc.name,
              decision.risk,
            );
            const reusedApproval =
              decision.action === "ask" &&
              reusableApprovalScope !== null &&
              this.approvedToolScopes.has(reusableApprovalScope);
            if (reusedApproval) {
              decision = {
                action: "allow",
                reason: `Previously approved "${tc.name}" for this task.`,
                risk: decision.risk,
              };
            }

            if (decision.action === "deny") {
              this.interaction.showText(`✖ Blocked: ${decision.reason}`);
              eventBus.emitEvent("tool_approval", {
                toolCallId: tc.id,
                approved: false,
                reason: `Blocked by safety policy: ${decision.reason}`,
              });
              eventBus.emitEvent("tool_result", {
                toolCallId: tc.id,
                toolName: tc.name,
                error: `Blocked by safety policy: ${decision.reason}`,
              });
              toolResultBlocks.push({
                type: "tool_result",
                toolResult: {
                  toolCallId: tc.id,
                  name: tc.name,
                  content: `Blocked by safety policy: ${decision.reason}`,
                  isError: true,
                },
              });
              this.sessionManager.recordToolExecution(
                tc.name,
                tc,
                null,
                decision.risk || "read",
                decision.action,
                "denied",
              );
              continue;
            }

            if (decision.action === "ask") {
              let approved = false;
              let currentArgs = tc.arguments;
              if (reusableApprovalScope) {
                approved = await Prompt.askApproval(
                  `Allow "${tc.name}" for this task? ${argSummary ? `Query: ${argSummary}` : decision.reason}`,
                );
                if (approved) {
                  this.approvedToolScopes.add(reusableApprovalScope);
                }
              } else {
                while (true) {
                  const choice = await Prompt.askSelect(
                    `Confirm execution of tool "${tc.name}"? Reason: ${decision.reason}`,
                    [
                      { value: "approve", label: "Approve execution" },
                      { value: "edit", label: "Edit tool arguments" },
                      { value: "deny", label: "Deny execution" },
                    ],
                  );
                  if (choice === "approve") {
                    approved = true;
                    break;
                  } else if (choice === "edit") {
                    let edited: string | null = null;
                    const isObjectSchema =
                      registeredTool?.inputSchema instanceof z.ZodObject;

                    if (isObjectSchema) {
                      const editChoice = await Prompt.askSelect(
                        "Choose edit mode:",
                        [
                          {
                            value: "form",
                            label:
                              "(Recommended) Interactive form fields editor",
                          },
                          { value: "json", label: "Raw JSON string editor" },
                          { value: "cancel", label: "Cancel" },
                        ],
                      );
                      if (editChoice === "form") {
                        edited = await this.promptSchemaGuided(
                          registeredTool,
                          currentArgs,
                        );
                      } else if (editChoice === "json") {
                        edited = await Prompt.askText(
                          "Edit tool arguments (JSON string):",
                          currentArgs,
                        );
                      }
                    } else {
                      edited = await Prompt.askText(
                        "Edit tool arguments (JSON string):",
                        currentArgs,
                      );
                    }

                    if (edited === null) {
                      continue;
                    }
                    try {
                      const parsed = JSON.parse(edited);
                      if (registeredTool && registeredTool.inputSchema) {
                        const validation =
                          registeredTool.inputSchema.safeParse(parsed);
                        if (!validation.success) {
                          const errorMsgs = validation.error.errors
                            .map(
                              (e) =>
                                `${e.path.join(".") || "root"}: ${e.message}`,
                            )
                            .join(", ");
                          this.interaction.showText(
                            `✖ Schema validation failed: ${errorMsgs}`,
                          );
                          continue;
                        }
                      }
                      currentArgs = edited;
                      tc.arguments = edited;
                      this.interaction.showText(`✔ Arguments updated.`);
                      approved = true;
                      break;
                    } catch (err: any) {
                      this.interaction.showText(
                        `✖ Invalid JSON: ${err.message}. Please try again.`,
                      );
                    }
                  } else {
                    break;
                  }
                }
              }

              if (!approved) {
                this.interaction.showText(`✖ Rejected by user.`);
                eventBus.emitEvent("tool_approval", {
                  toolCallId: tc.id,
                  approved: false,
                  reason: "Rejected by user",
                });
                eventBus.emitEvent("tool_result", {
                  toolCallId: tc.id,
                  toolName: tc.name,
                  error: "Rejected by user",
                });
                toolResultBlocks.push({
                  type: "tool_result",
                  toolResult: {
                    toolCallId: tc.id,
                    name: tc.name,
                    content: "Rejected by user",
                    isError: true,
                  },
                });
                this.sessionManager.recordToolExecution(
                  tc.name,
                  tc,
                  null,
                  decision.risk || "read",
                  decision.action,
                  "denied",
                );
                continue;
              } else {
                eventBus.emitEvent("tool_approval", {
                  toolCallId: tc.id,
                  approved: true,
                  reason: "Approved by user",
                });
              }
            } else {
              eventBus.emitEvent("tool_approval", {
                toolCallId: tc.id,
                approved: true,
                reason: reusedApproval
                  ? "Approved by earlier user confirmation"
                  : "Auto-approved by policy",
              });
            }

            let beforeContent: string | null = null;
            let targetPath: string | undefined;
            let parsedArgs: any = {};
            try {
              parsedArgs = JSON.parse(tc.arguments);
              targetPath =
                parsedArgs.path ||
                parsedArgs.TargetFile ||
                parsedArgs.filePath ||
                parsedArgs.file;
            } catch {
              // Ignored
            }

            let skipToolExecution = false;
            let hookResult: any = null;

            // Milestone 22: Git Auto-Commits with LLM Commit Messages & Pre-Commit Checks
            if (tc.name === "git_commit") {
              // 1. Pre-commit verification checks (run tests if available)
              if (
                contextPack.projectIndex.testCommands &&
                contextPack.projectIndex.testCommands.length > 0
              ) {
                this.interaction.showText(
                  `● Pre-commit checks: running verification tests...`,
                );
                const testCmd = contextPack.projectIndex.testCommands[0];
                try {
                  await execPromise(testCmd, { cwd: this.cwd });
                  this.interaction.showText(`✔ Pre-commit checks passed.`);
                } catch (err: any) {
                  this.interaction.showText(
                    picocolors.red(
                      `✖ Pre-commit checks failed. Verification tests failed.`,
                    ),
                  );

                  const choice = await Prompt.askSelect(
                    `Pre-commit verification tests failed. How would you like to proceed?`,
                    [
                      { value: "yes", label: "Proceed with the commit anyway" },
                      {
                        value: "diagnose",
                        label: "Let Agent auto-repair the failures (diagnose)",
                      },
                      { value: "no", label: "Abort the commit entirely" },
                    ],
                  );

                  if (choice === "diagnose") {
                    eventBus.emitEvent("tool_result", {
                      toolCallId: tc.id,
                      toolName: tc.name,
                      error: `Commit aborted. Verification tests failed: ${err.stdout || err.stderr || err.message}`,
                    });
                    toolResultBlocks.push({
                      type: "tool_result",
                      toolResult: {
                        toolCallId: tc.id,
                        name: tc.name,
                        content: `Commit aborted. Verification tests failed with the following log. Please diagnose and fix the codebase first:\n\n${err.stdout || err.stderr || err.message}`,
                        isError: true,
                      },
                    });
                    continue;
                  } else if (choice !== "yes") {
                    eventBus.emitEvent("tool_result", {
                      toolCallId: tc.id,
                      toolName: tc.name,
                      error:
                        "Commit aborted by user due to pre-commit test failures.",
                    });
                    toolResultBlocks.push({
                      type: "tool_result",
                      toolResult: {
                        toolCallId: tc.id,
                        name: tc.name,
                        content:
                          "Commit aborted by user due to pre-commit test failures.",
                        isError: true,
                      },
                    });
                    continue;
                  }
                }
              }

              // 2. Generate Commit Message via LLM if not provided
              if (!parsedArgs.message) {
                this.interaction.showText(
                  `● Git Commit: generating commit message via LLM...`,
                );
                try {
                  const { stdout } = await execPromise("git diff --cached", {
                    cwd: this.cwd,
                  });
                  if (!stdout.trim()) {
                    this.interaction.showText(
                      `⚠ Warning: No staged changes found to commit.`,
                    );
                  } else {
                    const fastModel =
                      this.config.models.fast || this.config.models.default;
                    const stream = this.provider.chat({
                      model: fastModel,
                      messages: [
                        {
                          id: `msg_commit_${Date.now()}`,
                          role: "user",
                          createdAt: new Date().toISOString(),
                          content: [
                            {
                              type: "text",
                              text: `Generate a concise, high-quality conventional git commit message (e.g. feat(cli): add autocomplete) for the following git diff. Output ONLY the commit message, no formatting, no markdown, no quotes, just the text:\n\n${stdout.substring(0, 20000)}`,
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

                    generatedMessage = generatedMessage
                      .trim()
                      .replace(/^["']|["']$/g, "");
                    if (generatedMessage) {
                      parsedArgs.message = generatedMessage;
                      tc.arguments = JSON.stringify(parsedArgs);
                      this.interaction.showText(
                        `● Generated Commit Message: "${generatedMessage}"`,
                      );
                    }
                  }
                } catch (err: any) {
                  this.interaction.showText(
                    `⚠ Failed to generate commit message: ${err.message}`,
                  );
                }
              }
            }

            if (
              (tc.name === "write_file" ||
                tc.name === "edit_file" ||
                tc.name === "replace_file_content" ||
                tc.name === "multi_replace_file_content") &&
              targetPath
            ) {
              const checkpoint =
                await this.checkpointManager.captureBeforeState(
                  tc.id,
                  targetPath,
                );
              beforeContent = checkpoint.backups[0].originalContent;

              eventBus.emitEvent("checkpoint_created", {
                checkpointId: checkpoint.id,
                timestamp: checkpoint.timestamp,
                message: `Before executing ${tc.name} on ${targetPath}`,
              });

              // Run pre-edit hook if configured
              if (this.config.hooks?.preEdit) {
                this.interaction.showText(`● Running pre-edit hook...`);
                const hookRes = await this.runHook(
                  this.config.hooks.preEdit,
                  targetPath,
                );
                if (!hookRes.ok) {
                  this.interaction.showText(
                    `✖ Pre-edit hook failed: ${hookRes.output}`,
                  );
                  hookResult = {
                    ok: false,
                    error: `Pre-edit hook failed: ${hookRes.output}`,
                  };
                  skipToolExecution = true;
                } else {
                  this.interaction.showText(`✔ Pre-edit hook passed.`);
                }
              }
            }

            if (tc.name === "bash" || tc.name === "run_tests") {
              const isGit = await this.isGitRepo();
              if (isGit) {
                await this.createGitCheckpoint(tc.id);
              }
            }

            this.statusBar.start(
              `Executing tool: ${tc.name}... | Cost: $${this.sessionCost.toFixed(4)}`,
            );
            const result = skipToolExecution
              ? hookResult
              : await this.stepRunner.run(tc, this.abortController?.signal);
            this.statusBar.stop();

            if (this.abortController?.signal.aborted) {
              const action = await this.handleInterrupt();
              if (action === "continue") {
                this.interaction.showText("● Resuming execution...");
                this.abortController = null;
                eventBus.emitEvent("tool_result", {
                  toolCallId: tc.id,
                  toolName: tc.name,
                  error: "Interrupted by user",
                });
                toolResultBlocks.push({
                  type: "tool_result",
                  toolResult: {
                    toolCallId: tc.id,
                    name: tc.name,
                    content: "Interrupted by user",
                    isError: true,
                  },
                });
                continue;
              } else if (action === "rollback_exit") {
                await this.rollbackLastCheckpoint();
                this.state.done = true;
                process.exit(0);
              } else {
                this.interaction.showText(
                  "● Aborted. Returning to REPL prompt.",
                );
                this.state.done = true;
                break;
              }
            }

            let finalResult = result;
            // Run post-edit hook if tool succeeded and it's a file edit
            if (
              result.ok &&
              !skipToolExecution &&
              (tc.name === "write_file" || tc.name === "edit_file") &&
              targetPath
            ) {
              if (this.config.hooks?.postEdit) {
                this.interaction.showText(`● Running post-edit hook...`);
                const hookRes = await this.runHook(
                  this.config.hooks.postEdit,
                  targetPath,
                );
                if (!hookRes.ok) {
                  this.interaction.showText(
                    `✖ Post-edit hook failed: ${hookRes.output}`,
                  );
                  finalResult = {
                    ok: false,
                    error: `Post-edit hook failed: ${hookRes.output}`,
                  };
                } else {
                  this.interaction.showText(`✔ Post-edit hook passed.`);
                }
              }
            }

            // Type & Lint Guard Rails check
            if (
              finalResult.ok &&
              targetPath &&
              (tc.name === "write_file" ||
                tc.name === "edit_file" ||
                tc.name === "replace_file_content" ||
                tc.name === "multi_replace_file_content")
            ) {
              // Run Auto-Formatters (Prettier / Biome / ESLint Fix)
              try {
                if (
                  fs.existsSync(path.join(this.cwd, "biome.json")) ||
                  fs.existsSync(path.join(this.cwd, "biome.jsonc"))
                ) {
                  this.interaction.showText(`● Running Biome Auto-Format...`);
                  await execPromise(
                    `npx @biomejs/biome format --write "${targetPath}"`,
                    { cwd: this.cwd },
                  );
                } else {
                  const prettierCandidates = [
                    ".prettierrc",
                    ".prettierrc.json",
                    ".prettierrc.yml",
                    ".prettierrc.yaml",
                    ".prettierrc.js",
                    "prettier.config.js",
                  ];
                  let hasPrettierConfig = false;
                  for (const c of prettierCandidates) {
                    if (fs.existsSync(path.join(this.cwd, c))) {
                      hasPrettierConfig = true;
                      break;
                    }
                  }
                  if (hasPrettierConfig) {
                    this.interaction.showText(
                      `● Running Prettier Auto-Format...`,
                    );
                    await execPromise(`npx prettier --write "${targetPath}"`, {
                      cwd: this.cwd,
                    });
                  }
                }
                const eslintCandidates = [
                  ".eslintrc",
                  ".eslintrc.json",
                  ".eslintrc.js",
                  "eslint.config.js",
                ];
                let hasEslintConfig = false;
                for (const c of eslintCandidates) {
                  if (fs.existsSync(path.join(this.cwd, c))) {
                    hasEslintConfig = true;
                    break;
                  }
                }
                if (hasEslintConfig) {
                  await execPromise(`npx eslint --fix "${targetPath}"`, {
                    cwd: this.cwd,
                  });
                }
              } catch {
                // Ignore formatting failures
              }

              if (
                targetPath.endsWith(".ts") ||
                targetPath.endsWith(".tsx") ||
                targetPath.endsWith(".js") ||
                targetPath.endsWith(".jsx")
              ) {
                try {
                  let lintCmd = `npx eslint --quiet "${targetPath}"`;
                  if (
                    fs.existsSync(path.join(this.cwd, "biome.json")) ||
                    fs.existsSync(path.join(this.cwd, "biome.jsonc"))
                  ) {
                    lintCmd = `npx @biomejs/biome lint "${targetPath}"`;
                  }
                  this.interaction.showText(
                    `● Verifying file syntax & type safety for ${targetPath}...`,
                  );
                  await execPromise(lintCmd, { cwd: this.cwd });
                  this.interaction.showText(`✔ Syntax verification passed.`);
                } catch (err: any) {
                  let lintError = err;
                  this.interaction.showText(
                    picocolors.yellow(
                      `⚠ Syntax/Lint validation warning for ${targetPath}:`,
                    ),
                  );
                  this.interaction.showText(
                    picocolors.red(
                      lintError.stdout || lintError.stderr || lintError.message,
                    ),
                  );

                  let checkPassedAfterAutoInstall = false;
                  const outputText = lintError.stdout || lintError.stderr || "";

                  try {
                    const missingModules: string[] = [];
                    const moduleMatch1 = [
                      ...outputText.matchAll(/Cannot find module '([^']+)'/g),
                    ];
                    for (const m of moduleMatch1) {
                      if (m[1]) missingModules.push(m[1]);
                    }
                    const moduleMatch2 = [
                      ...outputText.matchAll(/Cannot find name '([^']+)'/g),
                    ];
                    for (const m of moduleMatch2) {
                      if (
                        m[1] &&
                        (m[1].toLowerCase() === m[1] || m[1].startsWith("@"))
                      ) {
                        missingModules.push(m[1]);
                      }
                    }
                    const typesMatch = [
                      ...outputText.matchAll(
                        /Could not find a declaration file for module '([^']+)'/g,
                      ),
                    ];
                    for (const m of typesMatch) {
                      if (m[1]) missingModules.push(`@types/${m[1]}`);
                    }

                    if (missingModules.length > 0) {
                      const uniqueModules = Array.from(new Set(missingModules));
                      let dependenciesInstalled = false;
                      for (const pkg of uniqueModules) {
                        const installPkg = await Prompt.askApproval(
                          `Missing dependency "${pkg}" detected. Install it automatically?`,
                        );
                        if (installPkg) {
                          this.interaction.showText(`● Installing "${pkg}"...`);
                          const isPnpm = fs.existsSync(
                            path.join(this.cwd, "pnpm-lock.yaml"),
                          );
                          const isYarn = fs.existsSync(
                            path.join(this.cwd, "yarn.lock"),
                          );
                          const installCmd = isPnpm
                            ? `npx pnpm add -D ${pkg}`
                            : isYarn
                              ? `yarn add -D ${pkg}`
                              : `npm install --save-dev ${pkg}`;

                          try {
                            await execPromise(installCmd, { cwd: this.cwd });
                            this.interaction.showText(
                              `✔ Installed "${pkg}" successfully.`,
                            );
                            dependenciesInstalled = true;
                          } catch (installErr: any) {
                            this.interaction.showText(
                              picocolors.red(
                                `✖ Failed to install "${pkg}": ${installErr.message}`,
                              ),
                            );
                          }
                        }
                      }

                      if (dependenciesInstalled) {
                        try {
                          this.interaction.showText(
                            `● Re-verifying syntax after dependency installation...`,
                          );
                          await execPromise(
                            `npx eslint --quiet "${targetPath}"`,
                            { cwd: this.cwd },
                          );
                          this.interaction.showText(
                            `✔ Syntax verification passed after dependency installation.`,
                          );
                          checkPassedAfterAutoInstall = true;
                        } catch (recheckErr: any) {
                          lintError = recheckErr;
                        }
                      }
                    }
                  } catch {
                    // Ignore installer issues
                  }

                  let autoImported = false;
                  if (!checkPassedAfterAutoInstall) {
                    try {
                      const missingSymbols: string[] = [];
                      const currentOutput =
                        lintError.stdout || lintError.stderr || "";
                      const match1 = [
                        ...currentOutput.matchAll(/'([^']+)' is not defined/g),
                      ];
                      for (const m of match1) {
                        if (m[1]) missingSymbols.push(m[1]);
                      }
                      const match2 = [
                        ...currentOutput.matchAll(
                          /Cannot find name '([^']+)'/g,
                        ),
                      ];
                      for (const m of match2) {
                        if (m[1]) missingSymbols.push(m[1]);
                      }

                      if (missingSymbols.length > 0) {
                        const indexPath = path.join(
                          this.cwd,
                          ".orbit",
                          "symbols.json",
                        );
                        if (fs.existsSync(indexPath)) {
                          const raw = fs.readFileSync(indexPath, "utf8");
                          const index = JSON.parse(raw);
                          if (index.files && typeof index.files === "object") {
                            const fileContent = fs.readFileSync(
                              targetPath,
                              "utf8",
                            );
                            let newImports = "";
                            for (const symbol of new Set(missingSymbols)) {
                              let foundFile: string | null = null;
                              for (const [file, fileData] of Object.entries(
                                index.files,
                              )) {
                                const data = fileData as any;
                                if (data && Array.isArray(data.symbols)) {
                                  if (
                                    data.symbols.some(
                                      (s: any) => s.name === symbol,
                                    )
                                  ) {
                                    foundFile = file;
                                    break;
                                  }
                                }
                              }

                              if (foundFile) {
                                const targetDir = path.dirname(targetPath);
                                const exportFileAbs = path.resolve(
                                  this.cwd,
                                  foundFile,
                                );
                                let relPath = path.relative(
                                  targetDir,
                                  exportFileAbs,
                                );
                                relPath = relPath.replace(/\\/g, "/");
                                if (
                                  !relPath.startsWith("./") &&
                                  !relPath.startsWith("../")
                                ) {
                                  relPath = "./" + relPath;
                                }
                                relPath = relPath.replace(
                                  /\.(ts|tsx|js|jsx)$/,
                                  ".js",
                                );
                                newImports += `import { ${symbol} } from '${relPath}';\n`;
                              }
                            }

                            if (newImports) {
                              fs.writeFileSync(
                                targetPath,
                                newImports + fileContent,
                                "utf8",
                              );
                              this.interaction.showText(
                                `● Automatically resolved missing imports...`,
                              );
                              autoImported = true;
                            }
                          }
                        }
                      }
                    } catch {
                      // Ignore autofix errors
                    }
                  }

                  let checkPassedAfterAutofix = false;
                  if (autoImported) {
                    try {
                      this.interaction.showText(
                        `● Re-verifying syntax after auto-imports injection...`,
                      );
                      await execPromise(`npx eslint --quiet "${targetPath}"`, {
                        cwd: this.cwd,
                      });
                      this.interaction.showText(
                        `✔ Syntax verification passed after auto-imports injection.`,
                      );
                      checkPassedAfterAutofix = true;
                    } catch (reErr: any) {
                      this.interaction.showText(
                        picocolors.yellow(
                          `⚠ Syntax/Lint validation still failed after auto-imports:`,
                        ),
                      );
                      this.interaction.showText(
                        picocolors.red(
                          reErr.stdout || reErr.stderr || reErr.message,
                        ),
                      );
                    }
                  }

                  if (!checkPassedAfterAutofix) {
                    const autoFix = await Prompt.askApproval(
                      `Lint/Syntax verification failed. Let Agent auto-repair the file?`,
                    );
                    if (autoFix) {
                      finalResult = {
                        ok: false,
                        error: `Syntax or Lint verification failed on file edit: ${lintError.stdout || lintError.stderr || lintError.message}. Please fix the syntax/import errors.`,
                      };
                    }
                  }
                }
              }
            }

            // Phase 5: Interactive Diff Acceptance Check
            if (
              finalResult.ok &&
              targetPath &&
              (tc.name === "write_file" ||
                tc.name === "edit_file" ||
                tc.name === "replace_file_content" ||
                tc.name === "multi_replace_file_content")
            ) {
              let afterContent = "";
              try {
                afterContent = fs.readFileSync(
                  path.resolve(this.cwd, targetPath),
                  "utf8",
                );
              } catch {
                try {
                  const afterArgs = JSON.parse(tc.arguments);
                  afterContent = afterArgs.content || afterArgs.newText || "";
                } catch {}
              }
              try {
                await this.interaction.showDiff(
                  targetPath,
                  beforeContent,
                  afterContent,
                );
              } catch {
                // Ignored
              }

              let accepted = false;
              const choice = await Prompt.askSelect(
                `Accept changes to ${targetPath}?`,
                [
                  { value: "yes", label: "Accept all changes" },
                  { value: "hunks", label: "Review and accept by hunk/block" },
                  { value: "no", label: "Reject and rollback all changes" },
                ],
              );

              if (choice === "yes") {
                accepted = true;
              } else if (choice === "hunks") {
                try {
                  const linesBefore = beforeContent
                    ? beforeContent.split("\n")
                    : [];
                  const linesAfter = afterContent.split("\n");

                  interface Hunk {
                    startB: number;
                    endB: number;
                    startA: number;
                    endA: number;
                    linesB: string[];
                    linesA: string[];
                  }
                  const hunks: Hunk[] = [];
                  let iB = 0;
                  let iA = 0;

                  while (iB < linesBefore.length || iA < linesAfter.length) {
                    if (
                      iB < linesBefore.length &&
                      iA < linesAfter.length &&
                      linesBefore[iB] === linesAfter[iA]
                    ) {
                      iB++;
                      iA++;
                      continue;
                    }

                    const startB = iB;
                    const startA = iA;

                    let bestDB = -1;
                    let bestDA = -1;
                    let minSum = Infinity;

                    const maxLookahead = 20;
                    for (let dB = 0; dB <= maxLookahead; dB++) {
                      for (let dA = 0; dA <= maxLookahead; dA++) {
                        if (dB === 0 && dA === 0) continue;
                        const posB = iB + dB;
                        const posA = iA + dA;

                        if (
                          posB > linesBefore.length ||
                          posA > linesAfter.length
                        )
                          continue;

                        const isEndB = posB === linesBefore.length;
                        const isEndA = posA === linesAfter.length;

                        let isMatch = false;
                        if (isEndB && isEndA) {
                          isMatch = true;
                        } else if (!isEndB && !isEndA) {
                          isMatch = linesBefore[posB] === linesAfter[posA];
                        }

                        if (isMatch) {
                          const sum = dB + dA;
                          if (sum < minSum) {
                            minSum = sum;
                            bestDB = dB;
                            bestDA = dA;
                          }
                        }
                      }
                    }

                    if (bestDB !== -1 && bestDA !== -1) {
                      const linesB = linesBefore.slice(startB, startB + bestDB);
                      const linesA = linesAfter.slice(startA, startA + bestDA);
                      iB += bestDB;
                      iA += bestDA;

                      hunks.push({
                        startB,
                        endB: iB,
                        startA,
                        endA: iA,
                        linesB,
                        linesA,
                      });
                    } else {
                      const linesB = linesBefore.slice(startB);
                      const linesA = linesAfter.slice(startA);
                      iB = linesBefore.length;
                      iA = linesAfter.length;

                      hunks.push({
                        startB,
                        endB: iB,
                        startA,
                        endA: iA,
                        linesB,
                        linesA,
                      });
                    }
                  }

                  if (hunks.length === 0) {
                    accepted = true;
                  } else {
                    const previewLines = [
                      `\n● Reviewing ${hunks.length} hunks in ${targetPath}:`,
                    ];
                    for (let hIdx = 0; hIdx < hunks.length; hIdx++) {
                      const hunk = hunks[hIdx];
                      previewLines.push(
                        picocolors.cyan(
                          `\n--- Hunk #${hIdx + 1}/${hunks.length} ---`,
                        ),
                      );
                      for (const line of hunk.linesB) {
                        previewLines.push(`  ${picocolors.red(`- ${line}`)}`);
                      }
                      for (const line of hunk.linesA) {
                        previewLines.push(`  ${picocolors.green(`+ ${line}`)}`);
                      }
                      previewLines.push(
                        picocolors.cyan(
                          "----------------------------------------",
                        ),
                      );
                    }
                    this.interaction.showText(previewLines.join("\n"));

                    const selectedHunkIndices = await Prompt.askMultiSelect(
                      `Select the hunks to apply to ${targetPath}:`,
                      hunks.map((h, idx) => ({
                        value: idx.toString(),
                        label: `Apply Hunk #${idx + 1}`,
                        hint: `-${h.linesB.length} lines, +${h.linesA.length} lines`,
                      })),
                    );

                    if (selectedHunkIndices === null) {
                      accepted = false;
                    } else {
                      const mergedLines: string[] = [];
                      let lastB = 0;
                      for (let hIdx = 0; hIdx < hunks.length; hIdx++) {
                        const hunk = hunks[hIdx];
                        mergedLines.push(
                          ...linesBefore.slice(lastB, hunk.startB),
                        );
                        if (selectedHunkIndices.includes(hIdx.toString())) {
                          mergedLines.push(...hunk.linesA);
                        } else {
                          mergedLines.push(...hunk.linesB);
                        }
                        lastB = hunk.endB;
                      }
                      mergedLines.push(...linesBefore.slice(lastB));

                      fs.writeFileSync(
                        targetPath,
                        mergedLines.join("\n"),
                        "utf8",
                      );
                      this.interaction.showText(
                        picocolors.green(
                          `✔ Selected hunks merged and saved to ${targetPath}.`,
                        ),
                      );
                      accepted = true;
                    }
                  }
                } catch (hunkErr: any) {
                  this.interaction.showText(
                    picocolors.red(
                      `✖ Hunk merge failed: ${hunkErr.message}. Accepting all instead.`,
                    ),
                  );
                  accepted = true;
                }
              }

              if (!accepted) {
                this.interaction.showText(
                  picocolors.yellow(
                    `● Rejected changes. Reverting ${targetPath}...`,
                  ),
                );
                await this.rollbackLastCheckpoint();
                finalResult = {
                  ok: false,
                  error: `Edits to ${targetPath} rejected and rolled back by user.`,
                };
              }
            }

            const status = finalResult.ok
              ? ("success" as const)
              : ("failed" as const);
            this.sessionManager.recordToolExecution(
              tc.name,
              tc,
              finalResult,
              decision.risk || "read",
              decision.action,
              status,
            );

            if (finalResult.ok) {
              await this.commitLastGitCheckpointSoft();
              this.interaction.showText(
                `  ${picocolors.green("✔")} Success: ${picocolors.gray(finalResult.display || "Done")}`,
              );

              if (targetPath) {
                this.addRelevantFile(targetPath, `Modified by ${tc.name}`);
              }
              if (tc.name === "write_file" || tc.name === "edit_file") {
                new SymbolIndexer(this.cwd).index().catch(() => {});
              }
            } else {
              await this.rollbackLastGitCheckpoint();
              this.interaction.showText(
                `  ${picocolors.red("✖")} Failed: ${picocolors.red(finalResult.error || "Unknown error")}`,
              );
            }

            eventBus.emitEvent("tool_result", {
              toolCallId: tc.id,
              toolName: tc.name,
              result: finalResult.ok ? finalResult.data : undefined,
              error: finalResult.ok
                ? undefined
                : finalResult.error || "Unknown error",
            });

            toolResultBlocks.push({
              type: "tool_result",
              toolResult: {
                toolCallId: tc.id,
                name: tc.name,
                content: this.buildToolResultContent(tc.name, finalResult),
                isError: !finalResult.ok,
              },
            });
          }

          const toolMsg: OrbitMessage = {
            id: `msg_tool_${Date.now()}`,
            role: "tool",
            createdAt: new Date().toISOString(),
            content: toolResultBlocks,
          };
          this.state.history.push(toolMsg);
          this.abortController = null;
          this.sessionManager.saveHistory(this.state.history);
        }

        if (
          this.state.attemptCount >= this.state.maxAttempts &&
          !this.state.done
        ) {
          this.interaction.showText(
            `\n● Limit reached: Maximum consecutive loop iterations (${this.state.maxAttempts}) completed. Pausing loop.`,
          );
        }

        const sessions = this.sessionManager
          .getSessionStore()
          .getEvents(this.state.sessionId);
        const modifiedFiles = sessions
          .filter((e) => e.type === "file_modified")
          .map((e) => e.payload.path);

        this.interaction.showText(`\n● Summary:`);
        this.interaction.showText(
          `  Modified files: ${modifiedFiles.length > 0 ? Array.from(new Set(modifiedFiles)).join(", ") : "None"}`,
        );
        this.interaction.showText(`  Verification: test run executed.`);
        this.interaction.showText(
          `  Session Cost: $${this.sessionCost.toFixed(4)}`,
        );

        if (this.config.autoCommit && modifiedFiles.length > 0) {
          this.interaction.showText(`\n● Auto-committing changes...`);
          try {
            const uniqueFiles = Array.from(new Set(modifiedFiles));
            const { execFileSync, execSync } = await import("child_process");

            for (const file of uniqueFiles) {
              execFileSync("git", ["add", file], { cwd: this.cwd });
            }

            const diff = execSync("git diff --cached", { cwd: this.cwd })
              .toString()
              .trim();
            if (diff) {
              this.interaction.showText(
                "● Generating commit message via LLM...",
              );
              const fastModel =
                this.config.models.fast || this.config.models.default;
              const stream = this.provider.chat({
                model: fastModel,
                messages: [
                  {
                    id: `msg_auto_commit_${Date.now()}`,
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
              const finalMsg =
                generatedMessage.trim().replace(/^["']|["']$/g, "") ||
                "chore: auto-commit";

              this.interaction.showText(
                `● Committing: "${picocolors.green(finalMsg)}"`,
              );
              const commitCmd = `git commit -m ${JSON.stringify(finalMsg)}`;
              execSync(commitCmd, { cwd: this.cwd });
              this.interaction.showText(
                `${picocolors.green("✔")} Auto-commit created successfully.`,
              );
            } else {
              this.interaction.showText(
                "● No changes staged or modified. Skipping auto-commit.",
              );
            }
          } catch (commitErr: any) {
            this.interaction.showText(
              picocolors.red(`✖ Auto-commit failed: ${commitErr.message}`),
            );
          }
        }
        this.sessionManager.saveHistory(this.state.history);
      } finally {
        process.removeListener("SIGINT", sigintListener);
        process.removeListener("exit", exitListener);
        if (this.mcpClients.length > 0) {
          this.interaction.showText(`\n● Stopping MCP servers...`);
          for (const client of this.mcpClients) {
            await client.stop();
          }
        }
      }
    } finally {
      this.stopKeepaliveTimer();
    }
  }

  private addRelevantFile(path: string, reason: string) {
    if (!this.state.relevantFiles.some((f) => f.path === path)) {
      this.state.relevantFiles.push({ path, reason });
    }
  }

  private async runHook(
    hookCommand: string,
    filePath: string,
  ): Promise<{ ok: boolean; output: string }> {
    const absolutePath = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(this.cwd, filePath);
    const relativePath = path.relative(this.cwd, absolutePath);
    const cmd = hookCommand.replace(
      /{file}/g,
      `"${relativePath.replace(/"/g, '\\"')}"`,
    );

    try {
      const { stdout, stderr } = await execPromise(cmd, { cwd: this.cwd });
      return { ok: true, output: (stdout + stderr).trim() };
    } catch (err: any) {
      return {
        ok: false,
        output: (err.stdout + err.stderr || err.message).trim(),
      };
    }
  }

  public getSessionId(): string {
    return this.state.sessionId;
  }

  public getHistory(): OrbitMessage[] {
    return this.state.history;
  }

  public getRelevantFiles(): Array<{ path: string; reason: string }> {
    return this.state.relevantFiles;
  }

  public prepareUserTurn(task: string): void {
    this.state.task = task;
    this.state.done = false;
    this.state.attemptCount = 0;
    this.state.history.push({
      id: `msg_user_${Date.now()}`,
      role: "user",
      createdAt: new Date().toISOString(),
      content: [{ type: "text", text: task }],
    });
  }

  public addRelevantFilePublic(path: string, reason: string) {
    this.addRelevantFile(path, reason);
    this.cachedContextPack = null;
  }

  public addReadOnlyFilePublic(path: string, reason: string) {
    if (!this.state.relevantFiles.some((f) => f.path === path)) {
      this.state.relevantFiles.push({ path, reason, readOnly: true });
    }
    this.cachedContextPack = null;
  }

  public removeRelevantFilePublic(path: string) {
    this.state.relevantFiles = this.state.relevantFiles.filter(
      (f) => f.path !== path,
    );
    this.cachedContextPack = null;
  }

  public clearRelevantFilesPublic() {
    this.state.relevantFiles = [];
    this.cachedContextPack = null;
  }

  public clearHistoryPublic() {
    this.state.history = [];
    this.sessionManager.saveHistory([]);
  }

  public resumeSession(sessionId: string): boolean {
    const session = this.sessionManager.resumeSession(sessionId);
    if (!session) return false;

    this.state = createInitialState(
      sessionId,
      "REPL Interactive Shell Started",
    );
    const savedHistory = this.sessionManager.getHistory();
    if (savedHistory && savedHistory.length > 0) {
      this.state.history = savedHistory;
      const lastUser = [...savedHistory]
        .reverse()
        .find((m) => m.role === "user");
      if (lastUser) {
        const userText = lastUser.content
          .map((c: any) => (c.type === "text" ? c.text : ""))
          .join("");
        this.state.task = userText;
      }
    }

    this.checkpointManager = new CheckpointManager(this.cwd, sessionId);
    this.stepRunner = new StepRunner(this.cwd, sessionId, this.config);
    this.sessionCost = session.totalCostEstimate || 0;
    this.totalInputTokens = session.totalInputTokens || 0;
    this.totalCacheReadTokens = session.totalCacheReadTokens || 0;
    this.totalOutputTokens = session.totalOutputTokens || 0;
    return true;
  }

  public startNewSession(providerId: string, model: string): string {
    const session = this.sessionManager.startNewSession(providerId, model);
    this.state = createInitialState(
      session.id,
      "REPL Interactive Shell Started",
    );
    this.checkpointManager = new CheckpointManager(this.cwd, session.id);
    this.stepRunner = new StepRunner(this.cwd, session.id, this.config);
    this.sessionCost = 0;
    this.totalInputTokens = 0;
    this.totalCacheReadTokens = 0;
    this.totalOutputTokens = 0;
    this.sessionManager.saveHistory(this.state.history);
    return session.id;
  }

  public getSessions(): Session[] {
    return this.sessionManager.getSessionStore().listSessions();
  }

  public deleteSession(sessionId: string): void {
    this.sessionManager.getSessionStore().deleteSession(sessionId);
  }

  public getSessionCost(): number {
    return this.sessionCost;
  }

  public getTotalInputTokens(): number {
    return this.totalInputTokens;
  }

  public getTotalCacheReadTokens(): number {
    return this.totalCacheReadTokens;
  }

  public getTotalOutputTokens(): number {
    return this.totalOutputTokens;
  }

  public getConfig(): OrbitConfig {
    return this.config;
  }

  public getProvider(): ModelProvider {
    return this.provider;
  }

  public setModelOverride(model: string): void {
    if (!this.options) {
      this.options = {};
    }
    this.options.modelOverride = model;
  }

  public getModelOverride(): string | undefined {
    return this.options?.modelOverride;
  }

  public async rollbackLastCheckpoint(): Promise<void> {
    const checkpoints = this.checkpointManager.getCheckpoints();
    if (checkpoints.length === 0) {
      const rolledBackGit = await this.rollbackLastGitCheckpoint();
      if (rolledBackGit) {
        this.interaction.showText(
          "Successfully rolled back last command changes via Git.",
        );
      } else {
        this.interaction.showText("No checkpoints found to rollback.");
      }
      return;
    }
    const last = checkpoints[checkpoints.length - 1];
    this.interaction.showText(
      `Rolling back last changes for tool call ${last.toolCallId}...`,
    );
    const res = this.rollbackManager.rollback(last);
    if (res.success) {
      this.checkpointManager.removeCheckpoint(last.id);
      this.interaction.showText(
        `Successfully rolled back: ${res.restored.join(", ")}`,
      );
    } else {
      this.interaction.showText(`Rollback failed: ${res.error}`);
    }
    await this.rollbackLastGitCheckpoint();
  }

  public getCheckpoints(): Array<{
    id: string;
    timestamp: string;
    toolCallId: string;
    files: string[];
  }> {
    return this.checkpointManager.getCheckpoints().map((checkpoint) => ({
      id: checkpoint.id,
      timestamp: checkpoint.timestamp,
      toolCallId: checkpoint.toolCallId,
      files: checkpoint.backups.map((backup) => backup.path),
    }));
  }

  public async rewindToCheckpoint(checkpointId: string): Promise<boolean> {
    const checkpoints = this.checkpointManager.getCheckpoints();
    const targetIndex = checkpoints.findIndex(
      (checkpoint) => checkpoint.id === checkpointId,
    );
    if (targetIndex === -1) {
      this.interaction.showText(`Checkpoint not found: ${checkpointId}`);
      return false;
    }

    const checkpointsToRollback = checkpoints.slice(targetIndex).reverse();
    const restored = new Set<string>();
    for (const checkpoint of checkpointsToRollback) {
      const result = this.rollbackManager.rollback(checkpoint);
      if (!result.success) {
        this.interaction.showText(
          `Rewind failed at checkpoint ${checkpoint.id}: ${result.error || "unknown error"}`,
        );
        return false;
      }
      for (const file of result.restored) restored.add(file);
      this.checkpointManager.removeCheckpoint(checkpoint.id);
    }
    this.interaction.showText(
      `Rewound ${checkpointsToRollback.length} checkpoint(s): ${Array.from(restored).join(", ")}`,
    );
    return true;
  }

  public rollbackFileToCheckpoint(filePath: string): boolean {
    let targetAbs: string;
    try {
      targetAbs = resolveSafePath(this.cwd, filePath);
    } catch {
      return false;
    }
    const checkpoints = this.checkpointManager.getCheckpoints().reverse();
    for (const cp of checkpoints) {
      const backup = cp.backups.find((candidate) => {
        try {
          return resolveSafePath(this.cwd, candidate.path) === targetAbs;
        } catch {
          return false;
        }
      });
      if (backup) {
        const safePath = resolveSafePath(this.cwd, backup.path);
        try {
          if (backup.originalContent === null) {
            if (fs.existsSync(safePath)) {
              fs.unlinkSync(safePath);
            }
          } else {
            fs.writeFileSync(safePath, backup.originalContent, "utf8");
          }
          return true;
        } catch {
          return false;
        }
      }
    }
    return false;
  }

  private accumulateCost(model: string, usage: any) {
    const cleanModel = model.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
    let pricing = this.config.pricing?.[cleanModel];
    if (!pricing) {
      for (const key of Object.keys(this.config.pricing || {})) {
        if (key.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "") === cleanModel) {
          pricing = this.config.pricing[key];
          break;
        }
      }
    }
    if (!pricing) {
      pricing = {
        inputCostPer1M: 0.14,
        outputCostPer1M: 0.28,
        cacheReadCostPer1M: 0.07,
      };
    }

    const uncachedInputTokens = usage.cacheReadTokens
      ? Math.max(0, usage.inputTokens - usage.cacheReadTokens)
      : usage.inputTokens;

    const inputCost = (uncachedInputTokens / 1000000) * pricing.inputCostPer1M;
    const outputCost = (usage.outputTokens / 1000000) * pricing.outputCostPer1M;
    const cacheReadCost =
      usage.cacheReadTokens && pricing.cacheReadCostPer1M
        ? (usage.cacheReadTokens / 1000000) * pricing.cacheReadCostPer1M
        : 0;

    this.totalInputTokens += usage.inputTokens || 0;
    this.totalOutputTokens += usage.outputTokens || 0;
    this.totalCacheReadTokens += usage.cacheReadTokens || 0;

    const turnCost = inputCost + outputCost + cacheReadCost;
    this.sessionCost += turnCost;

    const session = this.sessionManager.getActiveSession();
    if (session) {
      session.totalInputTokens = this.totalInputTokens;
      session.totalOutputTokens = this.totalOutputTokens;
      session.totalCacheReadTokens = this.totalCacheReadTokens;
      session.totalCostEstimate = this.sessionCost;
      this.sessionManager.getSessionStore().updateSession(session);
    }

    eventBus.emitEvent("cost_update", {
      turnCost,
      sessionCost: this.sessionCost,
      totalInputTokens: this.totalInputTokens,
      totalCacheReadTokens: this.totalCacheReadTokens,
      totalOutputTokens: this.totalOutputTokens,
    });
  }

  /**
   * Cache-aware two-phase history compaction.
   *
   * Phase 1 (cache-friendly, triggers at >40 messages):
   *   Truncates bulky tool_result and tool-role text content in older messages.
   *   Preserves the message structure so the DeepSeek prompt prefix cache stays valid.
   *
   * Phase 2 (aggressive, triggers at >80 messages):
   *   Drops the oldest messages entirely to prevent context window overflow.
   *   This breaks the prefix cache but is necessary as a safety valve.
   *   Only fires when Phase 1 alone isn't enough to keep history bounded.
   */
  private async autoCompactHistory(): Promise<void> {
    const history = this.state.history;
    if (history.length <= 20) return;

    // --- Phase 1: Cache-friendly truncation ---
    // Keep the most recent 16 messages untouched (active working set)
    const protectedTailSize = 16;
    const compactBoundary = Math.max(0, history.length - protectedTailSize);
    const maxToolResultLen = 300;
    let truncatedCount = 0;

    for (let i = 0; i < compactBoundary; i++) {
      const msg = history[i];
      for (const block of msg.content) {
        if (block.type === "tool_result") {
          const tr = (block as any).toolResult;
          if (
            tr &&
            typeof tr.content === "string" &&
            tr.content.length > maxToolResultLen
          ) {
            tr.content =
              tr.content.substring(0, maxToolResultLen) + "\n... [truncated]";
            truncatedCount++;
          }
        }
        if (block.type === "text" && msg.role === "tool") {
          const textBlock = block as any;
          if (
            typeof textBlock.text === "string" &&
            textBlock.text.length > maxToolResultLen
          ) {
            textBlock.text =
              textBlock.text.substring(0, maxToolResultLen) +
              "\n... [truncated]";
            truncatedCount++;
          }
        }
      }
    }

    // --- Phase 2: Aggressive drop (safety valve for context window) ---
    const hardMaxMessages = 80;
    let droppedCount = 0;

    if (history.length > hardMaxMessages) {
      // Find a safe cut point: keep history[0] (may be system) + recent messages
      const keepRecent = 30;
      let cutIdx = history.length - keepRecent;

      // Don't cut in the middle of a tool_call → tool_result pair
      while (cutIdx > 1) {
        const msg = history[cutIdx];
        if (msg.role === "tool") {
          cutIdx--;
          continue;
        }
        const prevMsg = history[cutIdx - 1];
        if (
          prevMsg.role === "assistant" &&
          prevMsg.content.some((c: any) => c.type === "tool_call")
        ) {
          cutIdx--;
          continue;
        }
        break;
      }

      if (cutIdx > 1) {
        droppedCount = cutIdx - 1;
        const summaryText = this.buildCompactionSummary(
          history.slice(1, cutIdx),
        );
        const summaryMessage: OrbitMessage = {
          id: `msg_compaction_summary_${Date.now()}`,
          role: "user",
          createdAt: new Date().toISOString(),
          content: [{ type: "text", text: summaryText }],
          metadata: { kind: "history_compaction_summary" },
        };
        const kept = [history[0], summaryMessage, ...history.slice(cutIdx)];
        this.state.history.length = 0;
        this.state.history.push(...kept);
      }
    }

    if (truncatedCount > 0 || droppedCount > 0) {
      this.sessionManager.saveHistory(this.state.history);
    }

    if (droppedCount > 0) {
      this.interaction.showText(
        `✔ History compaction: truncated ${truncatedCount} tool outputs, dropped ${droppedCount} oldest messages (${this.state.history.length} remaining).`,
      );
    } else if (truncatedCount > 0) {
      this.interaction.showText(
        `✔ Cache-aware compaction: truncated ${truncatedCount} bulky tool outputs (preserved ${history.length} messages for prefix cache stability).`,
      );
    }
  }

  private buildCompactionSummary(messages: OrbitMessage[]): string {
    const lines = [
      "[Conversation Summary]",
      "Older conversation turns were compacted to preserve context budget. Use this stable summary as background; rely on recent turns for exact current instructions.",
    ];

    const snippets: string[] = [];
    for (const msg of messages.slice(-24)) {
      const text = msg.content
        .map((block: any) => {
          if (block.type === "text") return block.text;
          if (block.type === "tool_call") {
            return `tool_call:${block.toolCall.name}`;
          }
          if (block.type === "tool_result") {
            return `tool_result:${block.toolResult.name}:${block.toolResult.isError ? "error" : "ok"}`;
          }
          return "";
        })
        .filter(Boolean)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      if (!text) continue;
      snippets.push(`- ${msg.role}: ${text.slice(0, 240)}`);
    }

    if (snippets.length === 0) {
      lines.push("- No compactable text content was found.");
    } else {
      lines.push(...snippets.slice(-12));
    }

    return lines.join("\n");
  }

  private async promptSchemaGuided(
    registeredTool: any,
    currentArgsStr: string,
  ): Promise<string | null> {
    try {
      const schema = registeredTool.inputSchema;
      if (!(schema instanceof z.ZodObject)) {
        return null;
      }

      const currentArgs = JSON.parse(currentArgsStr);
      const shape = schema.shape;
      const updatedArgs: Record<string, any> = {};

      for (const [key, fieldSchema] of Object.entries(shape)) {
        const val = currentArgs[key];
        const valStr =
          val !== undefined
            ? typeof val === "object"
              ? JSON.stringify(val)
              : String(val)
            : "";
        const description =
          (fieldSchema as any).description || `Parameter "${key}"`;

        let result: any = null;
        let unwrapped = fieldSchema;
        while (
          unwrapped instanceof z.ZodOptional ||
          unwrapped instanceof z.ZodNullable ||
          unwrapped instanceof z.ZodEffects
        ) {
          unwrapped =
            (unwrapped as any)._def.innerType || (unwrapped as any)._def.schema;
        }

        if (unwrapped instanceof z.ZodBoolean) {
          const choice = await Prompt.askSelect(`${description} (boolean):`, [
            { value: "true", label: "true" },
            { value: "false", label: "false" },
          ]);
          if (choice === null) return null;
          result = choice === "true";
        } else if (unwrapped instanceof z.ZodEnum) {
          const options = (unwrapped as any)._def.values.map((v: string) => ({
            value: v,
            label: v,
          }));
          const choice = await Prompt.askSelect(
            `${description} (select):`,
            options,
          );
          if (choice === null) return null;
          result = choice;
        } else {
          const input = await Prompt.askText(
            `${description} (${key}):`,
            valStr,
          );
          if (input === null) return null;

          if (unwrapped instanceof z.ZodNumber) {
            const num = Number(input);
            result = isNaN(num) ? input : num;
          } else if (
            unwrapped instanceof z.ZodArray ||
            unwrapped instanceof z.ZodObject
          ) {
            try {
              result = JSON.parse(input);
            } catch {
              result = input;
            }
          } else {
            result = input;
          }
        }

        if (result !== undefined && result !== "") {
          updatedArgs[key] = result;
        }
      }

      return JSON.stringify(updatedArgs);
    } catch {
      return null;
    }
  }

  private async handleInterrupt(): Promise<
    "continue" | "abort" | "rollback_exit"
  > {
    this.statusBar.stop();
    this.interaction.showText(
      picocolors.yellow("\n● Execution interrupted by user."),
    );
    const choice = await Prompt.askSelect("What would you like to do?", [
      { value: "continue", label: "Continue execution" },
      { value: "abort", label: "Abort execution and return to prompt" },
      { value: "rollback_exit", label: "Rollback changes and exit" },
    ]);
    return (choice as any) || "abort";
  }

  private async isGitRepo(): Promise<boolean> {
    try {
      await execPromise("git rev-parse --is-inside-work-tree", {
        cwd: this.cwd,
      });
      return true;
    } catch {
      return false;
    }
  }

  private isDeepSeekCacheProvider(model?: string): boolean {
    const providerId = this.provider.id?.toLowerCase?.() || "";
    const configuredProvider =
      this.config.provider?.default?.toLowerCase?.() || "";
    const providerConfig = this.config.providers?.[configuredProvider];
    const providerType = providerConfig?.type || this.provider.type || "";
    const modelName = model?.toLowerCase?.() || "";
    const isCompatibleProvider =
      providerType === "openai-compatible" ||
      providerType === "anthropic-compatible" ||
      (providerId !== "openai" && providerId !== "anthropic");
    return (
      providerId.includes("deepseek") ||
      configuredProvider.includes("deepseek") ||
      (isCompatibleProvider &&
        (modelName.includes("deepseek") || modelName.includes("dspark")))
    );
  }

  private async primeDeepSeekCache(
    model: string,
    slab: PromptCacheSlab,
  ): Promise<{ primed: boolean }> {
    if (!this.isDeepSeekCacheProvider(model)) {
      return { primed: false };
    }
    if (this.primedCacheSlabs.has(slab.hash)) {
      return { primed: false };
    }

    const lastPrimedAt = slab.lastPrimedAt ? Date.parse(slab.lastPrimedAt) : 0;
    if (
      lastPrimedAt &&
      Date.now() - lastPrimedAt < DEEPSEEK_CACHE_PRIMER_TTL_MS
    ) {
      this.primedCacheSlabs.add(slab.hash);
      return { primed: false };
    }
    if (this.pendingCacheSlabs.has(slab.hash)) {
      return { primed: false };
    }

    const rounds = DEEPSEEK_CACHE_PRIMER_ROUNDS;
    const latencyBudgetMs = this.getDeepSeekCachePrimerLatencyBudgetMs(
      model,
      slab,
    );
    if (latencyBudgetMs <= 0) {
      return { primed: false };
    }

    if (this.shouldShowDeepSeekCacheStatus()) {
      this.interaction.showText(
        `● Priming DeepSeek cache slab ${slab.hash.slice(0, 8)} (${slab.tokenEstimate} tokens, ${rounds} rounds)...`,
      );
    }

    this.pendingCacheSlabs.add(slab.hash);
    const primerAbortController = new AbortController();
    const primer = this.runDeepSeekCachePrimers(
      model,
      slab,
      rounds,
      primerAbortController.signal,
    );
    const result = await this.waitForDeepSeekCachePrimer(
      primer,
      latencyBudgetMs,
    );

    if (result === "timeout") {
      if (this.options?.detachBackgroundCachePrimer) {
        primerAbortController.abort();
        this.pendingCacheSlabs.delete(slab.hash);
        void primer.catch(() => {});
        return { primed: false };
      }

      void primer
        .then((primed) => {
          this.completeDeepSeekCachePrimer(slab, primed);
        })
        .catch(() => {
          this.pendingCacheSlabs.delete(slab.hash);
        });
      return { primed: false };
    }

    this.completeDeepSeekCachePrimer(slab, result);
    return { primed: result };
  }

  private async waitForDeepSeekCachePrimer(
    primer: Promise<boolean>,
    budgetMs: number,
  ): Promise<boolean | "timeout"> {
    if (!Number.isFinite(budgetMs)) {
      return await primer;
    }

    let timeoutId: NodeJS.Timeout | undefined;
    try {
      return await Promise.race<boolean | "timeout">([
        primer,
        new Promise<"timeout">((resolve) => {
          timeoutId = setTimeout(() => resolve("timeout"), budgetMs);
          timeoutId.unref?.();
        }),
      ]);
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  }

  private getDeepSeekCachePrimerLatencyBudgetMs(
    model: string,
    slab: PromptCacheSlab,
  ): number {
    if (this.options?.detachBackgroundCachePrimer) {
      return 0;
    }

    const explicitBudget = Number(
      process.env.ORBIT_DEEPSEEK_CACHE_PRIMER_BUDGET_MS,
    );
    if (Number.isFinite(explicitBudget) && explicitBudget >= 0) {
      return explicitBudget;
    }

    const modelName = model.toLowerCase();
    if (modelName.includes("flash")) {
      return DEEPSEEK_FLASH_CACHE_PRIMER_LATENCY_BUDGET_MS;
    }

    if (
      modelName.includes("pro") ||
      modelName.includes("reasoner") ||
      modelName.includes("r1")
    ) {
      return DEEPSEEK_REASONING_CACHE_PRIMER_LATENCY_BUDGET_MS;
    }

    if (slab.tokenEstimate < 512) {
      return DEEPSEEK_FLASH_CACHE_PRIMER_LATENCY_BUDGET_MS;
    }

    return DEEPSEEK_REASONING_CACHE_PRIMER_LATENCY_BUDGET_MS;
  }

  private completeDeepSeekCachePrimer(
    slab: PromptCacheSlab,
    primed: boolean,
  ): void {
    this.pendingCacheSlabs.delete(slab.hash);
    if (!primed || this.primedCacheSlabs.has(slab.hash)) {
      return;
    }

    PromptCacheSlabBuilder.markPrimed(slab);
    this.primedCacheSlabs.add(slab.hash);
    eventBus.emitEvent("cache_update", {
      slabHash: slab.hash,
      slabTokenEstimate: slab.tokenEstimate,
      primed: true,
      hitTokens: 0,
      missTokens: 0,
      inputTokens: 0,
      hitRate: 0,
      degraded: false,
    });
  }

  private async runDeepSeekCachePrimers(
    model: string,
    slab: PromptCacheSlab,
    rounds: number,
    abortSignal?: AbortSignal,
  ): Promise<boolean> {
    try {
      for (let round = 0; round < rounds; round++) {
        if (abortSignal?.aborted) {
          return false;
        }
        const primerText = round % 2 === 0 ? "0" : "1";
        const primerStream = this.provider.chat({
          model,
          system: slab.text,
          messages: [
            {
              id: `msg_cache_primer_${Date.now()}_${round}`,
              role: "user",
              createdAt: new Date().toISOString(),
              content: [
                {
                  type: "text",
                  text: primerText,
                },
              ],
            },
          ],
          tools: [],
          stream: false,
          maxTokens: 1,
          abortSignal,
        });

        for await (const event of primerStream) {
          if (event.type === "usage") {
            this.accumulateCost(model, event.usage);
          }
        }
      }
      return true;
    } catch (err: any) {
      this.interaction.showText(
        picocolors.yellow(
          `⚠ DeepSeek cache primer skipped: ${err.message || String(err)}`,
        ),
      );
      return false;
    }
  }

  private shouldShowDeepSeekCacheStatus(inputTokens = 0, hitRate = 1): boolean {
    const verbose = process.env[DEEPSEEK_VERBOSE_CACHE_ENV];
    if (verbose === "1" || verbose?.toLowerCase() === "true") {
      return true;
    }
    if (verbose === "0" || verbose?.toLowerCase() === "false") {
      return false;
    }
    return inputTokens >= 4096 && hitRate < 0.5;
  }

  private emitCacheTelemetry(
    model: string,
    slab: PromptCacheSlab,
    usage: {
      inputTokens?: number;
      cacheReadTokens?: number;
      cacheMissTokens?: number;
    },
    primed: boolean,
  ): void {
    const inputTokens = usage.inputTokens || 0;
    const hitTokens = usage.cacheReadTokens || 0;
    const explicitMiss = usage.cacheMissTokens;
    const missTokens =
      explicitMiss !== undefined
        ? explicitMiss
        : Math.max(0, inputTokens - hitTokens);
    const hitRate = inputTokens > 0 ? hitTokens / inputTokens : 0;
    const degraded =
      inputTokens >= Math.min(1024, Math.max(256, slab.tokenEstimate / 2)) &&
      hitRate < DEEPSEEK_CACHE_REPAIR_HIT_RATE;

    eventBus.emitEvent("cache_update", {
      slabHash: slab.hash,
      slabTokenEstimate: slab.tokenEstimate,
      primed,
      hitTokens,
      missTokens,
      inputTokens,
      hitRate,
      degraded,
    });

    PromptCacheSlabBuilder.recordTelemetry(slab, {
      inputTokens,
      hitTokens,
      missTokens,
      hitRate,
      degraded,
    });

    if (degraded) {
      if (this.shouldShowDeepSeekCacheStatus(inputTokens, hitRate)) {
        this.interaction.showText(
          picocolors.yellow(
            `⚠ DeepSeek cache hit degraded for slab ${slab.hash.slice(0, 8)}: ${(hitRate * 100).toFixed(0)}% hit (${hitTokens}/${inputTokens} tokens).`,
          ),
        );
      }
      if (!primed && !this.pendingCacheSlabs.has(slab.hash)) {
        void this.repairDeepSeekCache(model, slab);
      }
    }
  }

  private async repairDeepSeekCache(
    model: string,
    slab: PromptCacheSlab,
  ): Promise<void> {
    if (!this.isDeepSeekCacheProvider(model)) return;
    if (
      this.primedCacheSlabs.has(slab.hash) ||
      this.pendingCacheSlabs.has(slab.hash)
    ) {
      return;
    }
    this.pendingCacheSlabs.add(slab.hash);
    try {
      const primed = await this.runDeepSeekCachePrimers(
        model,
        slab,
        DEEPSEEK_CACHE_PRIMER_ROUNDS,
      );
      this.completeDeepSeekCachePrimer(slab, primed);
    } catch {
      // Background cache repair must never affect the visible answer.
      this.pendingCacheSlabs.delete(slab.hash);
    }
  }

  private async createGitCheckpoint(toolCallId: string): Promise<boolean> {
    try {
      const isGit = await this.isGitRepo();
      if (!isGit) return false;

      const statusRes = await execPromise("git status --porcelain", {
        cwd: this.cwd,
      });
      const hasUnstaged = !!statusRes.stdout.trim();

      if (hasUnstaged) {
        await execPromise("git add -A", { cwd: this.cwd });
        const msg = `orbit-temp-checkpoint-${toolCallId}`;
        await execPromise(`git commit -m ${JSON.stringify(msg)} --no-verify`, {
          cwd: this.cwd,
        });

        const hashRes = await execPromise("git rev-parse HEAD", {
          cwd: this.cwd,
        });
        const hash = hashRes.stdout.trim();
        if (hash) {
          this.gitCheckpoints.push({ hash, isTemporary: true });
          return true;
        }
      } else {
        let hash = "unborn";
        try {
          const hashRes = await execPromise("git rev-parse HEAD", {
            cwd: this.cwd,
          });
          hash = hashRes.stdout.trim();
        } catch {
          // Unborn repository (no commits yet)
        }
        this.gitCheckpoints.push({ hash, isTemporary: false });
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  private async rollbackLastGitCheckpoint(): Promise<boolean> {
    if (this.gitCheckpoints.length === 0) return false;
    const checkpoint = this.gitCheckpoints.pop();
    if (!checkpoint) return false;

    try {
      if (checkpoint.isTemporary) {
        // 1. Reset to the checkpoint commit state to recover tracked changes
        await execPromise(`git reset --hard ${checkpoint.hash}`, {
          cwd: this.cwd,
        });
        // 2. Clean new untracked files created by the tool execution
        await execPromise("git clean -fd", { cwd: this.cwd });
        // 3. Reset HEAD to parent commit if it exists, restoring pre-existing files to unstaged/untracked state
        try {
          await execPromise("git rev-parse HEAD~1", { cwd: this.cwd });
          await execPromise("git reset HEAD~1", { cwd: this.cwd });
        } catch {
          // If parent commit doesn't exist (root commit), reset HEAD and index to unborn state
          await execPromise("git update-ref -d HEAD", { cwd: this.cwd });
          await execPromise("git rm -r --cached .", { cwd: this.cwd });
        }
      } else {
        if (checkpoint.hash === "unborn") {
          await execPromise("git rm -rf . --ignore-unmatch", { cwd: this.cwd });
          await execPromise("git clean -fd", { cwd: this.cwd });
        } else {
          await execPromise(`git reset --hard ${checkpoint.hash}`, {
            cwd: this.cwd,
          });
          await execPromise("git clean -fd", { cwd: this.cwd });
        }
      }
      return true;
    } catch {
      return false;
    }
  }

  private async commitLastGitCheckpointSoft(): Promise<boolean> {
    if (this.gitCheckpoints.length === 0) return false;
    const checkpoint = this.gitCheckpoints.pop();
    if (!checkpoint) return false;

    if (!checkpoint.isTemporary) {
      return true;
    }

    try {
      const currentHashRes = await execPromise("git rev-parse HEAD", {
        cwd: this.cwd,
      });
      if (currentHashRes.stdout.trim() === checkpoint.hash) {
        try {
          await execPromise("git rev-parse HEAD~1", { cwd: this.cwd });
          await execPromise("git reset --soft HEAD~1", { cwd: this.cwd });
        } catch {
          // If parent commit doesn't exist (root commit), reset HEAD to unborn state
          await execPromise("git update-ref -d HEAD", { cwd: this.cwd });
        }
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  private startKeepaliveTimer(): void {
    this.stopKeepaliveTimer();

    // Refresh only the stable DeepSeek slab prefix. Replaying full turn history
    // here is slower, more expensive, and can keep volatile context alive.
    this.keepaliveTimer = setInterval(async () => {
      if (!this.lastChatParams || this.cacheKeepaliveInFlight) return;
      this.cacheKeepaliveInFlight = true;
      try {
        const pingStream = this.provider.chat({
          model: this.lastChatParams.model,
          system: this.lastChatParams.system,
          messages: [
            {
              id: `msg_cache_keepalive_${Date.now()}`,
              role: "user",
              createdAt: new Date().toISOString(),
              content: [
                {
                  type: "text",
                  text: DEEPSEEK_CACHE_KEEPALIVE_PROMPT,
                },
              ],
            },
          ],
          tools: [],
          stream: false,
          maxTokens: 1,
        });

        for await (const event of pingStream) {
          void event;
        }
      } catch {
        // Background cache refresh must never disturb the active TUI.
      } finally {
        this.cacheKeepaliveInFlight = false;
      }
    }, DEEPSEEK_CACHE_KEEPALIVE_INTERVAL_MS);
  }

  private stopKeepaliveTimer(): void {
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
  }
}

function generateXMLToolsPrompt(tools: any[]): string {
  let prompt = `\n\n### Tool Use Instructions\n`;
  prompt += `You can execute tasks by calling tools. To call a tool, wrap it in a <tool_call> XML block with the correct parameter tags.\n`;
  prompt += `Format:\n`;
  prompt += `<tool_call name="tool_name">\n`;
  prompt += `  <param_name>value</param_name>\n`;
  prompt += `</tool_call>\n\n`;
  prompt += `Crucial XML Rules:\n`;
  prompt += `1. DO NOT escape special characters (like <, >, &) inside parameter tags (e.g. inside <content> or <newText>). Write them raw. The parser handles raw content.\n`;
  prompt += `2. Ensure parameter tag names match the parameter names exactly (case-sensitive).\n`;
  prompt += `3. You can execute multiple tool calls in a single turn.\n\n`;
  prompt += `Available Tools:\n\n`;

  for (const tool of tools) {
    prompt += `- **${tool.name}**: ${tool.description}\n`;
    prompt += `  Parameters:\n`;
    const schema = tool.inputSchema as any;
    if (schema && schema.shape) {
      for (const [key, prop] of Object.entries(schema.shape)) {
        const field = describeZodPromptField(prop);
        const values = field.values ? `, values: ${field.values}` : "";
        const description = field.description
          ? ` - ${field.description.replace(/\s+/g, " ").trim()}`
          : "";
        prompt += `    - \`${key}\`: (type: ${field.typeName}${field.isOptional ? ", optional" : ""}${values})${description}\n`;
      }
    }
    prompt += `\n`;
  }
  return prompt;
}

function describeZodPromptField(schema: any): {
  typeName: string;
  isOptional: boolean;
  values?: string;
  description?: string;
} {
  const description = schema?.description || schema?._def?.description;
  let current = schema;
  let isOptional = false;

  while (current?._def) {
    const typeName = current._def.typeName;
    if (typeName === "ZodOptional" || typeName === "ZodDefault") {
      isOptional = true;
      current = current._def.innerType;
      continue;
    }
    if (typeName === "ZodNullable" || typeName === "ZodEffects") {
      current = current._def.innerType || current._def.schema;
      continue;
    }
    break;
  }

  const typeName = String(current?._def?.typeName || "ZodString")
    .replace("Zod", "")
    .toLowerCase();
  const values =
    current instanceof z.ZodEnum
      ? (current as any)._def.values.join(", ")
      : undefined;

  return {
    typeName,
    isOptional,
    values,
    description:
      description || current?.description || current?._def?.description,
  };
}

function parseXMLToolCalls(text: string): OrbitToolCall[] {
  const toolCalls: OrbitToolCall[] = [];
  const toolCallRegex =
    /<tool_call\s+name="([^"]+)"\s*>([\s\S]*?)<\/tool_call>/g;

  let match;
  let idCounter = 1;
  while ((match = toolCallRegex.exec(text)) !== null) {
    const name = match[1];
    const innerContent = match[2];

    const paramRegex = /<([a-zA-Z0-9_]+)\s*>([\s\S]*?)<\/\1\s*>/g;
    const args: Record<string, any> = {};

    let paramMatch;
    while ((paramMatch = paramRegex.exec(innerContent)) !== null) {
      const paramName = paramMatch[1];
      let paramValue = paramMatch[2];

      if (paramValue.startsWith("\n")) {
        paramValue = paramValue.substring(1);
      }
      if (paramValue.endsWith("\n")) {
        paramValue = paramValue.substring(0, paramValue.length - 1);
      } else if (paramValue.endsWith("\r\n")) {
        paramValue = paramValue.substring(0, paramValue.length - 2);
      }

      let typedValue: any = paramValue;
      if (paramValue === "true") {
        typedValue = true;
      } else if (paramValue === "false") {
        typedValue = false;
      } else if (/^-?\d+$/.test(paramValue)) {
        typedValue = parseInt(paramValue, 10);
      } else if (/^-?\d+\.\d+$/.test(paramValue)) {
        typedValue = parseFloat(paramValue);
      } else if (
        (paramValue.startsWith("[") && paramValue.endsWith("]")) ||
        (paramValue.startsWith("{") && paramValue.endsWith("}"))
      ) {
        try {
          typedValue = JSON.parse(paramValue);
        } catch {
          // Keep as string
        }
      }
      args[paramName] = typedValue;
    }

    toolCalls.push({
      id: `xml_call_${idCounter++}_${Date.now()}`,
      name,
      arguments: JSON.stringify(args),
    });
  }

  return toolCalls;
}

function extractFilePathFromLine(line: string): string {
  const winAbsMatch = line.match(/([a-zA-Z]:[\\/][^`*:"#\s]+)/);
  if (winAbsMatch) {
    return winAbsMatch[1];
  }

  const pathMatch = line.match(/([.\w\-+]+[\\/][^`*:"#\s]+)/);
  if (pathMatch) {
    return pathMatch[1];
  }

  return line.replace(/[`*:*#\-+]/g, "").trim();
}

function parseSearchReplaceBlocks(
  text: string,
): { filePath: string; oldText: string; newText: string }[] {
  const blocks: { filePath: string; oldText: string; newText: string }[] = [];
  const regex =
    /<<<<<<< SEARCH\r?\n([\s\S]*?)\r?\n=======\r?\n([\s\S]*?)\r?\n>>>>>>>/g;

  let match;
  while ((match = regex.exec(text)) !== null) {
    const startIndex = match.index;
    const oldText = match[1];
    const newText = match[2];

    const beforeText = text.substring(0, startIndex);
    const lines = beforeText.split(/\r?\n/);
    let filePath = "";

    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      const extracted = extractFilePathFromLine(line);
      if (
        extracted &&
        (extracted.includes("/") ||
          extracted.includes("\\") ||
          extracted.endsWith(".ts") ||
          extracted.endsWith(".js") ||
          extracted.endsWith(".txt"))
      ) {
        filePath = extracted;
        break;
      }
    }

    if (filePath) {
      blocks.push({
        filePath,
        oldText,
        newText,
      });
    }
  }
  return blocks;
}

function cleanAndTruncateTestLog(log: string): string {
  const cleaned = log
    .replace(/\u001b\[\d+(;\d+)*m/g, "")
    .replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "");
  const lines = cleaned.split(/\r?\n/);
  const filteredLines: string[] = [];
  let skipCount = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (
      trimmed.startsWith("at ") &&
      (trimmed.includes("node_modules") ||
        trimmed.includes("node:internal") ||
        trimmed.includes("node:events"))
    ) {
      skipCount++;
      continue;
    }

    if (skipCount > 0) {
      filteredLines.push(
        `    ... skipped ${skipCount} internal/library stack frames ...`,
      );
      skipCount = 0;
    }
    filteredLines.push(line);
  }

  if (skipCount > 0) {
    filteredLines.push(
      `    ... skipped ${skipCount} internal/library stack frames ...`,
    );
  }

  if (filteredLines.length > 200) {
    const top = filteredLines.slice(0, 80);
    const bottom = filteredLines.slice(filteredLines.length - 120);
    return [
      ...top,
      "\n[... WARNING: Log output truncated by Orbit for Token Optimization ...]\n",
      ...bottom,
    ].join("\n");
  }

  return filteredLines.join("\n");
}
