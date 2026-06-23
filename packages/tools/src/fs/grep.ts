import { z } from "zod";
import { readFileSync } from "fs";
import { execa } from "execa";
import glob from "fast-glob";
import { resolveSafePath } from "@orbit-build/shared";
import { OrbitTool, ToolContext, ToolResult } from "../types.js";

export const GrepInputSchema = z.object({
  pattern: z.string(),
  path: z.string().optional(),
  include: z.string().optional(),
  maxResults: z.number().optional(),
});

export type GrepInput = z.infer<typeof GrepInputSchema>;

interface GrepMatch {
  file: string;
  line: number;
  content: string;
}

export class GrepTool implements OrbitTool<GrepInput, GrepMatch[]> {
  name = "grep";
  description =
    "Search for string patterns across project files. Uses ripgrep if available, falling back to a Node-based search.";
  inputSchema = GrepInputSchema;
  risk = "read" as const;

  async execute(
    input: GrepInput,
    ctx: ToolContext,
  ): Promise<ToolResult<GrepMatch[]>> {
    const max = input.maxResults || 100;
    const searchDir = input.path
      ? resolveSafePath(ctx.cwd, input.path)
      : ctx.cwd;

    try {
      const args = [
        "--line-number",
        "--color=never",
        "--no-heading",
        input.pattern,
      ];
      if (input.include) {
        args.push("--glob", input.include);
      }
      args.push(searchDir);

      const { stdout } = await execa("rg", args);
      const matches: GrepMatch[] = [];
      const lines = stdout.split("\n");

      for (const line of lines) {
        if (matches.length >= max) break;
        if (!line.trim()) continue;

        const parts = line.split(":");
        if (parts.length >= 3) {
          const filePath = parts[0];
          const lineNum = parseInt(parts[1], 10);
          const content = parts.slice(2).join(":");

          const relativePath = filePath.startsWith(ctx.cwd)
            ? filePath.substring(ctx.cwd.length + 1)
            : filePath;

          matches.push({
            file: relativePath.replace(/\\/g, "/"),
            line: lineNum,
            content,
          });
        }
      }

      return {
        ok: true,
        data: matches,
        display: `Grep for "${input.pattern}" using ripgrep: found ${matches.length} matches`,
      };
    } catch (rgError) {
      return this.jsFallback(input, searchDir, ctx.cwd, max);
    }
  }

  private async jsFallback(
    input: GrepInput,
    searchDir: string,
    cwd: string,
    max: number,
  ): Promise<ToolResult<GrepMatch[]>> {
    try {
      const globPattern = input.include || "**/*";
      const files = await glob(globPattern, {
        cwd: searchDir,
        ignore: [
          "**/node_modules/**",
          "**/.git/**",
          "**/dist/**",
          "**/build/**",
        ],
        onlyFiles: true,
        absolute: true,
        suppressErrors: true,
      });

      const matches: GrepMatch[] = [];

      for (const file of files) {
        if (matches.length >= max) break;
        const content = readFileSync(file, "utf8");

        if (!content.includes(input.pattern)) continue;

        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].includes(input.pattern)) {
            const relPath = file.startsWith(cwd)
              ? file.substring(cwd.length + 1)
              : file;
            matches.push({
              file: relPath.replace(/\\/g, "/"),
              line: i + 1,
              content: lines[i],
            });
            if (matches.length >= max) break;
          }
        }
      }

      return {
        ok: true,
        data: matches,
        display: `Grep for "${input.pattern}" using JS fallback: found ${matches.length} matches`,
      };
    } catch (e: any) {
      return {
        ok: false,
        error: `Grep failed: Ripgrep was unavailable and fallback search failed: ${e.message}`,
      };
    }
  }
}
