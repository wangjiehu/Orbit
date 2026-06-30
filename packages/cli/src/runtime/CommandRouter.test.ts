import { afterEach, describe, it, expect, vi } from "vitest";
import { CommandRouter } from "./CommandRouter.js";
import { Prompt } from "@orbit-build/tui";

describe("CommandRouter Unit Tests", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const mockConfig = {
    language: "en",
    permissions: { mode: "strict" },
    models: { default: "gpt-4" },
  };

  const mockProvider = {
    id: "openai",
    chat: vi.fn(),
  };

  const mockLoop = {
    getConfig: () => mockConfig,
    getModelOverride: () => undefined,
    getHistory: () => [],
    getCheckpoints: () => [],
    getRelevantFiles: () => [],
    addRelevantFilePublic: vi.fn(),
  };

  const mockTui = {
    isActive: true,
    addSystemMessage: vi.fn(),
    addLog: vi.fn(),
    syncFromLoop: vi.fn(),
    setCandidates: vi.fn(),
  };

  const mockInteraction = {
    askApproval: vi.fn(),
    showText: vi.fn(),
    showDiff: vi.fn(),
  };

  const localState = { lastSessionId: "123", lastModel: "gpt-4" };

  it("should output help message when /help is executed", async () => {
    const router = new CommandRouter(
      "/dummy/cwd",
      mockConfig,
      mockProvider,
      vi.fn(),
      mockLoop as any,
      mockTui as any,
      false,
      () => ({ commands: [], files: [], symbols: [], sessions: [] }),
      vi.fn(),
      () => localState,
      vi.fn(),
      mockInteraction as any,
      false,
    );

    const result = await router.route("/help");
    expect(result.processed).toBe(true);
    expect(result.shouldExit).toBe(false);
    // useFullscreenTui=false → printOutput → console.log (TUI not active)
    expect(result.processed).toBe(true);
  });

  it("should return processed: false for non-slash command inputs", async () => {
    const router = new CommandRouter(
      "/dummy/cwd",
      mockConfig,
      mockProvider,
      vi.fn(),
      mockLoop as any,
      mockTui as any,
      false,
      () => ({ commands: [], files: [], symbols: [], sessions: [] }),
      vi.fn(),
      () => localState,
      vi.fn(),
      mockInteraction as any,
      false,
    );

    const result = await router.route("create a login page");
    expect(result.processed).toBe(false);
    expect(result.shouldExit).toBe(false);
  });

  it("should output error message for unknown command", async () => {
    const router = new CommandRouter(
      "/dummy/cwd",
      mockConfig,
      mockProvider,
      vi.fn(),
      mockLoop as any,
      mockTui as any,
      false,
      () => ({ commands: [], files: [], symbols: [], sessions: [] }),
      vi.fn(),
      () => localState,
      vi.fn(),
      mockInteraction as any,
      false,
    );

    const result = await router.route("/invalidcommand");
    expect(result.processed).toBe(true);
    expect(result.shouldExit).toBe(false);
  });

  it("keeps the /chat picker open after deleting a session", async () => {
    let sessions = [
      {
        id: "session-1",
        title: "First",
        createdAt: "2026-06-28T01:00:00.000Z",
        model: "deepseek-v4-flash",
      },
      {
        id: "session-2",
        title: "Second",
        createdAt: "2026-06-28T02:00:00.000Z",
        model: "deepseek-v4-flash",
      },
    ];
    const deleteSession = vi.fn((id: string) => {
      sessions = sessions.filter((session) => session.id !== id);
    });
    const askSelectWithDelete = vi
      .spyOn(Prompt, "askSelectWithDelete")
      .mockResolvedValueOnce({ action: "delete", value: "session-1" })
      .mockResolvedValueOnce({ action: "delete", value: "session-2" });
    vi.spyOn(console, "log").mockImplementation(() => {});

    const loop = {
      ...mockLoop,
      state: { sessionId: "active-session" },
      sessionManager: {
        getActiveSession: () => ({ id: "active-session" }),
      },
      getSessions: vi.fn(() => sessions),
      deleteSession,
      startNewSession: vi.fn(),
      resumeSession: vi.fn(),
    };
    const tui = {
      ...mockTui,
      isActive: false,
      loadHistory: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
    };
    const router = new CommandRouter(
      "/dummy/cwd",
      mockConfig,
      mockProvider,
      vi.fn(),
      loop as any,
      tui as any,
      false,
      () => ({ commands: [], files: [], symbols: [], sessions: [] }),
      vi.fn(),
      () => localState,
      vi.fn(),
      mockInteraction as any,
      false,
    );

    const result = await router.route("/chat");

    expect(result).toEqual({ shouldExit: false, processed: true });
    expect(deleteSession).toHaveBeenCalledTimes(2);
    expect(deleteSession).toHaveBeenNthCalledWith(1, "session-1");
    expect(deleteSession).toHaveBeenNthCalledWith(2, "session-2");
    expect(askSelectWithDelete).toHaveBeenCalledTimes(2);
    expect(askSelectWithDelete.mock.calls[0][1]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ value: "session-1" }),
        expect.objectContaining({ value: "session-2" }),
      ]),
    );
    expect(askSelectWithDelete.mock.calls[1][1]).toEqual(
      expect.arrayContaining([expect.objectContaining({ value: "session-2" })]),
    );
    expect(askSelectWithDelete.mock.calls[1][1]).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ value: "session-1" })]),
    );
    expect(askSelectWithDelete.mock.calls[1][2]).toEqual(
      expect.objectContaining({ initialSelectedValue: "session-2" }),
    );
  });

  it("silently reloads history after deleting the active session in fullscreen", async () => {
    let sessions = [
      {
        id: "session-1",
        title: "First",
        createdAt: "2026-06-28T01:00:00.000Z",
        model: "deepseek-v4-flash",
      },
      {
        id: "session-2",
        title: "Second",
        createdAt: "2026-06-28T02:00:00.000Z",
        model: "deepseek-v4-flash",
      },
    ];
    const reloadedHistory = [
      {
        role: "user",
        content: [{ type: "text", text: "still here" }],
      },
    ];
    const deleteSession = vi.fn((id: string) => {
      sessions = sessions.filter((session) => session.id !== id);
    });
    const askSelectWithDelete = vi
      .spyOn(Prompt, "askSelectWithDelete")
      .mockResolvedValueOnce({ action: "delete", value: "session-1" })
      .mockResolvedValueOnce({ action: "cancel" });
    const loop = {
      ...mockLoop,
      state: { sessionId: "session-1" },
      sessionManager: {
        getActiveSession: () => ({ id: "session-1" }),
      },
      getSessions: vi.fn(() => sessions),
      getHistory: vi.fn(() => reloadedHistory),
      deleteSession,
      startNewSession: vi.fn(),
      resumeSession: vi.fn((id: string) => {
        loop.state.sessionId = id;
        return true;
      }),
    };
    const tui = {
      ...mockTui,
      isActive: true,
      loadHistory: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
    };
    const router = new CommandRouter(
      "/dummy/cwd",
      mockConfig,
      mockProvider,
      vi.fn(),
      loop as any,
      tui as any,
      true,
      () => ({ commands: [], files: [], symbols: [], sessions: [] }),
      vi.fn(),
      () => localState,
      vi.fn(),
      mockInteraction as any,
      false,
    );

    const result = await router.route("/chat");

    expect(result).toEqual({ shouldExit: false, processed: true });
    expect(deleteSession).toHaveBeenCalledWith("session-1");
    expect(loop.resumeSession).toHaveBeenCalledWith("session-2");
    expect(tui.loadHistory).toHaveBeenCalledWith(reloadedHistory, {
      silent: true,
    });
    expect(askSelectWithDelete.mock.calls[0][2]).toEqual(
      expect.objectContaining({ suppressCloseRenderOnDelete: true }),
    );
  });
});
