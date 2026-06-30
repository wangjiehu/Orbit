import { describe, it, expect } from "vitest";
import { MessageBuilder } from "./MessageBuilder.js";
import { createInitialState } from "./AgentState.js";
import { ContextPack } from "@orbit-build/context-engine";

describe("MessageBuilder prompt caching", () => {
  it("should include codebase context and files excerpts in the system prompt", () => {
    const state = createInitialState("session-123", "fix the bug");
    state.history = [
      {
        id: "msg-1",
        role: "user",
        createdAt: new Date().toISOString(),
        content: [{ type: "text", text: "fix the bug" }],
      },
    ];

    const context: ContextPack = {
      projectIndex: {
        detectedLanguages: ["typescript"],
        frameworks: ["vitest"],
        entrypoints: [],
        packageManager: "pnpm",
        files: {},
      },
      projectInstructions: "Use spaces.",
      relevantFiles: [
        {
          path: "src/index.ts",
          reason: "entrypoint",
          summary: "entry point file",
          excerpt: "console.log('hello');",
        },
      ],
      recentChanges: "",
      currentDiff: "",
      previousErrors: "",
      codebaseContext: "RAG context A",
      tokenBudget: { max: 128000, usedEstimate: 100 },
    };

    const build = MessageBuilder.build("System Prompt Base", state, context, {
      now: new Date(2026, 5, 29, 10, 30, 5),
    });

    // Verify system prompt contains stable base AND volatile context
    expect(build.system).toContain("System Prompt Base");
    expect(build.system).toContain("### Runtime Context");
    expect(build.system).toContain("Current local date: 2026-06-29");
    expect(build.system).toContain("Current local time: 10:30:05");
    expect(build.system).toContain(
      "Resolve relative dates such as today, tomorrow, yesterday",
    );
    expect(build.system).toContain(
      "trust live results over model training memory",
    );
    expect(build.system).toContain("RAG context A");
    expect(build.system).toContain("console.log('hello');");
    expect(build.system).not.toContain("Use spaces.");
    expect(build.system.indexOf("### Runtime Context")).toBeLessThan(
      build.system.indexOf("### Context Instructions"),
    );
    expect(build.system.indexOf("File: src/index.ts")).toBeLessThan(
      build.system.indexOf("### Codebase Context"),
    );

    // Verify user message (last message) is clean and undecorated
    const lastMsgText = build.messages[0].content[0].text;
    expect(lastMsgText).toBe("fix the bug");
  });

  it("should keep messages stable across multiple turns and steps", () => {
    const state = createInitialState("session-123", "run tests");
    state.history = [
      {
        id: "msg-1",
        role: "user",
        createdAt: new Date().toISOString(),
        content: [{ type: "text", text: "decorated user message from Turn 1" }],
      },
      {
        id: "msg-2",
        role: "assistant",
        createdAt: new Date().toISOString(),
        content: [{ type: "text", text: "done" }],
      },
      {
        id: "msg-3",
        role: "user",
        createdAt: new Date().toISOString(),
        content: [{ type: "text", text: "run tests" }],
      },
    ];

    const context: ContextPack = {
      projectIndex: {
        detectedLanguages: ["typescript"],
        frameworks: ["vitest"],
        entrypoints: [],
        packageManager: "pnpm",
        files: {},
      },
      projectInstructions: "",
      relevantFiles: [],
      recentChanges: "",
      currentDiff: "",
      previousErrors: "",
      codebaseContext: "RAG context B",
      tokenBudget: { max: 128000, usedEstimate: 100 },
    };

    const build = MessageBuilder.build("System Prompt Base", state, context);

    // Verify the system prompt contains stable base AND volatile context
    expect(build.system).toContain("System Prompt Base");
    expect(build.system).toContain("RAG context B");

    // Verify only messages are stable and undecorated
    expect(build.messages.length).toBe(3);
    expect(build.messages[0].content[0].text).toBe(
      "decorated user message from Turn 1",
    );
    expect(build.messages[1].content[0].text).toBe("done");
    expect(build.messages[2].content[0].text).toBe("run tests");
  });
});
