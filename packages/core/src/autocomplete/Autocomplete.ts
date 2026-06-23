import {
  OpenAIProvider,
  DeepSeekOpenAIProvider,
  OllamaProvider,
} from "@orbit-build/model-providers";

function getAutocompleteProvider(providerId: string, config: any) {
  const providerConfig = config.providers?.[providerId];
  if (!providerConfig) {
    if (providerId === "ollama") {
      return new OllamaProvider();
    }
    return new DeepSeekOpenAIProvider(
      process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY || "no-key",
    );
  }

  const apiKey =
    providerConfig.apiKey ||
    (providerConfig.apiKeyEnv
      ? process.env[providerConfig.apiKeyEnv]
      : undefined);
  const baseUrl = providerConfig.baseUrl;

  switch (providerConfig.type) {
    case "openai":
      return new OpenAIProvider(apiKey, baseUrl);
    case "ollama":
      return new OllamaProvider(baseUrl);
    case "openai-compatible":
    case "anthropic-compatible":
    default:
      return new DeepSeekOpenAIProvider(apiKey, baseUrl);
  }
}

function safeDecodeURI(uri: string): string {
  try {
    return decodeURIComponent(uri);
  } catch {
    return uri;
  }
}

function getPathCommentHeader(windowId: string, cwd: string): string {
  if (!windowId || windowId === "default") {
    return "";
  }

  let filePath = windowId;
  if (filePath.startsWith("file:///")) {
    const afterScheme = safeDecodeURI(filePath.substring(8));
    if (/^[a-zA-Z]:/.test(afterScheme)) {
      filePath = afterScheme;
    } else {
      filePath = safeDecodeURI(filePath.substring(7));
    }
  } else if (filePath.startsWith("file://")) {
    filePath = safeDecodeURI(filePath.substring(7));
  }

  filePath = filePath.replace(/\\/g, "/");
  const normalizedCwd = cwd.replace(/\\/g, "/");

  let displayPath = filePath;
  if (filePath.toLowerCase().startsWith(normalizedCwd.toLowerCase() + "/")) {
    displayPath = filePath.substring(normalizedCwd.length + 1);
  } else {
    const parts = filePath.split("/");
    displayPath = parts.slice(-2).join("/");
  }

  const ext = displayPath.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "py":
    case "yaml":
    case "yml":
    case "sh":
    case "rb":
    case "pl":
      return `# Path: ${displayPath}\n`;
    case "html":
    case "xml":
    case "vue":
      return `<!-- Path: ${displayPath} -->\n`;
    case "css":
    case "scss":
    case "less":
      return `/* Path: ${displayPath} */\n`;
    default:
      return `// Path: ${displayPath}\n`;
  }
}

export class AutocompleteEngine {
  private activeRequests = new Map<string, AbortController>();
  private debounceTimers = new Map<string, NodeJS.Timeout>();
  private debounceResolvers = new Map<string, (val: string) => void>();
  private providerCache = new Map<string, any>();

  constructor(private cwd: string = process.cwd()) {}

  private getCachedProvider(providerId: string, config: any) {
    const providerConfig = config.providers?.[providerId];
    const key = JSON.stringify({
      providerId,
      apiKey: providerConfig?.apiKey || (providerConfig?.apiKeyEnv ? process.env[providerConfig.apiKeyEnv] : undefined),
      baseUrl: providerConfig?.baseUrl,
      type: providerConfig?.type
    });
    if (!this.providerCache.has(key)) {
      this.providerCache.set(key, getAutocompleteProvider(providerId, config));
    }
    return this.providerCache.get(key);
  }

  /**
   * Generates local FIM code autocomplete suggestions.
   */
  public async autocomplete(
    prefix: string,
    suffix: string,
    config: any,
    windowId = "default",
  ): Promise<string> {
    if (!config.autocomplete?.enabled) {
      return "";
    }

    // Debounce: Cancel previous autocomplete timer and resolve its promise
    const prevTimer = this.debounceTimers.get(windowId);
    if (prevTimer) {
      clearTimeout(prevTimer);
    }
    const prevResolve = this.debounceResolvers.get(windowId);
    if (prevResolve) {
      prevResolve("");
      this.debounceResolvers.delete(windowId);
    }

    // Cancel previous autocomplete request for this specific window if it is still running
    const active = this.activeRequests.get(windowId);
    if (active) {
      active.abort();
    }

    const controller = new AbortController();
    this.activeRequests.set(windowId, controller);
    const signal = controller.signal;

    const debounceMs = config.autocomplete?.debounceMs !== undefined ? config.autocomplete.debounceMs : 150;

    return new Promise<string>((resolve) => {
      this.debounceResolvers.set(windowId, resolve);

      const timer = setTimeout(async () => {
        this.debounceResolvers.delete(windowId);
        if (signal.aborted) {
          resolve("");
          return;
        }

        const providerId = config.autocomplete.provider || "ollama";
        const modelName = config.autocomplete.model || "qwen2.5-coder:1.5b";

        try {
          const provider = this.getCachedProvider(providerId, config);
          if (typeof provider.complete !== "function") {
            resolve("");
            return;
          }

          // Prepend path comment header to prefix for FIM context enhancement
          const header = getPathCommentHeader(windowId, this.cwd);
          const enhancedPrefix = header ? header + prefix : prefix;

          // Detect if this is the official DeepSeek API
          const isOfficialDeepSeek = providerId === "deepseek-openai" || (config.providers?.[providerId]?.baseUrl || "").includes("api.deepseek.com");

          // Detect and format FIM Prompt template based on the model name
          let fimPrompt = "";
          let stopWords: string[] = [];

          const lowercaseModel = modelName.toLowerCase();
          if (lowercaseModel.includes("deepseek")) {
            fimPrompt = `<｜fim begin｜>${enhancedPrefix}<｜fim hole｜>${suffix}<｜fim end｜>`;
            stopWords = [
              "<｜fim begin｜>",
              "<｜fim hole｜>",
              "<｜fim end｜>",
              "\n\n",
            ];
          } else if (lowercaseModel.includes("qwen")) {
            fimPrompt = `<|fim_prefix|>${enhancedPrefix}<|fim_suffix|>${suffix}<|fim_middle|>`;
            stopWords = [
              "<|fim_prefix|>",
              "<|fim_suffix|>",
              "<|fim_middle|>",
              "<|fim_pad|>",
              "<file_sep>",
              "\n\n",
            ];
          } else {
            fimPrompt = `<fim_prefix>${enhancedPrefix}<fim_suffix>${suffix}<fim_middle>`;
            stopWords = [
              "<fim_prefix>",
              "<fim_suffix>",
              "<fim_middle>",
              "<fim_pad>",
              "<file_sep>",
              "\n\n",
            ];
          }

          let localPromise: Promise<string> = Promise.resolve("");
          let cloudPromise: Promise<string> = Promise.resolve("");

          const speculativeEnabled = config.autocomplete.speculative?.enabled === true;
          if (speculativeEnabled) {
            const specProviderId = config.autocomplete.speculative.provider || "ollama";
            const specModelName = config.autocomplete.speculative.model || "qwen2.5-coder:0.5b";
            const isSpecOfficialDeepSeek = specProviderId === "deepseek-openai" || (config.providers?.[specProviderId]?.baseUrl || "").includes("api.deepseek.com");
            try {
              const specProvider = this.getCachedProvider(specProviderId, config);
              if (typeof specProvider.complete === "function") {
                if (isSpecOfficialDeepSeek) {
                  localPromise = specProvider.complete(enhancedPrefix, {
                    model: specModelName,
                    maxTokens: 32,
                    stop: stopWords,
                    suffix: suffix,
                    abortSignal: signal,
                  }).catch(() => "");
                } else {
                  localPromise = specProvider.complete(fimPrompt, {
                    model: specModelName,
                    maxTokens: 32,
                    stop: stopWords,
                    abortSignal: signal,
                  }).catch(() => "");
                }
              }
            } catch {
              // Ignore spec provider init issues
            }
          }

          if (isOfficialDeepSeek) {
            cloudPromise = provider.complete(enhancedPrefix, {
              model: modelName,
              maxTokens: 64,
              stop: stopWords,
              suffix: suffix,
              abortSignal: signal,
            });
          } else {
            cloudPromise = provider.complete(fimPrompt, {
              model: modelName,
              maxTokens: 64,
              stop: stopWords,
              abortSignal: signal,
            });
          }

          if (speculativeEnabled) {
            const specTimeout = config.autocomplete.speculative.timeoutMs !== undefined
              ? config.autocomplete.speculative.timeoutMs
              : 150;
            const timeoutPromise = new Promise<string>((r) => setTimeout(() => r("__TIMEOUT__"), specTimeout));
            const winner = await Promise.race([
              cloudPromise.catch(() => ""),
              timeoutPromise,
            ]);

            if (winner !== "__TIMEOUT__" && winner.trim() !== "") {
              resolve(winner);
            } else {
              const localResult = await localPromise;
              if (localResult.trim() !== "") {
                resolve(localResult);
              } else {
                resolve(await cloudPromise.catch(() => ""));
              }
            }
          } else {
            const completed = await cloudPromise;
            resolve(completed);
          }
        } catch (e: any) {
          resolve("");
        } finally {
          if (this.activeRequests.get(windowId) === controller) {
            this.activeRequests.delete(windowId);
          }
        }
      }, debounceMs);

      this.debounceTimers.set(windowId, timer);
    });
  }
}
