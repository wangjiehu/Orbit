import { ConfigLoader } from "@orbit-build/config";
import picocolors from "picocolors";
import type { ModelProvider } from "@orbit-build/model-providers";
import { createProviderFromConfig } from "../runtime/ProviderFactory.js";
import {
  benchmarkPromptHash,
  formatProviderBenchmarkSummary,
  recordProviderBenchmark,
  type ProviderBenchmarkResult,
} from "../runtime/ProviderBenchmarks.js";

async function runSingleBench(
  provider: ModelProvider,
  model: string,
  prompt: string,
  maxTokens: number,
): Promise<ProviderBenchmarkResult> {
  const startedAt = Date.now();
  let firstDeltaMs: number | undefined;
  let textChars = 0;
  let outputTokens = 0;
  let inputTokens = 0;
  let cacheReadTokens = 0;
  let cacheMissTokens = 0;
  let error: string | undefined;

  try {
    const stream = provider.chat({
      model,
      messages: [
        {
          id: `msg_bench_${Date.now()}`,
          role: "user",
          createdAt: new Date().toISOString(),
          content: [{ type: "text", text: prompt }],
        },
      ],
      tools: [],
      stream: true,
      maxTokens,
    });

    for await (const event of stream) {
      if (event.type === "text_delta" || event.type === "thinking_delta") {
        if (firstDeltaMs === undefined) {
          firstDeltaMs = Date.now() - startedAt;
        }
        textChars += event.text.length;
      } else if (event.type === "usage") {
        inputTokens = event.usage.inputTokens || 0;
        outputTokens = event.usage.outputTokens || 0;
        cacheReadTokens = event.usage.cacheReadTokens || 0;
        cacheMissTokens = event.usage.cacheMissTokens || 0;
      } else if (event.type === "error") {
        error = event.error?.message || String(event.error);
        break;
      }
    }
  } catch (err: any) {
    error = err?.message || String(err);
  }

  const totalMs = Math.max(1, Date.now() - startedAt);
  const throughputTokensPerSec =
    outputTokens > 0 ? outputTokens / (totalMs / 1000) : 0;
  const cacheInputTokens = cacheReadTokens + cacheMissTokens || inputTokens;
  const cacheHitRate =
    cacheInputTokens > 0 ? cacheReadTokens / cacheInputTokens : 0;

  return {
    providerId: provider.id,
    model,
    checkedAt: new Date().toISOString(),
    promptHash: benchmarkPromptHash(prompt),
    promptChars: prompt.length,
    maxTokens,
    firstDeltaMs,
    totalMs,
    outputTokens,
    textChars,
    throughputTokensPerSec,
    cacheReadTokens,
    cacheInputTokens,
    cacheHitRate,
    error,
  };
}

function clampRepeat(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 1;
  return Math.max(1, Math.min(20, Math.floor(parsed)));
}

function clampMaxTokens(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 96;
  return Math.max(1, Math.min(4096, Math.floor(parsed)));
}

function printBenchResult(
  result: ProviderBenchmarkResult,
  index: number,
): void {
  const suffix = index > 1 ? ` #${index}` : "";
  console.log(picocolors.bold(`Orbit Bench${suffix}`));
  console.log(`Provider: ${picocolors.cyan(result.providerId)}`);
  console.log(`Model: ${picocolors.cyan(result.model)}`);
  console.log(`First delta: ${result.firstDeltaMs ?? "n/a"}ms`);
  console.log(`Total: ${result.totalMs}ms`);
  console.log(
    `Output: ${result.outputTokens || "n/a"} tokens, ${result.textChars} chars`,
  );
  console.log(
    `Throughput: ${
      result.throughputTokensPerSec
        ? result.throughputTokensPerSec.toFixed(1)
        : "n/a"
    } tokens/sec`,
  );
  console.log(
    `Cache: ${Math.round(result.cacheHitRate * 100)}% (${result.cacheReadTokens}/${result.cacheInputTokens})`,
  );
  if (result.error) {
    console.log(picocolors.red(`Error: ${result.error}`));
  }
}

export async function runBench(
  cwd: string,
  options: {
    prompt?: string;
    model?: string;
    repeat?: number;
    maxTokens?: number;
    json?: boolean;
  } = {},
): Promise<void> {
  const config = ConfigLoader.loadSync(cwd);
  const provider = createProviderFromConfig(config);
  const model = options.model || config.models.fast || config.models.default;
  const prompt =
    options.prompt ||
    "Reply with one concise sentence explaining what Orbit is.";
  const repeat = clampRepeat(options.repeat);
  const maxTokens = clampMaxTokens(options.maxTokens);
  const results: ProviderBenchmarkResult[] = [];

  for (let i = 0; i < repeat; i++) {
    const result = await runSingleBench(provider, model, prompt, maxTokens);
    recordProviderBenchmark(cwd, result);
    results.push(result);
    if (!options.json) {
      printBenchResult(result, i + 1);
      if (i < repeat - 1) {
        console.log("");
      }
    }
  }

  if (options.json) {
    console.log(JSON.stringify({ results }, null, 2));
  } else {
    console.log("");
    console.log(formatProviderBenchmarkSummary(cwd, provider.id, model));
  }
}
