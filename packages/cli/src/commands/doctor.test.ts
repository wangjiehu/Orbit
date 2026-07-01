import { describe, expect, it } from "vitest";
import { buildDoctorReport } from "./doctor.js";
import type { OrbitConfig } from "@orbit-build/config";

describe("doctor diagnostics", () => {
  it("summarizes capabilities without exposing secret values", () => {
    const config = {
      provider: { default: "deepseek-openai" },
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
        "deepseek-openai": {
          type: "openai-compatible",
          baseUrl: "https://api.deepseek.com",
          apiKeyEnv: "DEEPSEEK_API_KEY",
          apiKey: "secret-deepseek-key",
        },
      },
      permissions: {
        mode: "normal",
        allowRead: true,
        requireApprovalForWrite: true,
        requireApprovalForBash: true,
        blockDangerousCommands: true,
        protectSecrets: true,
        protectedPaths: [],
      },
      context: {
        maxFilesToIndex: 5000,
        maxFileSizeKb: 512,
        ignore: [],
        autoCompact: true,
        compactThreshold: 0.75,
        autoRepair: false,
        testCommands: [],
      },
      tools: {
        bash: { enabled: true, timeoutMs: 120000 },
        webSearch: {
          enabled: true,
          provider: "auto",
          searxngUrls: ["http://localhost:8080"],
          tavilyApiKeyEnv: "TAVILY_API_KEY",
          tavilyBaseUrl: "https://api.tavily.com/search",
          timeoutMs: 8000,
          maxResults: 8,
        },
        mcp: { enabled: false },
      },
      skills: {
        enabled: true,
        directories: [".orbit/skills", ".agents/skills"],
        activation: "auto",
        maxActive: 3,
        maxSkillBytes: 24000,
        maxAutoSkillBytes: 8000,
      },
      mcpServers: {},
      hooks: {},
      pricing: {},
      budgetLimit: 10,
      session: { store: "sqlite", path: ".orbit/sessions.sqlite" },
      autocomplete: {
        enabled: true,
        provider: "ollama",
        model: "qwen2.5-coder:1.5b",
        debounceMs: 150,
      },
      tui: { mouse: true, scrollSpeed: 50 },
      editor: "notepad.exe",
      autoCommit: false,
      language: "en",
      name: "orbit-project",
    } satisfies OrbitConfig;

    const report = buildDoctorReport("D:/repo", config, {
      exec: (command) => {
        if (command === "git --version") return "git version 2.50.0";
        if (command === "rg --version") return "ripgrep 14.1.1\nfeatures";
        if (command === "git status --short") return "";
        return "";
      },
      env: {
        TAVILY_API_KEY: "secret-tavily-key",
      },
    });

    expect(report).toContain("Orbit Diagnostics");
    expect(report).toContain("DeepSeek cache-first profile is active");
    expect(report).toContain("Provider benchmark");
    expect(report).toContain("Realtime lookup enabled");
    expect(report).toContain("Skills:");
    expect(report).not.toContain("secret-deepseek-key");
    expect(report).not.toContain("secret-tavily-key");
  });
});
