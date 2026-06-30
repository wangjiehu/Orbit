import {
  confirm,
  text,
  spinner,
  select,
  multiselect,
  password,
  isCancel,
} from "@clack/prompts";
import picocolors from "picocolors";
import readline from "readline";

export type PromptOption = {
  value: string;
  label: string;
  hint?: string;
  deleteDisabled?: boolean;
};

export type SelectWithDeleteResult =
  | { action: "select"; value: string }
  | { action: "delete"; value: string }
  | { action: "cancel" };

export class Prompt {
  public static tuiInstance: any = null;

  public static setTuiInstance(tui: any) {
    this.tuiInstance = tui;
  }

  private static async wrapPrompt<T>(promptFn: () => Promise<T>): Promise<T> {
    const onKeypress = (str: any, key: any) => {
      if (key && key.name === "escape") {
        process.stdin.emit("keypress", "\u0003", { ctrl: true, name: "c" });
      }
    };
    process.stdin.on("keypress", onKeypress);
    try {
      return await promptFn();
    } finally {
      process.stdin.removeListener("keypress", onKeypress);
    }
  }

  public static async askPassword(message: string): Promise<string | null> {
    if (this.tuiInstance && this.tuiInstance.isActive) {
      return this.tuiInstance.showPrompt({
        type: "password",
        message,
      });
    }
    return this.wrapPrompt(async () => {
      const response = await password({
        message,
        mask: "*",
      });
      if (isCancel(response)) return null;
      return typeof response === "string" ? response : "";
    });
  }

  public static async askApproval(message: string): Promise<boolean> {
    if (this.tuiInstance && this.tuiInstance.isActive) {
      return this.tuiInstance.showPrompt({
        type: "confirm",
        message,
      });
    }
    return this.wrapPrompt(async () => {
      const response = await confirm({
        message: `${picocolors.yellow(message)} Approve?`,
      });
      if (isCancel(response)) return false;
      return !!response;
    });
  }

  public static async askText(
    message: string,
    initialValue?: string,
  ): Promise<string | null> {
    if (this.tuiInstance && this.tuiInstance.isActive) {
      return this.tuiInstance.showPrompt({
        type: "text",
        message,
        initialValue,
      });
    }
    return this.wrapPrompt(async () => {
      const response = await text({
        message,
        placeholder: "Type your task or command...",
        initialValue,
      });
      if (isCancel(response)) return null;
      return typeof response === "string" ? response : "";
    });
  }

  public static async askTextWithAutocomplete(
    message: string,
    completerFn: (line: string) => [string[], string],
    promptPrefix?: string,
  ): Promise<string | null> {
    return new Promise((resolve) => {
      const promptStr =
        promptPrefix !== undefined
          ? promptPrefix
          : `${picocolors.cyan("?")} ${message} › `;

      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        completer: completerFn,
        prompt: promptStr,
      });

      let currentSuggestion = "";
      let hasPrintedSuggestions = false;

      function clearSuggestions() {
        if (hasPrintedSuggestions) {
          process.stdout.write("\n\x1b[K");
          readline.moveCursor(process.stdout, 0, -1);
          const visiblePromptLen = promptStr.replace(
            /\x1b\[[0-9;]*[a-zA-Z]/g,
            "",
          ).length;
          readline.cursorTo(process.stdout, rl.cursor + visiblePromptLen);
          hasPrintedSuggestions = false;
        }
      }

      function printSuggestions(hits: string[]) {
        clearSuggestions();
        if (hits.length === 0) return;
        const suggestionText = ` Suggestions: ${hits.slice(0, 6).join(" | ")}${hits.length > 6 ? " ..." : ""}`;

        process.stdout.write("\n\x1b[K" + picocolors.gray(suggestionText));
        readline.moveCursor(process.stdout, 0, -1);
        const visiblePromptLen = promptStr.replace(
          /\x1b\[[0-9;]*[a-zA-Z]/g,
          "",
        ).length;
        readline.cursorTo(process.stdout, rl.cursor + visiblePromptLen);
        hasPrintedSuggestions = true;
      }

      function updateSuggestion() {
        const line = rl.line;
        const cursor = rl.cursor;
        currentSuggestion = "";

        if (cursor === line.length && line.trim().length > 0) {
          const [hits, lastWord] = completerFn(line);
          if (hits.length > 0) {
            const bestMatch = hits[0];
            if (line.startsWith("/")) {
              if (bestMatch.startsWith(line) && bestMatch !== line) {
                currentSuggestion = bestMatch.substring(line.length);
              }
            } else if (lastWord) {
              if (bestMatch.startsWith(lastWord) && bestMatch !== lastWord) {
                currentSuggestion = bestMatch.substring(lastWord.length);
              }
            }
          }
        }

        process.stdout.write("\x1b[K"); // clear forward
        if (currentSuggestion) {
          process.stdout.write(picocolors.dim(currentSuggestion));
          readline.moveCursor(process.stdout, -currentSuggestion.length, 0);
        }
      }

      const originalTtyWrite = (rl as any)._ttyWrite;
      if (originalTtyWrite) {
        (rl as any)._ttyWrite = function (char: any, key: any) {
          if (key && key.name === "escape") {
            clearSuggestions();
            rl.close();
            process.stdout.write("\n");
            resolve(null);
            return;
          }

          if (
            currentSuggestion &&
            key &&
            (key.name === "tab" || key.name === "right")
          ) {
            clearSuggestions();
            rl.write(currentSuggestion);
            currentSuggestion = "";
            process.stdout.write("\x1b[K");
            return;
          }

          if (key && key.name === "tab" && !currentSuggestion) {
            const line = rl.line;
            const [hits] = completerFn(line);
            if (hits.length > 0) {
              printSuggestions(hits);
              return;
            }
          }

          clearSuggestions();
          originalTtyWrite.call(rl, char, key);
          updateSuggestion();
        };
      }

      rl.prompt();

      rl.on("SIGINT", () => {
        clearSuggestions();
        rl.close();
        process.stdout.write("\n");
        resolve(null);
      });

      rl.on("line", (line) => {
        clearSuggestions();
        rl.close();
        resolve(line);
      });
    });
  }

  public static async askSelect(
    message: string,
    options: PromptOption[],
  ): Promise<string | null> {
    if (this.tuiInstance && this.tuiInstance.isActive) {
      const response = await this.tuiInstance.showPrompt({
        type: "select",
        message,
        options,
      });
      if (response && typeof response === "object" && "action" in response) {
        return response.action === "select" ? response.value : null;
      }
      return typeof response === "string" ? response : null;
    }
    return this.wrapPrompt(async () => {
      const response = await select({
        message,
        options,
      });
      if (isCancel(response)) return null;
      return typeof response === "string" ? response : "";
    });
  }

  public static async askSelectWithDelete(
    message: string,
    options: PromptOption[],
    config: {
      initialSelectedValue?: string;
      suppressCloseRenderOnDelete?: boolean;
    } = {},
  ): Promise<SelectWithDeleteResult> {
    if (this.tuiInstance && this.tuiInstance.isActive) {
      const response = await this.tuiInstance.showPrompt({
        type: "select",
        message,
        options,
        deletable: true,
        initialSelectedValue: config.initialSelectedValue,
        suppressCloseRenderOnDelete: config.suppressCloseRenderOnDelete,
      });
      if (response && typeof response === "object" && "action" in response) {
        return response as SelectWithDeleteResult;
      }
      if (typeof response === "string" && response.length > 0) {
        return { action: "select", value: response };
      }
      return { action: "cancel" };
    }

    const response = await this.askSelect(message, options);
    if (!response) {
      return { action: "cancel" };
    }
    return { action: "select", value: response };
  }

  public static async askMultiSelect(
    message: string,
    options: PromptOption[],
  ): Promise<string[] | null> {
    if (this.tuiInstance && this.tuiInstance.isActive) {
      return this.tuiInstance.showPrompt({
        type: "multiselect",
        message,
        options,
      });
    }
    return this.wrapPrompt(async () => {
      const response = await multiselect({
        message,
        options,
        required: false,
      });
      if (isCancel(response)) return null;
      return Array.isArray(response) ? (response as string[]) : [];
    });
  }

  public static makeSpinner() {
    return spinner();
  }
}
