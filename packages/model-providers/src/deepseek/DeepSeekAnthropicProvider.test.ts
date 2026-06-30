import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeepSeekAnthropicProvider } from "./DeepSeekAnthropicProvider.js";

describe("DeepSeekAnthropicProvider compatibility options", () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    global.fetch = vi.fn().mockImplementation(() =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            content: [{ type: "text", text: "ok" }],
            usage: { input_tokens: 10, output_tokens: 5 },
          }),
      }),
    ) as any;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("should support bearer-style auth and custom headers for compatible gateways", async () => {
    const provider = new DeepSeekAnthropicProvider(
      undefined,
      "https://anthropic-gateway.example.com/v1",
      {
        id: "ciyuan-anthropic",
        apiKeyEnv: "CIYUAN_ANTHROPIC_KEY",
        apiKeyHeader: "Authorization",
        apiKeyPrefix: "Bearer",
        headers: { "X-Gateway": "orbit" },
        disablePreheat: true,
        maxRetries: 0,
      },
    );
    process.env.CIYUAN_ANTHROPIC_KEY = "test-anthropic-key";

    try {
      for await (const event of provider.chat({
        model: "claude-compatible",
        messages: [
          {
            id: "msg-1",
            role: "user",
            createdAt: new Date().toISOString(),
            content: [{ type: "text", text: "hi" }],
          },
        ],
        stream: false,
      })) {
        void event;
      }

      const postCall = (global.fetch as any).mock.calls.find(
        (call: any) => call[1]?.method === "POST",
      );
      expect(postCall[0]).toBe(
        "https://anthropic-gateway.example.com/v1/messages",
      );
      expect(postCall[1].headers.Authorization).toBe(
        "Bearer test-anthropic-key",
      );
      expect(postCall[1].headers["X-Gateway"]).toBe("orbit");
    } finally {
      delete process.env.CIYUAN_ANTHROPIC_KEY;
    }
  });

  it("uses adaptive thinking for newer Claude models without legacy temperature", async () => {
    const provider = new DeepSeekAnthropicProvider(
      "test-key",
      "https://anthropic.example.com",
      {
        disablePreheat: true,
        maxRetries: 0,
      },
    );

    for await (const event of provider.chat({
      model: "claude-opus-4-8",
      messages: [
        {
          id: "msg-1",
          role: "user",
          createdAt: new Date().toISOString(),
          content: [{ type: "text", text: "think carefully" }],
        },
      ],
      stream: false,
      thinking: { enabled: true, budgetTokens: 8192 },
    })) {
      void event;
    }

    const postCall = (global.fetch as any).mock.calls.find(
      (call: any) => call[1]?.method === "POST",
    );
    const body = JSON.parse(postCall[1].body);
    expect(body.thinking).toEqual({
      type: "adaptive",
      display: "summarized",
    });
    expect(body.output_config).toEqual({ effort: "max" });
    expect(body.temperature).toBeUndefined();
  });

  it("splits Orbit volatile context into separate Anthropic cache blocks", async () => {
    const provider = new DeepSeekAnthropicProvider(
      "test-key",
      "https://anthropic.example.com",
      {
        disablePreheat: true,
        maxRetries: 0,
      },
    );

    for await (const event of provider.chat({
      model: "claude-sonnet-4-6",
      system: "stable prompt\n<!-- VOLATILE_CONTEXT -->\nruntime context",
      messages: [
        {
          id: "msg-1",
          role: "user",
          createdAt: new Date().toISOString(),
          content: [{ type: "text", text: "hi" }],
        },
      ],
      stream: false,
    })) {
      void event;
    }

    const postCall = (global.fetch as any).mock.calls.find(
      (call: any) => call[1]?.method === "POST",
    );
    const body = JSON.parse(postCall[1].body);
    expect(body.system).toEqual([
      {
        type: "text",
        text: "stable prompt",
        cache_control: { type: "ephemeral" },
      },
      {
        type: "text",
        text: "\nruntime context",
        cache_control: { type: "ephemeral" },
      },
    ]);
  });
});
