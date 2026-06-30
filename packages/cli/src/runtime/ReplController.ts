import {
  AgentLoop,
  UserInteraction,
  Orchestrator,
  eventBus,
  AutocompleteEngine,
} from "@orbit-build/core";
import { Prompt, Renderer, DiffView } from "@orbit-build/tui";
import picocolors from "picocolors";
import { existsSync, readFileSync, writeFileSync, mkdirSync, watch } from "fs";
import { join, dirname, resolve } from "path";
import { homedir } from "os";
import http from "http";
import { SymbolIndexer } from "@orbit-build/context-engine";
import { FullscreenTui, pageText } from "../tui/FullscreenTui.js";
import { CommandRouter, getAutocompleteCandidates } from "./CommandRouter.js";

interface LocalState {
  lastSessionId?: string;
  lastModel?: string;
}

export class ReplController {
  private currentTui: FullscreenTui | null = null;
  private watchTimeout: NodeJS.Timeout | null = null;
  private watcher: any = null;
  private candidates: any = null;
  private autocompleteServer: http.Server | null = null;

  constructor(
    private cwd: string,
    private config: any,
    private providerInstance: any,
    private interaction: UserInteraction,
    private multi?: boolean,
    private direct?: boolean,
  ) {}

  private getLocalState(): LocalState {
    const statePath = join(this.cwd, ".orbit", "state.json");
    if (!existsSync(statePath)) return {};
    try {
      return JSON.parse(readFileSync(statePath, "utf8"));
    } catch {
      return {};
    }
  }

  private saveLocalState(state: LocalState): void {
    const statePath = join(this.cwd, ".orbit", "state.json");
    try {
      const dir = dirname(statePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      const current = this.getLocalState();
      const updated = { ...current, ...state };
      writeFileSync(statePath, JSON.stringify(updated, null, 2), "utf8");
    } catch {}
  }

  private startAutocompleteServer() {
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
            const completion = await engine.autocomplete(
              prefix,
              suffix,
              this.config,
            );
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

    let currentPort = 6018;
    server.once("listening", () => {
      eventBus.emitEvent("info", {
        message: `Autocomplete bridge server running on http://127.0.0.1:${currentPort}`,
      });
    });
    server.on("error", (err: any) => {
      if (err.code === "EADDRINUSE") {
        currentPort++;
        server.listen(currentPort, "127.0.0.1");
      }
    });
    server.listen(currentPort, "127.0.0.1");
    return server;
  }

  public async start(): Promise<void> {
    const version = "v0.1.0";
    const sigintHandler = () => {
      // Prevent process exit on Ctrl+C during agent execution or REPL waiting.
    };
    process.on("SIGINT", sigintHandler);

    const isTTY =
      process.stdin.isTTY && typeof process.stdin.setRawMode === "function";
    const useFullscreenTui = isTTY && !this.direct;
    this.autocompleteServer = this.config.autocomplete?.enabled
      ? this.startAutocompleteServer()
      : null;

    const tui = new FullscreenTui(
      this.cwd,
      this.config.models.default,
      version,
      this.config,
    );
    this.currentTui = tui;
    tui.setPermissionsMode(this.config.permissions.mode);
    if (useFullscreenTui) {
      Prompt.setTuiInstance(tui);
    }

    const tuiInteraction: UserInteraction = {
      askApproval: async (
        reason: string,
        preview?: string,
      ): Promise<boolean> => {
        if (useFullscreenTui && tui.isActive) {
          const message = preview
            ? `Risk Warning: ${reason}\nParameters: ${preview}\nConfirm action?`
            : `Risk Warning: ${reason}\nConfirm action?`;
          return await Prompt.askApproval(message);
        }

        const wasActive = useFullscreenTui && tui.isActive;
        if (wasActive) tui.stop();

        console.log(`\nRisk Warning: ${reason}`);
        if (preview) {
          console.log(picocolors.gray(`Parameters: ${preview}`));
        }
        const approved = await Prompt.askApproval("Confirm action?");

        if (wasActive) tui.start(this.config.budgetLimit);
        return approved;
      },
      showText(text: string): void {
        if (useFullscreenTui && tui.isActive) {
          tui.addLog(text);
        } else {
          console.log(text);
        }
      },
      showDiff: async (
        filePath: string,
        before: string | null,
        after: string,
      ): Promise<void> => {
        const wasActive = useFullscreenTui && tui.isActive;
        if (wasActive) tui.stop();

        await pageText(DiffView.render(filePath, before, after));

        if (wasActive) tui.start(this.config.budgetLimit);
      },
    };

    const localState = this.getLocalState();
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
      this.cwd,
      this.config,
      this.providerInstance,
      "REPL Interactive Shell Started",
      tuiInteraction,
      {
        disableStatusBar: useFullscreenTui,
        sessionId: resumeSessionId,
      },
    );

    this.saveLocalState({
      lastSessionId: loop.getSessionId(),
      lastModel: loop.getModelOverride() || this.config.models.default,
    });

    if (resumeSessionId && useFullscreenTui) {
      tui.loadHistory(loop.getHistory());
      tui.setCost(
        loop.getSessionCost(),
        loop.getTotalInputTokens(),
        loop.getTotalCacheReadTokens(),
        loop.getTotalOutputTokens(),
      );
    }

    tui.setModelNameGetter(
      () => loop.getModelOverride() || this.config.models.default,
    );

    // Load autocomplete candidates
    this.candidates = await getAutocompleteCandidates(this.cwd, this.config);
    tui.setCandidates(this.candidates);

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
    const onModelRequest = (payload: any) => {
      if (useFullscreenTui && payload?.model) {
        tui.setActiveModelName(payload.model);
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
    const onCacheUpdate = (payload: any) => {
      if (useFullscreenTui) {
        tui.setCacheTelemetry(payload);
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
    eventBus.on("model_request", onModelRequest);
    eventBus.on("cost_update", onCostUpdate);
    eventBus.on("cache_update", onCacheUpdate);
    eventBus.on("thinking_delta", onThinkingDelta);

    // Start background file watcher (Dynamic Incremental Watcher with Config Ignores)
    const ignorePatterns = this.config.context?.ignore || [];
    const ignoreRegexes = ignorePatterns.map((pattern: string) => {
      const escaped = pattern
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*\*/g, "__DOUBLE_STAR__")
        .replace(/\*/g, "[^/]*")
        .replace(/__DOUBLE_STAR__\/?/g, "(?:|.*/)");
      const finalPattern = escaped.endsWith(".*")
        ? "^" + escaped + "$"
        : "(^" + escaped + "$|^" + escaped + "\/.*)";
      return new RegExp(finalPattern);
    });

    const normCwd = resolve(this.cwd).toLowerCase().replace(/\\/g, "/");
    const normHome = resolve(homedir()).toLowerCase().replace(/\\/g, "/");
    const isHomeOrRoot =
      normCwd === normHome ||
      normCwd === "/" ||
      /^[a-zA-Z]:\/$/.test(normCwd) ||
      dirname(normCwd) === normCwd;

    if (!isHomeOrRoot) {
      const indexer = new SymbolIndexer(this.cwd);
      this.watcher = watch(
        this.cwd,
        { recursive: true },
        (eventType, filename) => {
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

            if (this.watchTimeout) clearTimeout(this.watchTimeout);
            this.watchTimeout = setTimeout(() => {
              indexer.index().catch(() => {});
            }, 500); // debounce 500ms
          }
        },
      );
    }

    if (useFullscreenTui) {
      tui.start(this.config.budgetLimit);
    } else {
      Renderer.printHeader(
        loop.getSessionId(),
        this.config.models.default,
        this.cwd,
      );
    }

    const commandRouter = new CommandRouter(
      this.cwd,
      this.config,
      this.providerInstance,
      (newProvider: any) => {
        this.providerInstance = newProvider;
      },
      loop,
      tui,
      useFullscreenTui,
      () => this.candidates,
      (c: any) => {
        this.candidates = c;
        tui.setCandidates(c);
      },
      this.getLocalState.bind(this),
      this.saveLocalState.bind(this),
      tuiInteraction,
      this.multi,
    );

    try {
      while (true) {
        let input: string | null;
        if (useFullscreenTui) {
          input = await tui.askInput();
        } else {
          input = await Prompt.askTextWithAutocomplete(
            "Type your task or command...",
            this.makeCompleter(),
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

        const trimmed = input.trim();
        if (!trimmed) continue;

        const routeResult = await commandRouter.route(trimmed);
        if (routeResult.shouldExit) {
          break;
        }
        if (routeResult.processed) {
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
          const fastModel =
            this.config.models.fast || this.config.models.default;
          const firstPrompt = trimmed;
          Promise.resolve().then(async () => {
            try {
              const stream = this.providerInstance.chat({
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
        if (this.multi) {
          orchestratorInstance = new Orchestrator(
            this.cwd,
            this.config,
            this.providerInstance,
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
        } catch {
          // Fallback
        } finally {
          tui.stopThinkingInput();
          tui.setActiveRunnable(null);
        }

        // If a guided correction was entered during execution, loop to append and rerun
        while (tui.pendingGuidedStatement) {
          const guidedTask = tui.pendingGuidedStatement;
          tui.pendingGuidedStatement = null;

          const isZh = this.config.language === "zh";
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
          if (this.multi) {
            subOrchestrator = new Orchestrator(
              this.cwd,
              this.config,
              this.providerInstance,
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
          } catch {
            // Fallback
          } finally {
            tui.stopThinkingInput();
            tui.setActiveRunnable(null);
          }
        }
        tui.syncFromLoop(loop);
        tui.finishAttempt();

        // Refresh candidates in the background asynchronously
        getAutocompleteCandidates(this.cwd, this.config)
          .then((c) => {
            this.candidates = c;
            tui.setCandidates(c);
          })
          .catch(() => {});
      }
    } finally {
      process.off("SIGINT", sigintHandler);
      this.watcher?.close();
      if (this.watchTimeout) clearTimeout(this.watchTimeout);
      eventBus.off("model_delta", onModelDelta);
      eventBus.off("loop_start", onLoopStart);
      eventBus.off("model_request", onModelRequest);
      eventBus.off("cost_update", onCostUpdate);
      eventBus.off("cache_update", onCacheUpdate);
      eventBus.off("thinking_delta", onThinkingDelta);
      if (useFullscreenTui) {
        Prompt.setTuiInstance(null);
      }
      tui.dispose();
      this.autocompleteServer?.close();
    }
  }

  private makeCompleter() {
    return (line: string): [string[], string] => {
      const candidates = this.candidates;
      if (!candidates) return [[], ""];

      if (line.startsWith("/")) {
        const hits = candidates.commands.filter((c: string) =>
          c.startsWith(line),
        );
        return [hits.length ? hits : candidates.commands, line];
      }

      const words = line.split(/\s+/);
      const lastWord = words[words.length - 1] || "";

      if (!lastWord) {
        return [[], lastWord];
      }

      const fileHits = candidates.files.filter((f: string) =>
        f.startsWith(lastWord),
      );
      const symbolHits = candidates.symbols.filter((s: string) =>
        s.startsWith(lastWord),
      );
      const allHits = [...fileHits, ...symbolHits];

      return [allHits, lastWord];
    };
  }
}
