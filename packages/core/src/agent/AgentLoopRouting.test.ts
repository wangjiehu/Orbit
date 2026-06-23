import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AgentLoop } from "./AgentLoop.js";
import { OrbitConfig } from "@orbit-build/config";
import { ModelProvider } from "@orbit-build/model-providers";
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
      { disableStatusBar: true }
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
      { disableStatusBar: true }
    );

    await loop.run();

    expect(chatMock).toHaveBeenCalled();
    const callArgs = chatMock.mock.calls[0][0];
    expect(callArgs.model).toBe("deepseek-v4-flash");
    // Since it's deepseek-v4-flash (which doesn't contain "reasoner" or "r1" or "v4-pro"), thinking should be undefined
    expect(callArgs.thinking).toBeUndefined();
  });
});
