import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AgentLoop } from "./AgentLoop.js";
import { OrbitConfig } from "@orbit-build/config";
import { ModelProvider } from "@orbit-build/model-providers";
import { Prompt } from "@orbit-build/tui";
import fs from "fs";
import path from "path";

describe("AgentLoop Hunk Acceptance Flow", () => {
  const testDir = path.resolve(process.cwd(), "hunk-test-temp");
  const testFile = path.join(testDir, "test.txt");

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
    hooks: {},
    session: { store: "jsonl", path: ".orbit/test-sessions" },
  };

  const createMockProvider = (): ModelProvider => {
    let callCount = 0;
    return {
      id: "openai",
      chat: async function* () {
        callCount++;
        if (callCount === 1) {
          yield {
            type: "tool_call",
            toolCall: {
              id: "call_1",
              name: "write_file",
              arguments: JSON.stringify({
                path: testFile,
                content: "line1\nlineX\nline3\nlineY\nline5",
              }),
            },
          };
        } else {
          yield {
            type: "text_delta",
            text: "I have finished writing the file.",
          };
        }
      },
    } as any;
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
    fs.writeFileSync(testFile, "line1\nline2\nline3\nline4\nline5", "utf8");
  });

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  it("should accept all changes when user selects yes", async () => {
    const askSelectSpy = vi.spyOn(Prompt, "askSelect").mockResolvedValue("yes");

    const loop = new AgentLoop(
      testDir,
      dummyConfig,
      createMockProvider(),
      "modify file",
      dummyInteraction,
    );
    await loop.run();

    expect(askSelectSpy).toHaveBeenCalled();
    const finalContent = fs.readFileSync(testFile, "utf8");
    expect(finalContent).toBe("line1\nlineX\nline3\nlineY\nline5");
  });

  it("should reject and rollback changes when user selects no", async () => {
    const askSelectSpy = vi.spyOn(Prompt, "askSelect").mockResolvedValue("no");

    const loop = new AgentLoop(
      testDir,
      dummyConfig,
      createMockProvider(),
      "modify file",
      dummyInteraction,
    );
    await loop.run();

    expect(askSelectSpy).toHaveBeenCalled();
    const finalContent = fs.readFileSync(testFile, "utf8");
    // Content should remain original
    expect(finalContent).toBe("line1\nline2\nline3\nline4\nline5");
  });

  it("should apply selected hunks and reject other hunks", async () => {
    const askSelectSpy = vi
      .spyOn(Prompt, "askSelect")
      .mockResolvedValue("hunks");
    // Mock multi-select to return indices of hunks to apply (only apply Hunk 1)
    const askMultiSelectSpy = vi
      .spyOn(Prompt, "askMultiSelect")
      .mockResolvedValue(["0"]);

    const loop = new AgentLoop(
      testDir,
      dummyConfig,
      createMockProvider(),
      "modify file",
      dummyInteraction,
    );
    await loop.run();

    expect(askSelectSpy).toHaveBeenCalled();
    expect(askMultiSelectSpy).toHaveBeenCalled();

    const finalContent = fs.readFileSync(testFile, "utf8");
    // Hunk 1 accepted (lineX), Hunk 2 rejected (remains line4)
    expect(finalContent).toBe("line1\nlineX\nline3\nline4\nline5");
  });

  it("should parse XML tool call from text_delta and execute it successfully", async () => {
    const askSelectSpy = vi.spyOn(Prompt, "askSelect").mockResolvedValue("yes");

    let callCount = 0;
    const xmlMockProvider: ModelProvider = {
      id: "openai",
      chat: async function* () {
        callCount++;
        if (callCount === 1) {
          yield {
            type: "text_delta",
            text: `I will use the write_file tool to write to the file.\n\n<tool_call name="write_file">\n  <path>${testFile.replace(/\\/g, "/")}</path>\n  <content>xmlLine1\nxmlLine2</content>\n</tool_call>\n\nLet me know if this works.`,
          };
        } else {
          yield {
            type: "text_delta",
            text: "I have finished writing the file via XML.",
          };
        }
      },
    } as any;

    const loop = new AgentLoop(
      testDir,
      dummyConfig,
      xmlMockProvider,
      "modify file",
      dummyInteraction,
    );
    await loop.run();

    expect(askSelectSpy).toHaveBeenCalled();
    const finalContent = fs.readFileSync(testFile, "utf8");
    expect(finalContent).toBe("xmlLine1\nxmlLine2");
  });

  it("should parse SEARCH/REPLACE block from text_delta and execute it successfully", async () => {
    const askSelectSpy = vi.spyOn(Prompt, "askSelect").mockResolvedValue("yes");

    let callCount = 0;
    const srMockProvider: ModelProvider = {
      id: "openai",
      chat: async function* () {
        callCount++;
        if (callCount === 1) {
          yield {
            type: "text_delta",
            text: `I will modify the test file now.\n\nFile: ${testFile.replace(/\\/g, "/")}\n<<<<<<< SEARCH\nline2\nline3\n=======\nlineX\nlineY\n>>>>>>>\n\nHope that looks correct!`,
          };
        } else {
          yield {
            type: "text_delta",
            text: "I have completed the SEARCH/REPLACE modifications.",
          };
        }
      },
    } as any;

    const loop = new AgentLoop(
      testDir,
      dummyConfig,
      srMockProvider,
      "modify file",
      dummyInteraction,
    );
    await loop.run();

    expect(askSelectSpy).toHaveBeenCalled();
    const finalContent = fs.readFileSync(testFile, "utf8");
    expect(finalContent).toBe("line1\nlineX\nlineY\nline4\nline5");
  });
});
