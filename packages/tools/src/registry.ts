import { OrbitTool } from './types.js';

export class ToolRegistry {
  private tools = new Map<string, OrbitTool<any, any>>();

  register(tool: OrbitTool<any, any>) {
    this.tools.set(tool.name, tool);
  }

  get(name: string): OrbitTool<any, any> | undefined {
    return this.tools.get(name);
  }

  list(): OrbitTool<any, any>[] {
    return Array.from(this.tools.values());
  }

  getDefinitions() {
    return this.list().map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
  }
}

export const toolRegistry = new ToolRegistry();
