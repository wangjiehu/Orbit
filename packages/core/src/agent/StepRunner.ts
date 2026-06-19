import { toolRegistry, ToolResult } from '@orbit-ai/tools';
import { OrbitToolCall } from '@orbit-ai/model-providers';

export class StepRunner {
  constructor(private cwd: string, private sessionId: string) {}

  public async run(toolCall: OrbitToolCall, abortSignal?: AbortSignal): Promise<ToolResult<any>> {
    const tool = toolRegistry.get(toolCall.name);
    if (!tool) {
      return {
        ok: false,
        error: `Tool "${toolCall.name}" not found in registry.`,
      };
    }

    try {
      const parsedArgs = JSON.parse(toolCall.arguments);
      const validated = tool.inputSchema.safeParse(parsedArgs);
      if (!validated.success) {
        return {
          ok: false,
          error: `Tool input validation failed: ${validated.error.message}`,
        };
      }

      return await tool.execute(validated.data, {
        cwd: this.cwd,
        sessionId: this.sessionId,
        abortSignal,
      });
    } catch (e: any) {
      return {
        ok: false,
        error: `Tool execution threw exception: ${e.message}`,
      };
    }
  }
}
