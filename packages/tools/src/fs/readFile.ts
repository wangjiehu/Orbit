import { z } from "zod";
import { readFileSync } from "fs";
import { resolveSafePath } from "@orbit-build/shared";
import { OrbitTool, ToolContext, ToolResult } from "../types.js";

export const ReadFileInputSchema = z.object({
  path: z.string(),
  startLine: z.number().optional(),
  endLine: z.number().optional(),
});

export type ReadFileInput = z.infer<typeof ReadFileInputSchema>;

export class ReadFileTool implements OrbitTool<ReadFileInput, string> {
  name = "read_file";
  description =
    "Read content from a file inside the project. Defaults to reading a maximum of 400 lines unless specified.";
  inputSchema = ReadFileInputSchema;
  risk = "read" as const;

  async execute(
    input: ReadFileInput,
    ctx: ToolContext,
  ): Promise<ToolResult<string>> {
    try {
      const safePath = resolveSafePath(ctx.cwd, input.path);
      const content = readFileSync(safePath, "utf8");

      const lines = content.split("\n");
      const start =
        input.startLine !== undefined ? Math.max(1, input.startLine) : 1;
      const end =
        input.endLine !== undefined
          ? Math.min(lines.length, input.endLine)
          : Math.min(lines.length, start + 399);

      const slicedLines = lines.slice(start - 1, end);
      const displayContent = slicedLines.join("\n");

      return {
        ok: true,
        data: displayContent,
        display: `Read lines ${start}-${end} of ${input.path}`,
      };
    } catch (e: any) {
      return {
        ok: false,
        error: e.message,
      };
    }
  }
}
