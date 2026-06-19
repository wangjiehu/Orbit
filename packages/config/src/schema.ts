import { z } from 'zod';

export const ProviderConfigSchema = z.object({
  type: z.enum(['openai', 'anthropic', 'openai-compatible', 'anthropic-compatible', 'ollama']),
  baseUrl: z.string().optional(),
  apiKeyEnv: z.string().optional(),
  apiKey: z.string().optional(),
});

export const McpServerConfigSchema = z.object({
  command: z.string(),
  args: z.array(z.string()).default([]),
  env: z.record(z.string()).optional(),
  tools: z.record(z.object({
    risk: z.enum(['read', 'write', 'execute', 'dangerous', 'network']).default('execute'),
  })).default({}),
});

export const ModelPriceSchema = z.object({
  inputCostPer1M: z.number().default(0),
  outputCostPer1M: z.number().default(0),
  cacheReadCostPer1M: z.number().optional(),
});

export const ConfigSchema = z.object({
  name: z.string().default('orbit-project'),
  editor: z.string().default('notepad.exe'),
  autoCommit: z.boolean().default(false),
  provider: z.object({
    default: z.string().default('deepseek-anthropic'),
  }).default({}),
  models: z.object({
    default: z.string().default('deepseek-v4-pro[1m]'),
    fast: z.string().default('deepseek-v4-flash'),
    planner: z.string().default('deepseek-v4-pro[1m]'),
    coder: z.string().default('deepseek-v4-pro[1m]'),
    reviewer: z.string().default('deepseek-v4-pro[1m]'),
    summarizer: z.string().default('deepseek-v4-flash'),
  }).default({}),
  providers: z.record(ProviderConfigSchema).default({}),
  permissions: z.object({
    mode: z.enum(['strict', 'normal', 'auto', 'plan']).default('normal'),
    allowRead: z.boolean().default(true),
    requireApprovalForWrite: z.boolean().default(true),
    requireApprovalForBash: z.boolean().default(true),
    blockDangerousCommands: z.boolean().default(true),
    protectSecrets: z.boolean().default(true),
    protectedPaths: z.array(z.string()).default([
      '.env',
      '.env.*',
      'id_rsa',
      'id_ed25519',
      '.ssh/**',
      '**/*secret*',
      '**/*token*',
      '**/*credential*',
    ]),
  }).default({}),
  context: z.object({
    maxFilesToIndex: z.number().default(5000),
    maxFileSizeKb: z.number().default(512),
    ignore: z.array(z.string()).default([
      'node_modules/**',
      'dist/**',
      'build/**',
      '.git/**',
      'coverage/**',
      '.next/**',
      '.turbo/**',
    ]),
    autoCompact: z.boolean().default(true),
    compactThreshold: z.number().default(0.75),
  }).default({}),
  tools: z.object({
    bash: z.object({
      enabled: z.boolean().default(true),
      timeoutMs: z.number().default(120000),
    }).default({}),
    webSearch: z.object({
      enabled: z.boolean().default(false),
    }).default({}),
    mcp: z.object({
      enabled: z.boolean().default(false),
    }).default({}),
  }).default({}),
  mcpServers: z.record(McpServerConfigSchema).default({}),
  hooks: z.object({
    preEdit: z.string().optional(),
    postEdit: z.string().optional(),
  }).default({}),
  pricing: z.record(ModelPriceSchema).default({}),
  budgetLimit: z.number().default(10.00),
  session: z.object({
    store: z.enum(['sqlite', 'jsonl']).default('sqlite'),
    path: z.string().default('.orbit/sessions.sqlite'),
  }).default({}),
});

export type OrbitConfig = z.infer<typeof ConfigSchema>;
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;
export type ProviderType = ProviderConfig['type'];
