import { afterEach, describe, expect, it, vi } from "vitest";
import { Prompt } from "./Prompt.js";

describe("Prompt.askSelectWithDelete", () => {
  afterEach(() => {
    Prompt.setTuiInstance(null);
  });

  it("forwards delete-capable select prompts to the active TUI", async () => {
    const showPrompt = vi
      .fn()
      .mockResolvedValue({ action: "delete", value: "session-1" });

    Prompt.setTuiInstance({
      isActive: true,
      showPrompt,
    });

    await expect(
      Prompt.askSelectWithDelete("Choose a session", [
        { value: "session-1", label: "Session 1" },
      ]),
    ).resolves.toEqual({ action: "delete", value: "session-1" });

    expect(showPrompt).toHaveBeenCalledWith({
      type: "select",
      message: "Choose a session",
      options: [{ value: "session-1", label: "Session 1" }],
      deletable: true,
      initialSelectedValue: undefined,
      suppressCloseRenderOnDelete: undefined,
    });
  });

  it("forwards initial selection and delete render options", async () => {
    const showPrompt = vi
      .fn()
      .mockResolvedValue({ action: "delete", value: "session-2" });

    Prompt.setTuiInstance({
      isActive: true,
      showPrompt,
    });

    await Prompt.askSelectWithDelete(
      "Choose a session",
      [
        { value: "session-1", label: "Session 1" },
        { value: "session-2", label: "Session 2" },
      ],
      {
        initialSelectedValue: "session-2",
        suppressCloseRenderOnDelete: true,
      },
    );

    expect(showPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        initialSelectedValue: "session-2",
        suppressCloseRenderOnDelete: true,
      }),
    );
  });

  it("normalizes TUI string and null responses", async () => {
    const showPrompt = vi
      .fn()
      .mockResolvedValueOnce("session-2")
      .mockResolvedValueOnce(null);

    Prompt.setTuiInstance({
      isActive: true,
      showPrompt,
    });

    await expect(
      Prompt.askSelectWithDelete("Choose a session", [
        { value: "session-2", label: "Session 2" },
      ]),
    ).resolves.toEqual({ action: "select", value: "session-2" });

    await expect(
      Prompt.askSelectWithDelete("Choose a session", [
        { value: "session-2", label: "Session 2" },
      ]),
    ).resolves.toEqual({ action: "cancel" });
  });
});
