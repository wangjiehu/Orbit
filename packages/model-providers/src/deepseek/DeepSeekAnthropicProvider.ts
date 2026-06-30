import {
  ModelProvider,
  ModelChatInput,
  ModelEvent,
  ModelCapabilities,
  ProviderRuntimeOptions,
} from "../types.js";
import { zodToJsonSchema, fetchWithRetry } from "../utils.js";

export class DeepSeekAnthropicProvider implements ModelProvider {
  id = "deepseek-anthropic";
  type: ModelProvider["type"] = "anthropic-compatible";
  capabilities = {
    streaming: true,
    toolCalls: true,
    jsonMode: true,
    thinking: true,
    vision: false,
    promptCaching: true,
  };

  constructor(
    private apiKey?: string,
    private baseUrl = "https://api.deepseek.com/anthropic",
    private options: ProviderRuntimeOptions = {},
  ) {
    if (options.id) {
      this.id = options.id;
    }
    if (!options.disablePreheat) {
      this.preheat();
    }
  }

  private preheat() {
    try {
      if (this.baseUrl && typeof fetch === "function") {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 1000);
        timeout.unref?.();
        fetch(this.baseUrl, { method: "HEAD", signal: controller.signal })
          .catch(() => {})
          .finally(() => clearTimeout(timeout));
      }
    } catch {
      // Ignored
    }
  }

  private getDefaultApiKeyEnv(): string {
    if (this.options.apiKeyEnv) {
      return this.options.apiKeyEnv;
    }
    if (this.type === "anthropic" || this.id === "anthropic") {
      return "ANTHROPIC_API_KEY";
    }
    return "ANTHROPIC_AUTH_TOKEN";
  }

  private resolveApiKey(): string | undefined {
    return (
      this.apiKey ||
      (this.options.apiKeyEnv
        ? process.env[this.options.apiKeyEnv]
        : undefined) ||
      process.env[this.getDefaultApiKeyEnv()]
    );
  }

  private getEndpointUrl(path: string): string {
    const base = this.baseUrl.endsWith("/")
      ? this.baseUrl.slice(0, -1)
      : this.baseUrl;
    if (base.endsWith("/v1") && path.startsWith("/v1/")) {
      return `${base}${path.substring(3)}`;
    }
    return `${base}${path}`;
  }

  private buildJsonHeaders(key: string): Record<string, string> {
    const authHeader = this.options.apiKeyHeader || "x-api-key";
    const prefix = this.options.apiKeyPrefix ?? "";
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
      [authHeader]: prefix
        ? `${prefix}${prefix.endsWith(" ") ? "" : " "}${key}`
        : key,
    };
    return { ...headers, ...(this.options.headers || {}) };
  }

  private getModelCapabilityOverride(
    model: string,
  ): Partial<ModelCapabilities> | undefined {
    const overrides = this.options.modelCapabilities || {};
    const normalizedModel = model.toLowerCase();
    for (const [pattern, caps] of Object.entries(overrides)) {
      const normalizedPattern = pattern.toLowerCase();
      if (normalizedPattern === normalizedModel) {
        return caps;
      }
      if (
        normalizedPattern.includes("*") &&
        this.matchesWildcard(normalizedModel, normalizedPattern)
      ) {
        return caps;
      }
    }
    return undefined;
  }

  private matchesWildcard(value: string, pattern: string): boolean {
    const escaped = pattern
      .split("*")
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*");
    return new RegExp(`^${escaped}$`).test(value);
  }

  private supportsAdaptiveThinking(model: string): boolean {
    const lowercase = model.toLowerCase();
    return (
      lowercase.includes("claude-fable-5") ||
      lowercase.includes("claude-mythos-5") ||
      lowercase.includes("claude-mythos-preview") ||
      lowercase.includes("claude-opus-4-8") ||
      lowercase.includes("claude-opus-4-7") ||
      lowercase.includes("claude-opus-4-6") ||
      lowercase.includes("claude-sonnet-4-6")
    );
  }

  private getAdaptiveThinkingEffort(budgetTokens = 4096): string {
    if (budgetTokens >= 8192) return "max";
    if (budgetTokens >= 4096) return "high";
    if (budgetTokens >= 1500) return "medium";
    return "low";
  }

  public getModelCapabilities(model: string): ModelCapabilities {
    const lowercase = model.toLowerCase();
    const isClaude = lowercase.includes("claude");
    const inferred: ModelCapabilities = {
      streaming: true,
      toolCalls: true,
      jsonMode: true,
      thinking:
        this.supportsAdaptiveThinking(model) ||
        lowercase.includes("thinking") ||
        lowercase.includes("sonnet-3-7") ||
        lowercase.includes("sonnet-4") ||
        lowercase.includes("opus-4"),
      vision: isClaude,
      promptCaching: true,
    };
    return {
      ...inferred,
      ...(this.options.capabilities || {}),
      ...(this.getModelCapabilityOverride(model) || {}),
    };
  }

  async *chat(input: ModelChatInput): AsyncIterable<ModelEvent> {
    const key = this.resolveApiKey();
    if (!key) {
      const keyEnv = this.getDefaultApiKeyEnv();
      yield {
        type: "error",
        error: new Error(
          `API key missing for ${this.id} provider. Please set ${keyEnv}.`,
        ),
      };
      return;
    }

    // Convert OrbitMessage to Anthropic messages
    const anthropicMessages = input.messages
      .filter((m) => m.role !== "system")
      .map((m) => {
        const content = m.content.map((block) => {
          if (block.type === "text") {
            return { type: "text", text: block.text };
          } else if (block.type === "tool_call") {
            return {
              type: "tool_use",
              id: block.toolCall.id,
              name: block.toolCall.name,
              input: JSON.parse(block.toolCall.arguments),
            };
          } else if (block.type === "tool_result") {
            return {
              type: "tool_result",
              tool_use_id: block.toolResult.toolCallId,
              content: block.toolResult.content,
              is_error: block.toolResult.isError,
            };
          } else if (block.type === "thinking") {
            return {
              type: "thinking",
              thinking: block.text,
              ...(block.signature ? { signature: block.signature } : {}),
            };
          }
          return { type: "text", text: "" };
        });
        return {
          role: m.role === "tool" ? "user" : m.role,
          content,
        };
      });

    // Extract system prompt
    const systemPrompt =
      input.system ||
      input.messages
        .find((m) => m.role === "system")
        ?.content.filter((b) => b.type === "text")
        .map((b) => (b.type === "text" ? b.text : ""))
        .join("\n");

    // Build Anthropic tools definition
    const tools = input.tools?.map((t) => {
      return {
        name: t.name,
        description: t.description,
        input_schema: zodToJsonSchema(t.inputSchema),
      };
    });

    // Split system prompt at Orbit's volatile marker for optimal cache breakpoints.
    // Layer 1 (stable prefix): core rules + tool schemas + repo map → cached across turns
    // Layer 2 (dynamic suffix): RAG context + file excerpts → changes per turn
    const cacheBoundaryMarkers = [
      "\n<!-- VOLATILE_CONTEXT -->",
      "\n<!-- CACHE_BOUNDARY -->",
    ];
    const cacheBoundary = systemPrompt
      ? cacheBoundaryMarkers.find((marker) => systemPrompt.includes(marker))
      : undefined;
    let systemParam: any[] | undefined;

    if (systemPrompt && cacheBoundary) {
      const splitIdx = systemPrompt.indexOf(cacheBoundary);
      const stablePrefix = systemPrompt.substring(0, splitIdx);
      const dynamicSuffix = systemPrompt.substring(
        splitIdx + cacheBoundary.length,
      );

      systemParam = [
        {
          type: "text" as const,
          text: stablePrefix,
          cache_control: { type: "ephemeral" as const },
        },
        {
          type: "text" as const,
          text: dynamicSuffix,
          cache_control: { type: "ephemeral" as const },
        },
      ];
    } else if (systemPrompt) {
      systemParam = [
        {
          type: "text" as const,
          text: systemPrompt,
          cache_control: { type: "ephemeral" as const },
        },
      ];
    }

    if (this.capabilities.promptCaching && anthropicMessages.length > 0) {
      const lastMsg = anthropicMessages[anthropicMessages.length - 1];
      if (lastMsg.content.length > 0) {
        const lastBlock = lastMsg.content[lastMsg.content.length - 1] as any;
        lastBlock.cache_control = { type: "ephemeral" as const };
      }
    }

    const body: any = {
      model: input.model,
      messages: anthropicMessages,
      max_tokens: input.maxTokens || 4000,
      system: systemParam,
      stream:
        input.stream !== false &&
        this.getModelCapabilities(input.model).streaming,
    };

    if (input.userId) {
      body.metadata = { user_id: input.userId };
    }

    if (tools && tools.length > 0) {
      body.tools = tools;
    }

    if (input.thinking?.enabled) {
      if (this.supportsAdaptiveThinking(input.model)) {
        body.thinking = {
          type: "adaptive",
          display: "summarized",
        };
        body.output_config = {
          ...(body.output_config || {}),
          effort: this.getAdaptiveThinkingEffort(input.thinking.budgetTokens),
        };
      } else {
        body.thinking = {
          type: "enabled",
          budget_tokens: input.thinking.budgetTokens || 1024,
        };
        body.temperature = 1.0;
      }
    }
    if (this.options.extraBody) {
      Object.assign(body, this.options.extraBody);
    }

    const chatController = new AbortController();
    const chatSignal = chatController.signal;

    const onExternalAbort = () => {
      chatController.abort();
    };

    if (input.abortSignal) {
      if (input.abortSignal.aborted) {
        throw (
          input.abortSignal.reason ||
          new DOMException("The user aborted a request.", "AbortError")
        );
      }
      input.abortSignal.addEventListener("abort", onExternalAbort);
    }

    let response: Response;
    try {
      response = await fetchWithRetry(
        this.getEndpointUrl("/v1/messages"),
        {
          method: "POST",
          headers: this.buildJsonHeaders(key),
          body: JSON.stringify(body),
          signal: chatSignal,
          timeout: this.options.requestTimeoutMs,
        },
        this.options.maxRetries ?? 2,
      );
    } catch (err) {
      if (input.abortSignal) {
        input.abortSignal.removeEventListener("abort", onExternalAbort);
      }
      yield { type: "error", error: err };
      return;
    }

    if (!response.ok) {
      const errText = await response.text();
      yield {
        type: "error",
        error: new Error(`HTTP ${response.status}: ${errText}`),
      };
      if (input.abortSignal) {
        input.abortSignal.removeEventListener("abort", onExternalAbort);
      }
      return;
    }

    if (!body.stream) {
      const data: any = await response.json();
      for (const block of data.content) {
        if (block.type === "text") {
          yield { type: "text_delta", text: block.text };
        } else if (block.type === "tool_use") {
          yield {
            type: "tool_call",
            toolCall: {
              id: block.id,
              name: block.name,
              arguments: JSON.stringify(block.input),
            },
          };
        }
      }
      yield {
        type: "usage",
        usage: {
          inputTokens: data.usage?.input_tokens || 0,
          outputTokens: data.usage?.output_tokens || 0,
          cacheReadTokens: data.usage?.cache_read_input_tokens || 0,
          cacheMissTokens: data.usage?.cache_creation_input_tokens || 0,
          totalTokens:
            (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0),
        },
      };
      yield { type: "done" };
      if (input.abortSignal) {
        input.abortSignal.removeEventListener("abort", onExternalAbort);
      }
      return;
    }

    const reader = response.body?.getReader();
    if (!reader) {
      if (input.abortSignal) {
        input.abortSignal.removeEventListener("abort", onExternalAbort);
      }
      yield {
        type: "error",
        error: new Error("Response body is not readable"),
      };
      return;
    }

    const decoder = new TextDecoder();
    let buffer = "";
    const streamingTools = new Map<
      number,
      { id: string; name: string; arguments: string }
    >();
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheMissTokens = 0;

    let streamTimeoutId: NodeJS.Timeout | undefined;
    const streamTimeoutMs = this.options.streamTimeoutMs ?? 60000;

    const resetStreamTimeout = () => {
      if (streamTimeoutId) clearTimeout(streamTimeoutId);
      streamTimeoutId = setTimeout(() => {
        chatController.abort(
          new DOMException(
            `Stream reading timed out after ${Math.round(streamTimeoutMs / 1000)} seconds of inactivity.`,
            "TimeoutError",
          ),
        );
      }, streamTimeoutMs);
    };

    try {
      resetStreamTimeout();
      while (true) {
        const { done, value } = await reader.read();
        resetStreamTimeout();
        if (done) break;

        let accumulatedText = "";
        let accumulatedThinking = "";

        buffer += decoder.decode(value, { stream: true });
        let lineStart = 0;
        while (true) {
          const idx = buffer.indexOf("\n", lineStart);
          if (idx === -1) break;
          const line = buffer.substring(lineStart, idx);
          lineStart = idx + 1;

          const trimmed = line.trim();
          if (!trimmed) continue;

          if (trimmed.startsWith("data:")) {
            const rawData = trimmed.substring(5).trimStart();
            if (rawData === "[DONE]") continue;
            try {
              const parsed = JSON.parse(rawData);

              if (parsed.type === "message_start") {
                if (parsed.message?.usage) {
                  inputTokens = parsed.message.usage.input_tokens || 0;
                  outputTokens = parsed.message.usage.output_tokens || 0;
                  cacheReadTokens =
                    parsed.message.usage.cache_read_input_tokens || 0;
                  cacheMissTokens =
                    parsed.message.usage.cache_creation_input_tokens || 0;
                }
              } else if (parsed.type === "content_block_start") {
                const idx = parsed.index;
                const block = parsed.content_block;
                if (block.type === "tool_use") {
                  streamingTools.set(idx, {
                    id: block.id,
                    name: block.name,
                    arguments: "",
                  });
                }
              } else if (parsed.type === "content_block_delta") {
                const idx = parsed.index;
                const delta = parsed.delta;
                if (delta.type === "text_delta") {
                  accumulatedText += delta.text;
                } else if (delta.type === "thinking_delta") {
                  accumulatedThinking += delta.thinking;
                } else if (delta.type === "signature_delta") {
                  if (accumulatedThinking) {
                    yield { type: "thinking_delta", text: accumulatedThinking };
                    accumulatedThinking = "";
                  }
                  yield {
                    type: "thinking_delta",
                    text: "",
                    signature: delta.signature,
                  };
                } else if (delta.type === "input_json_delta") {
                  const tool = streamingTools.get(idx);
                  if (tool) {
                    tool.arguments += delta.partial_json;
                  }
                }
              } else if (parsed.type === "content_block_stop") {
                const idx = parsed.index;
                const tool = streamingTools.get(idx);
                if (tool) {
                  if (accumulatedText) {
                    yield { type: "text_delta", text: accumulatedText };
                    accumulatedText = "";
                  }
                  if (accumulatedThinking) {
                    yield { type: "thinking_delta", text: accumulatedThinking };
                    accumulatedThinking = "";
                  }
                  yield {
                    type: "tool_call",
                    toolCall: {
                      id: tool.id,
                      name: tool.name,
                      arguments: tool.arguments,
                    },
                  };
                  streamingTools.delete(idx);
                }
              } else if (parsed.type === "message_delta") {
                if (parsed.usage) {
                  outputTokens = parsed.usage.output_tokens || outputTokens;
                }
              }
            } catch {
              // Parse error on incomplete chunk
            }
          }
        }
        buffer = buffer.substring(lineStart);

        if (accumulatedText) {
          yield { type: "text_delta", text: accumulatedText };
        }
        if (accumulatedThinking) {
          yield { type: "thinking_delta", text: accumulatedThinking };
        }
      }

      yield {
        type: "usage",
        usage: {
          inputTokens,
          outputTokens,
          cacheReadTokens,
          cacheMissTokens,
          totalTokens: inputTokens + outputTokens,
        },
      };
      yield { type: "done" };
    } catch (err: any) {
      yield {
        type: "error",
        error: err,
      };
    } finally {
      if (streamTimeoutId) clearTimeout(streamTimeoutId);
      if (input.abortSignal) {
        input.abortSignal.removeEventListener("abort", onExternalAbort);
      }
      reader.releaseLock();
    }
  }
}
