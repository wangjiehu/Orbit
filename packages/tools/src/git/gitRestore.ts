import { z } from 'zod';
import { execa } from 'execa';
import { OrbitTool, ToolContext, ToolResult } from '../types.js';

export const GitRestoreInputSchema = z.object({
  paths: z.array(z.string()),
});

export type GitRestoreInput = z.infer<typeof GitRestoreInputSchema>;

export class GitRestoreTool implements OrbitTool<GitRestoreInput, string> {
  name = 'git_restore';
  description =
    'Discard unstaged changes in specific file paths in the git repository. Reverts working modifications.';
  inputSchema = GitRestoreInputSchema;
  risk = 'dangerous' as const;

  async execute(input: GitRestoreInput, ctx: ToolContext): Promise<ToolResult<string>> {
    try {
      const { stdout } = await execa('git', ['restore', ...input.paths], { cwd: ctx.cwd });
      return {
        ok: true,
        data: stdout,
        display: `Restored files: ${input.paths.join(', ')}`,
      };
    } catch (e: any) {
      return {
        ok: false,
        error: `Git restore failed: ${e.message}`,
      };
    }
  }
}
