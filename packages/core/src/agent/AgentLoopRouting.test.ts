import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AgentLoop } from "./AgentLoop.js";
import { OrbitConfig } from "@orbit-build/config";
import { ModelProvider } from "@orbit-build/model-providers";
import { toolRegistry } from "@orbit-build/tools";
import { Prompt } from "@orbit-build/tui";
import { z } from "zod";
import fs from "fs";
import path from "path";

describe("AgentLoop Fin Heuristic Routing", () => {
  const testDir = path.resolve(process.cwd(), "routing-test-temp");

  const dummyConfig: OrbitConfig = {
    name: "test",
    provider: { default: "openai" },
    models: {
      default: "deepseek-v4-pro",
      fast: "deepseek-v4-flash",
    },
    providers: { openai: { type: "openai", apiKey: "test" } },
    permissions: {
      mode: "auto",
      allowRead: true,
      requireApprovalForWrite: false,
      requireApprovalForBash: false,
      blockDangerousCommands: false,
      protectSecrets: false,
      protectedPaths: [],
    },
    context: {
      maxFilesToIndex: 10,
      maxFileSizeKb: 10,
      ignore: [],
      autoCompact: false,
      compactThreshold: 0.75,
    },
    tools: {
      bash: { enabled: false, timeoutMs: 1000 },
      webSearch: { enabled: false },
      mcp: { enabled: false },
    },
    mcpServers: {},
    hooks: {},
    session: { store: "jsonl", path: ".orbit/test-sessions" },
  };

  const dummyInteraction = {
    askApproval: async () => true,
    showText: () => {},
    showDiff: () => {},
  };

  beforeEach(() => {
    if (!fs.existsSync(testDir)) {
      fs.mkdirSync(testDir, { recursive: true });
    }
  });

  afterEach(() => {
    delete process.env.ORBIT_DEEPSEEK_CACHE_PRIMER_BUDGET_MS;
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("should route to default reasoning model and set high thinking budget on complex keywords", async () => {
    const chatMock = vi.fn().mockImplementation(async function* () {
      yield {
        type: "text_delta",
        text: "Response",
      };
    });

    const mockProvider: ModelProvider = {
      id: "openai",
      chat: chatMock,
    } as any;

    const loop = new AgentLoop(
      testDir,
      dummyConfig,
      mockProvider,
      "please debug the compilation error in parser.ts",
      dummyInteraction,
      { disableStatusBar: true },
    );

    await loop.run();

    expect(chatMock).toHaveBeenCalled();
    const callArgs = chatMock.mock.calls[0][0];
    expect(callArgs.model).toBe("deepseek-v4-pro");
    expect(callArgs.thinking).toEqual({ enabled: true, budgetTokens: 4096 });
  });

  it("should route to fast model on simple query", async () => {
    const chatMock = vi.fn().mockImplementation(async function* () {
      yield {
        type: "text_delta",
        text: "Response",
      };
    });

    const mockProvider: ModelProvider = {
      id: "openai",
      chat: chatMock,
    } as any;

    const loop = new AgentLoop(
      testDir,
      dummyConfig,
      mockProvider,
      "what is this project?",
      dummyInteraction,
      { disableStatusBar: true },
    );

    await loop.run();

    expect(chatMock).toHaveBeenCalled();
    const callArgs = chatMock.mock.calls[0][0];
    expect(callArgs.model).toBe("deepseek-v4-flash");
    // Since it's deepseek-v4-flash (which doesn't contain "reasoner" or "r1" or "v4-pro"), thinking should be undefined
    expect(callArgs.thinking).toBeUndefined();
  });

  it("should apply configured agent loop iteration limit", () => {
    const mockProvider: ModelProvider = {
      id: "openai",
      chat: vi.fn(),
    } as any;

    const loop = new AgentLoop(
      testDir,
      {
        ...dummyConfig,
        agent: { maxIterations: 12 },
      } as any,
      mockProvider,
      "search current weather",
      dummyInteraction,
      { disableStatusBar: true },
    );

    expect((loop as any).state.maxAttempts).toBe(12);
  });

  it("should ask only once for repeated web search approval in one run", async () => {
    const originalWebSearch = toolRegistry.get("web_search");
    const executeWebSearch = vi.fn(async (input: any) => ({
      ok: true,
      data: `result for ${input.query}`,
      display: `mock search for ${input.query}`,
    }));
    toolRegistry.register({
      name: "web_search",
      description: "mock web search",
      inputSchema: z.object({ query: z.string() }),
      risk: "network",
      execute: executeWebSearch,
    });
    const askApproval = vi.spyOn(Prompt, "askApproval").mockResolvedValue(true);
    const askSelect = vi.spyOn(Prompt, "askSelect");

    let callCount = 0;
    const chatMock = vi.fn().mockImplementation(async function* () {
      callCount++;
      if (callCount === 1) {
        yield {
          type: "tool_call",
          toolCall: {
            id: "search-1",
            name: "web_search",
            arguments: JSON.stringify({ query: "杭州 2026-06-29 天气" }),
          },
        };
        return;
      }
      if (callCount === 2) {
        yield {
          type: "tool_call",
          toolCall: {
            id: "search-2",
            name: "web_search",
            arguments: JSON.stringify({ query: "杭州 2026-06-29 气温" }),
          },
        };
        return;
      }
      yield { type: "text_delta", text: "done" };
    });

    const mockProvider: ModelProvider = {
      id: "openai",
      chat: chatMock,
      getModelCapabilities: () => ({
        streaming: true,
        toolCalls: true,
        jsonMode: true,
        thinking: false,
        vision: false,
        promptCaching: true,
      }),
    } as any;

    try {
      const loop = new AgentLoop(
        testDir,
        {
          ...dummyConfig,
          permissions: { ...dummyConfig.permissions, mode: "normal" },
          tools: {
            ...dummyConfig.tools,
            webSearch: { enabled: true },
          },
          agent: { maxIterations: 8 },
        } as any,
        mockProvider,
        "查杭州 2026-06-29 天气",
        dummyInteraction,
        { disableStatusBar: true },
      );

      await loop.run();

      expect(executeWebSearch).toHaveBeenCalledTimes(2);
      expect(askApproval).toHaveBeenCalledTimes(1);
      expect(askSelect).not.toHaveBeenCalledWith(
        expect.stringContaining('Confirm execution of tool "web_search"'),
        expect.anything(),
      );
    } finally {
      if (originalWebSearch) {
        toolRegistry.register(originalWebSearch);
      }
      askApproval.mockRestore();
      askSelect.mockRestore();
    }
  });

  it("should prime DeepSeek cache slab before the main request", async () => {
    const chatMock = vi.fn().mockImplementation(async function* (input: any) {
      if (input.maxTokens === 1) {
        yield {
          type: "usage",
          usage: {
            inputTokens: 100,
            outputTokens: 1,
            totalTokens: 101,
            cacheReadTokens: 0,
            cacheMissTokens: 100,
          },
        };
        return;
      }
      yield {
        type: "text_delta",
        text: "Response",
      };
      yield {
        type: "usage",
        usage: {
          inputTokens: 120,
          outputTokens: 5,
          totalTokens: 125,
          cacheReadTokens: 80,
          cacheMissTokens: 40,
        },
      };
    });

    const mockProvider: ModelProvider = {
      id: "deepseek-openai",
      type: "openai-compatible",
      chat: chatMock,
      getModelCapabilities: () => ({
        streaming: true,
        toolCalls: true,
        jsonMode: true,
        thinking: false,
        vision: false,
        promptCaching: true,
      }),
    } as any;

    const loop = new AgentLoop(
      testDir,
      {
        ...dummyConfig,
        provider: { default: "deepseek-openai" },
      },
      mockProvider,
      "what is this project?",
      dummyInteraction,
      { disableStatusBar: true },
    );

    await loop.run();

    expect(chatMock).toHaveBeenCalledTimes(3);
    const firstPrimerArgs = chatMock.mock.calls[0][0];
    const secondPrimerArgs = chatMock.mock.calls[1][0];
    const mainArgs = chatMock.mock.calls[2][0];
    expect(firstPrimerArgs.maxTokens).toBe(1);
    expect(secondPrimerArgs.maxTokens).toBe(1);
    expect(firstPrimerArgs.system).toContain("<!-- VOLATILE_CONTEXT -->");
    expect(mainArgs.system.startsWith(firstPrimerArgs.system)).toBe(true);
    expect(mainArgs.system).toContain("### Volatile Context");
  });

  it("should prime cache for self-hosted DSpark models by model name", async () => {
    const chatMock = vi.fn().mockImplementation(async function* (input: any) {
      if (input.maxTokens === 1) {
        yield {
          type: "usage",
          usage: {
            inputTokens: 100,
            outputTokens: 1,
            totalTokens: 101,
            cacheReadTokens: 0,
            cacheMissTokens: 100,
          },
        };
        return;
      }
      yield {
        type: "text_delta",
        text: "Response",
      };
    });

    const mockProvider: ModelProvider = {
      id: "local-openai-compatible",
      type: "openai-compatible",
      chat: chatMock,
      getModelCapabilities: () => ({
        streaming: true,
        toolCalls: true,
        jsonMode: true,
        thinking: false,
        vision: false,
        promptCaching: true,
      }),
    } as any;

    const loop = new AgentLoop(
      testDir,
      {
        ...dummyConfig,
        provider: { default: "local-dspark" },
        models: {
          default: "deepseek-ai/DeepSeek-V4-Flash-DSpark",
          fast: "deepseek-ai/DeepSeek-V4-Flash-DSpark",
        },
        providers: {
          "local-dspark": {
            type: "openai-compatible",
            baseUrl: "http://localhost:8000/v1",
          },
        },
      },
      mockProvider,
      "what is this project?",
      dummyInteraction,
      { disableStatusBar: true },
    );

    await loop.run();

    expect(chatMock).toHaveBeenCalledTimes(3);
    expect(chatMock.mock.calls[0][0].maxTokens).toBe(1);
    expect(chatMock.mock.calls[1][0].maxTokens).toBe(1);
    expect(chatMock.mock.calls[2][0].model).toBe(
      "deepseek-ai/DeepSeek-V4-Flash-DSpark",
    );
  });

  it("does not block Flash main request when cache primer exceeds latency budget", async () => {
    process.env.ORBIT_DEEPSEEK_CACHE_PRIMER_BUDGET_MS = "1";
    const callOrder: string[] = [];
    const chatMock = vi.fn().mockImplementation(async function* (input: any) {
      if (input.maxTokens === 1) {
        callOrder.push("primer");
        await new Promise((resolve) => setTimeout(resolve, 50));
        yield {
          type: "usage",
          usage: {
            inputTokens: 100,
            outputTokens: 1,
            totalTokens: 101,
            cacheReadTokens: 0,
            cacheMissTokens: 100,
          },
        };
        return;
      }

      callOrder.push("main");
      yield {
        type: "text_delta",
        text: "Response",
      };
    });

    const mockProvider: ModelProvider = {
      id: "deepseek-openai",
      type: "openai-compatible",
      chat: chatMock,
      getModelCapabilities: () => ({
        streaming: true,
        toolCalls: true,
        jsonMode: true,
        thinking: false,
        vision: false,
        promptCaching: true,
      }),
    } as any;

    const loop = new AgentLoop(
      testDir,
      {
        ...dummyConfig,
        provider: { default: "deepseek-openai" },
      },
      mockProvider,
      "what is this project?",
      dummyInteraction,
      { disableStatusBar: true },
    );

    await loop.run();

    expect(callOrder[0]).toBe("primer");
    expect(callOrder[1]).toBe("main");
    expect(chatMock.mock.calls[1][0].maxTokens).toBeUndefined();

    await new Promise((resolve) => setTimeout(resolve, 120));

    expect(chatMock).toHaveBeenCalledTimes(3);
    expect(chatMock.mock.calls[2][0].maxTokens).toBe(1);
  });
});
