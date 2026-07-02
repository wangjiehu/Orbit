import { afterEach, describe, expect, it } from "vitest";
import { ConfigSchema } from "@orbit-build/config";
import {
  parseWebUiArgs,
  startOrbitWebUi,
  stopOrbitWebUi,
} from "./WebUiServer.js";

describe("WebUiServer", () => {
  afterEach(async () => {
    await stopOrbitWebUi();
  });

  it("parses port and open flags", () => {
    expect(parseWebUiArgs("6060 --no-open")).toEqual({
      port: 6060,
      open: false,
    });
    expect(parseWebUiArgs("--port=0")).toEqual({ port: 0, open: true });
    expect(parseWebUiArgs("--port 6080")).toEqual({
      port: 6080,
      open: true,
    });
  });

  it("serves the Orbit graphical page and status API", async () => {
    const submitted: string[] = [];
    const patches: unknown[] = [];
    const handle = await startOrbitWebUi({
      cwd: "D:/repo",
      port: 0,
      open: false,
      config: ConfigSchema.parse({
        provider: { default: "deepseek-openai" },
        providers: {
          "deepseek-openai": {
            type: "openai-compatible",
            baseUrl: "https://api.deepseek.com",
          },
        },
        models: {
          default: "deepseek-v4-flash",
          fast: "deepseek-v4-flash",
          planner: "deepseek-v4-pro",
          coder: "deepseek-v4-pro",
        },
        permissions: { mode: "normal" },
        tools: {
          webSearch: { enabled: true, provider: "auto" },
          mcp: { enabled: false },
        },
        skills: { enabled: true },
        context: { maxFilesToIndex: 5000, compactThreshold: 0.75 },
      }),
      loop: {
        getSessionId: () => "sess-test",
        getSessions: () => [{ id: "sess-test" }],
        getHistory: () => [
          {
            id: "msg-1",
            role: "user",
            content: [{ type: "text", text: "hello" }],
          },
        ],
        getRelevantFiles: () => [{ path: "src/index.ts" }],
      },
      submitPrompt: async (prompt) => {
        submitted.push(prompt);
        return { ok: true };
      },
      updateSettings: async (patch) => {
        patches.push(patch);
        return { ok: true };
      },
    });

    const html = await fetch(handle.url).then((response) => response.text());
    const status = await fetch(`${handle.url}api/status`).then((response) =>
      response.json(),
    );
    const messages = await fetch(`${handle.url}api/messages`).then((response) =>
      response.json(),
    );
    const chat = await fetch(`${handle.url}api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "hi from web" }),
    }).then((response) => response.json());
    const settings = await fetch(`${handle.url}api/settings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "deepseek-v4-pro",
        permissionMode: "auto",
        webSearchEnabled: false,
        webSearchProvider: "bing",
        webSearchMaxResults: 12,
      }),
    }).then((response) => response.json());

    expect(html).toContain("ORBIT");
    expect(html).toContain("/api/chat");
    expect(status.workspace).toBe("D:/repo");
    expect(status.provider.id).toBe("deepseek-openai");
    expect(status.session.activeId).toBe("sess-test");
    expect(status.context.relevantFiles).toBe(1);
    expect(messages.messages[0].text).toBe("hello");
    expect(chat.ok).toBe(true);
    expect(submitted).toEqual(["hi from web"]);
    expect(settings.ok).toBe(true);
    expect(patches).toEqual([
      {
        model: "deepseek-v4-pro",
        permissionMode: "auto",
        webSearchEnabled: false,
        webSearchProvider: "bing",
        webSearchMaxResults: 12,
      },
    ]);
  });
});
