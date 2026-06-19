import { describe, it, expect } from 'vitest';
import { ConfigLoader } from './ConfigLoader.js';

describe('ConfigLoader tests', () => {
  it('should load default configuration when no local or global files exist', () => {
    const config = ConfigLoader.loadSync(process.cwd());
    expect(config.name).toBe('orbit-project');
    expect(config.provider.default).toBe('deepseek-anthropic');
    expect(config.models.default).toBe('deepseek-v4-pro[1m]');
  });

  it('should apply CLI overrides', () => {
    const config = ConfigLoader.loadSync(process.cwd(), {
      name: 'overridden-name',
      provider: { default: 'openai' },
    });
    expect(config.name).toBe('overridden-name');
    expect(config.provider.default).toBe('openai');
  });

  it('should resolve environment variables key mapping', () => {
    process.env.DEEPSEEK_API_KEY = 'test-deepseek-key';
    const config = ConfigLoader.loadSync(process.cwd());
    expect(config.providers['deepseek-openai']?.apiKey).toBe('test-deepseek-key');
    delete process.env.DEEPSEEK_API_KEY;
  });
});
