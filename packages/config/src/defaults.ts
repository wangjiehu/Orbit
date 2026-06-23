import { OrbitConfig } from "./schema.js";

export const DEFAULT_CONFIG: OrbitConfig = {
  name: "orbit-project",
  editor: "notepad.exe",
  autoCommit: false,
  language: "en",
  provider: {
    default: "deepseek-openai",
  },
  models: {
    default: "deepseek-v4-flash",
    fast: "deepseek-v4-flash",
    planner: "deepseek-v4-pro",
    coder: "deepseek-v4-pro",
    reviewer: "deepseek-v4-pro",
    summarizer: "deepseek-v4-flash",
    embedding: "text-embedding-3-small",
  },
  providers: {
    "deepseek-anthropic": {
      type: "anthropic-compatible",
      baseUrl: "https://api.deepseek.com/anthropic",
      apiKeyEnv: "ANTHROPIC_AUTH_TOKEN",
    },
    "deepseek-openai": {
      type: "openai-compatible",
      baseUrl: "https://api.deepseek.com",
      apiKeyEnv: "DEEPSEEK_API_KEY",
    },
    openai: {
      type: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiKeyEnv: "OPENAI_API_KEY",
    },
    anthropic: {
      type: "anthropic",
      baseUrl: "https://api.anthropic.com",
      apiKeyEnv: "ANTHROPIC_API_KEY",
    },
    ollama: {
      type: "ollama",
      baseUrl: "http://localhost:11434",
    },
  },
  permissions: {
    mode: "normal",
    allowRead: true,
    requireApprovalForWrite: true,
    requireApprovalForBash: true,
    blockDangerousCommands: true,
    protectSecrets: true,
    protectedPaths: [
      ".env",
      ".env.*",
      "id_rsa",
      "id_ed25519",
      ".ssh/**",
      "**/*secret*",
      "**/*token*",
      "**/*credential*",
    ],
  },
  context: {
    maxFilesToIndex: 5000,
    maxFileSizeKb: 512,
    ignore: [
      "**/node_modules/**",
      "**/dist/**",
      "**/build/**",
      "**/.git/**",
      "**/coverage/**",
      "**/.next/**",
      "**/.turbo/**",
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
    ],
    autoCompact: true,
    compactThreshold: 0.75,
    autoRepair: false,
    testCommands: [],
  },
  tools: {
    bash: {
      enabled: true,
      timeoutMs: 120000,
    },
    webSearch: {
      enabled: false,
    },
    mcp: {
      enabled: false,
    },
  },
  mcpServers: {},
  hooks: {},
  pricing: {
    "deepseek-v4-flash": {
      inputCostPer1M: 0.14,
      outputCostPer1M: 0.28,
      cacheReadCostPer1M: 0.0028,
    },
    "deepseek-v4-pro": {
      inputCostPer1M: 0.435,
      outputCostPer1M: 0.87,
      cacheReadCostPer1M: 0.003625,
    },
  },
  budgetLimit: 10.0,
  session: {
    store: "sqlite",
    path: ".orbit/sessions.sqlite",
  },
  autocomplete: {
    enabled: true,
    provider: "ollama",
    model: "qwen2.5-coder:1.5b",
    debounceMs: 150,
  },
  tui: {
    mouse: true,
    scrollSpeed: 50,
  },
};
