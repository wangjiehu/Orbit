import { describe, expect, it } from "vitest";
import { Planner } from "./Planner.js";

describe("Planner system prompt", () => {
  it("pins Simplified Chinese replies when configured for zh", () => {
    const prompt = Planner.makeSystemPrompt("deepseek-v4-pro", "zh");

    expect(prompt).toContain("Reply in Simplified Chinese by default");
    expect(prompt).toContain("DeepSeek");
    expect(prompt).toContain("Use the runtime date from the Volatile Context");
    expect(prompt).toContain(
      "search the live web instead of relying on model training memory",
    );
  });

  it("matches the user's message language when configured for en", () => {
    const prompt = Planner.makeSystemPrompt("deepseek-v4-flash", "en");

    expect(prompt).toContain("Reply in the user's language");
  });
});
