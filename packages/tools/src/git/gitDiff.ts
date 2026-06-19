import { z } from 'zod';
import { execa } from 'execa';
import { OrbitTool, ToolContext, ToolResult } from '../types.js';

export const GitDiffInputSchema = z.object({
  staged: z.boolean().optional(),
});

export type GitDiffInput = z.infer<typeof GitDiffInputSchema>;

export class GitDiffTool implements OrbitTool<GitDiffInput, string> {
  name = 'git_diff';
  description = 'Show working tree diff or staged diff in the git repository.';
  inputSchema = GitDiffInputSchema;
  risk = 'read' as const;

  async execute(input: GitDiffInput, ctx: ToolContext): Promise<ToolResult<string>> {
    try {
      const args = ['diff'];
      if (input.staged) {
        args.push('--staged');
      }

      const { stdout } = await execa('git', args, { cwd: ctx.cwd });
      return {
        ok: true,
        data: stdout,
        display: stdout ? stdout : 'No changes detected in git workspace.',
      };
    } catch (e: any) {
      return {
        ok: false,
        error: `Git diff failed: ${e.message}`,
      };
    }
  }
}
