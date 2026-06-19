import {
  ModelProvider,
  ModelChatInput,
  ModelEvent,
  OrbitMessage,
  OrbitContentBlock,
} from '../types.js';
import { zodToJsonSchema } from '../utils.js';

export class DeepSeekAnthropicProvider implements ModelProvider {
  id = 'deepseek-anthropic';
  type: ModelProvider['type'] = 'anthropic-compatible';
  capabilities = {
    streaming: true,
    toolCalls: true,
    jsonMode: true,
    thinking: true,
    vision: false,
    promptCaching: true,
  };

  constructor(private apiKey?: string, private baseUrl = 'https://api.deepseek.com/anthropic') {}

  async *chat(input: ModelChatInput): AsyncIterable<ModelEvent> {
    const key = this.apiKey || process.env.ANTHROPIC_AUTH_TOKEN;
    if (!key) {
      yield {
        type: 'error',
        error: new Error(
          'API key missing for deepseek-anthropic provider. Please set ANTHROPIC_AUTH_TOKEN.'
        ),
      };
      return;
    }

    // Convert OrbitMessage to Anthropic messages
    const anthropicMessages = input.messages
      .filter((m) => m.role !== 'system')
      .map((m) => {
        const content = m.content.map((block) => {
          if (block.type === 'text') {
            return { type: 'text', text: block.text };
          } else if (block.type === 'tool_call') {
            return {
              type: 'tool_use',
              id: block.toolCall.id,
              name: block.toolCall.name,
              input: JSON.parse(block.toolCall.arguments),
            };
          } else if (block.type === 'tool_result') {
            return {
              type: 'tool_result',
              tool_use_id: block.toolResult.toolCallId,
              content: block.toolResult.content,
              is_error: block.toolResult.isError,
            };
          } else if (block.type === 'thinking') {
            return { type: 'text', text: block.text };
          }
          return { type: 'text', text: '' };
        });
        return {
          role: m.role === 'tool' ? 'user' : m.role,
          content,
        };
      });

    // Extract system prompt
    const systemPrompt =
      input.system ||
      input.messages
        .find((m) => m.role === 'system')
        ?.content.filter((b) => b.type === 'text')
        .map((b) => (b.type === 'text' ? b.text : ''))
        .join('\n');

    // Build Anthropic tools definition
    const tools = input.tools?.map((t) => {
      return {
        name: t.name,
        description: t.description,
        input_schema: zodToJsonSchema(t.inputSchema),
      };
    });

    const body: any = {
      model: input.model,
      messages: anthropicMessages,
      max_tokens: input.maxTokens || 4000,
      system: systemPrompt,
      stream: input.stream !== false,
    };

    if (tools && tools.length > 0) {
      body.tools = tools;
    }

    if (input.thinking?.enabled) {
      body.thinking = {
        type: 'enabled',
        budget_tokens: input.thinking.budgetTokens || 1024,
      };
    }

    const response = await fetch(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
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
      for (const block of data.content) {
        if (block.type === 'text') {
          yield { type: 'text_delta', text: block.text };
        } else if (block.type === 'tool_use') {
          yield {
            type: 'tool_call',
            toolCall: {
              id: block.id,
              name: block.name,
              arguments: JSON.stringify(block.input),
            },
          };
        }
      }
      yield {
        type: 'usage',
        usage: {
          inputTokens: data.usage?.input_tokens || 0,
          outputTokens: data.usage?.output_tokens || 0,
          totalTokens: (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0),
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
    let inputTokens = 0;
    let outputTokens = 0;

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

              if (parsed.type === 'message_start') {
                if (parsed.message?.usage) {
                  inputTokens = parsed.message.usage.input_tokens || 0;
                  outputTokens = parsed.message.usage.output_tokens || 0;
                }
              } else if (parsed.type === 'content_block_start') {
                const idx = parsed.index;
                const block = parsed.content_block;
                if (block.type === 'tool_use') {
                  streamingTools.set(idx, {
                    id: block.id,
                    name: block.name,
                    arguments: '',
                  });
                }
              } else if (parsed.type === 'content_block_delta') {
                const idx = parsed.index;
                const delta = parsed.delta;
                if (delta.type === 'text_delta') {
                  yield { type: 'text_delta', text: delta.text };
                } else if (delta.type === 'input_json_delta') {
                  const tool = streamingTools.get(idx);
                  if (tool) {
                    tool.arguments += delta.partial_json;
                  }
                }
              } else if (parsed.type === 'content_block_stop') {
                const idx = parsed.index;
                const tool = streamingTools.get(idx);
                if (tool) {
                  yield {
                    type: 'tool_call',
                    toolCall: {
                      id: tool.id,
                      name: tool.name,
                      arguments: tool.arguments,
                    },
                  };
                  streamingTools.delete(idx);
                }
              } else if (parsed.type === 'message_delta') {
                if (parsed.usage) {
                  outputTokens = parsed.usage.output_tokens || outputTokens;
                }
              }
            } catch (e) {
              // Parse error on incomplete chunk
            }
          }
        }
      }

      yield {
        type: 'usage',
        usage: {
          inputTokens,
          outputTokens,
          totalTokens: inputTokens + outputTokens,
        },
      };
      yield { type: 'done' };
    } finally {
      reader.releaseLock();
    }
  }
}
