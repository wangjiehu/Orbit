import { describe, it, expect, vi } from "vitest";
import { AutocompleteEngine } from "./Autocomplete.js";
import {
  DeepSeekOpenAIProvider,
  OllamaProvider,
} from "@orbit-build/model-providers";

let mockLastPrompt = "";

// Mock model providers complete API
vi.mock("@orbit-build/model-providers", async (importOriginal) => {
  const original: any = await importOriginal();

  class MockDeepSeekProvider {
    id = "deepseek-openai";
    async complete(prompt: string, options: any) {
      mockLastPrompt = prompt;
      const lowercaseModel = (options?.model || "").toLowerCase();

      if (lowercaseModel.includes("slow")) {
        await new Promise((r) => setTimeout(r, 250));
      }

      if (lowercaseModel.includes("0.5b")) {
        return "Local_Speculative_Completion";
      }

      if (options?.abortSignal) {
        await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            resolve(true);
          }, 30);
          if (options.abortSignal.aborted) {
            clearTimeout(timeout);
            const err = new Error("Aborted");
            err.name = "AbortError";
            reject(err);
            return;
          }
          options.abortSignal.addEventListener("abort", () => {
            clearTimeout(timeout);
            const err = new Error("Aborted");
            err.name = "AbortError";
            reject(err);
          });
        });
      }
      if (prompt.includes("<｜fim begin｜>") || (options?.suffix !== undefined && (options?.model || "").toLowerCase().includes("deepseek"))) {
        return "DeepSeek_Completion_Middle";
      }
      if (prompt.includes("<|fim_prefix|>")) {
        return "Qwen_Completion_Middle";
      }
      return "Generic_Completion";
    }
  }

  class MockOllamaProvider extends MockDeepSeekProvider {
    override id = "ollama";
  }

  return {
    ...original,
    DeepSeekOpenAIProvider: MockDeepSeekProvider,
    OllamaProvider: MockOllamaProvider,
  };
});

describe("AutocompleteEngine Tests", () => {
  const config = {
    autocomplete: {
      enabled: true,
      provider: "ollama",
      model: "qwen2.5-coder:1.5b",
      debounceMs: 0,
    },
    providers: {
      ollama: {
        type: "ollama",
        baseUrl: "http://localhost:11434/v1",
      },
    },
  };

  it("should return empty if disabled in configuration", async () => {
    const engine = new AutocompleteEngine();
    const disabledConfig = {
      ...config,
      autocomplete: { ...config.autocomplete, enabled: false },
    };
    const result = await engine.autocomplete(
      "function test() {",
      "}",
      disabledConfig,
    );
    expect(result).toBe("");
  });

  it("should construct Qwen-style FIM Prompt and get completion", async () => {
    const engine = new AutocompleteEngine();
    const result = await engine.autocomplete(
      "function test() {\n  ",
      "\n}",
      config,
    );
    expect(result).toBe("Qwen_Completion_Middle");
  });

  it("should construct DeepSeek-style FIM Prompt and get completion", async () => {
    const engine = new AutocompleteEngine();
    const deepseekConfig = {
      ...config,
      autocomplete: {
        enabled: true,
        provider: "deepseek-openai",
        model: "deepseek-coder",
        debounceMs: 0,
      },
    };
    const result = await engine.autocomplete(
      "function test() {\n  ",
      "\n}",
      deepseekConfig,
    );
    expect(result).toBe("DeepSeek_Completion_Middle");
  });

  describe("Window-specific Debouncing", () => {
    it("should cancel previous call on the same windowId, but allow concurrent calls on different windowIds", async () => {
      const engine = new AutocompleteEngine();

      // 1. Same window: first should be aborted, second should succeed
      const promise1 = engine.autocomplete("const a = ", "", config, "win1");
      const promise2 = engine.autocomplete("const b = ", "", config, "win1");

      const [res1, res2] = await Promise.all([promise1, promise2]);
      expect(res1).toBe(""); // Canceled/aborted
      expect(res2).toBe("Qwen_Completion_Middle"); // Succeeded

      // 2. Different windows: both should run concurrently and succeed
      const promiseA = engine.autocomplete("const a = ", "", config, "winA");
      const promiseB = engine.autocomplete("const b = ", "", config, "winB");

      const [resA, resB] = await Promise.all([promiseA, promiseB]);
      expect(resA).toBe("Qwen_Completion_Middle");
      expect(resB).toBe("Qwen_Completion_Middle");
    });

    it("should prepend language-specific file path comments to prefix", async () => {
      const engine = new AutocompleteEngine("/workspace");

      // 1. TS file
      await engine.autocomplete("const a = 1;", "", config, "file:///workspace/src/utils.ts");
      expect(mockLastPrompt).toContain("// Path: src/utils.ts\nconst a = 1;");

      // 2. Python file
      await engine.autocomplete("a = 1", "", config, "file:///workspace/scripts/run.py");
      expect(mockLastPrompt).toContain("# Path: scripts/run.py\na = 1");

      // 3. HTML file
      await engine.autocomplete("<div>", "", config, "file:///workspace/index.html");
      expect(mockLastPrompt).toContain("<!-- Path: index.html -->\n<div>");

      // 4. CSS file
      await engine.autocomplete("body {", "", config, "file:///workspace/styles.css");
      expect(mockLastPrompt).toContain("/* Path: styles.css */\nbody {");

      // 5. Malformed percent-encoded URI (should fall back safely)
      await engine.autocomplete("const x = 1;", "", config, "file:///workspace/src/%invalid.ts");
      expect(mockLastPrompt).toContain("// Path: src/%invalid.ts\nconst x = 1;");
    });
  });

  describe("Speculative FIM Autocomplete Race", () => {
    it("should return the cloud completion immediately if it is fast (under timeout)", async () => {
      const engine = new AutocompleteEngine();
      const specConfig = {
        autocomplete: {
          enabled: true,
          provider: "deepseek-openai",
          model: "fast-deepseek-cloud-model",
          debounceMs: 0,
          speculative: {
            enabled: true,
            provider: "ollama",
            model: "qwen2.5-coder:0.5b",
            timeoutMs: 150,
          },
        },
        providers: {
          "deepseek-openai": { type: "openai-compatible", baseUrl: "..." },
          ollama: { type: "ollama", baseUrl: "..." },
        },
      };

      const result = await engine.autocomplete("const x = ", "", specConfig);
      expect(result).toBe("DeepSeek_Completion_Middle");
    });

    it("should fall back to local completion if the cloud completion is slow (times out)", async () => {
      const engine = new AutocompleteEngine();
      const specConfig = {
        autocomplete: {
          enabled: true,
          provider: "deepseek-openai",
          model: "slow-cloud-model",
          debounceMs: 0,
          speculative: {
            enabled: true,
            provider: "ollama",
            model: "qwen2.5-coder:0.5b",
            timeoutMs: 50,
          },
        },
        providers: {
          "deepseek-openai": { type: "openai-compatible", baseUrl: "..." },
          ollama: { type: "ollama", baseUrl: "..." },
        },
      };

      const result = await engine.autocomplete("const x = ", "", specConfig);
      expect(result).toBe("Local_Speculative_Completion");
    });
  });
});
