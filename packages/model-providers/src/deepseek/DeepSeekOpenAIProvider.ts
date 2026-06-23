import {
  ModelProvider,
  ModelChatInput,
  ModelEvent,
  OrbitMessage,
  OrbitContentBlock,
  ModelCapabilities,
} from "../types.js";
import { zodToJsonSchema, fetchWithRetry } from "../utils.js";

class StreamingThinkParser {
  private buffer = "";
  private inThinking = false;

  public feed(
    chunk: string,
  ): Array<{ type: "text_delta" | "thinking_delta"; text: string }> {
    this.buffer += chunk;
    const events: Array<{
      type: "text_delta" | "thinking_delta";
      text: string;
    }> = [];

    while (this.buffer.length > 0) {
      if (!this.inThinking) {
        const index = this.buffer.indexOf("<think>");
        if (index !== -1) {
          if (index > 0) {
            events.push({
              type: "text_delta",
              text: this.buffer.substring(0, index),
            });
          }
          this.buffer = this.buffer.substring(index + 7);
          this.inThinking = true;
          continue;
        }

        const openBracketIdx = this.buffer.lastIndexOf("<");
        if (openBracketIdx !== -1 && openBracketIdx >= this.buffer.length - 7) {
          const partial = this.buffer.substring(openBracketIdx);
          if ("<think>".startsWith(partial)) {
            if (openBracketIdx > 0) {
              events.push({
                type: "text_delta",
                text: this.buffer.substring(0, openBracketIdx),
              });
            }
            this.buffer = partial;
            break;
          }
        }

        events.push({ type: "text_delta", text: this.buffer });
        this.buffer = "";
      } else {
        const index = this.buffer.indexOf("</think>");
        if (index !== -1) {
          if (index > 0) {
            events.push({
              type: "thinking_delta",
              text: this.buffer.substring(0, index),
            });
          }
          this.buffer = this.buffer.substring(index + 8);
          this.inThinking = false;
          continue;
        }

        const openBracketIdx = this.buffer.lastIndexOf("<");
        if (openBracketIdx !== -1 && openBracketIdx >= this.buffer.length - 8) {
          const partial = this.buffer.substring(openBracketIdx);
          if ("</think>".startsWith(partial)) {
            if (openBracketIdx > 0) {
              events.push({
                type: "thinking_delta",
                text: this.buffer.substring(0, openBracketIdx),
              });
            }
            this.buffer = partial;
            break;
          }
        }

        events.push({ type: "thinking_delta", text: this.buffer });
        this.buffer = "";
      }
    }

    return events;
  }

  public flush(): Array<{
    type: "text_delta" | "thinking_delta";
    text: string;
  }> {
    const events: Array<{
      type: "text_delta" | "thinking_delta";
      text: string;
    }> = [];
    if (this.buffer.length > 0) {
      events.push({
        type: this.inThinking ? "thinking_delta" : "text_delta",
        text: this.buffer,
      });
      this.buffer = "";
    }
    return events;
  }
}

export class DeepSeekOpenAIProvider implements ModelProvider {
  id = "deepseek-openai";
  type: ModelProvider["type"] = "openai-compatible";
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
    private baseUrl = "https://api.deepseek.com",
  ) {
    this.preheat();
  }

  private preheat() {
    try {
      if (this.baseUrl && typeof fetch === "function") {
        fetch(this.baseUrl, { method: "HEAD" }).catch(() => {});
      }
    } catch {
      // Ignored
    }
  }

  private getEndpointUrl(path: string): string {
    const base = this.baseUrl.endsWith("/") ? this.baseUrl.slice(0, -1) : this.baseUrl;
    if (base.endsWith("/v1") && path.startsWith("/v1/")) {
      return `${base}${path.substring(3)}`;
    }
    return `${base}${path}`;
  }

  public getModelCapabilities(model: string): ModelCapabilities {
    const lowercase = model.toLowerCase();
    const isReasoner =
      lowercase.includes("reasoner") ||
      lowercase.includes("r1") ||
      lowercase.includes("v4-pro");

    const isOpenAIReasoner =
      this.id === "openai" &&
      (lowercase.startsWith("o1") || lowercase.startsWith("o3"));

    const isOfficialDeepSeek = this.baseUrl.includes("api.deepseek.com");
    const supportsNativeTools = !(
      (isOfficialDeepSeek && isReasoner) ||
      lowercase.includes("o1-preview") ||
      lowercase.includes("o1-mini")
    );

    return {
      streaming: !isOpenAIReasoner,
      toolCalls: supportsNativeTools,
      jsonMode: !isReasoner,
      thinking: isReasoner || isOpenAIReasoner,
      vision: lowercase.includes("vision") || lowercase.includes("gpt-4o") || lowercase.includes("claude-3"),
      promptCaching: true,
    };
  }

  async *chat(input: ModelChatInput): AsyncIterable<ModelEvent> {
    const thinkParser = new StreamingThinkParser();
    const key = this.apiKey || process.env.DEEPSEEK_API_KEY;
    if (!key) {
      yield {
        type: "error",
        error: new Error(
          "API key missing for deepseek-openai provider. Please set DEEPSEEK_API_KEY.",
        ),
      };
      return;
    }

    const isOfficialDeepSeek = this.baseUrl.includes("api.deepseek.com");

    // Convert messages to OpenAI chat completions messages
    const openaiMessages = input.messages.flatMap((m) => {
      if (m.role === "tool") {
        const toolResults = m.content.filter((b) => b.type === "tool_result");
        if (toolResults.length > 0) {
          return toolResults.map((tr) => {
            const trData = (tr as any).toolResult;
            return {
              role: "tool" as const,
              tool_call_id: trData.toolCallId,
              content: typeof trData.content === "string" ? trData.content : JSON.stringify(trData.content),
            };
          });
        }
      }

      // Map contents
      const content = m.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");

      const reasoningContent = m.content
        .filter((block) => block.type === "thinking")
        .map((block) => block.text)
        .join("\n");

      const toolCalls = m.content
        .filter((b) => b.type === "tool_call")
        .map((b) => {
          const tc = (b as any).toolCall;
          return {
            id: tc.id,
            type: "function" as const,
            function: {
              name: tc.name,
              arguments: tc.arguments,
            },
          };
        });

      const role = m.role === "tool" ? "tool" : m.role;

      const msg: any = { role };
      if (role === "assistant" && reasoningContent && !isOfficialDeepSeek) {
        // Wrap reasoning inside content with think tags for compatible providers
        msg.content = `<think>\n${reasoningContent}\n</think>\n${content}`;
      } else {
        if (role === "tool") {
          msg.content = content || "";
        } else if (content) {
          msg.content = content;
        } else if (role === "assistant") {
          msg.content = null;
        } else {
          msg.content = "";
        }

        if (reasoningContent && role === "assistant" && isOfficialDeepSeek) {
          msg.reasoning_content = reasoningContent;
        }
      }

      if (toolCalls.length > 0) {
        msg.tool_calls = toolCalls;
      }

      return [msg];
    });

    if (input.system) {
      openaiMessages.unshift({
        role: "system",
        content: input.system,
      });
    }

    const tools = input.tools?.map((t) => {
      return {
        type: "function" as const,
        function: {
          name: t.name,
          description: t.description,
          parameters: zodToJsonSchema(t.inputSchema),
        },
      };
    });

    const capabilities = this.getModelCapabilities(input.model);
    const isReasoner = capabilities.thinking && !input.model.toLowerCase().startsWith("o");
    const isOpenAIReasoner = capabilities.thinking && input.model.toLowerCase().startsWith("o");

    const body: any = {
      model: input.model,
      messages: openaiMessages,
      stream: input.stream !== false,
    };

    if (input.userId) {
      body.user_id = input.userId;
    }

    if (isOpenAIReasoner) {
      body.max_completion_tokens = input.maxTokens;
      if (input.thinking?.enabled) {
        const budget = input.thinking.budgetTokens || 1024;
        body.reasoning_effort = budget > 1500 ? "high" : budget > 500 ? "medium" : "low";
      }
    } else {
      body.max_tokens = input.maxTokens;
    }

    if (input.thinking?.enabled) {
      if (!isOpenAIReasoner && !isOfficialDeepSeek) {
        body.thinking = {
          type: "enabled",
          budget_tokens: input.thinking.budgetTokens || 1024,
        };
      }
      body.temperature = 1.0;
    } else if (isReasoner) {
      body.temperature = 1.0;
    } else {
      if (isOpenAIReasoner) {
        // o1/o3-mini only support temperature 1.0 (or default)
      } else {
        body.temperature = input.temperature ?? 0.7;
      }
    }

    if (body.stream) {
      body.stream_options = { include_usage: true };
    }

    const supportsNativeTools = capabilities.toolCalls;

    if (tools && tools.length > 0 && supportsNativeTools) {
      body.tools = tools;
    }

    if (input.responseFormat === "json") {
      body.response_format = { type: "json_object" };
    }

    const chatController = new AbortController();
    const chatSignal = chatController.signal;

    let externalSignalAborted = false;
    const onExternalAbort = () => {
      externalSignalAborted = true;
      chatController.abort();
    };

    if (input.abortSignal) {
      if (input.abortSignal.aborted) {
        throw input.abortSignal.reason || new DOMException("The user aborted a request.", "AbortError");
      }
      input.abortSignal.addEventListener("abort", onExternalAbort);
    }

    const response = await fetchWithRetry(
      this.getEndpointUrl("/v1/chat/completions"),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify(body),
        signal: chatSignal,
        keepalive: true,
      },
    );

    if (!response.ok) {
      const errText = await response.text();
      yield {
        type: "error",
        error: new Error(`HTTP ${response.status}: ${errText}`),
      };
      return;
    }

    if (!body.stream) {
      const data: any = await response.json();
      const choice = data.choices?.[0];
      if (choice?.message?.content) {
        yield { type: "text_delta", text: choice.message.content };
      }
      if (choice?.message?.tool_calls) {
        for (const tc of choice.message.tool_calls) {
          yield {
            type: "tool_call",
            toolCall: {
              id: tc.id,
              name: tc.function.name,
              arguments: tc.function.arguments,
            },
          };
        }
      }
      yield {
        type: "usage",
        usage: {
          inputTokens: data.usage?.prompt_tokens || 0,
          outputTokens: data.usage?.completion_tokens || 0,
          cacheReadTokens:
            data.usage?.prompt_cache_hit_tokens ||
            data.usage?.prompt_tokens_details?.cached_tokens ||
            0,
          totalTokens: data.usage?.total_tokens || 0,
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
    let promptTokens = 0;
    let completionTokens = 0;
    let cacheReadTokens = 0;

    let streamTimeoutId: NodeJS.Timeout | undefined;
    const streamTimeoutMs = 60000;

    const resetStreamTimeout = () => {
      if (streamTimeoutId) clearTimeout(streamTimeoutId);
      streamTimeoutId = setTimeout(() => {
        chatController.abort(new DOMException("Stream reading timed out after 60 seconds of inactivity.", "TimeoutError"));
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

          if (trimmed.startsWith("data: ")) {
            const rawData = trimmed.substring(6);
            if (rawData === "[DONE]") continue;
            try {
              const parsed = JSON.parse(rawData);
              const choice = parsed.choices?.[0];

              if (choice?.delta?.content) {
                const parsedEvents = thinkParser.feed(choice.delta.content);
                for (const ev of parsedEvents) {
                  if (ev.type === "text_delta") {
                    accumulatedText += ev.text;
                  } else {
                    accumulatedThinking += ev.text;
                  }
                }
              }

              if (choice?.delta?.reasoning_content) {
                accumulatedThinking += choice.delta.reasoning_content;
              }

              if (choice?.delta?.tool_calls) {
                for (const tcDelta of choice.delta.tool_calls) {
                  const idx = tcDelta.index;
                  let tool = streamingTools.get(idx);
                  if (!tool) {
                    tool = { id: "", name: "", arguments: "" };
                    streamingTools.set(idx, tool);
                  }
                  if (tcDelta.id) tool.id = tcDelta.id;
                  if (tcDelta.function?.name) tool.name = tcDelta.function.name;
                  if (tcDelta.function?.arguments)
                    tool.arguments += tcDelta.function.arguments;
                }
              }

              if (parsed.usage) {
                promptTokens = parsed.usage.prompt_tokens || promptTokens;
                completionTokens =
                  parsed.usage.completion_tokens || completionTokens;
                if (parsed.usage.prompt_cache_hit_tokens) {
                  cacheReadTokens = parsed.usage.prompt_cache_hit_tokens;
                } else if (parsed.usage.prompt_tokens_details?.cached_tokens) {
                  cacheReadTokens =
                    parsed.usage.prompt_tokens_details.cached_tokens;
                }
              }
            } catch (e) {
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

      // Flush any remaining characters in parser
      const flushed = thinkParser.flush();
      for (const ev of flushed) {
        yield { type: ev.type, text: ev.text };
      }

      // Emit finished tool calls
      for (const tool of streamingTools.values()) {
        if (tool.id && tool.name) {
          yield {
            type: "tool_call",
            toolCall: {
              id: tool.id,
              name: tool.name,
              arguments: tool.arguments,
            },
          };
        }
      }

      yield {
        type: "usage",
        usage: {
          inputTokens: promptTokens,
          outputTokens: completionTokens,
          cacheReadTokens: cacheReadTokens,
          totalTokens: promptTokens + completionTokens,
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

  async embed(
    texts: string[],
    options?: { model?: string },
  ): Promise<number[][]> {
    const key = this.apiKey || process.env.DEEPSEEK_API_KEY;
    if (!key) {
      throw new Error(
        "API key missing for embedding provider. Please set DEEPSEEK_API_KEY.",
      );
    }

    const model = options?.model || "text-embedding-3-small";

    const response = await fetchWithRetry(this.getEndpointUrl("/v1/embeddings"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        input: texts,
        model: model,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(
        `Embedding API Error HTTP ${response.status}: ${errText}`,
      );
    }

    const data: any = await response.json();
    if (!data.data || !Array.isArray(data.data)) {
      throw new Error("Invalid response format from embedding API");
    }

    // Sort by index to preserve order
    const sorted = [...data.data].sort(
      (a: any, b: any) => (a.index ?? 0) - (b.index ?? 0),
    );
    return sorted.map((item: any) => item.embedding);
  }

  async complete(
    prompt: string,
    options?: {
      model?: string;
      maxTokens?: number;
      stop?: string[];
      suffix?: string;
      abortSignal?: AbortSignal;
    },
  ): Promise<string> {
    const key = this.apiKey || process.env.DEEPSEEK_API_KEY;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (key && key !== "ollama-no-key") {
      headers["Authorization"] = `Bearer ${key}`;
    }

    const isOfficialDeepSeek = this.baseUrl.includes("api.deepseek.com");
    let url = this.getEndpointUrl("/v1/completions");
    const bodyData: any = {
      model: options?.model || "qwen2.5-coder:1.5b",
      prompt: prompt,
      max_tokens: options?.maxTokens || 64,
      temperature: 0.0,
      stop: options?.stop || [],
    };

    if (isOfficialDeepSeek) {
      // Official DeepSeek API FIM endpoint is under /beta/v1/completions
      const betaBase = this.baseUrl.endsWith("/") ? this.baseUrl.slice(0, -1) : this.baseUrl;
      url = betaBase.includes("/beta") ? `${betaBase}/v1/completions` : `${betaBase}/beta/v1/completions`;

      if (options?.suffix !== undefined) {
        bodyData.prompt = prompt;
        bodyData.suffix = options.suffix;
      }
      if (!options?.model || options.model.includes("qwen") || options.model === "deepseek-chat") {
        bodyData.model = "deepseek-v4-flash";
      }
    }

    const response = await fetchWithRetry(url, {
      method: "POST",
      headers,
      body: JSON.stringify(bodyData),
      signal: options?.abortSignal,
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(
        `Completion API Error HTTP ${response.status}: ${errText}`,
      );
    }

    const data: any = await response.json();
    return data.choices?.[0]?.text || "";
  }
}
