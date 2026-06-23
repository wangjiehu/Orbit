import { ConfigLoader } from "@orbit-build/config";
import { AutocompleteEngine } from "@orbit-build/core";

class JSONRPCReader {
  private buffer = "";

  constructor(private onMessage: (msg: any) => void) {}

  public feed(chunk: string) {
    this.buffer += chunk;
    while (true) {
      const headerIndex = this.buffer.indexOf("\r\n\r\n");
      if (headerIndex === -1) {
        break;
      }

      const headerPart = this.buffer.substring(0, headerIndex);
      const contentLengthMatch = headerPart.match(/Content-Length:\s*(\d+)/i);
      if (!contentLengthMatch) {
        // Invalid header, clear header and continue
        this.buffer = this.buffer.substring(headerIndex + 4);
        continue;
      }

      const contentLength = parseInt(contentLengthMatch[1], 10);
      const bodyStartIndex = headerIndex + 4;

      if (this.buffer.length < bodyStartIndex + contentLength) {
        // Message body is still incomplete, wait for more data
        break;
      }

      const bodyPart = this.buffer.substring(
        bodyStartIndex,
        bodyStartIndex + contentLength,
      );
      this.buffer = this.buffer.substring(bodyStartIndex + contentLength);

      try {
        const parsed = JSON.parse(bodyPart);
        this.onMessage(parsed);
      } catch (err: any) {
        console.error(`[LSP Error] Failed to parse JSON body: ${err.message}`);
      }
    }
  }
}

function sendRPC(msg: any) {
  const body = JSON.stringify(msg);
  process.stdout.write(
    `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`,
  );
}

function getPrefixSuffix(
  text: string,
  line: number,
  character: number,
): { prefix: string; suffix: string } {
  const lines = text.split(/\r?\n/);
  if (line < 0 || line >= lines.length) {
    return { prefix: text, suffix: "" };
  }

  const beforeLines = lines.slice(0, line);
  const currentLine = lines[line];
  const charIdx = Math.min(character, currentLine.length);

  const beforeInLine = currentLine.substring(0, charIdx);
  const afterInLine = currentLine.substring(charIdx);

  const afterLines = lines.slice(line + 1);

  const prefix = [...beforeLines, beforeInLine].join("\n");
  const suffix = [afterInLine, ...afterLines].join("\n");

  return { prefix, suffix };
}

export async function runLSPServer(cwd: string): Promise<void> {
  console.error("[LSP] Starting Orbit LSP Server...");

  const config = ConfigLoader.loadSync(cwd);
  const autocompleteEngine = new AutocompleteEngine();
  const documentCache = new Map<string, string>();

  const reader = new JSONRPCReader(async (msg) => {
    if (!msg.method) return;

    switch (msg.method) {
      case "initialize":
        sendRPC({
          jsonrpc: "2.0",
          id: msg.id,
          result: {
            capabilities: {
              textDocumentSync: 1, // Full document sync
              completionProvider: {
                resolveProvider: false,
                triggerCharacters: [".", "(", "{", " ", ":", ","],
              },
            },
          },
        });
        break;

      case "initialized":
        console.error("[LSP] Orbit Autocomplete Server fully initialized.");
        break;

      case "textDocument/didOpen": {
        const { uri, text } = msg.params.textDocument;
        documentCache.set(uri, text);
        break;
      }

      case "textDocument/didChange": {
        const { uri } = msg.params.textDocument;
        const change = msg.params.contentChanges?.[0];
        if (change) {
          documentCache.set(uri, change.text);
        }
        break;
      }

      case "textDocument/didClose": {
        const { uri } = msg.params.textDocument;
        documentCache.delete(uri);
        break;
      }

      case "textDocument/completion": {
        const { uri } = msg.params.textDocument;
        const { line, character } = msg.params.position;

        const docText = documentCache.get(uri);
        if (!docText) {
          sendRPC({
            jsonrpc: "2.0",
            id: msg.id,
            result: [],
          });
          break;
        }

        const { prefix, suffix } = getPrefixSuffix(docText, line, character);

        try {
          const completion = await autocompleteEngine.autocomplete(
            prefix,
            suffix,
            config,
            uri,
          );

          if (completion) {
            sendRPC({
              jsonrpc: "2.0",
              id: msg.id,
              result: [
                {
                  label:
                    completion.trim().substring(0, 40) +
                    (completion.trim().length > 40 ? "..." : ""),
                  kind: 15, // Snippet / Text
                  insertText: completion,
                  detail: "Orbit Autocomplete",
                  documentation: {
                    kind: "markdown",
                    value: `\`\`\`typescript\n${completion}\n\`\`\``,
                  },
                },
              ],
            });
          } else {
            sendRPC({
              jsonrpc: "2.0",
              id: msg.id,
              result: [],
            });
          }
        } catch (err: any) {
          console.error(`[LSP Autocomplete Error] ${err.message}`);
          sendRPC({
            jsonrpc: "2.0",
            id: msg.id,
            result: [],
          });
        }
        break;
      }

      case "shutdown":
        sendRPC({
          jsonrpc: "2.0",
          id: msg.id,
          result: null,
        });
        break;

      case "exit":
        process.exit(0);
        break;

      default:
        // Respond with method not found for standard requests
        if (msg.id !== undefined) {
          sendRPC({
            jsonrpc: "2.0",
            id: msg.id,
            error: {
              code: -32601,
              message: `Method not found: ${msg.method}`,
            },
          });
        }
        break;
    }
  });

  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    reader.feed(chunk.toString());
  });

  process.stdin.on("end", () => {
    console.error("[LSP] Connection ended.");
    process.exit(0);
  });
}
