import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Orchestrator } from "./Orchestrator.js";
import { OrbitConfig } from "@orbit-build/config";
import { ModelProvider } from "@orbit-build/model-providers";
import fs from "fs";
import path from "path";
import os from "os";
import { WorktreeManager } from "@orbit-build/sandbox";

describe("Orchestrator Multi-Agent Flow", () => {
  let testCwd: string;

  const dummyConfig: OrbitConfig = {
    name: "test",
    provider: { default: "openai" },
    models: {
      default: "gpt-4",
      planner: "planner-model",
      coder: "coder-model",
      reviewer: "reviewer-model",
      fast: "fast-model",
      summarizer: "fast-model",
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
    vi.restoreAllMocks();
    testCwd = path.join(
      os.tmpdir(),
      `orbit-orchestrator-test-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    );
    fs.mkdirSync(testCwd, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(testCwd)) {
      try {
        fs.rmSync(testCwd, { recursive: true, force: true });
      } catch {}
    }
  });

  it("should run the Planner, Coder, and Reviewer flow using Git worktrees when Git is available", async () => {
    let plannerCalled = false;
    let coderCalled = false;
    let reviewerCalled = false;

    const mockProvider: ModelProvider = {
      id: "openai",
      chat: (params: any) => {
        return (async function* () {
          if (params.model === "planner-model") {
            plannerCalled = true;
            yield {
              type: "text_delta" as const,
              text: "Plan: Add a new test file.",
            };
          } else if (params.model === "coder-model") {
            coderCalled = true;
            yield { type: "text_delta" as const, text: "Coder finished." };
          } else if (params.model === "reviewer-model") {
            reviewerCalled = true;
            yield {
              type: "text_delta" as const,
              text: "Verification APPROVED",
            };
          }
        })();
      },
    } as any;

    const isGitRepoSpy = vi
      .spyOn(WorktreeManager.prototype, "isGitRepo")
      .mockReturnValue(true);

    const createWorktreeSpy = vi
      .spyOn(WorktreeManager.prototype, "createWorktree")
      .mockImplementation((subagentId) => ({
        path: path.join(testCwd, ".orbit", "worktrees", subagentId),
        branchName: `mock-branch-${subagentId}`,
      }));

    const mergeAndCleanupSpy = vi
      .spyOn(WorktreeManager.prototype, "mergeAndCleanup")
      .mockReturnValue({ success: true });

    const orchestrator = new Orchestrator(
      testCwd,
      dummyConfig,
      mockProvider,
      "Test user task",
      dummyInteraction,
    );

    await orchestrator.run();

    expect(plannerCalled).toBe(true);
    expect(coderCalled).toBe(true);
    expect(reviewerCalled).toBe(true);

    // Verify git worktree methods were invoked
    expect(isGitRepoSpy).toHaveBeenCalled();
    expect(createWorktreeSpy).toHaveBeenCalled();
    expect(mergeAndCleanupSpy).toHaveBeenCalled();

    // Verify plan file was written
    const planPath = path.resolve(testCwd, "orbit_plan.md");
    expect(fs.existsSync(planPath)).toBe(true);
    expect(fs.readFileSync(planPath, "utf8")).toContain(
      "Plan: Add a new test file.",
    );
  }, 15_000);

  it("should fall back to main workspace when Git is not available", async () => {
    let plannerCalled = false;
    let coderCalled = false;
    let reviewerCalled = false;

    const mockProvider: ModelProvider = {
      id: "openai",
      chat: (params: any) => {
        return (async function* () {
          if (params.model === "planner-model") {
            plannerCalled = true;
            yield {
              type: "text_delta" as const,
              text: "Plan: Add a new test file.",
            };
          } else if (params.model === "coder-model") {
            coderCalled = true;
            yield { type: "text_delta" as const, text: "Coder finished." };
          } else if (params.model === "reviewer-model") {
            reviewerCalled = true;
            yield {
              type: "text_delta" as const,
              text: "Verification APPROVED",
            };
          }
        })();
      },
    } as any;

    const isGitRepoSpy = vi
      .spyOn(WorktreeManager.prototype, "isGitRepo")
      .mockReturnValue(false);

    const createWorktreeSpy = vi.spyOn(WorktreeManager.prototype, "createWorktree");
    const mergeAndCleanupSpy = vi.spyOn(WorktreeManager.prototype, "mergeAndCleanup");

    const orchestrator = new Orchestrator(
      testCwd,
      dummyConfig,
      mockProvider,
      "Test user task",
      dummyInteraction,
    );

    await orchestrator.run();

    expect(plannerCalled).toBe(true);
    expect(coderCalled).toBe(true);
    expect(reviewerCalled).toBe(true);

    // Verify isGitRepo checked, but worktrees not used
    expect(isGitRepoSpy).toHaveBeenCalled();
    expect(createWorktreeSpy).not.toHaveBeenCalled();
    expect(mergeAndCleanupSpy).not.toHaveBeenCalled();

    // Verify plan file was written
    const planPath = path.resolve(testCwd, "orbit_plan.md");
    expect(fs.existsSync(planPath)).toBe(true);
  }, 15_000);

  it("should fall back to main workspace when createWorktree fails", async () => {
    let plannerCalled = false;
    let coderCalled = false;
    let reviewerCalled = false;

    const mockProvider: ModelProvider = {
      id: "openai",
      chat: (params: any) => {
        return (async function* () {
          if (params.model === "planner-model") {
            plannerCalled = true;
            yield {
              type: "text_delta" as const,
              text: "Plan: Add a new test file.",
            };
          } else if (params.model === "coder-model") {
            coderCalled = true;
            yield { type: "text_delta" as const, text: "Coder finished." };
          } else if (params.model === "reviewer-model") {
            reviewerCalled = true;
            yield {
              type: "text_delta" as const,
              text: "Verification APPROVED",
            };
          }
        })();
      },
    } as any;

    const isGitRepoSpy = vi
      .spyOn(WorktreeManager.prototype, "isGitRepo")
      .mockReturnValue(true);

    const createWorktreeSpy = vi
      .spyOn(WorktreeManager.prototype, "createWorktree")
      .mockImplementation(() => {
        throw new Error("Simulated worktree creation error");
      });

    const mergeAndCleanupSpy = vi.spyOn(WorktreeManager.prototype, "mergeAndCleanup");

    const orchestrator = new Orchestrator(
      testCwd,
      dummyConfig,
      mockProvider,
      "Test user task",
      dummyInteraction,
    );

    await orchestrator.run();

    expect(plannerCalled).toBe(true);
    expect(coderCalled).toBe(true);
    expect(reviewerCalled).toBe(true);

    // Verify isGitRepo and createWorktree called, but mergeAndCleanup not called due to failure
    expect(isGitRepoSpy).toHaveBeenCalled();
    expect(createWorktreeSpy).toHaveBeenCalled();
    expect(mergeAndCleanupSpy).not.toHaveBeenCalled();

    // Verify plan file was written
    const planPath = path.resolve(testCwd, "orbit_plan.md");
    expect(fs.existsSync(planPath)).toBe(true);
  }, 15_000);
});
