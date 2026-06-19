import { z } from 'zod';
import glob from 'fast-glob';
import { resolveSafePath } from '@orbit-ai/shared';
import { OrbitTool, ToolContext, ToolResult } from '../types.js';

export const ListFilesInputSchema = z.object({
  path: z.string().optional(),
  depth: z.number().optional(),
});

export type ListFilesInput = z.infer<typeof ListFilesInputSchema>;

export class ListFilesTool implements OrbitTool<ListFilesInput, string[]> {
  name = 'list_files';
  description =
    'List all files recursively in the project directory, ignoring dependencies (node_modules) and build output folders.';
  inputSchema = ListFilesInputSchema;
  risk = 'read' as const;

  async execute(input: ListFilesInput, ctx: ToolContext): Promise<ToolResult<string[]>> {
    try {
      const targetDir = input.path ? resolveSafePath(ctx.cwd, input.path) : ctx.cwd;

      const files = await glob('**/*', {
        cwd: targetDir,
        deep: input.depth || 3,
        ignore: ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**'],
        onlyFiles: true,
        dot: true,
      });

      return {
        ok: true,
        data: files,
        display: `Listed ${files.length} files in ${input.path || 'project root'}`,
      };
    } catch (e: any) {
      return {
        ok: false,
        error: e.message,
      };
    }
  }
}
