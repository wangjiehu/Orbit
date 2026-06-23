import { describe, it, expect } from "vitest";
import { AgentLoop } from "./AgentLoop.js";
import { OrbitConfig } from "@orbit-build/config";
import { ModelProvider } from "@orbit-build/model-providers";

describe("AgentLoop Hooks System", () => {
  const dummyConfig: OrbitConfig = {
    name: "test",
    provider: { default: "openai" },
    models: { default: "gpt-4" },
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
    hooks: {
      preEdit:
        "node -e \"if (process.env.FAIL === 'true') process.exit(1); console.log('pre-ok')\"",
      postEdit:
        "node -e \"if (process.env.FAIL_POST === 'true') process.exit(1); console.log('post-ok')\"",
    },
    session: { store: "jsonl", path: ".orbit/test-sessions" },
  };

  const dummyProvider: ModelProvider = {
    id: "openai",
    chat: () => {
      throw new Error("Not implemented");
    },
  } as any;

  const dummyInteraction = {
    askApproval: async () => true,
    showText: () => {},
    showDiff: () => {},
  };

  it("should run preEdit and postEdit hooks successfully", async () => {
    const loop = new AgentLoop(
      process.cwd(),
      dummyConfig,
      dummyProvider,
      "test task",
      dummyInteraction,
    );

    // Test runHook helper directly
    const resPre = await (loop as any).runHook(
      dummyConfig.hooks.preEdit!,
      "dummy.txt",
    );
    expect(resPre.ok).toBe(true);
    expect(resPre.output).toBe("pre-ok");

    // Test runHook failure
    process.env.FAIL = "true";
    const resPreFail = await (loop as any).runHook(
      dummyConfig.hooks.preEdit!,
      "dummy.txt",
    );
    expect(resPreFail.ok).toBe(false);
    delete process.env.FAIL;
  });

  it("should substitute {file} placeholder in hooks", async () => {
    const loop = new AgentLoop(
      process.cwd(),
      dummyConfig,
      dummyProvider,
      "test task",
      dummyInteraction,
    );
    const hookWithFile = 'node -e "console.log(process.argv[1])" {file}';
    const res = await (loop as any).runHook(
      hookWithFile,
      "dummy-test-file.txt",
    );
    expect(res.ok).toBe(true);
    expect(res.output).toContain("dummy-test-file.txt");
  });
});
