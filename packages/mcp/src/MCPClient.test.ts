import { describe, it, expect } from 'vitest';
import { MCPClient } from './MCPClient.js';
import path from 'path';
import { writeFileSync, unlinkSync } from 'fs';

describe('MCPClient', () => {
  it('should handshake and list/call tools from a stdio MCP server', async () => {
    const dummyServerPath = path.resolve(process.cwd(), 'packages/mcp/src/dummy-server-test.js');

    // Create a simple dummy MCP server script
    const dummyServerCode = `
import readline from 'readline';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false
});

rl.on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        serverInfo: { name: 'dummy', version: '0.1.0' }
      }
    }) + '\\n');
  } else if (msg.method === 'tools/list') {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        tools: [
          {
            name: 'hello',
            description: 'Says hello',
            inputSchema: { type: 'object', properties: { name: { type: 'string' } } }
          }
        ]
      }
    }) + '\\n');
  } else if (msg.method === 'tools/call') {
    const args = msg.params.arguments;
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        content: [{ type: 'text', text: \`Hello, \${args?.name || 'World'}!\` }],
        isError: false
      }
    }) + '\\n');
  }
});
`;
    writeFileSync(dummyServerPath, dummyServerCode);

    const client = new MCPClient('dummy-server', 'node', [dummyServerPath]);
    try {
      const tools = await client.start();
      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe('hello');

      const res = await client.callTool('hello', { name: 'Orbit' });
      expect(res.result?.content || res.content).toBeDefined();
      const content = res.result?.content || res.content;
      expect(content[0].text).toBe('Hello, Orbit!');
    } finally {
      await client.stop();
      try {
        unlinkSync(dummyServerPath);
      } catch {
        // Ignored
      }
    }
  });
});
