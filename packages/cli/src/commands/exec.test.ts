import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runAgent } from "./run.js";
import { eventBus } from "@orbit-build/core";
import { ConfigLoader } from "@orbit-build/config";
import fs from "fs";
import path from "path";
import { tmpdir } from "os";

// Mock AgentLoop to avoid actual provider calls
vi.mock("@orbit-build/core", async () => {
  const actual = await vi.importActual<typeof import("@orbit-build/core")>("@orbit-build/core");
  
  class MockAgentLoop {
    constructor(
      private cwd: string,
      private config: any,
      private provider: any,
      private task: string,
      private interaction: any
    ) {}
    
    async run() {
      // Simulate calling interaction.askApproval to test non-interactive auto-deny
      const approved = await this.interaction.askApproval("Should write file?", "some-args");
      this.interaction.showText(`Approved: ${approved}`);
      
      // Simulate emitting an event
      eventBus.emitEvent("info", { message: "Test info message" });
    }
  }

  return {
    ...actual,
    AgentLoop: MockAgentLoop,
  };
});

describe("non-interactive orbit exec tests", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = path.join(tmpdir(), `orbit-exec-test-${Date.now()}`);
    fs.mkdirSync(cwd, { recursive: true });

    vi.spyOn(ConfigLoader, "loadSync").mockReturnValue({
      name: "test",
      provider: { default: "test-provider" },
      models: { default: "test-model" },
      providers: { "test-provider": { type: "openai", apiKey: "test-key" } },
      permissions: { mode: "interactive" },
      tools: { bash: { enabled: false }, webSearch: { enabled: false }, mcp: { enabled: false } },
      mcpServers: {},
      hooks: {},
      session: { store: "jsonl" },
    } as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (fs.existsSync(cwd)) {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("should auto-deny approvals and write to stderr in non-interactive mode", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    
    await runAgent(cwd, "test task", {}, false, { nonInteractive: true });

    // Expect showText and askApproval logs to go to stderr
    expect(consoleErrorSpy).toHaveBeenCalled();
    const calls = consoleErrorSpy.mock.calls.map(c => c.join(" "));
    expect(calls.some(c => c.includes("Automatically denying action"))).toBe(true);
    expect(calls.some(c => c.includes("Approved: false"))).toBe(true);
  });

  it("should stream events as JSONL to stdout in jsonl mode", async () => {
    const logOutput: string[] = [];
    const origLog = console.log;
    const origError = console.error;
    
    // We capture stdout log calls
    console.log = (msg: string) => {
      logOutput.push(msg);
    };
    console.error = () => {};

    try {
      await runAgent(cwd, "test task", {}, false, {
        nonInteractive: true,
        jsonl: true,
      });
    } finally {
      console.log = origLog;
      console.error = origError;
    }

    // Check if the JSONL event was printed to stdout
    expect(logOutput.length).toBeGreaterThan(0);
    const parsedEvents = logOutput.map(line => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    });

    const infoEvent = parsedEvents.find(e => e && e.type === "info");
    expect(infoEvent).toBeDefined();
    expect(infoEvent.payload.message).toBe("Test info message");
  });
});
