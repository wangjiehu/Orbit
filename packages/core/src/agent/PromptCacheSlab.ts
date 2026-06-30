import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "fs";
import { createHash } from "crypto";
import { dirname, join } from "path";
import { estimateTokenCount } from "@orbit-build/shared";
import { ContextPack } from "@orbit-build/context-engine";

export interface PromptCacheSlabInput {
  cwd: string;
  model: string;
  baseSystemPrompt: string;
  toolsPrompt: string;
  repoMapText: string;
  contextPack: ContextPack;
}

export interface PromptCacheSlab {
  hash: string;
  model: string;
  text: string;
  tokenEstimate: number;
  path: string;
  lastPrimedAt?: string;
}

export class PromptCacheSlabBuilder {
  public static build(input: PromptCacheSlabInput): PromptCacheSlab {
    const stableText = this.buildStableText(input);
    const hash = createHash("sha256").update(stableText).digest("hex");
    const slabPath = join(
      input.cwd,
      ".orbit",
      "cache-slabs",
      `${hash.slice(0, 24)}.json`,
    );

    let lastPrimedAt: string | undefined;
    if (existsSync(slabPath)) {
      try {
        const raw = JSON.parse(readFileSync(slabPath, "utf8"));
        if (raw?.hash === hash && typeof raw.lastPrimedAt === "string") {
          lastPrimedAt = raw.lastPrimedAt;
        }
      } catch {
        // Ignore stale or partial slab metadata.
      }
    }

    const slab: PromptCacheSlab = {
      hash,
      model: input.model,
      text: stableText,
      tokenEstimate: estimateTokenCount(stableText),
      path: slabPath,
      lastPrimedAt,
    };
    this.save(slab);
    return slab;
  }

  public static markPrimed(
    slab: PromptCacheSlab,
    date = new Date(),
  ): PromptCacheSlab {
    const updated = {
      ...slab,
      lastPrimedAt: date.toISOString(),
    };
    this.save(updated);
    return updated;
  }

  private static save(slab: PromptCacheSlab): void {
    try {
      const dir = dirname(slab.path);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      const tmpPath = `${slab.path}.tmp`;
      writeFileSync(
        tmpPath,
        JSON.stringify(
          {
            hash: slab.hash,
            model: slab.model,
            tokenEstimate: slab.tokenEstimate,
            lastPrimedAt: slab.lastPrimedAt,
          },
          null,
          2,
        ),
        "utf8",
      );
      renameSync(tmpPath, slab.path);
    } catch {
      // Cache metadata must never block agent execution.
    }
  }

  private static buildStableText(input: PromptCacheSlabInput): string {
    const ctx = input.contextPack;
    const sortedLanguages = [...ctx.projectIndex.detectedLanguages].sort();
    const sortedFrameworks = [...ctx.projectIndex.frameworks].sort();
    const sortedEntrypoints = [...ctx.projectIndex.entrypoints].sort();
    const skillsIndex = (ctx.skillsIndex || [])
      .map((skill) => {
        const description = skill.description
          ? ` - ${skill.description.replace(/\s+/g, " ").trim()}`
          : "";
        return `- ${skill.name}${description}`;
      })
      .join("\n");

    const stableWorkspace = [
      "### DeepSeek Cache Slab",
      `Model lane: ${input.model}`,
      "Cache policy: Keep everything above VOLATILE_CONTEXT byte-stable across turns.",
      "",
      "### Workspace Stable Profile",
      `Language profile: ${sortedLanguages.join(", ")}`,
      `Framework profile: ${sortedFrameworks.join(", ") || "None"}`,
      `Entrypoints: ${sortedEntrypoints.join(", ") || "None"}`,
      `PM: ${ctx.projectIndex.packageManager || "None"}`,
      skillsIndex ? `\n### Available Skills\n${skillsIndex}` : "",
      ctx.projectInstructions
        ? `\n### Project Instructions\n${ctx.projectInstructions}`
        : "",
      input.repoMapText ? `\n### Stable Repo Map\n${input.repoMapText}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    return [
      input.baseSystemPrompt.trimEnd(),
      input.toolsPrompt.trimEnd(),
      stableWorkspace.trimEnd(),
      "<!-- VOLATILE_CONTEXT -->",
    ].join("\n\n");
  }
}
