import { z } from "zod";

export type OrbitRole = "system" | "user" | "assistant" | "tool";

export interface OrbitToolCall {
  id: string;
  name: string;
  arguments: string; // JSON string
}

export interface OrbitToolResult {
  toolCallId: string;
  name: string;
  content: string;
  isError?: boolean;
}

export interface OrbitMessage {
  id: string;
  role: OrbitRole;
  content: OrbitContentBlock[];
  createdAt: string;
  metadata?: Record<string, unknown>;
}

export type OrbitContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_call"; toolCall: OrbitToolCall }
  | { type: "tool_result"; toolResult: OrbitToolResult }
  | { type: "thinking"; text: string; signature?: string };

export interface ModelCapabilities {
  streaming: boolean;
  toolCalls: boolean;
  jsonMode: boolean;
  thinking: boolean;
  vision: boolean;
  promptCaching: boolean;
  maxContextTokens?: number;
  maxOutputTokens?: number;
}

export interface OrbitToolDefinition {
  name: string;
  description: string;
  inputSchema: z.ZodType<any>;
}

export interface ModelChatInput {
  model: string;
  messages: OrbitMessage[];
  system?: string;
  tools?: OrbitToolDefinition[];
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
  thinking?: {
    enabled: boolean;
    budgetTokens?: number;
  };
  responseFormat?: "text" | "json";
  abortSignal?: AbortSignal;
  userId?: string;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens?: number;
}

export type ModelEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string; signature?: string }
  | { type: "tool_call"; toolCall: OrbitToolCall }
  | { type: "usage"; usage: TokenUsage }
  | { type: "done" }
  | { type: "error"; error: any };

export interface ModelProvider {
  id: string;
  type:
    | "openai"
    | "anthropic"
    | "openai-compatible"
    | "anthropic-compatible"
    | "ollama";
  capabilities: ModelCapabilities;
  chat(input: ModelChatInput): AsyncIterable<ModelEvent>;
  countTokens?(input: ModelChatInput): Promise<number>;
  embed?(texts: string[], options?: { model?: string }): Promise<number[][]>;
  complete?(
    prompt: string,
    options?: {
      model?: string;
      maxTokens?: number;
      stop?: string[];
      suffix?: string;
      abortSignal?: AbortSignal;
    },
  ): Promise<string>;
  getModelCapabilities?(model: string): ModelCapabilities;
}
