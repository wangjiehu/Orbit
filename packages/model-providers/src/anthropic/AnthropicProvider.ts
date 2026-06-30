import { DeepSeekAnthropicProvider } from "../deepseek/DeepSeekAnthropicProvider.js";

import { ModelProvider, ProviderRuntimeOptions } from "../types.js";

export class AnthropicProvider extends DeepSeekAnthropicProvider {
  override id = "anthropic";
  override type: ModelProvider["type"] = "anthropic";

  constructor(
    apiKey?: string,
    baseUrl = "https://api.anthropic.com",
    options: ProviderRuntimeOptions = {},
  ) {
    super(apiKey, baseUrl, {
      apiKeyEnv: "ANTHROPIC_API_KEY",
      ...options,
    });
  }
}
