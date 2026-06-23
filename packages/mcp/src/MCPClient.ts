import { spawn, ChildProcess } from "child_process";
import readline from "readline";
import { ToolRisk } from "@orbit-build/shared";
import { OrbitTool, ToolResult, ToolContext } from "@orbit-build/tools";
import { z } from "zod";

export interface MCPToolDefinition {
  name: string;
  description: string;
  inputSchema: any;
}

export class MCPClient {
  private child: ChildProcess | null = null;
  private pendingRequests = new Map<
    number,
    {
      resolve: (val: any) => void;
      reject: (err: any) => void;
      timeout: NodeJS.Timeout;
    }
  >();
  private nextRequestId = 1;
  private isConnected = false;

  constructor(
    public readonly serverName: string,
    private command: string,
    private args: string[] = [],
    private env: Record<string, string> = {},
  ) {}

  public async start(): Promise<MCPToolDefinition[]> {
    const runEnv = { ...process.env, ...this.env };

    this.child = spawn(this.command, this.args, {
      env: runEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.child.on("error", (err) => {
      this.cleanup(
        new Error(
          `MCP server "${this.serverName}" failed to start: ${err.message}`,
        ),
      );
    });

    this.child.on("exit", (code, signal) => {
      this.cleanup(
        new Error(
          `MCP server "${this.serverName}" exited with code ${code} and signal ${signal}`,
        ),
      );
    });

    this.child.stderr?.on("data", (data) => {
      const msg = data.toString().trim();
      if (msg) {
        console.warn(`[MCP Server: ${this.serverName} STDERR] ${msg}`);
      }
    });

    const rl = readline.createInterface({
      input: this.child.stdout!,
      terminal: false,
    });

    rl.on("line", (line) => {
      this.handleIncomingMessage(line);
    });

    this.isConnected = true;

    // Handshake
    await this.initializeHandshake();

    // Load tools list
    const tools = await this.listTools();
    return tools;
  }

  private async initializeHandshake(): Promise<void> {
    await this.sendRequest("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: {
        name: "orbit-client",
        version: "0.1.0",
      },
    });

    this.sendNotification("notifications/initialized");
  }

  private async listTools(): Promise<MCPToolDefinition[]> {
    const res = await this.sendRequest("tools/list", {});
    return res.tools || [];
  }

  public async callTool(originalToolName: string, args: any): Promise<any> {
    if (!this.isConnected) {
      throw new Error(`MCP client "${this.serverName}" is not connected.`);
    }
    const res = await this.sendRequest("tools/call", {
      name: originalToolName,
      arguments: args,
    });
    return res;
  }

  private sendRequest(method: string, params: any): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.child || !this.child.stdin) {
        return reject(new Error("MCP server process is not running."));
      }

      const id = this.nextRequestId++;
      const request = {
        jsonrpc: "2.0",
        id,
        method,
        params,
      };

      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(
          new Error(`MCP request "${method}" (id: ${id}) timed out after 30s`),
        );
      }, 30000);

      this.pendingRequests.set(id, { resolve, reject, timeout });
      this.child.stdin.write(JSON.stringify(request) + "\n");
    });
  }

  private sendNotification(method: string, params?: any): void {
    if (!this.child || !this.child.stdin) return;

    const notification = {
      jsonrpc: "2.0",
      method,
      params,
    };
    this.child.stdin.write(JSON.stringify(notification) + "\n");
  }

  private handleIncomingMessage(line: string) {
    if (!line.trim()) return;
    try {
      const msg = JSON.parse(line);
      if (msg.jsonrpc === "2.0" && msg.id !== undefined) {
        const pending = this.pendingRequests.get(msg.id);
        if (pending) {
          clearTimeout(pending.timeout);
          this.pendingRequests.delete(msg.id);

          if (msg.error) {
            pending.reject(
              new Error(
                `MCP Error: ${msg.error.message} (code: ${msg.error.code})`,
              ),
            );
          } else {
            pending.resolve(msg.result);
          }
        }
      }
    } catch (err) {
      // Ignored parsing errors of other messages
    }
  }

  private cleanup(err: Error) {
    this.isConnected = false;
    for (const [id, pending] of this.pendingRequests.entries()) {
      clearTimeout(pending.timeout);
      pending.reject(err);
    }
    this.pendingRequests.clear();
  }

  public async stop(): Promise<void> {
    this.isConnected = false;
    if (this.child) {
      this.child.removeAllListeners("exit");
      this.child.removeAllListeners("error");
      this.child.kill();
      this.child = null;
    }
    this.cleanup(new Error("MCP Client stopped"));
  }
}

export class DynamicMCPTool implements OrbitTool<any, any> {
  public name: string;
  public description: string;
  public inputSchema: z.ZodType<any>;
  public risk: ToolRisk;
  private originalToolName: string;

  constructor(
    serverName: string,
    toolDef: MCPToolDefinition,
    risk: ToolRisk,
    private client: MCPClient,
  ) {
    this.name = `mcp__${serverName}__${toolDef.name}`;
    this.description = `[MCP Tool: ${serverName}] ${toolDef.description}`;
    this.risk = risk;
    this.originalToolName = toolDef.name;
    this.inputSchema = z.any();
  }

  public async execute(input: any, ctx: ToolContext): Promise<ToolResult<any>> {
    try {
      const response = await this.client.callTool(this.originalToolName, input);
      const isError = response.isError || false;
      const text =
        response.content?.map((c: any) => c.text || "").join("\n") || "";

      if (isError) {
        return {
          ok: false,
          error: text || "Unknown MCP tool execution error",
        };
      }
      return {
        ok: true,
        data: text,
        display: text,
      };
    } catch (err: any) {
      return {
        ok: false,
        error: `MCP Tool execution failed: ${err.message}`,
      };
    }
  }
}
