import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { StepRunner } from "./StepRunner.js";
import { toolRegistry } from "@orbit-build/tools";

describe("StepRunner Subprocess Timestamps & Limits", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should abort tool execution and return timeout error if command runs past 45 seconds", async () => {
    // Mock the registry get to return a dummy execution tool that hangs
    const mockTool = {
      name: "bash",
      description: "mock bash",
      inputSchema: {
        safeParse: () => ({ success: true, data: {} }),
      },
      execute: async (args: any, ctx: any) => {
        return new Promise((resolve, reject) => {
          ctx.abortSignal.addEventListener("abort", () => {
            const err = new Error("Aborted");
            err.name = "AbortError";
            reject(err);
          });
        });
      },
    };

    vi.spyOn(toolRegistry, "get").mockReturnValue(mockTool as any);

    const runner = new StepRunner(process.cwd(), "test-session");

    const runPromise = runner.run({
      id: "call_1",
      name: "bash",
      arguments: "{}",
    });

    // Advance fake timers by 45 seconds
    vi.advanceTimersByTime(45000);

    const result = await runPromise;
    expect(result.ok).toBe(false);
    expect(result.error).toContain("timed out after 45000ms");
  });
});
