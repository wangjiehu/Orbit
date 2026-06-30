import { homedir } from "os";
import { join, dirname } from "path";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { parse } from "yaml";
import { ConfigSchema, OrbitConfig } from "./schema.js";
import { DEFAULT_CONFIG } from "./defaults.js";
import { CredentialsManager } from "./Credentials.js";

export class ConfigLoader {
  private static merge(target: any, source: any): any {
    if (!source) return target;
    const result = { ...target };
    for (const key of Object.keys(source)) {
      if (
        source[key] &&
        typeof source[key] === "object" &&
        !Array.isArray(source[key])
      ) {
        result[key] = this.merge(result[key] || {}, source[key]);
      } else if (source[key] !== undefined) {
        result[key] = source[key];
      }
    }
    return result;
  }

  public static loadSync(
    cwd: string,
    cliOverrides?: Partial<OrbitConfig>,
  ): OrbitConfig {
    let config = JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as OrbitConfig;

    // 1. Load User Global Config (~/.orbit/config.yaml)
    const globalConfigPath = join(homedir(), ".orbit", "config.yaml");
    if (existsSync(globalConfigPath)) {
      try {
        const raw = readFileSync(globalConfigPath, "utf8");
        const parsed = parse(raw);
        config = this.merge(config, parsed);
      } catch (e) {
        console.warn(
          `Warning: Failed to load global config at ${globalConfigPath}:`,
          e,
        );
      }
    }

    // 2. Load Project Config (cwd/orbit.config.yaml)
    const projectConfigPath = join(cwd, "orbit.config.yaml");
    if (existsSync(projectConfigPath)) {
      try {
        const raw = readFileSync(projectConfigPath, "utf8");
        const parsed = parse(raw);
        config = this.merge(config, parsed);
      } catch (e) {
        console.warn(
          `Warning: Failed to load project config at ${projectConfigPath}:`,
          e,
        );
      }
    }

    // 3. Apply Environment Variable overrides
    config = this.applyEnvOverrides(config);

    // Load external pricing directory if it exists (~/.orbit/pricing.json)
    const pricingPath = join(homedir(), ".orbit", "pricing.json");
    if (existsSync(pricingPath)) {
      try {
        const raw = readFileSync(pricingPath, "utf8");
        const parsed = JSON.parse(raw);
        config.pricing = { ...config.pricing, ...parsed };
      } catch (e) {
        console.warn(
          `Warning: Failed to load pricing config at ${pricingPath}:`,
          e,
        );
      }
    } else {
      try {
        const dir = dirname(pricingPath);
        if (!existsSync(dir)) {
          mkdirSync(dir, { recursive: true });
        }
        writeFileSync(
          pricingPath,
          JSON.stringify(config.pricing, null, 2),
          "utf8",
        );
      } catch {
        // Ignore
      }
    }

    // 4. Apply CLI overrides
    if (cliOverrides) {
      config = this.merge(config, cliOverrides);
    }

    // 5. Validate with Zod
    const validated = ConfigSchema.safeParse(config);
    if (!validated.success) {
      throw new Error(
        `Configuration validation failed: ${validated.error.message}`,
      );
    }

    // 6. Dynamically resolve apiKey using apiKeyEnv if apiKey not directly set
    const finalConfig = validated.data;
    const credsManager = new CredentialsManager();
    for (const key of Object.keys(finalConfig.providers)) {
      const provider = finalConfig.providers[key];
      if (!provider.apiKey && provider.apiKeyEnv) {
        let cachedKey: string | undefined = undefined;
        let resolved = false;
        Object.defineProperty(provider, "apiKey", {
          get() {
            if (resolved) return cachedKey;
            let keyVal = process.env[provider.apiKeyEnv!];
            if (!keyVal) {
              keyVal = credsManager.getSecret(provider.apiKeyEnv!) || undefined;
            }
            cachedKey = keyVal;
            resolved = true;
            return cachedKey;
          },
          set(val) {
            cachedKey = val;
            resolved = true;
          },
          configurable: true,
          enumerable: true,
        });
      }
    }

    return finalConfig;
  }

  private static applyEnvOverrides(config: OrbitConfig): OrbitConfig {
    const nextConfig = { ...config };

    const language = process.env.ORBIT_LANGUAGE || process.env.ORBIT_LANG;
    if (language === "en" || language === "zh") {
      nextConfig.language = language;
    }

    if (process.env.DEEPSEEK_BASE_URL) {
      if (nextConfig.providers["deepseek-openai"]) {
        nextConfig.providers["deepseek-openai"].baseUrl =
          process.env.DEEPSEEK_BASE_URL;
      }
    }
    if (process.env.DEEPSEEK_API_KEY) {
      if (nextConfig.providers["deepseek-openai"]) {
        nextConfig.providers["deepseek-openai"].apiKey =
          process.env.DEEPSEEK_API_KEY;
      }
    }

    if (process.env.ANTHROPIC_BASE_URL) {
      if (nextConfig.providers["deepseek-anthropic"]) {
        nextConfig.providers["deepseek-anthropic"].baseUrl =
          process.env.ANTHROPIC_BASE_URL;
      }
      if (nextConfig.providers["anthropic"]) {
        nextConfig.providers["anthropic"].baseUrl =
          process.env.ANTHROPIC_BASE_URL;
      }
    }
    if (process.env.ANTHROPIC_AUTH_TOKEN) {
      if (nextConfig.providers["deepseek-anthropic"]) {
        nextConfig.providers["deepseek-anthropic"].apiKey =
          process.env.ANTHROPIC_AUTH_TOKEN;
      }
    }
    if (process.env.ANTHROPIC_API_KEY) {
      if (nextConfig.providers["anthropic"]) {
        nextConfig.providers["anthropic"].apiKey =
          process.env.ANTHROPIC_API_KEY;
      }
    }

    if (process.env.OPENAI_BASE_URL) {
      if (nextConfig.providers["openai"]) {
        nextConfig.providers["openai"].baseUrl = process.env.OPENAI_BASE_URL;
      }
    }
    if (process.env.OPENAI_API_KEY) {
      if (nextConfig.providers["openai"]) {
        nextConfig.providers["openai"].apiKey = process.env.OPENAI_API_KEY;
      }
    }

    if (process.env.OLLAMA_BASE_URL) {
      if (nextConfig.providers["ollama"]) {
        nextConfig.providers["ollama"].baseUrl = process.env.OLLAMA_BASE_URL;
      }
    }

    if (process.env.DEEPSEEK_MODEL) {
      nextConfig.models.default = process.env.DEEPSEEK_MODEL;
    }
    if (process.env.ANTHROPIC_MODEL) {
      nextConfig.models.default = process.env.ANTHROPIC_MODEL;
    }
    if (process.env.OPENAI_MODEL) {
      nextConfig.models.default = process.env.OPENAI_MODEL;
    }
    if (process.env.OLLAMA_MODEL) {
      nextConfig.models.default = process.env.OLLAMA_MODEL;
    }

    const defaultProviderConfig =
      nextConfig.providers?.[nextConfig.provider?.default || ""];
    if (defaultProviderConfig) {
      if (process.env.ORBIT_PROVIDER_MODELS) {
        defaultProviderConfig.models = process.env.ORBIT_PROVIDER_MODELS.split(
          ",",
        )
          .map((model) => model.trim())
          .filter(Boolean);
      }
      if (process.env.ORBIT_PROVIDER_API_KEY_HEADER) {
        defaultProviderConfig.apiKeyHeader =
          process.env.ORBIT_PROVIDER_API_KEY_HEADER;
      }
      if (process.env.ORBIT_PROVIDER_API_KEY_PREFIX !== undefined) {
        defaultProviderConfig.apiKeyPrefix =
          process.env.ORBIT_PROVIDER_API_KEY_PREFIX;
      }
      const requestTimeoutMs = Number(
        process.env.ORBIT_PROVIDER_REQUEST_TIMEOUT_MS,
      );
      if (Number.isFinite(requestTimeoutMs) && requestTimeoutMs > 0) {
        defaultProviderConfig.requestTimeoutMs = requestTimeoutMs;
      }
      const streamTimeoutMs = Number(
        process.env.ORBIT_PROVIDER_STREAM_TIMEOUT_MS,
      );
      if (Number.isFinite(streamTimeoutMs) && streamTimeoutMs > 0) {
        defaultProviderConfig.streamTimeoutMs = streamTimeoutMs;
      }
      const maxRetries = Number(process.env.ORBIT_PROVIDER_MAX_RETRIES);
      if (Number.isFinite(maxRetries) && maxRetries >= 0) {
        defaultProviderConfig.maxRetries = maxRetries;
      }
    }

    const maxIterations = Number(
      process.env.ORBIT_AGENT_MAX_ITERATIONS ||
        process.env.ORBIT_MAX_ITERATIONS,
    );
    if (Number.isFinite(maxIterations) && maxIterations > 0) {
      nextConfig.agent = {
        ...(nextConfig.agent || {}),
        maxIterations,
      };
    }

    const webSearch = nextConfig.tools?.webSearch;
    if (webSearch) {
      if (process.env.ORBIT_WEB_SEARCH_ENABLED) {
        webSearch.enabled =
          process.env.ORBIT_WEB_SEARCH_ENABLED.toLowerCase() !== "false" &&
          process.env.ORBIT_WEB_SEARCH_ENABLED !== "0";
      }
      const provider = process.env.ORBIT_WEB_SEARCH_PROVIDER;
      if (
        provider === "auto" ||
        provider === "searxng" ||
        provider === "tavily" ||
        provider === "bing" ||
        provider === "duckduckgo"
      ) {
        webSearch.provider = provider;
      }
      const searxngUrls =
        process.env.ORBIT_SEARXNG_URL || process.env.SEARXNG_URL;
      if (searxngUrls) {
        webSearch.searxngUrls = searxngUrls
          .split(",")
          .map((url) => url.trim())
          .filter(Boolean);
      }
      if (process.env.ORBIT_TAVILY_API_URL) {
        webSearch.tavilyBaseUrl = process.env.ORBIT_TAVILY_API_URL;
      }
      const timeoutMs = Number(process.env.ORBIT_WEB_SEARCH_TIMEOUT_MS);
      if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
        webSearch.timeoutMs = timeoutMs;
      }
      const maxResults = Number(process.env.ORBIT_WEB_SEARCH_MAX_RESULTS);
      if (Number.isFinite(maxResults) && maxResults > 0) {
        webSearch.maxResults = maxResults;
      }
    }

    if (nextConfig.skills) {
      if (process.env.ORBIT_SKILLS_ENABLED) {
        nextConfig.skills.enabled =
          process.env.ORBIT_SKILLS_ENABLED.toLowerCase() !== "false" &&
          process.env.ORBIT_SKILLS_ENABLED !== "0";
      }
      if (process.env.ORBIT_SKILLS_DIRS || process.env.ORBIT_SKILLS_DIR) {
        const raw =
          process.env.ORBIT_SKILLS_DIRS || process.env.ORBIT_SKILLS_DIR || "";
        nextConfig.skills.directories = raw
          .split(/[;,]/)
          .map((dir) => dir.trim())
          .filter(Boolean);
      }
      if (
        process.env.ORBIT_SKILLS_ACTIVATION === "explicit" ||
        process.env.ORBIT_SKILLS_ACTIVATION === "auto"
      ) {
        nextConfig.skills.activation = process.env.ORBIT_SKILLS_ACTIVATION;
      }
      const maxActive = Number(process.env.ORBIT_SKILLS_MAX_ACTIVE);
      if (Number.isFinite(maxActive) && maxActive >= 0) {
        nextConfig.skills.maxActive = maxActive;
      }
      const maxSkillBytes = Number(process.env.ORBIT_SKILLS_MAX_BYTES);
      if (Number.isFinite(maxSkillBytes) && maxSkillBytes > 0) {
        nextConfig.skills.maxSkillBytes = maxSkillBytes;
      }
    }

    return nextConfig;
  }
}
