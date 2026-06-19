import {
  ModelProvider,
  ModelChatInput,
  ModelEvent,
  OrbitMessage,
  OrbitContentBlock,
} from '../types.js';
import { zodToJsonSchema } from '../utils.js';

export class DeepSeekOpenAIProvider implements ModelProvider {
  id = 'deepseek-openai';
  type: ModelProvider['type'] = 'openai-compatible';
  capabilities = {
    streaming: true,
    toolCalls: true,
    jsonMode: true,
    thinking: true,
    vision: false,
    promptCaching: true,
  };

  constructor(private apiKey?: string, private baseUrl = 'https://api.deepseek.com') {}

  async *chat(input: ModelChatInput): AsyncIterable<ModelEvent> {
    const key = this.apiKey || process.env.DEEPSEEK_API_KEY;
    if (!key) {
      yield {
        type: 'error',
        error: new Error(
          'API key missing for deepseek-openai provider. Please set DEEPSEEK_API_KEY.'
        ),
      };
      return;
    }

    // Convert messages to OpenAI chat completions messages
    const openaiMessages = input.messages.map((m) => {
      // Map contents
      const content = m.content
        .map((block) => {
          if (block.type === 'text') {
            return block.text;
          }
          return '';
        })
        .join('\n');

      const toolCalls = m.content
        .filter((b) => b.type === 'tool_call')
        .map((b) => {
          const tc = (b as any).toolCall;
          return {
            id: tc.id,
            type: 'function' as const,
            function: {
              name: tc.name,
              arguments: tc.arguments,
            },
          };
        });

      const toolResult = m.content.find((b) => b.type === 'tool_result');

      const role = m.role === 'tool' ? 'tool' : m.role;

      const msg: any = { role };
      if (content) {
        msg.content = content;
      }
      if (toolCalls.length > 0) {
        msg.tool_calls = toolCalls;
      }
      if (role === 'tool' && toolResult) {
        msg.tool_call_id = (toolResult as any).toolResult.toolCallId;
      }

      return msg;
    });

    const tools = input.tools?.map((t) => {
      return {
        type: 'function' as const,
        function: {
          name: t.name,
          description: t.description,
          parameters: zodToJsonSchema(t.inputSchema),
        },
      };
    });

    const body: any = {
      model: input.model,
      messages: openaiMessages,
      temperature: input.temperature ?? 0.7,
      max_tokens: input.maxTokens,
      stream: input.stream !== false,
    };

    if (tools && tools.length > 0) {
      body.tools = tools;
    }

    if (input.responseFormat === 'json') {
      body.response_format = { type: 'json_object' };
    }

    const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify(body),
      signal: input.abortSignal,
    });

    if (!response.ok) {
      const errText = await response.text();
      yield { type: 'error', error: new Error(`HTTP ${response.status}: ${errText}`) };
      return;
    }

    if (!body.stream) {
      const data: any = await response.json();
      const choice = data.choices?.[0];
      if (choice?.message?.content) {
        yield { type: 'text_delta', text: choice.message.content };
      }
      if (choice?.message?.tool_calls) {
        for (const tc of choice.message.tool_calls) {
          yield {
            type: 'tool_call',
            toolCall: {
              id: tc.id,
              name: tc.function.name,
              arguments: tc.function.arguments,
            },
          };
        }
      }
      yield {
        type: 'usage',
        usage: {
          inputTokens: data.usage?.prompt_tokens || 0,
          outputTokens: data.usage?.completion_tokens || 0,
          totalTokens: data.usage?.total_tokens || 0,
        },
      };
      yield { type: 'done' };
      return;
    }

    const reader = response.body?.getReader();
    if (!reader) {
      yield { type: 'error', error: new Error('Response body is not readable') };
      return;
    }

    const decoder = new TextDecoder();
    let buffer = '';
    const streamingTools = new Map<number, { id: string; name: string; arguments: string }>();
    let promptTokens = 0;
    let completionTokens = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          if (trimmed.startsWith('data: ')) {
            const rawData = trimmed.substring(6);
            if (rawData === '[DONE]') continue;
            try {
              const parsed = JSON.parse(rawData);
              const choice = parsed.choices?.[0];

              if (choice?.delta?.content) {
                yield { type: 'text_delta', text: choice.delta.content };
              }

              if (choice?.delta?.reasoning_content) {
                yield { type: 'thinking_delta', text: choice.delta.reasoning_content };
              }

              if (choice?.delta?.tool_calls) {
                for (const tcDelta of choice.delta.tool_calls) {
                  const idx = tcDelta.index;
                  let tool = streamingTools.get(idx);
                  if (!tool) {
                    tool = { id: '', name: '', arguments: '' };
                    streamingTools.set(idx, tool);
                  }
                  if (tcDelta.id) tool.id = tcDelta.id;
                  if (tcDelta.function?.name) tool.name = tcDelta.function.name;
                  if (tcDelta.function?.arguments) tool.arguments += tcDelta.function.arguments;
                }
              }

              if (parsed.usage) {
                promptTokens = parsed.usage.prompt_tokens || promptTokens;
                completionTokens = parsed.usage.completion_tokens || completionTokens;
              }
            } catch (e) {
              // Parse error on incomplete chunk
            }
          }
        }
      }

      // Emit finished tool calls
      for (const tool of streamingTools.values()) {
        if (tool.id && tool.name) {
          yield {
            type: 'tool_call',
            toolCall: {
              id: tool.id,
              name: tool.name,
              arguments: tool.arguments,
            },
          };
        }
      }

      yield {
        type: 'usage',
        usage: {
          inputTokens: promptTokens,
          outputTokens: completionTokens,
          totalTokens: promptTokens + completionTokens,
        },
      };
      yield { type: 'done' };
    } finally {
      reader.releaseLock();
    }
  }
}
