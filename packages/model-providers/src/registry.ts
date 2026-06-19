import { ModelProvider } from './types.js';

export class ProviderRegistry {
  private providers = new Map<string, ModelProvider>();

  register(provider: ModelProvider) {
    this.providers.set(provider.id, provider);
  }

  get(id: string): ModelProvider | undefined {
    return this.providers.get(id);
  }

  list(): ModelProvider[] {
    return Array.from(this.providers.values());
  }
}

export const providerRegistry = new ProviderRegistry();
