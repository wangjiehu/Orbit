import { DeepSeekOpenAIProvider } from '../deepseek/DeepSeekOpenAIProvider.js';

import { ModelProvider } from '../types.js';

export class OpenAIProvider extends DeepSeekOpenAIProvider {
  override id = 'openai';
  override type: ModelProvider['type'] = 'openai';

  constructor(apiKey?: string, baseUrl = 'https://api.openai.com/v1') {
    super(apiKey, baseUrl);
  }
}
