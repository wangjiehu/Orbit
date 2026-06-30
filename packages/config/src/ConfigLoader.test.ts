import { describe, it, expect } from "vitest";
import { ConfigLoader } from "./ConfigLoader.js";

describe("ConfigLoader tests", () => {
  it("should load default configuration when no local or global files exist", () => {
    const config = ConfigLoader.loadSync(process.cwd());
    expect(config.name).toBe("orbit-project");
    expect(config.provider.default).toBe("deepseek-openai");
    expect(config.models.default).toBe("deepseek-v4-flash");
    expect(config.agent.maxIterations).toBe(8);
    expect(config.tools.webSearch.maxResults).toBe(8);
  });

  it("should apply CLI overrides", () => {
    const config = ConfigLoader.loadSync(process.cwd(), {
      name: "overridden-name",
      provider: { default: "openai" },
    });
    expect(config.name).toBe("overridden-name");
    expect(config.provider.default).toBe("openai");
  });

  it("should resolve environment variables key mapping", () => {
    process.env.DEEPSEEK_API_KEY = "test-deepseek-key";
    const config = ConfigLoader.loadSync(process.cwd());
    expect(config.providers["deepseek-openai"]?.apiKey).toBe(
      "test-deepseek-key",
    );
    delete process.env.DEEPSEEK_API_KEY;
  });

  it("should allow language override from environment", () => {
    process.env.ORBIT_LANGUAGE = "zh";

    try {
      const config = ConfigLoader.loadSync(process.cwd());
      expect(config.language).toBe("zh");
    } finally {
      delete process.env.ORBIT_LANGUAGE;
    }
  });

  it("should read default provider gateway env overrides", () => {
    process.env.ORBIT_PROVIDER_MODELS = "vendor/fast, vendor/reasoner";
    process.env.ORBIT_PROVIDER_API_KEY_HEADER = "X-API-Key";
    process.env.ORBIT_PROVIDER_API_KEY_PREFIX = "";
    process.env.ORBIT_PROVIDER_REQUEST_TIMEOUT_MS = "12000";
    process.env.ORBIT_PROVIDER_STREAM_TIMEOUT_MS = "90000";
    process.env.ORBIT_PROVIDER_MAX_RETRIES = "1";

    try {
      const config = ConfigLoader.loadSync(process.cwd());
      const provider = config.providers[config.provider.default];
      expect(provider.models).toEqual(["vendor/fast", "vendor/reasoner"]);
      expect(provider.apiKeyHeader).toBe("X-API-Key");
      expect(provider.apiKeyPrefix).toBe("");
      expect(provider.requestTimeoutMs).toBe(12000);
      expect(provider.streamTimeoutMs).toBe(90000);
      expect(provider.maxRetries).toBe(1);
    } finally {
      delete process.env.ORBIT_PROVIDER_MODELS;
      delete process.env.ORBIT_PROVIDER_API_KEY_HEADER;
      delete process.env.ORBIT_PROVIDER_API_KEY_PREFIX;
      delete process.env.ORBIT_PROVIDER_REQUEST_TIMEOUT_MS;
      delete process.env.ORBIT_PROVIDER_STREAM_TIMEOUT_MS;
      delete process.env.ORBIT_PROVIDER_MAX_RETRIES;
    }
  });

  it("should read skills env overrides", () => {
    process.env.ORBIT_SKILLS_DIRS = ".orbit/skills;C:/skills";
    process.env.ORBIT_SKILLS_ACTIVATION = "explicit";
    process.env.ORBIT_SKILLS_MAX_ACTIVE = "2";
    process.env.ORBIT_SKILLS_MAX_BYTES = "4096";

    try {
      const config = ConfigLoader.loadSync(process.cwd());
      expect(config.skills.directories).toEqual([".orbit/skills", "C:/skills"]);
      expect(config.skills.activation).toBe("explicit");
      expect(config.skills.maxActive).toBe(2);
      expect(config.skills.maxSkillBytes).toBe(4096);
    } finally {
      delete process.env.ORBIT_SKILLS_DIRS;
      delete process.env.ORBIT_SKILLS_ACTIVATION;
      delete process.env.ORBIT_SKILLS_MAX_ACTIVE;
      delete process.env.ORBIT_SKILLS_MAX_BYTES;
    }
  });

  it("should enable web search by default and read search env overrides", () => {
    process.env.ORBIT_WEB_SEARCH_PROVIDER = "searxng";
    process.env.ORBIT_WEB_SEARCH_ENABLED = "true";
    process.env.ORBIT_SEARXNG_URL =
      "https://search.local, https://search2.local";
    process.env.ORBIT_WEB_SEARCH_TIMEOUT_MS = "4000";
    process.env.ORBIT_WEB_SEARCH_MAX_RESULTS = "7";

    try {
      const config = ConfigLoader.loadSync(process.cwd());

      expect(config.tools.webSearch.enabled).toBe(true);
      expect(config.tools.webSearch.provider).toBe("searxng");
      expect(config.tools.webSearch.searxngUrls).toEqual([
        "https://search.local",
        "https://search2.local",
      ]);
      expect(config.tools.webSearch.timeoutMs).toBe(4000);
      expect(config.tools.webSearch.maxResults).toBe(7);
    } finally {
      delete process.env.ORBIT_WEB_SEARCH_PROVIDER;
      delete process.env.ORBIT_WEB_SEARCH_ENABLED;
      delete process.env.ORBIT_SEARXNG_URL;
      delete process.env.ORBIT_WEB_SEARCH_TIMEOUT_MS;
      delete process.env.ORBIT_WEB_SEARCH_MAX_RESULTS;
    }
  });

  it("should read agent loop env overrides", () => {
    process.env.ORBIT_AGENT_MAX_ITERATIONS = "12";

    try {
      const config = ConfigLoader.loadSync(process.cwd());
      expect(config.agent.maxIterations).toBe(12);
    } finally {
      delete process.env.ORBIT_AGENT_MAX_ITERATIONS;
    }
  });
});
