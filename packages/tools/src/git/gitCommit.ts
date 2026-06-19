import { z } from 'zod';
import { execa } from 'execa';
import { OrbitTool, ToolContext, ToolResult } from '../types.js';

export const GitCommitInputSchema = z.object({
  message: z.string().optional(),
});

export type GitCommitInput = z.infer<typeof GitCommitInputSchema>;

export class GitCommitTool implements OrbitTool<GitCommitInput, string> {
  name = 'git_commit';
  description = 'Commit current staged changes in the git repository.';
  inputSchema = GitCommitInputSchema;
  risk = 'execute' as const;

  async execute(input: GitCommitInput, ctx: ToolContext): Promise<ToolResult<string>> {
    try {
      const commitMessage = input.message || 'chore: update workspace';
      const { stdout } = await execa('git', ['commit', '-m', commitMessage], { cwd: ctx.cwd });
      return {
        ok: true,
        data: stdout,
        display: `Staged changes committed:\n${stdout}`,
      };
    } catch (e: any) {
      return {
        ok: false,
        error: `Git commit failed: ${e.message}`,
      };
    }
  }
}
