import { describe, expect, it } from "vitest";
import { getProviderModelCandidates } from "./ModelCatalog.js";

describe("ModelCatalog", () => {
  it("should prefer configured provider models", () => {
    const models = getProviderModelCandidates({
      provider: { default: "ciyuan" },
      providers: {
        ciyuan: {
          type: "openai-compatible",
          models: ["vendor/fast", "vendor/reasoner"],
        },
      },
    });

    expect(models).toEqual(["vendor/fast", "vendor/reasoner"]);
  });

  it("should provide current default OpenAI and Anthropic candidates", () => {
    expect(
      getProviderModelCandidates({
        provider: { default: "openai" },
        providers: { openai: { type: "openai" } },
      }),
    ).toContain("gpt-5.5");
    expect(
      getProviderModelCandidates({
        provider: { default: "anthropic" },
        providers: { anthropic: { type: "anthropic" } },
      }),
    ).toContain("claude-sonnet-4-6");
  });
});
