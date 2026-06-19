import { z } from 'zod';
import { execa } from 'execa';
import { OrbitTool, ToolContext, ToolResult } from '../types.js';
import { LogTruncator } from '@orbit-ai/shared';

export const BashInputSchema = z.object({
  command: z.string(),
  timeoutMs: z.number().optional(),
});

export type BashInput = z.infer<typeof BashInputSchema>;

interface BashOutput {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export class BashTool implements OrbitTool<BashInput, BashOutput> {
  name = 'bash';
  description = 'Run a command in the local shell environment. Captures outputs and exit code.';
  inputSchema = BashInputSchema;
  risk = 'execute' as const;

  async execute(input: BashInput, ctx: ToolContext): Promise<ToolResult<BashOutput>> {
    const timeout = input.timeoutMs || 120000;
    try {
      const result = await execa(input.command, {
        shell: true,
        cwd: ctx.cwd,
        timeout,
        reject: false,
        signal: ctx.abortSignal,
      });

      const stdout = result.stdout || '';
      const stderr = result.stderr || '';
      const exitCode = result.exitCode ?? 0;

      const displayStdout = LogTruncator.truncate(stdout, 150, 20000);
      const displayStderr = LogTruncator.truncate(stderr, 150, 20000);
      const truncated = stdout.length !== displayStdout.length || stderr.length !== displayStderr.length;

      const display = [
        displayStdout ? `Stdout:\n${displayStdout}` : '',
        displayStderr ? `Stderr:\n${displayStderr}` : '',
        `Exit code: ${exitCode}`,
      ]
        .filter(Boolean)
        .join('\n\n');

      return {
        ok: true,
        data: {
          stdout,
          stderr,
          exitCode,
        },
        display,
        metadata: { truncated },
      };
    } catch (e: any) {
      if (e.name === 'AbortError' || ctx.abortSignal?.aborted) {
        return {
          ok: false,
          error: `Command execution was interrupted by the user.`,
        };
      }
      return {
        ok: false,
        error: `Command failed to execute or timed out: ${e.message}`,
      };
    }
  }
}
