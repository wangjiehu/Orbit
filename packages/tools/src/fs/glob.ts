import { z } from 'zod';
import glob from 'fast-glob';
import { OrbitTool, ToolContext, ToolResult } from '../types.js';

export const GlobInputSchema = z.object({
  pattern: z.string(),
});

export type GlobInput = z.infer<typeof GlobInputSchema>;

export class GlobTool implements OrbitTool<GlobInput, string[]> {
  name = 'glob';
  description = 'Find files matching a glob pattern inside the project workspace.';
  inputSchema = GlobInputSchema;
  risk = 'read' as const;

  async execute(input: GlobInput, ctx: ToolContext): Promise<ToolResult<string[]>> {
    try {
      const files = await glob(input.pattern, {
        cwd: ctx.cwd,
        ignore: ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**'],
        onlyFiles: true,
        dot: true,
      });

      return {
        ok: true,
        data: files,
        display: `Glob matches for "${input.pattern}": found ${files.length} files`,
      };
    } catch (e: any) {
      return {
        ok: false,
        error: e.message,
      };
    }
  }
}
