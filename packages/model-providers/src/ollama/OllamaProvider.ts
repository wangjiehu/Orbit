import { DeepSeekOpenAIProvider } from '../deepseek/DeepSeekOpenAIProvider.js';

export class OllamaProvider extends DeepSeekOpenAIProvider {
  override id = 'ollama';
  override type = 'ollama' as const;

  constructor(baseUrl = 'http://localhost:11434/v1') {
    // Ollama does not require an API key, so we pass a placeholder to pass the base key check
    super('ollama-no-key', baseUrl);
  }
}
