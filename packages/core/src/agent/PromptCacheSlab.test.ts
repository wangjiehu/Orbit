import { describe, expect, it, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import { PromptCacheSlabBuilder } from "./PromptCacheSlab.js";
import { ContextPack } from "@orbit-build/context-engine";

describe("PromptCacheSlabBuilder", () => {
  const cwd = path.resolve(process.cwd(), "cache-slab-test-temp");

  afterEach(() => {
    if (fs.existsSync(cwd)) {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  function makeContext(codebaseContext: string): ContextPack {
    return {
      projectIndex: {
        detectedLanguages: ["typescript"],
        frameworks: ["vitest"],
        entrypoints: ["src/index.ts"],
        packageManager: "pnpm",
        files: {},
      },
      projectInstructions: "Always preserve workspace boundaries.",
      skillsIndex: [
        {
          name: "api-tuning",
          description: "Optimize provider throughput",
          path: ".orbit/skills/api-tuning/SKILL.md",
        },
      ],
      activeSkills: [
        {
          name: "api-tuning",
          description: "Optimize provider throughput",
          path: ".orbit/skills/api-tuning/SKILL.md",
          content: "Volatile skill body for this turn",
        },
      ],
      relevantFiles: [
        {
          path: "src/dynamic.ts",
          reason: "selected by current turn",
          summary: "dynamic file",
          excerpt: "console.log(Date.now())",
        },
      ],
      recentChanges: "",
      currentDiff: "",
      previousErrors: "",
      codebaseContext,
      tokenBudget: { max: 128000, usedEstimate: 100 },
    };
  }

  it("keeps the stable slab independent from volatile RAG and file excerpts", () => {
    const first = PromptCacheSlabBuilder.build({
      cwd,
      model: "deepseek-v4-flash",
      baseSystemPrompt: "Base rules",
      toolsPrompt: "Tool schema A",
      repoMapText: "Repo map A",
      contextPack: makeContext("RAG result one"),
    });
    const second = PromptCacheSlabBuilder.build({
      cwd,
      model: "deepseek-v4-flash",
      baseSystemPrompt: "Base rules",
      toolsPrompt: "Tool schema A",
      repoMapText: "Repo map A",
      contextPack: makeContext("RAG result two"),
    });

    expect(first.hash).toBe(second.hash);
    expect(first.text).toContain("Always preserve workspace boundaries.");
    expect(first.text).toContain("api-tuning - Optimize provider throughput");
    expect(first.text).not.toContain("Volatile skill body");
    expect(first.text).toContain("Repo map A");
    expect(first.text).toContain("<!-- VOLATILE_CONTEXT -->");
    expect(first.text).not.toContain("### Runtime Context");
    expect(first.text).not.toContain("Current local date");
    expect(first.text).not.toContain("RAG result one");
    expect(first.text).not.toContain("console.log(Date.now())");
    expect(fs.existsSync(first.path)).toBe(true);
  });
});
