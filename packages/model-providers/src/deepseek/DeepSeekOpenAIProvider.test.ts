import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DeepSeekOpenAIProvider } from "./DeepSeekOpenAIProvider.js";

describe("DeepSeekOpenAIProvider messages mapping", () => {
  let originalFetch: any;

  beforeEach(() => {
    originalFetch = global.fetch;
    global.fetch = vi.fn().mockImplementation(() =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            choices: [{ message: { content: "ok" } }],
            usage: {
              prompt_tokens: 10,
              completion_tokens: 5,
              total_tokens: 15,
            },
          }),
      }),
    ) as any;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("should always provide the content field for all message roles", async () => {
    const provider = new DeepSeekOpenAIProvider("test-key");

    const input = {
      model: "deepseek-v4-flash",
      messages: [
        {
          role: "user" as const,
          content: [{ type: "text" as const, text: "hi" }],
        },
        {
          role: "assistant" as const,
          content: [
            {
              type: "tool_call" as const,
              toolCall: {
                id: "call-1",
                name: "test_tool",
                arguments: "{}",
              },
            },
          ],
        },
        {
          role: "tool" as const,
          content: [
            {
              type: "tool_result" as const,
              toolResult: {
                toolCallId: "call-1",
                content: "tool output text",
                isError: false,
              },
            },
          ],
        },
      ],
      stream: false,
    };

    const events = [];
    for await (const event of provider.chat(input)) {
      events.push(event);
    }

    expect(global.fetch).toHaveBeenCalled();
    const postCall = (global.fetch as any).mock.calls.find(
      (call: any) => call[1]?.method === "POST",
    );
    expect(postCall).toBeDefined();
    const requestBody = JSON.parse(postCall[1].body);

    const messages = requestBody.messages;
    expect(messages.length).toBe(3);

    // Verify message 0 (user)
    expect(messages[0].role).toBe("user");
    expect(messages[0].content).toBe("hi");

    // Verify message 1 (assistant with tool calls)
    expect(messages[1].role).toBe("assistant");
    expect(messages[1].content).toBeNull();
    expect(messages[1].tool_calls).toBeDefined();

    // Verify message 2 (tool result)
    expect(messages[2].role).toBe("tool");
    expect(messages[2].content).toBe("tool output text");
    expect(messages[2].tool_call_id).toBe("call-1");
  });

  it("should prevent double /v1/v1 in endpoint URLs when base URL ends with /v1", async () => {
    // Instantiate provider with OpenAI base URL (ending in /v1)
    const provider = new DeepSeekOpenAIProvider(
      "test-key",
      "https://api.openai.com/v1",
    );

    const input = {
      model: "gpt-4o",
      messages: [
        {
          role: "user" as const,
          content: [{ type: "text" as const, text: "hi" }],
        },
      ],
      stream: false,
    };

    for await (const event of provider.chat(input)) {
      void event;
    }

    expect(global.fetch).toHaveBeenCalled();
    const postCall = (global.fetch as any).mock.calls.find(
      (call: any) => call[1]?.method === "POST",
    );
    expect(postCall).toBeDefined();
    // Verify that /v1/chat/completions is appended correctly without double /v1
    expect(postCall[0]).toBe("https://api.openai.com/v1/chat/completions");
  });

  it("should route to beta/v1/completions for official DeepSeek FIM completions", async () => {
    const provider = new DeepSeekOpenAIProvider(
      "test-key",
      "https://api.deepseek.com",
    );

    global.fetch = vi.fn().mockImplementation(() =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            choices: [{ text: "completed_code" }],
          }),
      }),
    ) as any;

    const result = await provider.complete("prefix_code", {
      suffix: "suffix_code",
      model: "deepseek-v4-flash",
    });

    expect(result).toBe("completed_code");
    expect(global.fetch).toHaveBeenCalled();
    const completionsCall = (global.fetch as any).mock.calls.find((call: any) =>
      call[0].includes("/completions"),
    );
    expect(completionsCall).toBeDefined();
    // URL should be rewritten to beta endpoint
    expect(completionsCall[0]).toBe(
      "https://api.deepseek.com/beta/v1/completions",
    );

    // Request body should contain suffix
    const body = JSON.parse(completionsCall[1].body);
    expect(body.prompt).toBe("prefix_code");
    expect(body.suffix).toBe("suffix_code");
    expect(body.model).toBe("deepseek-v4-flash");
  });

  it("should support custom auth headers and model capability overrides for compatible gateways", async () => {
    const provider = new DeepSeekOpenAIProvider(
      undefined,
      "https://gateway.example.com/v1",
      {
        id: "ciyuan",
        apiKeyEnv: "CIYUAN_API_KEY",
        apiKeyHeader: "X-API-Key",
        apiKeyPrefix: "",
        headers: { "X-Gateway": "orbit" },
        disablePreheat: true,
        maxRetries: 0,
        modelCapabilities: {
          "vendor/reasoner-*": {
            thinking: true,
            toolCalls: false,
            streaming: true,
          },
        },
      },
    );
    process.env.CIYUAN_API_KEY = "test-ciyuan-key";

    try {
      const input = {
        model: "vendor/reasoner-fast",
        messages: [
          {
            role: "user" as const,
            content: [{ type: "text" as const, text: "hi" }],
          },
        ],
        stream: false,
      };

      for await (const event of provider.chat(input)) {
        void event;
      }

      const postCall = (global.fetch as any).mock.calls.find(
        (call: any) => call[1]?.method === "POST",
      );
      expect(postCall).toBeDefined();
      expect(postCall[1].headers["X-API-Key"]).toBe("test-ciyuan-key");
      expect(postCall[1].headers["X-Gateway"]).toBe("orbit");
      expect(
        provider.getModelCapabilities("vendor/reasoner-fast"),
      ).toMatchObject({
        thinking: true,
        toolCalls: false,
        streaming: true,
      });
    } finally {
      delete process.env.CIYUAN_API_KEY;
    }
  });

  it("uses OpenAI reasoning parameters for GPT-5 models", async () => {
    const provider = new DeepSeekOpenAIProvider(
      "test-key",
      "https://api.openai.com/v1",
      {
        id: "openai",
        disablePreheat: true,
        maxRetries: 0,
      },
    );

    for await (const event of provider.chat({
      model: "gpt-5.5",
      messages: [
        {
          role: "user" as const,
          content: [{ type: "text" as const, text: "hi" }],
        },
      ],
      stream: false,
      maxTokens: 1234,
      thinking: { enabled: true, budgetTokens: 4096 },
    })) {
      void event;
    }

    const postCall = (global.fetch as any).mock.calls.find(
      (call: any) => call[1]?.method === "POST",
    );
    const body = JSON.parse(postCall[1].body);
    expect(body.max_completion_tokens).toBe(1234);
    expect(body.reasoning_effort).toBe("high");
    expect(body.max_tokens).toBeUndefined();
    expect(body.thinking).toBeUndefined();
    expect(body.temperature).toBeUndefined();
  });
});
