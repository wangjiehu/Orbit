import { homedir } from 'os';
import { join, dirname } from 'path';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { parse } from 'yaml';
import { ConfigSchema, OrbitConfig } from './schema.js';
import { DEFAULT_CONFIG } from './defaults.js';
import { CredentialsManager } from './Credentials.js';

export class ConfigLoader {
  private static merge(target: any, source: any): any {
    if (!source) return target;
    const result = { ...target };
    for (const key of Object.keys(source)) {
      if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
        result[key] = this.merge(result[key] || {}, source[key]);
      } else if (source[key] !== undefined) {
        result[key] = source[key];
      }
    }
    return result;
  }

  public static loadSync(cwd: string, cliOverrides?: Partial<OrbitConfig>): OrbitConfig {
    let config = { ...DEFAULT_CONFIG };

    // 1. Load User Global Config (~/.orbit/config.yaml)
    const globalConfigPath = join(homedir(), '.orbit', 'config.yaml');
    if (existsSync(globalConfigPath)) {
      try {
        const raw = readFileSync(globalConfigPath, 'utf8');
        const parsed = parse(raw);
        config = this.merge(config, parsed);
      } catch (e) {
        console.warn(`Warning: Failed to load global config at ${globalConfigPath}:`, e);
      }
    }

    // 2. Load Project Config (cwd/orbit.config.yaml)
    const projectConfigPath = join(cwd, 'orbit.config.yaml');
    if (existsSync(projectConfigPath)) {
      try {
        const raw = readFileSync(projectConfigPath, 'utf8');
        const parsed = parse(raw);
        config = this.merge(config, parsed);
      } catch (e) {
        console.warn(`Warning: Failed to load project config at ${projectConfigPath}:`, e);
      }
    }

    // 3. Apply Environment Variable overrides
    config = this.applyEnvOverrides(config);

    // Load external pricing directory if it exists (~/.orbit/pricing.json)
    const pricingPath = join(homedir(), '.orbit', 'pricing.json');
    if (existsSync(pricingPath)) {
      try {
        const raw = readFileSync(pricingPath, 'utf8');
        const parsed = JSON.parse(raw);
        config.pricing = { ...config.pricing, ...parsed };
      } catch (e) {
        console.warn(`Warning: Failed to load pricing config at ${pricingPath}:`, e);
      }
    } else {
      try {
        const dir = dirname(pricingPath);
        if (!existsSync(dir)) {
          mkdirSync(dir, { recursive: true });
        }
        writeFileSync(pricingPath, JSON.stringify(config.pricing, null, 2), 'utf8');
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
      throw new Error(`Configuration validation failed: ${validated.error.message}`);
    }

    // 6. Dynamically resolve apiKey using apiKeyEnv if apiKey not directly set
    const finalConfig = validated.data;
    const credsManager = new CredentialsManager();
    for (const key of Object.keys(finalConfig.providers)) {
      const provider = finalConfig.providers[key];
      if (!provider.apiKey && provider.apiKeyEnv) {
        let keyVal = process.env[provider.apiKeyEnv];
        if (!keyVal) {
          keyVal = credsManager.getSecret(provider.apiKeyEnv) || undefined;
        }
        provider.apiKey = keyVal;
      }
    }

    return finalConfig;
  }

  private static applyEnvOverrides(config: OrbitConfig): OrbitConfig {
    const nextConfig = { ...config };

    if (process.env.DEEPSEEK_BASE_URL) {
      if (nextConfig.providers['deepseek-openai']) {
        nextConfig.providers['deepseek-openai'].baseUrl = process.env.DEEPSEEK_BASE_URL;
      }
    }
    if (process.env.DEEPSEEK_API_KEY) {
      if (nextConfig.providers['deepseek-openai']) {
        nextConfig.providers['deepseek-openai'].apiKey = process.env.DEEPSEEK_API_KEY;
      }
    }

    if (process.env.ANTHROPIC_BASE_URL) {
      if (nextConfig.providers['deepseek-anthropic']) {
        nextConfig.providers['deepseek-anthropic'].baseUrl = process.env.ANTHROPIC_BASE_URL;
      }
      if (nextConfig.providers['anthropic']) {
        nextConfig.providers['anthropic'].baseUrl = process.env.ANTHROPIC_BASE_URL;
      }
    }
    if (process.env.ANTHROPIC_AUTH_TOKEN) {
      if (nextConfig.providers['deepseek-anthropic']) {
        nextConfig.providers['deepseek-anthropic'].apiKey = process.env.ANTHROPIC_AUTH_TOKEN;
      }
    }
    if (process.env.ANTHROPIC_API_KEY) {
      if (nextConfig.providers['anthropic']) {
        nextConfig.providers['anthropic'].apiKey = process.env.ANTHROPIC_API_KEY;
      }
    }

    if (process.env.OPENAI_BASE_URL) {
      if (nextConfig.providers['openai']) {
        nextConfig.providers['openai'].baseUrl = process.env.OPENAI_BASE_URL;
      }
    }
    if (process.env.OPENAI_API_KEY) {
      if (nextConfig.providers['openai']) {
        nextConfig.providers['openai'].apiKey = process.env.OPENAI_API_KEY;
      }
    }

    if (process.env.OLLAMA_BASE_URL) {
      if (nextConfig.providers['ollama']) {
        nextConfig.providers['ollama'].baseUrl = process.env.OLLAMA_BASE_URL;
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

    return nextConfig;
  }
}
