import { DeepSeekAnthropicProvider } from '../deepseek/DeepSeekAnthropicProvider.js';

import { ModelProvider } from '../types.js';

export class AnthropicProvider extends DeepSeekAnthropicProvider {
  override id = 'anthropic';
  override type: ModelProvider['type'] = 'anthropic';

  constructor(apiKey?: string, baseUrl = 'https://api.anthropic.com') {
    super(apiKey, baseUrl);
  }
}
