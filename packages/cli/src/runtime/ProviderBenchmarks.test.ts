import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  formatProviderBenchmarkSummary,
  readProviderBenchmarks,
  recordProviderBenchmark,
} from "./ProviderBenchmarks.js";

describe("ProviderBenchmarks", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("records samples without storing prompt text and summarizes latency", () => {
    const cwd = mkdtempSync(join(tmpdir(), "orbit-provider-bench-"));
    dirs.push(cwd);

    recordProviderBenchmark(cwd, {
      providerId: "deepseek-openai",
      model: "deepseek-v4-flash",
      checkedAt: "2026-07-01T00:00:00.000Z",
      promptHash: "abc123",
      promptChars: 14,
      maxTokens: 96,
      firstDeltaMs: 2800,
      totalMs: 3300,
      outputTokens: 30,
      textChars: 90,
      throughputTokensPerSec: 9.1,
      cacheReadTokens: 0,
      cacheInputTokens: 8,
      cacheHitRate: 0,
    });

    const samples = readProviderBenchmarks(cwd);
    const summary = formatProviderBenchmarkSummary(
      cwd,
      "deepseek-openai",
      "deepseek-v4-flash",
    );

    expect(samples).toHaveLength(1);
    expect(JSON.stringify(samples)).not.toContain("Reply with ok");
    expect(summary).toContain("slow-first-token");
    expect(summary).toContain("p50 first=2800ms");
  });
});
