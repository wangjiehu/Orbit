import { z } from "zod";

export const ProviderConfigSchema = z.object({
  type: z.enum([
    "openai",
    "anthropic",
    "openai-compatible",
    "anthropic-compatible",
    "ollama",
  ]),
  baseUrl: z.string().optional(),
  apiKeyEnv: z.string().optional(),
  apiKey: z.string().optional(),
  apiKeyHeader: z.string().optional(),
  apiKeyPrefix: z.string().optional(),
  headers: z.record(z.string()).optional(),
  models: z.array(z.string()).optional(),
  requestTimeoutMs: z.number().int().min(1000).max(600000).optional(),
  streamTimeoutMs: z.number().int().min(1000).max(600000).optional(),
  maxRetries: z.number().int().min(0).max(5).optional(),
  disablePreheat: z.boolean().optional(),
  extraBody: z.record(z.unknown()).optional(),
  capabilities: z
    .object({
      streaming: z.boolean().optional(),
      toolCalls: z.boolean().optional(),
      jsonMode: z.boolean().optional(),
      thinking: z.boolean().optional(),
      vision: z.boolean().optional(),
      promptCaching: z.boolean().optional(),
      maxContextTokens: z.number().int().positive().optional(),
      maxOutputTokens: z.number().int().positive().optional(),
    })
    .optional(),
  modelCapabilities: z
    .record(
      z.object({
        streaming: z.boolean().optional(),
        toolCalls: z.boolean().optional(),
        jsonMode: z.boolean().optional(),
        thinking: z.boolean().optional(),
        vision: z.boolean().optional(),
        promptCaching: z.boolean().optional(),
        maxContextTokens: z.number().int().positive().optional(),
        maxOutputTokens: z.number().int().positive().optional(),
      }),
    )
    .optional(),
});

export const McpServerConfigSchema = z.object({
  command: z.string(),
  args: z.array(z.string()).default([]),
  env: z.record(z.string()).optional(),
  tools: z
    .record(
      z.object({
        risk: z
          .enum(["read", "write", "execute", "dangerous", "network"])
          .default("execute"),
      }),
    )
    .default({}),
});

export const ModelPriceSchema = z.object({
  inputCostPer1M: z.number().default(0),
  outputCostPer1M: z.number().default(0),
  cacheReadCostPer1M: z.number().optional(),
});

export const ConfigSchema = z.object({
  name: z.string().default("orbit-project"),
  editor: z.string().default("notepad.exe"),
  autoCommit: z.boolean().default(false),
  language: z.enum(["en", "zh"]).default("en"),
  provider: z
    .object({
      default: z.string().default("deepseek-openai"),
    })
    .default({}),
  models: z
    .object({
      default: z.string().default("deepseek-v4-flash"),
      fast: z.string().default("deepseek-v4-flash"),
      planner: z.string().default("deepseek-v4-pro"),
      coder: z.string().default("deepseek-v4-pro"),
      reviewer: z.string().default("deepseek-v4-pro"),
      summarizer: z.string().default("deepseek-v4-flash"),
      embedding: z.string().default("text-embedding-3-small"),
    })
    .default({}),
  providers: z.record(ProviderConfigSchema).default({}),
  permissions: z
    .object({
      mode: z.enum(["strict", "normal", "auto", "plan"]).default("normal"),
      allowRead: z.boolean().default(true),
      requireApprovalForWrite: z.boolean().default(true),
      requireApprovalForBash: z.boolean().default(true),
      blockDangerousCommands: z.boolean().default(true),
      protectSecrets: z.boolean().default(true),
      protectedPaths: z
        .array(z.string())
        .default([
          ".env",
          ".env.*",
          "id_rsa",
          "id_ed25519",
          ".ssh/**",
          "**/*secret*",
          "**/*token*",
          "**/*credential*",
        ]),
    })
    .default({}),
  context: z
    .object({
      maxFilesToIndex: z.number().default(5000),
      maxFileSizeKb: z.number().default(512),
      ignore: z
        .array(z.string())
        .default([
          "node_modules/**",
          "dist/**",
          "build/**",
          ".git/**",
          "coverage/**",
          ".next/**",
          ".turbo/**",
          "**/AppData/**",
          "**/Local Settings/**",
          "**/Downloads/**",
          "**/Documents/**",
          "**/Pictures/**",
          "**/Music/**",
          "**/Videos/**",
          "**/.npm/**",
          "**/.cargo/**",
          "**/.gradle/**",
          "**/.rustup/**",
          "**/.orbit/**",
        ]),
      autoCompact: z.boolean().default(true),
      compactThreshold: z.number().default(0.75),
      autoRepair: z.boolean().default(false),
      testCommands: z.array(z.string()).default([]),
    })
    .default({}),
  agent: z
    .object({
      maxIterations: z.number().int().min(1).max(50).default(8),
    })
    .default({}),
  autocomplete: z
    .object({
      enabled: z.boolean().default(true),
      provider: z.string().default("ollama"),
      model: z.string().default("qwen2.5-coder:1.5b"),
      debounceMs: z.number().default(150),
      speculative: z
        .object({
          enabled: z.boolean().default(false),
          provider: z.string().default("ollama"),
          model: z.string().default("qwen2.5-coder:0.5b"),
          timeoutMs: z.number().default(150),
        })
        .optional(),
    })
    .default({}),
  tui: z
    .object({
      mouse: z.boolean().default(true),
      scrollSpeed: z.number().int().min(1).max(100).default(50),
    })
    .default({}),
  tools: z
    .object({
      bash: z
        .object({
          enabled: z.boolean().default(true),
          timeoutMs: z.number().default(120000),
        })
        .default({}),
      webSearch: z
        .object({
          enabled: z.boolean().default(true),
          provider: z
            .enum(["auto", "searxng", "tavily", "bing", "duckduckgo"])
            .default("auto"),
          searxngUrls: z.array(z.string()).default([]),
          tavilyApiKeyEnv: z.string().default("TAVILY_API_KEY"),
          tavilyBaseUrl: z.string().default("https://api.tavily.com/search"),
          timeoutMs: z.number().int().min(1000).max(30000).default(8000),
          maxResults: z.number().int().min(1).max(20).default(8),
        })
        .default({}),
      mcp: z
        .object({
          enabled: z.boolean().default(false),
        })
        .default({}),
    })
    .default({}),
  skills: z
    .object({
      enabled: z.boolean().default(true),
      directories: z
        .array(z.string())
        .default([".orbit/skills", ".agents/skills"]),
      activation: z.enum(["explicit", "auto"]).default("auto"),
      maxActive: z.number().int().min(0).max(8).default(3),
      maxSkillBytes: z.number().int().min(512).max(200000).default(24000),
    })
    .default({}),
  mcpServers: z.record(McpServerConfigSchema).default({}),
  hooks: z
    .object({
      preEdit: z.string().optional(),
      postEdit: z.string().optional(),
    })
    .default({}),
  pricing: z.record(ModelPriceSchema).default({}),
  budgetLimit: z.number().default(10.0),
  session: z
    .object({
      store: z.enum(["sqlite", "jsonl"]).default("sqlite"),
      path: z.string().default(".orbit/sessions.sqlite"),
    })
    .default({}),
});

export type OrbitConfig = z.infer<typeof ConfigSchema>;
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;
export type ProviderType = ProviderConfig["type"];
