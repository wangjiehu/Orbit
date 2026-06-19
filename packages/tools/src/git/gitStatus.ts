import { z } from 'zod';
import { execa } from 'execa';
import { OrbitTool, ToolContext, ToolResult } from '../types.js';

export const GitStatusInputSchema = z.object({});

export class GitStatusTool implements OrbitTool<any, string> {
  name = 'git_status';
  description = 'Show working tree status of git files (short format).';
  inputSchema = GitStatusInputSchema;
  risk = 'read' as const;

  async execute(input: any, ctx: ToolContext): Promise<ToolResult<string>> {
    try {
      const { stdout } = await execa('git', ['status', '--short'], { cwd: ctx.cwd });
      return {
        ok: true,
        data: stdout,
        display: stdout ? stdout : 'Working tree clean.',
      };
    } catch (e: any) {
      return {
        ok: false,
        error: `Git status failed: ${e.message}`,
      };
    }
  }
}
