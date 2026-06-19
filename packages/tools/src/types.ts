import { z } from 'zod';
import { ToolRisk } from '@orbit-ai/shared';

export interface ToolContext {
  cwd: string;
  sessionId: string;
  logger?: any;
  abortSignal?: AbortSignal;
}

export interface ToolResult<O = unknown> {
  ok: boolean;
  data?: O;
  error?: string;
  display?: string;
  metadata?: Record<string, unknown>;
}

export interface OrbitTool<I = unknown, O = unknown> {
  name: string;
  description: string;
  inputSchema: z.ZodType<I>;
  risk: ToolRisk;
  execute(input: I, ctx: ToolContext): Promise<ToolResult<O>>;
}
