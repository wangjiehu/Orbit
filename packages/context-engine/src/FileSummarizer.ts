import { promises as fsPromises } from "fs";
import { resolveSafePath } from "@orbit-build/shared";

export class FileSummarizer {
  constructor(private cwd: string) {}

  public async summarize(
    filePath: string,
    maxLines = 100,
  ): Promise<{ summary: string; excerpt: string }> {
    try {
      const safePath = resolveSafePath(this.cwd, filePath);
      try {
        await fsPromises.access(safePath);
      } catch {
        return { summary: "File not found", excerpt: "" };
      }

      const content = await fsPromises.readFile(safePath, "utf8");
      const lines = content.split("\n");

      const summary = `File size: ${content.length} bytes, total lines: ${lines.length}`;
      const excerpt =
        lines.slice(0, maxLines).join("\n") +
        (lines.length > maxLines ? "\n... [TRUNCATED] ..." : "");

      return { summary, excerpt };
    } catch (e: any) {
      return { summary: `Error reading file: ${e.message}`, excerpt: "" };
    }
  }
}

