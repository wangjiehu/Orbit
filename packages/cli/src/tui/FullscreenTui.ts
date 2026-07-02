import { join, dirname } from "path";
import { homedir } from "os";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  statSync,
} from "fs";
import { exec } from "child_process";
import readline from "readline";
import { Prompt, Renderer, type PromptOption } from "@orbit-build/tui";
import { BUILTIN_SLASH_COMMANDS } from "../runtime/CommandRouter.js";
import { getProviderModelCandidates } from "../runtime/ModelCatalog.js";

export function previousCodePointIndex(text: string, index: number): number {
  const safeIndex = Math.max(0, Math.min(index, text.length));
  if (safeIndex === 0) return 0;
  const previous = text.charCodeAt(safeIndex - 1);
  if (previous >= 0xdc00 && previous <= 0xdfff && safeIndex >= 2) {
    const leading = text.charCodeAt(safeIndex - 2);
    if (leading >= 0xd800 && leading <= 0xdbff) {
      return safeIndex - 2;
    }
  }
  return safeIndex - 1;
}

export function nextCodePointIndex(text: string, index: number): number {
  const safeIndex = Math.max(0, Math.min(index, text.length));
  if (safeIndex >= text.length) return text.length;
  const leading = text.charCodeAt(safeIndex);
  if (leading >= 0xd800 && leading <= 0xdbff && safeIndex + 1 < text.length) {
    const trailing = text.charCodeAt(safeIndex + 1);
    if (trailing >= 0xdc00 && trailing <= 0xdfff) {
      return safeIndex + 2;
    }
  }
  return safeIndex + 1;
}

export function previousWordIndex(text: string, index: number): number {
  let pos = index;
  while (pos > 0 && /\s/.test(text.charAt(pos - 1))) {
    pos--;
  }
  while (pos > 0 && !/\s/.test(text.charAt(pos - 1))) {
    pos--;
  }
  return pos;
}

export function nextWordIndex(text: string, index: number): number {
  let pos = index;
  while (pos < text.length && /\s/.test(text.charAt(pos))) {
    pos++;
  }
  while (pos < text.length && !/\s/.test(text.charAt(pos))) {
    pos++;
  }
  return pos;
}

export type SubmittedInputEcho = boolean | ((submitted: string) => boolean);

export interface AskInputOptions {
  echoSubmitted?: SubmittedInputEcho;
}

export function parseMouseWheelDirection(
  input: string | undefined | null,
): "up" | "down" | null {
  if (typeof input !== "string") return null;
  const match = input.match(/\x1b\[<(\d+);\d+;\d+[mM]/);
  if (!match) return null;
  const button = Number(match[1]);
  if ((button & 64) === 0) return null;
  return (button & 1) === 0 ? "up" : "down";
}

export async function pageText(text: string): Promise<void> {
  const lines = text.split("\n");
  const rows = process.stdout.rows || 24;
  const pageSize = rows - 2;

  if (lines.length <= pageSize) {
    console.log(text);
    return;
  }

  let cursor = 0;
  const wasRaw = !!process.stdin.isRaw;
  if (process.stdin.setRawMode) {
    process.stdin.setRawMode(true);
  }
  process.stdin.resume();

  readline.emitKeypressEvents(process.stdin);

  const keypressPromise = (): Promise<string> => {
    return new Promise((resolve) => {
      const onKeypress = (str: string, key: any) => {
        process.stdin.removeListener("keypress", onKeypress);
        if (key && key.ctrl && key.name === "c") {
          if (process.stdin.setRawMode) {
            process.stdin.setRawMode(wasRaw);
          }
          process.exit(0);
        }
        resolve(key ? key.name || str : str);
      };
      process.stdin.on("keypress", onKeypress);
    });
  };

  try {
    while (cursor < lines.length) {
      const chunk = lines.slice(cursor, cursor + pageSize);
      console.log(chunk.join("\n"));
      cursor += pageSize;

      if (cursor >= lines.length) {
        break;
      }

      process.stdout.write(
        `\r\x1b[36m-- More (${Math.round((cursor / lines.length) * 100)}%) [Space/Enter to continue, q to quit] --\x1b[39m`,
      );

      const key = await keypressPromise();
      process.stdout.write("\r\x1b[K");

      if (key === "q") {
        break;
      }
      if (key === "return" || key === "enter") {
        cursor = cursor - pageSize + 1;
      }
    }
  } finally {
    if (process.stdin.setRawMode) {
      process.stdin.setRawMode(wasRaw);
    }
    process.stdin.pause();
  }
}

// ─── Shared ANSI colour helpers (class-level constant, avoids recreation per render) ───
const MORANDI = {
  user: (s: string) => `\x1b[38;2;158;184;196m${s}\x1b[0m`,
  userBold: (s: string) => `\x1b[1;38;2;158;184;196m${s}\x1b[0m`,
  asst: (s: string) => `\x1b[38;2;164;178;150m${s}\x1b[0m`,
  asstBold: (s: string) => `\x1b[1;38;2;164;178;150m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[38;2;158;184;196m${s}\x1b[0m`,
  accent: (s: string) => `\x1b[38;2;224;188;124m${s}\x1b[0m`,
  completed: (s: string) => `\x1b[38;2;152;188;146m${s}\x1b[0m`,
  failed: (s: string) => `\x1b[38;2;212;132;132m${s}\x1b[0m`,
  warn: (s: string) => `\x1b[38;2;226;178;98m${s}\x1b[0m`,
  white: (s: string) => `\x1b[38;2;236;233;224m${s}\x1b[0m`,
  whiteBold: (s: string) => `\x1b[1;38;2;245;242;232m${s}\x1b[0m`,
  gray: (s: string) => `\x1b[38;2;178;176;168m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[38;2;148;146;138m${s}\x1b[0m`,
} as const;

// Width of the fixed input-box left prefix "  │ orbit > " (constant, pre-calculated)
const INPUT_PREFIX_WIDTH = 12; // "  │ orbit > " visual width

export function selectActiveSlashSuggestion(
  input: string,
  matches: string[],
  activeIndex: number,
): string {
  if (!input.startsWith("/") || matches.length === 0) return input;
  const idx = Math.min(Math.max(0, activeIndex), matches.length - 1);
  return matches[idx] || input;
}

export function getSlashSuggestionFooterText(
  isZh: boolean,
  matchCount: number,
): string {
  return isZh
    ? `↑/↓ 选择  Enter 运行所选  Tab 填入  Esc 关闭  ·  ${matchCount} 项`
    : `↑/↓ select  Enter run selected  Tab fill  Esc close  ·  ${matchCount} match(es)`;
}

const ANSI_PATTERN =
  /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;

export function stripAnsiCodes(str: string): string {
  return str.replace(ANSI_PATTERN, "");
}

export function filterPromptOptionIndices(
  options: PromptOption[],
  query: string,
): number[] {
  const terms = stripAnsiCodes(query)
    .trim()
    .toLocaleLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  if (terms.length === 0) {
    return options.map((_, index) => index);
  }

  return options
    .map((option, index) => ({ option, index }))
    .filter(({ option }) => {
      const haystack = stripAnsiCodes(
        [option.label, option.value, option.hint || ""].join(" "),
      ).toLocaleLowerCase();
      return terms.every((term) => haystack.includes(term));
    })
    .map(({ index }) => index);
}

function normalizeMatchText(text: string): string {
  return stripAnsiCodes(text)
    .toLocaleLowerCase()
    .replace(/[_/\\:-]+/g, " ");
}

function isOrderedSubsequence(needle: string, haystack: string): boolean {
  if (needle.length === 0) return true;
  let pos = 0;
  for (const char of haystack) {
    if (char === needle[pos]) {
      pos++;
      if (pos === needle.length) return true;
    }
  }
  return false;
}

export function rankSlashCandidates(
  candidates: string[],
  input: string,
): string[] {
  const rawQuery = stripAnsiCodes(input).trim();
  if (!rawQuery || rawQuery === "/") return candidates;

  const normalizedQuery = normalizeMatchText(rawQuery);
  const queryNoSlash = normalizedQuery.replace(/^\s*\/\s*/, "").trim();
  const terms = queryNoSlash.split(/\s+/).filter(Boolean);

  return candidates
    .map((candidate, index) => {
      const normalizedCandidate = normalizeMatchText(candidate);
      const candidateNoSlash = normalizedCandidate
        .replace(/^\s*\/\s*/, "")
        .trim();

      let score = Number.POSITIVE_INFINITY;
      if (normalizedCandidate === normalizedQuery) {
        score = 0;
      } else if (normalizedCandidate.startsWith(normalizedQuery)) {
        score = 10;
      } else if (queryNoSlash && candidateNoSlash.startsWith(queryNoSlash)) {
        score = 20;
      } else if (
        terms.length > 0 &&
        terms.every((term) => normalizedCandidate.includes(term))
      ) {
        const positionScore = terms.reduce(
          (sum, term) => sum + Math.max(0, normalizedCandidate.indexOf(term)),
          0,
        );
        score = 50 + positionScore + normalizedCandidate.length / 1000;
      } else if (
        queryNoSlash.length >= 2 &&
        isOrderedSubsequence(queryNoSlash.replace(/\s+/g, ""), candidateNoSlash)
      ) {
        score = 100 + candidateNoSlash.length;
      }

      return { candidate, index, score };
    })
    .filter((entry) => Number.isFinite(entry.score))
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .map((entry) => entry.candidate);
}

export function findPreviousHistoryEntry(
  history: string[],
  query: string,
  startIndex = history.length,
): { entry: string; index: number } | null {
  if (history.length === 0) return null;
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const cappedStart = Math.max(0, Math.min(startIndex, history.length));

  for (let offset = 0; offset < history.length; offset++) {
    const index = (cappedStart - 1 - offset + history.length) % history.length;
    const entry = history[index];
    if (
      !normalizedQuery ||
      entry.toLocaleLowerCase().includes(normalizedQuery)
    ) {
      return { entry, index };
    }
  }

  return null;
}

/** One conversation turn in the TUI history view. */
type HistoryEntry = {
  role: "user" | "assistant" | "system";
  text: string;
  thoughtTime?: number;
  totalTime?: number;
  attempt?: number;
  model?: string;
};

interface TuiTurn {
  user?: HistoryEntry;
  assistant?: HistoryEntry;
  system: HistoryEntry[];
}

interface TuiPrompt {
  type: "select" | "multiselect" | "text" | "confirm" | "password";
  message: string;
  options: PromptOption[];
  initialValue?: string;
  initialSelectedValue?: string;
  deletable?: boolean;
  suppressCloseRenderOnDelete?: boolean;
  pendingDeleteValue?: string | null;
  pendingDeleteAt?: number;
  filterQuery: string;
  filterActive: boolean;
  resolve: (value: any) => void;
  selectedIndex: number;
  selectedValues: Set<string>;
  inputValue: string;
  cursorPosition: number;
}

interface WrappedInputLine {
  text: string;
  start: number;
  end: number;
}

export class FullscreenTui {
  private history: HistoryEntry[] = [];

  private inputBuffer = "";
  private cursorPosition = 0;
  public isActive = false;
  private currentAttempt = 0;

  // Command history
  private inputHistory: string[] = [];
  private historyIndex = -1;
  private historySearchQuery: string | null = null;
  private tempBuffer = "";
  private activeCommandIndex = 0;
  private ctrlCPressedOnce = false;
  private ctrlCTimeout: NodeJS.Timeout | null = null;
  private cachedStaticLinesCount = 0;
  private cachedStaticContent = "";
  private lastRenderedBottomHeight = 0;

  // DeepSeek real-time thinking
  private currentThinking = "";

  // Timers and metrics
  private attemptStartTime = 0;
  private firstDeltaTime = 0;
  private thoughtTimer: NodeJS.Timeout | null = null;
  private thoughtElapsed = 0;
  private activePrompt: TuiPrompt | null = null;

  private isThinking = false;

  private sessionCost = 0;
  private lastNpmCheckTime = 0;
  private isCheckingNpm = false;
  private npmNeedsUpdate = false;
  private totalInputTokens = 0;
  private totalCacheReadTokens = 0;
  private totalOutputTokens = 0;
  private cacheTelemetry: {
    slabHash: string;
    slabTokenEstimate: number;
    primed: boolean;
    hitTokens: number;
    missTokens: number;
    inputTokens: number;
    hitRate: number;
    degraded: boolean;
  } | null = null;
  private budgetLimit = 0;

  private resolveInput: ((val: string | null) => void) | null = null;
  private activeRunnable: { abort: () => void } | null = null;
  private thinkingKeypressListener: ((str: string, key: any) => void) | null =
    null;
  public pendingGuidedStatement: string | null = null;

  // Throttled rendering to prevent terminal flickering during model output
  private lastRenderTime = 0;
  private renderPending = false;
  private renderTimeout: NodeJS.Timeout | null = null;
  private hasRenderedAttemptDelta = false;

  private originalWrite = process.stdout.write.bind(process.stdout);
  private hasWrittenStdoutSinceStop = false;
  private originalStdinEmit: any = null;

  private candidates: {
    commands: string[];
    files: string[];
    symbols: string[];
    sessions: string[];
  } | null = null;
  private modelNameGetter: () => string = () => this.modelName;
  private activeModelName = "";
  private permissionsMode = "normal";
  private hideAutocomplete = false;
  /** Cached logo-line widths — static strings, computed once. */
  private _cachedLogoWidths: {
    w0: number;
    w1: number;
    w2: number;
    w3: number;
    maxW: number;
  } | null = null;

  private cachedPlanLines: string[] = [];
  private lastPlanReadTime = 0;
  private activeContextFiles: Array<{
    path: string;
    reason: string;
    readOnly?: boolean;
  }> = [];
  private cachedGitSummary: {
    branch: string;
    added: number;
    modified: number;
    deleted: number;
  } | null = null;
  private lastGitSummaryReadTime = 0;
  private isRefreshingGit = false;
  private historyScrollOffset = 0;
  private maxHistoryScrollOffset = 0;
  private lastHistoryLineCount = 0;
  private hasNewOutputWhileScrolled = false;

  private getPlanLines(): string[] {
    const now = Date.now();
    if (now - this.lastPlanReadTime < 2000) {
      return this.cachedPlanLines;
    }
    this.lastPlanReadTime = now;
    const planPath2 = join(this.cwd, ".orbit", "task.md");
    const planPath1 = join(this.cwd, "task.md");
    let planPath = "";
    if (existsSync(planPath2)) {
      planPath = planPath2;
    } else if (existsSync(planPath1)) {
      planPath = planPath1;
    }
    if (!planPath) {
      this.cachedPlanLines = [];
      return [];
    }
    try {
      const content = readFileSync(planPath, "utf8");
      const lines = content.split("\n");
      const planItems: string[] = [];
      for (const line of lines) {
        const trimmed = line.trim();
        if (
          trimmed.startsWith("- [ ") ||
          trimmed.startsWith("- [x") ||
          trimmed.startsWith("- [/")
        ) {
          planItems.push(trimmed);
        }
      }
      this.cachedPlanLines = planItems;
    } catch {
      this.cachedPlanLines = [];
    }
    return this.cachedPlanLines;
  }

  public setPermissionsMode(mode: string) {
    this.permissionsMode = mode;
  }

  public setModelNameGetter(getter: () => string) {
    this.modelNameGetter = getter;
  }

  public setActiveModelName(model: string) {
    const cleanModel = model.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
    this.activeModelName = cleanModel;
    const lastAsst = [...this.history]
      .reverse()
      .find((m) => m.role === "assistant" && (!m.text || !m.model));
    if (lastAsst) {
      lastAsst.model = cleanModel;
    }
    this.render();
  }

  public setActiveRunnable(runnable: { abort: () => void } | null) {
    this.activeRunnable = runnable;
  }

  constructor(
    private cwd: string,
    private modelName: string,
    private version: string,
    private config?: any,
  ) {
    readline.emitKeypressEvents(process.stdin);
    process.stdout.write = (chunk: any, encoding?: any, cb?: any) => {
      if (!this.isActive) {
        const text = typeof chunk === "string" ? chunk : chunk.toString();
        if (text.trim().length > 0) {
          this.hasWrittenStdoutSinceStop = true;
        }
      }
      return this.originalWrite(chunk, encoding, cb);
    };
    this.loadInputHistory();
  }

  private formatSystemStatusLine(
    rawLine: string,
    prefixUnknown: boolean,
  ): string {
    const morandi = MORANDI;
    const plain = stripAnsiCodes(rawLine.trim()).trim();
    if (!plain) return "";
    if (/^(?:✓|✔)\s*Success/i.test(plain) || /^✖\s*Failed/i.test(plain)) {
      return "";
    }
    if (plain.startsWith("✔")) {
      return morandi.completed("completed") + morandi.gray(plain.substring(1));
    }
    if (plain.startsWith("✖")) {
      return morandi.failed("failed") + morandi.gray(plain.substring(1));
    }
    if (plain.startsWith("●")) {
      return morandi.cyan("●") + morandi.gray(plain.substring(1));
    }
    if (plain.startsWith("✦")) {
      return morandi.cyan("✦") + morandi.gray(plain.substring(1));
    }
    if (plain.startsWith("⚠")) {
      return morandi.warn("⚠") + morandi.gray(plain.substring(1));
    }
    if (prefixUnknown) {
      return morandi.cyan("✦") + " " + morandi.gray(plain);
    }
    return morandi.gray(plain);
  }

  private formatSystemLinesForDisplay(
    system: HistoryEntry[],
    options: { prefixUnknown: boolean; preserveBlank: boolean },
  ): string[] {
    const morandi = MORANDI;
    const lines: string[] = [];
    let liveLookupCount = 0;
    let liveLookupTool = "";
    let liveLookupResults = 0;
    let liveLookupOpenMeteo = false;
    let lastLiveLookupQuery = "";

    const flushLiveLookupSummary = () => {
      if (liveLookupCount === 0) return;
      const resultsText =
        liveLookupResults > 0 ? ` · ${liveLookupResults} results` : "";
      const sourceText = liveLookupOpenMeteo ? " · Open-Meteo" : "";
      const queryText = lastLiveLookupQuery
        ? this.truncatePlainToWidth(lastLiveLookupQuery, 42)
        : "";
      const label =
        liveLookupTool && liveLookupTool !== "mixed"
          ? liveLookupTool
          : "live_lookup";
      const summary =
        liveLookupCount === 1
          ? `${label}${queryText ? ` ${queryText}` : ""}${resultsText}${sourceText}`
          : label === "web_search"
            ? `web_search ${liveLookupCount} searches${resultsText}${
                queryText ? ` · latest: ${queryText}` : ""
              }`
            : `${label} ${liveLookupCount} lookups${resultsText}${sourceText}${
                queryText ? ` · latest: ${queryText}` : ""
              }`;
      lines.push(morandi.cyan("✦") + " " + morandi.gray(summary));
      liveLookupCount = 0;
      liveLookupTool = "";
      liveLookupResults = 0;
      liveLookupOpenMeteo = false;
      lastLiveLookupQuery = "";
    };

    for (const sys of system) {
      const rawLines = sys.text.split("\n");
      for (const rawLine of rawLines) {
        const plain = stripAnsiCodes(rawLine.trim()).trim();
        if (!plain) {
          flushLiveLookupSummary();
          if (options.preserveBlank) lines.push("");
          continue;
        }

        const liveLookupMatch = plain.match(
          /^✦\s*(?:✨\s*)?(web_search)\b\s*(.*)$/i,
        );
        if (liveLookupMatch) {
          liveLookupCount += 1;
          const toolName = liveLookupMatch[1] || "";
          liveLookupTool =
            !liveLookupTool || liveLookupTool === toolName ? toolName : "mixed";
          const query = liveLookupMatch[2]?.trim();
          if (query) lastLiveLookupQuery = query;
          continue;
        }

        const webSearchSuccess = plain.match(
          /^(?:✓|✔)\s*Success:\s*Web search returned\s+(\d+)\s+results?/i,
        );
        if (webSearchSuccess) {
          liveLookupResults += Number(webSearchSuccess[1] || 0);
          continue;
        }

        if (
          /^(?:✓|✔)\s*Success:\s*Weather data returned\b.*\bOpen-Meteo\b/i.test(
            plain,
          )
        ) {
          liveLookupOpenMeteo = true;
          continue;
        }

        if (/^⚠.*DeepSeek cache hit degraded/i.test(plain)) {
          continue;
        }

        flushLiveLookupSummary();
        const formatted = this.formatSystemStatusLine(
          rawLine,
          options.prefixUnknown,
        );
        if (formatted) {
          lines.push(formatted);
        }
      }
    }
    flushLiveLookupSummary();
    return lines;
  }

  public setCandidates(candidates: any) {
    if (!candidates) {
      this.candidates = null;
      return;
    }
    this.candidates = {
      commands: Array.isArray(candidates.commands)
        ? candidates.commands.filter((c: any) => typeof c === "string")
        : [],
      files: Array.isArray(candidates.files)
        ? candidates.files.filter((f: any) => typeof f === "string")
        : [],
      symbols: Array.isArray(candidates.symbols)
        ? candidates.symbols.filter((s: any) => typeof s === "string")
        : [],
      sessions: Array.isArray(candidates.sessions)
        ? candidates.sessions.filter((s: any) => typeof s === "string")
        : [],
    };
  }

  private getHistoryFilePath(): string {
    return join(homedir(), ".orbit", "input_history.json");
  }

  private loadInputHistory() {
    try {
      const filePath = this.getHistoryFilePath();
      if (existsSync(filePath)) {
        const raw = readFileSync(filePath, "utf8");
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          this.inputHistory = parsed.filter((x) => typeof x === "string");
        }
      }
    } catch {
      this.inputHistory = [];
    }
  }

  private saveInputHistory() {
    try {
      const filePath = this.getHistoryFilePath();
      const dir = dirname(filePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      writeFileSync(
        filePath,
        JSON.stringify(this.inputHistory, null, 2),
        "utf8",
      );
    } catch {
      // Ignore
    }
  }

  public addSystemMessage(text: string, _raw = false) {
    if (!text) return;
    this.history.push({
      role: "system",
      text: text,
    });
    this.render();
  }

  private onResize = () => {
    if (this.isActive) {
      this.render(true);
    }
  };

  public start(budgetLimit: number) {
    this.budgetLimit = budgetLimit;
    this.isActive = true;
    this.hasWrittenStdoutSinceStop = false;

    if (this.originalStdinEmit) {
      process.stdin.emit = this.originalStdinEmit;
      this.originalStdinEmit = null;
    }

    const mouseMode =
      this.config?.tui?.mouse !== false ? "\x1b[?1000h\x1b[?1006h" : "";
    process.stdout.write(`\x1b[?1049h${mouseMode}\x1b[?25l`);
    process.stdout.on("resize", this.onResize);

    if (this.config?.tui?.mouse !== false) {
      this.originalStdinEmit = process.stdin.emit;
      process.stdin.emit = (event: string, ...args: any[]) => {
        if (event === "data" && args[0]) {
          const chunk = args[0];
          const isBuffer = Buffer.isBuffer(chunk);
          let str = isBuffer ? chunk.toString("utf8") : chunk;

          const sgrRegex = /\x1b\[<(\d+);(\d+);(\d+)([mM])/g;
          let match;
          let hasMouse = false;
          while ((match = sgrRegex.exec(str)) !== null) {
            hasMouse = true;
            const button = Number(match[1]);
            if ((button & 64) !== 0) {
              const direction = (button & 1) === 0 ? "up" : "down";
              const lines = this.getWheelScrollLines();
              this.scrollHistory(direction === "up" ? lines : -lines);
            }
          }

          if (hasMouse) {
            str = str.replace(sgrRegex, "");
          }

          const normalRegex = /\x1b\[M([\s\S]{3})/g;
          if (normalRegex.test(str)) {
            str = str.replace(normalRegex, "");
            hasMouse = true;
          }

          if (hasMouse) {
            if (str.length === 0) {
              return true;
            }
            args[0] = isBuffer ? Buffer.from(str, "utf8") : str;
          }
        }
        return this.originalStdinEmit.apply(process.stdin, [event, ...args]);
      };
    }

    this.render();
  }

  public stop() {
    if (!this.isActive) return;
    this.isActive = false;
    process.stdout.off("resize", this.onResize);
    process.stdout.write("\x1b[?1006l\x1b[?1000l\x1b[?1049l\x1b[?25h");
    this.hasWrittenStdoutSinceStop = false;
    if (this.renderTimeout) {
      clearTimeout(this.renderTimeout);
      this.renderTimeout = null;
    }
    this.renderPending = false;

    if (this.originalStdinEmit) {
      process.stdin.emit = this.originalStdinEmit;
      this.originalStdinEmit = null;
    }
  }

  public dispose() {
    this.stopThinkingInput();
    this.stop();
    if (this.thoughtTimer) {
      clearInterval(this.thoughtTimer);
      this.thoughtTimer = null;
    }
    if (this.ctrlCTimeout) {
      clearTimeout(this.ctrlCTimeout);
      this.ctrlCTimeout = null;
    }
    if (process.stdin.setRawMode && process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
    process.stdout.write = this.originalWrite as typeof process.stdout.write;
  }

  private getNpmNeedsUpdate(): boolean {
    const now = Date.now();
    if (now - this.lastNpmCheckTime > 8000) {
      this.refreshNpmStatusAsync().catch(() => {});
    }
    return this.npmNeedsUpdate;
  }

  private async refreshNpmStatusAsync() {
    if (this.isCheckingNpm) return;
    this.isCheckingNpm = true;
    this.lastNpmCheckTime = Date.now();

    try {
      const packageJsonPath = join(this.cwd, "package.json");
      if (!existsSync(packageJsonPath)) {
        this.npmNeedsUpdate = false;
        this.isCheckingNpm = false;
        return;
      }

      const nodeModulesPath = join(this.cwd, "node_modules");
      if (!existsSync(nodeModulesPath)) {
        this.npmNeedsUpdate = true;
        this.isCheckingNpm = false;
        this.draw();
        return;
      }

      // Find lockfiles
      const lockfiles = [
        "package-lock.json",
        "pnpm-lock.yaml",
        "yarn.lock",
        "bun.lockb",
      ];
      let maxLockfileMtime = 0;
      let hasLockfile = false;

      for (const lf of lockfiles) {
        const lfPath = join(this.cwd, lf);
        if (existsSync(lfPath)) {
          hasLockfile = true;
          const stat = statSync(lfPath);
          if (stat.mtimeMs > maxLockfileMtime) {
            maxLockfileMtime = stat.mtimeMs;
          }
        }
      }

      // Determine what configuration time to check: check lockfiles if present, otherwise fallback to package.json
      const configMtimeToCheck = hasLockfile
        ? maxLockfileMtime
        : statSync(packageJsonPath).mtimeMs;

      // Determine the installation state time by checking state files updated on successful install
      let maxInstallStateMtime = statSync(nodeModulesPath).mtimeMs;
      const stateFiles = [
        join(nodeModulesPath, ".modules.yaml"), // pnpm
        join(nodeModulesPath, ".package-lock.json"), // npm
      ];
      for (const sf of stateFiles) {
        if (existsSync(sf)) {
          const stat = statSync(sf);
          if (stat.mtimeMs > maxInstallStateMtime) {
            maxInstallStateMtime = stat.mtimeMs;
          }
        }
      }

      this.npmNeedsUpdate = configMtimeToCheck > maxInstallStateMtime;
    } catch {
      this.npmNeedsUpdate = false;
    } finally {
      this.isCheckingNpm = false;
      this.draw();
    }
  }

  private getGitSummary() {
    const now = Date.now();
    if (!this.cachedGitSummary) {
      this.cachedGitSummary = {
        branch: "no-git",
        added: 0,
        modified: 0,
        deleted: 0,
      };
      this.refreshGitSummaryAsync().catch(() => {});
    } else if (now - this.lastGitSummaryReadTime > 8000) {
      this.refreshGitSummaryAsync().catch(() => {});
    }
    return this.cachedGitSummary;
  }

  private async refreshGitSummaryAsync() {
    if (this.isRefreshingGit) return;
    this.isRefreshingGit = true;
    this.lastGitSummaryReadTime = Date.now();

    try {
      const summary = {
        branch: "no-git",
        added: 0,
        modified: 0,
        deleted: 0,
      };

      const branchPromise = new Promise<string>((resolve) => {
        exec(
          "git rev-parse --abbrev-ref HEAD",
          { cwd: this.cwd },
          (err, stdout) => {
            if (err) resolve("no-git");
            else resolve(stdout.trim());
          },
        );
      });

      const statusPromise = new Promise<string>((resolve) => {
        exec("git status --porcelain", { cwd: this.cwd }, (err, stdout) => {
          if (err) resolve("");
          else resolve(stdout);
        });
      });

      const [branch, statusOutput] = await Promise.all([
        branchPromise,
        statusPromise,
      ]);
      summary.branch = branch;

      for (const line of statusOutput.split("\n")) {
        if (!line) continue;
        const code = line.substring(0, 2);
        if (code.includes("A") || code.includes("?")) {
          summary.added++;
        } else if (code.includes("M") || code.includes("R")) {
          summary.modified++;
        } else if (code.includes("D")) {
          summary.deleted++;
        }
      }

      this.cachedGitSummary = summary;
      this.render();
    } catch {
      // Ignored
    } finally {
      this.isRefreshingGit = false;
    }
  }

  private getWheelScrollLines(): number {
    const configured = Number(this.config?.tui?.scrollSpeed ?? 50);
    return Math.max(1, Math.min(20, Math.ceil(configured / 5)));
  }

  private scrollHistory(delta: number): void {
    this.historyScrollOffset = Math.max(
      0,
      Math.min(this.maxHistoryScrollOffset, this.historyScrollOffset + delta),
    );
    if (this.historyScrollOffset === 0) {
      this.hasNewOutputWhileScrolled = false;
    }
    this.render();
  }

  private handleScrollInput(str: string, key: any): boolean {
    const wheelDirection = parseMouseWheelDirection(str);
    if (wheelDirection) {
      const lines = this.getWheelScrollLines();
      this.scrollHistory(wheelDirection === "up" ? lines : -lines);
      return true;
    }

    const pageSize = Math.max(3, Math.floor((process.stdout.rows || 24) * 0.6));
    if (key?.name === "pageup") {
      this.scrollHistory(pageSize);
      return true;
    }
    if (key?.name === "pagedown") {
      this.scrollHistory(-pageSize);
      return true;
    }
    if (key?.name === "home" && key?.ctrl) {
      this.scrollHistory(this.maxHistoryScrollOffset);
      return true;
    }
    if (key?.name === "end" && this.historyScrollOffset > 0) {
      this.historyScrollOffset = 0;
      this.hasNewOutputWhileScrolled = false;
      this.render();
      return true;
    }
    return false;
  }

  public startThinkingInput() {
    if (!this.isActive) return;
    this.stopThinkingInput();

    if (process.stdin.setRawMode) {
      process.stdin.setRawMode(true);
    }
    process.stdin.resume();

    this.thinkingKeypressListener = (str: string, key: any) => {
      try {
        if (!this.isActive) {
          this.stopThinkingInput();
          return;
        }

        if (this.handleScrollInput(str, key)) {
          return;
        }

        if (key && key.ctrl && key.name === "c") {
          if (this.inputBuffer.length > 0) {
            this.inputBuffer = "";
            this.cursorPosition = 0;
            this.render();
          } else {
            if (this.activeRunnable) {
              this.activeRunnable.abort();
            }
          }
          return;
        }

        if (key && (key.name === "return" || key.name === "enter")) {
          const submitted = this.inputBuffer;
          if (submitted.trim()) {
            this.pendingGuidedStatement = submitted;
            if (this.activeRunnable) {
              this.activeRunnable.abort();
            }
          }
          this.inputBuffer = "";
          this.cursorPosition = 0;
          this.render();
          return;
        }

        if (key && key.ctrl && key.name === "j") {
          this.inputBuffer =
            this.inputBuffer.slice(0, this.cursorPosition) +
            "\n" +
            this.inputBuffer.slice(this.cursorPosition);
          this.cursorPosition += 1;
          this.render();
          return;
        }

        if (key && (key.name === "home" || (key.ctrl && key.name === "a"))) {
          this.cursorPosition = 0;
          this.render();
          return;
        }

        if (key && (key.name === "end" || (key.ctrl && key.name === "e"))) {
          this.cursorPosition = this.inputBuffer.length;
          this.render();
          return;
        }

        if (key && (key.ctrl || key.meta) && key.name === "left") {
          this.cursorPosition = previousWordIndex(
            this.inputBuffer,
            this.cursorPosition,
          );
          this.render();
          return;
        }

        if (key && (key.ctrl || key.meta) && key.name === "right") {
          this.cursorPosition = nextWordIndex(
            this.inputBuffer,
            this.cursorPosition,
          );
          this.render();
          return;
        }

        if (key && key.ctrl && (key.name === "backspace" || key.name === "w")) {
          if (this.cursorPosition > 0) {
            const targetPos = previousWordIndex(
              this.inputBuffer,
              this.cursorPosition,
            );
            this.inputBuffer =
              this.inputBuffer.slice(0, targetPos) +
              this.inputBuffer.slice(this.cursorPosition);
            this.cursorPosition = targetPos;
            this.render();
          }
          return;
        }

        if (key && key.ctrl && key.name === "delete") {
          if (this.cursorPosition < this.inputBuffer.length) {
            const targetPos = nextWordIndex(
              this.inputBuffer,
              this.cursorPosition,
            );
            this.inputBuffer =
              this.inputBuffer.slice(0, this.cursorPosition) +
              this.inputBuffer.slice(targetPos);
            this.render();
          }
          return;
        }

        if (key && key.ctrl && key.name === "u") {
          this.inputBuffer = "";
          this.cursorPosition = 0;
          this.render();
          return;
        }

        if (key && key.ctrl) {
          return;
        }

        if (key && key.name === "backspace") {
          if (this.cursorPosition > 0) {
            const previousIndex = previousCodePointIndex(
              this.inputBuffer,
              this.cursorPosition,
            );
            this.inputBuffer =
              this.inputBuffer.slice(0, previousIndex) +
              this.inputBuffer.slice(this.cursorPosition);
            this.cursorPosition = previousIndex;
            this.render();
          }
          return;
        }

        if (key && key.name === "delete") {
          if (this.cursorPosition < this.inputBuffer.length) {
            const nextIndex = nextCodePointIndex(
              this.inputBuffer,
              this.cursorPosition,
            );
            this.inputBuffer =
              this.inputBuffer.slice(0, this.cursorPosition) +
              this.inputBuffer.slice(nextIndex);
            this.render();
          }
          return;
        }

        if (key && key.name === "left") {
          if (this.cursorPosition > 0) {
            this.cursorPosition = previousCodePointIndex(
              this.inputBuffer,
              this.cursorPosition,
            );
            this.render();
          }
          return;
        }

        if (key && key.name === "right") {
          if (this.cursorPosition < this.inputBuffer.length) {
            this.cursorPosition = nextCodePointIndex(
              this.inputBuffer,
              this.cursorPosition,
            );
            this.render();
          }
          return;
        }

        if (str && !/[\u0000-\u001f\u007f]/.test(str)) {
          this.inputBuffer =
            this.inputBuffer.slice(0, this.cursorPosition) +
            str +
            this.inputBuffer.slice(this.cursorPosition);
          this.cursorPosition += str.length;
          this.render();
        }
      } catch (error) {
        const logDir = join(homedir(), ".orbit");
        try {
          if (!existsSync(logDir)) {
            mkdirSync(logDir, { recursive: true });
          }
          writeFileSync(
            join(logDir, "tui_error.log"),
            `[${new Date().toISOString()}] Error in thinkingKeypressListener: ${error instanceof Error ? error.stack : error}\n`,
            { flag: "a" },
          );
        } catch {}
        try {
          this.render();
        } catch {}
      }
    };

    process.stdin.on("keypress", this.thinkingKeypressListener);
  }

  public stopThinkingInput() {
    if (this.thinkingKeypressListener) {
      process.stdin.removeListener("keypress", this.thinkingKeypressListener);
      this.thinkingKeypressListener = null;
    }
  }

  private getActiveMatches(): string[] {
    if (!this.inputBuffer.startsWith("/")) return [];
    if (this.hideAutocomplete) return [];

    const line = this.inputBuffer;
    const parts = line.split(/\s+/);

    if (parts[0] === "/add" && line.includes(" ")) {
      let query = line.slice(5).trim();
      let prefix = "/add ";
      if (query.startsWith("-r ")) {
        prefix = "/add -r ";
        query = query.slice(3).trim();
      } else if (query.startsWith("--read-only ")) {
        prefix = "/add --read-only ";
        query = query.slice(12).trim();
      } else if (query.startsWith("--readonly ")) {
        prefix = "/add --readonly ";
        query = query.slice(11).trim();
      } else if (
        query === "-r" ||
        query === "--read-only" ||
        query === "--readonly"
      ) {
        query = "";
        prefix = `/add ${parts[1]} `;
      }
      const hits = rankSlashCandidates(
        (this.candidates?.files || []).map((f) => `${prefix}${f}`),
        line,
      );
      if (hits.length > 0) return hits;
    }

    if (parts[0] === "/drop" && line.includes(" ")) {
      const hits = rankSlashCandidates(
        (this.candidates?.files || []).map((f) => `/drop ${f}`),
        line,
      );
      if (hits.length > 0) return hits;
    }

    if (parts[0] === "/model" && line.includes(" ")) {
      const models = getProviderModelCandidates(this.config);

      const hits = rankSlashCandidates(
        models.map((m) => `/model ${m}`),
        line,
      );
      if (hits.length > 0) return hits;
    }

    if (parts[0] === "/chat" && line.includes(" ")) {
      // 1. If it's just "/chat " completing the subcommand
      if (parts.length <= 2) {
        const subcommands = ["list", "ls", "new", "delete", "rm", "switch"];
        const hits = rankSlashCandidates(
          subcommands.map((sub) => `/chat ${sub}`),
          line,
        );
        if (hits.length > 0) return hits;
      }

      // 2. If it's "/chat delete <query>", "/chat switch <query>", "/chat rm <query>"
      if (parts.length >= 3 && ["delete", "rm", "switch"].includes(parts[1])) {
        const cmd = parts[0];
        const sub = parts[1];
        const prefix = `${cmd} ${sub} `;
        const hits = rankSlashCandidates(
          (this.candidates?.sessions || []).map((s) => `${prefix}${s}`),
          line,
        );
        if (hits.length > 0) return hits;
      }
    }

    const cmds =
      this.candidates &&
      Array.isArray(this.candidates.commands) &&
      this.candidates.commands.length > 0
        ? this.candidates.commands
        : BUILTIN_SLASH_COMMANDS;
    return rankSlashCandidates(cmds, line);
  }

  private getSuggestion(): string {
    const line = this.inputBuffer;
    const matches = this.getActiveMatches();
    if (matches.length > 0) {
      const idx = Math.min(this.activeCommandIndex, matches.length - 1);
      const match = matches[idx];
      if (match && match !== line && match.startsWith(line)) {
        return match.substring(line.length);
      }
    }
    return "";
  }

  private acceptActiveSlashSuggestion(): string | null {
    const matches = this.getActiveMatches();
    const selected = selectActiveSlashSuggestion(
      this.inputBuffer,
      matches,
      this.activeCommandIndex,
    );
    if (selected === this.inputBuffer) return null;
    this.inputBuffer = selected;
    this.cursorPosition = selected.length;
    this.activeCommandIndex = 0;
    return selected;
  }

  private getHits(): { hits: string[]; lastWord: string } {
    const hits = this.getActiveMatches();
    return { hits, lastWord: this.inputBuffer };
  }

  public setCost(
    cost: number,
    inputTokens = 0,
    cacheReadTokens = 0,
    outputTokens = 0,
  ) {
    this.sessionCost = cost;
    this.totalInputTokens = inputTokens;
    this.totalCacheReadTokens = cacheReadTokens;
    this.totalOutputTokens = outputTokens;
    this.render();
  }

  public setCacheTelemetry(payload: {
    slabHash: string;
    slabTokenEstimate: number;
    primed: boolean;
    hitTokens: number;
    missTokens: number;
    inputTokens: number;
    hitRate: number;
    degraded: boolean;
  }) {
    this.cacheTelemetry = payload;
    this.render();
  }

  public handleThinkingDelta(text: string) {
    this.currentThinking += text;
    this.throttleRender();
  }

  public addLog(text: string) {
    if (!text || !text.trim()) return;
    const trimmed = text.trim();
    if (
      trimmed.includes("Summary:") ||
      trimmed.includes("Modified files:") ||
      trimmed.includes("Verification:") ||
      trimmed.includes("Session Cost:")
    ) {
      return;
    }
    if (text.includes("Orbit:")) {
      const cleanText = text.replace(/Orbit:\s*/i, "").trim();
      const last = this.history[this.history.length - 1];
      if (last && last.role === "assistant") {
        if (!last.text.includes(cleanText)) {
          last.text = cleanText;
        }
        this.render();
      }
      return;
    }
    if (text.includes("Thought")) {
      return;
    }

    this.history.push({
      role: "system",
      text: trimmed,
    });
    this.render();
  }

  public clearHistoryView(options: { silent?: boolean } = {}) {
    this.history = [];
    this.historyScrollOffset = 0;
    this.maxHistoryScrollOffset = 0;
    this.lastHistoryLineCount = 0;
    this.hasNewOutputWhileScrolled = false;
    this.historySearchQuery = null;
    if (!options.silent) {
      this.render();
    }
  }

  public syncFromLoop(loop: any) {
    this.activeContextFiles = loop.getRelevantFiles() || [];
    const loopHistory = loop.getHistory();
    if (loopHistory.length === 0) {
      this.render();
      return;
    }

    const localAsstIdx = this.history
      .map((m, i) => (m.role === "assistant" ? i : -1))
      .filter((i) => i !== -1);
    const loopAsst = loopHistory.filter((m: any) => m.role === "assistant");

    for (let i = 0; i < loopAsst.length; i++) {
      const loopMsg = loopAsst[i];
      const textBlock = loopMsg.content.find((b: any) => b.type === "text");
      if (textBlock && textBlock.text) {
        const localIdx = localAsstIdx[i];
        if (localIdx !== undefined) {
          this.history[localIdx].text = textBlock.text;
          this.history[localIdx].model = loopMsg.metadata?.model;
        } else {
          this.history.push({
            role: "assistant",
            text: textBlock.text,
            attempt: i + 1,
            model: loopMsg.metadata?.model,
          });
        }
      }
    }
    this.render();
  }

  public loadHistory(loopHistory: any[], options: { silent?: boolean } = {}) {
    this.clearHistoryView({ silent: true });
    let attempt = 0;
    for (const msg of loopHistory) {
      if (msg.role === "user") {
        const text = msg.content
          .map((c: any) => (c.type === "text" ? c.text : ""))
          .join("");
        if (text === "REPL Interactive Shell Started") {
          continue;
        }
        this.history.push({
          role: "user",
          text,
        });
      } else if (msg.role === "assistant") {
        attempt++;
        const textBlock = msg.content.find((b: any) => b.type === "text");
        this.history.push({
          role: "assistant",
          text: textBlock?.text || "",
          attempt,
          model: msg.metadata?.model,
        });
      } else if (msg.role === "system") {
        const text = msg.content
          .map((c: any) => (c.type === "text" ? c.text : ""))
          .join("");
        this.history.push({
          role: "system",
          text,
        });
      }
    }
    if (!options.silent) {
      this.render();
    }
  }

  private getPromptOptionIndices(prompt: TuiPrompt): number[] {
    return filterPromptOptionIndices(prompt.options, prompt.filterQuery);
  }

  private ensurePromptSelectionVisible(prompt: TuiPrompt): number[] {
    const indices = this.getPromptOptionIndices(prompt);
    if (indices.length > 0 && !indices.includes(prompt.selectedIndex)) {
      prompt.selectedIndex = indices[0];
    }
    return indices;
  }

  private movePromptSelection(prompt: TuiPrompt, delta: number): void {
    const indices = this.ensurePromptSelectionVisible(prompt);
    if (indices.length === 0) return;

    const currentPosition = Math.max(0, indices.indexOf(prompt.selectedIndex));
    const nextPosition =
      (currentPosition + delta + indices.length * 1000) % indices.length;
    prompt.selectedIndex = indices[nextPosition];
  }

  private setPromptSelectionToEdge(
    prompt: TuiPrompt,
    edge: "first" | "last",
  ): void {
    const indices = this.ensurePromptSelectionVisible(prompt);
    if (indices.length === 0) return;
    prompt.selectedIndex =
      edge === "first" ? indices[0] : indices[indices.length - 1];
  }

  private truncatePlainToWidth(text: string, maxWidth: number): string {
    if (maxWidth <= 0) return "";
    const plain = stripAnsiCodes(text);
    if (this.getStringWidth(plain) <= maxWidth) return plain;
    if (maxWidth <= 3) return this.truncateToWidth(plain, maxWidth);
    return this.truncateToWidth(plain, maxWidth - 3) + "...";
  }

  private getCursorPositionInWrappedInput(
    wrappedInputLines: WrappedInputLine[],
  ): { lineIndex: number; xOffset: number } {
    for (let i = 0; i < wrappedInputLines.length; i++) {
      const line = wrappedInputLines[i];
      if (
        this.cursorPosition >= line.start &&
        this.cursorPosition <= line.end
      ) {
        const subStr = line.text.substring(
          0,
          Math.max(0, this.cursorPosition - line.start),
        );
        return { lineIndex: i, xOffset: this.getStringWidth(subStr) };
      }
    }
    const lastIndex = Math.max(0, wrappedInputLines.length - 1);
    const lastLine = wrappedInputLines[lastIndex] || {
      text: "",
      start: 0,
      end: 0,
    };
    return {
      lineIndex: lastIndex,
      xOffset: this.getStringWidth(lastLine.text),
    };
  }

  public showPrompt(config: {
    type: "select" | "multiselect" | "text" | "confirm" | "password";
    message: string;
    options?: PromptOption[];
    initialValue?: string;
    initialSelectedValue?: string;
    deletable?: boolean;
    suppressCloseRenderOnDelete?: boolean;
  }): Promise<any> {
    return new Promise((resolve) => {
      const options = config.options || [];
      this.activePrompt = {
        type: config.type,
        message: config.message,
        options,
        initialValue: config.initialValue || "",
        initialSelectedValue: config.initialSelectedValue,
        deletable: config.deletable,
        suppressCloseRenderOnDelete: config.suppressCloseRenderOnDelete,
        pendingDeleteValue: null,
        pendingDeleteAt: 0,
        filterQuery: "",
        filterActive: false,
        resolve,
        selectedIndex: 0,
        selectedValues: new Set(),
        inputValue: config.initialValue || "",
        cursorPosition: (config.initialValue || "").length,
      };

      if (config.type === "confirm") {
        this.activePrompt.options = [
          { value: "yes", label: "Yes" },
          { value: "no", label: "No" },
        ];
      }
      if (
        config.initialSelectedValue &&
        (config.type === "select" || config.type === "multiselect")
      ) {
        const initialIndex = this.activePrompt.options.findIndex(
          (option) => option.value === config.initialSelectedValue,
        );
        if (initialIndex >= 0) {
          this.activePrompt.selectedIndex = initialIndex;
        }
      }

      this.render();

      const wasRaw = !!process.stdin.isRaw;
      if (process.stdin.setRawMode) {
        process.stdin.setRawMode(true);
      }
      process.stdin.resume();

      const onPromptKeypress = (str: string, key: any) => {
        if (!this.activePrompt) {
          cleanup();
          return;
        }

        try {
          const prompt = this.activePrompt;
          const options = prompt.options;
          const completePrompt = (value: any) => {
            cleanup();
            this.activePrompt = null;
            const isDeleteAction =
              value && typeof value === "object" && value.action === "delete";
            if (!isDeleteAction || !prompt.suppressCloseRenderOnDelete) {
              this.render();
            }
            resolve(value);
          };
          const clearPendingDelete = () => {
            prompt.pendingDeleteValue = null;
            prompt.pendingDeleteAt = 0;
          };
          const isListPrompt =
            prompt.type === "select" || prompt.type === "multiselect";
          const moveSelection = (delta: number) => {
            clearPendingDelete();
            this.movePromptSelection(prompt, delta);
            this.render();
          };

          if (key && key.ctrl && key.name === "c") {
            if (prompt.type === "confirm") {
              completePrompt(false);
            } else if (prompt.deletable && prompt.type === "select") {
              completePrompt({ action: "cancel" });
            } else {
              completePrompt(null);
            }
            return;
          }

          if (isListPrompt && key && key.name === "/" && !prompt.filterActive) {
            clearPendingDelete();
            prompt.filterActive = true;
            this.render();
            return;
          }

          if (isListPrompt && prompt.filterActive) {
            if (key && key.name === "escape") {
              clearPendingDelete();
              if (prompt.filterQuery.length > 0) {
                prompt.filterQuery = "";
                this.ensurePromptSelectionVisible(prompt);
              } else {
                prompt.filterActive = false;
              }
              this.render();
              return;
            }

            if (key && key.ctrl && key.name === "u") {
              clearPendingDelete();
              prompt.filterQuery = "";
              this.ensurePromptSelectionVisible(prompt);
              this.render();
              return;
            }

            if (key && key.name === "backspace") {
              clearPendingDelete();
              const previousIndex = previousCodePointIndex(
                prompt.filterQuery,
                prompt.filterQuery.length,
              );
              prompt.filterQuery = prompt.filterQuery.slice(0, previousIndex);
              this.ensurePromptSelectionVisible(prompt);
              this.render();
              return;
            }

            if (
              str &&
              !key?.ctrl &&
              !key?.meta &&
              !/[\u0000-\u001f\u007f]/.test(str)
            ) {
              clearPendingDelete();
              prompt.filterQuery += str;
              this.ensurePromptSelectionVisible(prompt);
              this.render();
              return;
            }
          }

          if (key && key.name === "escape") {
            if (prompt.type === "confirm") {
              completePrompt(false);
            } else if (prompt.deletable && prompt.type === "select") {
              completePrompt({ action: "cancel" });
            } else {
              completePrompt(null);
            }
            return;
          }

          if (key && (key.name === "return" || key.name === "enter")) {
            if (prompt.type === "select") {
              const indices = this.ensurePromptSelectionVisible(prompt);
              if (indices.length === 0) {
                this.render();
                return;
              }
              const value = options[prompt.selectedIndex]?.value || null;
              completePrompt(
                prompt.deletable && value ? { action: "select", value } : value,
              );
            } else if (prompt.type === "confirm") {
              completePrompt(options[prompt.selectedIndex]?.value === "yes");
            } else if (prompt.type === "multiselect") {
              completePrompt(Array.from(prompt.selectedValues));
            } else if (prompt.type === "text" || prompt.type === "password") {
              completePrompt(prompt.inputValue);
            }
            return;
          }

          if (
            prompt.type === "select" ||
            prompt.type === "confirm" ||
            prompt.type === "multiselect"
          ) {
            const visibleIndices =
              prompt.type === "confirm"
                ? options.map((_, index) => index)
                : this.ensurePromptSelectionVisible(prompt);
            if (visibleIndices.length === 0) {
              return;
            }

            if (
              prompt.type === "select" &&
              prompt.deletable &&
              key &&
              key.name === "delete"
            ) {
              const option = options[prompt.selectedIndex];
              if (
                !option ||
                option.deleteDisabled ||
                !visibleIndices.includes(prompt.selectedIndex)
              ) {
                clearPendingDelete();
                this.render();
                return;
              }

              const armed = prompt.pendingDeleteValue === option.value;
              if (armed) {
                completePrompt({ action: "delete", value: option.value });
                return;
              }

              prompt.pendingDeleteValue = option.value;
              prompt.pendingDeleteAt = Date.now();
              this.render();
              return;
            }

            if (key && (key.name === "up" || str === "k")) {
              moveSelection(-1);
              return;
            }
            if (key && (key.name === "down" || str === "j")) {
              moveSelection(1);
              return;
            }
            if (key && key.name === "home") {
              clearPendingDelete();
              this.setPromptSelectionToEdge(prompt, "first");
              this.render();
              return;
            }
            if (key && key.name === "end") {
              clearPendingDelete();
              this.setPromptSelectionToEdge(prompt, "last");
              this.render();
              return;
            }
            if (key && key.name === "pageup") {
              moveSelection(-8);
              return;
            }
            if (key && key.name === "pagedown") {
              moveSelection(8);
              return;
            }
            if (
              prompt.type === "multiselect" &&
              key &&
              (key.name === "space" || str === " ")
            ) {
              const val = options[prompt.selectedIndex]?.value;
              if (val) {
                if (prompt.selectedValues.has(val)) {
                  prompt.selectedValues.delete(val);
                } else {
                  prompt.selectedValues.add(val);
                }
              }
              this.render();
              return;
            }
          } else if (prompt.type === "text" || prompt.type === "password") {
            if (
              key &&
              (key.name === "home" || (key.ctrl && key.name === "a"))
            ) {
              prompt.cursorPosition = 0;
              this.render();
              return;
            }
            if (key && (key.name === "end" || (key.ctrl && key.name === "e"))) {
              prompt.cursorPosition = prompt.inputValue.length;
              this.render();
              return;
            }
            if (key && (key.ctrl || key.meta) && key.name === "left") {
              prompt.cursorPosition = previousWordIndex(
                prompt.inputValue,
                prompt.cursorPosition,
              );
              this.render();
              return;
            }
            if (key && (key.ctrl || key.meta) && key.name === "right") {
              prompt.cursorPosition = nextWordIndex(
                prompt.inputValue,
                prompt.cursorPosition,
              );
              this.render();
              return;
            }
            if (
              key &&
              key.ctrl &&
              (key.name === "backspace" || key.name === "w")
            ) {
              if (prompt.cursorPosition > 0) {
                const targetPos = previousWordIndex(
                  prompt.inputValue,
                  prompt.cursorPosition,
                );
                prompt.inputValue =
                  prompt.inputValue.slice(0, targetPos) +
                  prompt.inputValue.slice(prompt.cursorPosition);
                prompt.cursorPosition = targetPos;
                this.render();
              }
              return;
            }
            if (key && key.ctrl && key.name === "u") {
              prompt.inputValue = prompt.inputValue.slice(
                prompt.cursorPosition,
              );
              prompt.cursorPosition = 0;
              this.render();
              return;
            }
            if (key && key.name === "backspace") {
              if (prompt.cursorPosition > 0) {
                const previousIndex = previousCodePointIndex(
                  prompt.inputValue,
                  prompt.cursorPosition,
                );
                prompt.inputValue =
                  prompt.inputValue.substring(0, previousIndex) +
                  prompt.inputValue.substring(prompt.cursorPosition);
                prompt.cursorPosition = previousIndex;
                this.render();
              }
              return;
            }
            if (key && key.name === "delete") {
              if (prompt.cursorPosition < prompt.inputValue.length) {
                const nextIndex = nextCodePointIndex(
                  prompt.inputValue,
                  prompt.cursorPosition,
                );
                prompt.inputValue =
                  prompt.inputValue.substring(0, prompt.cursorPosition) +
                  prompt.inputValue.substring(nextIndex);
                this.render();
              }
              return;
            }
            if (key && key.name === "left") {
              if (prompt.cursorPosition > 0) {
                prompt.cursorPosition = previousCodePointIndex(
                  prompt.inputValue,
                  prompt.cursorPosition,
                );
                this.render();
              }
              return;
            }
            if (key && key.name === "right") {
              if (prompt.cursorPosition < prompt.inputValue.length) {
                prompt.cursorPosition = nextCodePointIndex(
                  prompt.inputValue,
                  prompt.cursorPosition,
                );
                this.render();
              }
              return;
            }
            if (
              str &&
              !key?.ctrl &&
              !key?.meta &&
              !/[\u0000-\u001f\u007f]/.test(str)
            ) {
              prompt.inputValue =
                prompt.inputValue.substring(0, prompt.cursorPosition) +
                str +
                prompt.inputValue.substring(prompt.cursorPosition);
              prompt.cursorPosition += str.length;
              this.render();
              return;
            }
          }
        } catch {}
      };

      const cleanup = () => {
        process.stdin.removeListener("keypress", onPromptKeypress);
        if (process.stdin.setRawMode) {
          process.stdin.setRawMode(wasRaw);
        }
      };

      process.stdin.on("keypress", onPromptKeypress);
    });
  }

  public async askInput(options: AskInputOptions = {}): Promise<string | null> {
    if (!this.isActive) {
      if (this.hasWrittenStdoutSinceStop) {
        const wasRaw = !!process.stdin.isRaw;
        if (process.stdin.setRawMode) {
          process.stdin.setRawMode(false);
        }
        await Prompt.askText("Press Enter to return to Orbit...");
        if (process.stdin.setRawMode) {
          process.stdin.setRawMode(wasRaw);
        }
        this.hasWrittenStdoutSinceStop = false;
      }
      this.start(this.budgetLimit);
    }
    process.stdout.write("\x1b[?25h");

    return new Promise((resolve) => {
      this.resolveInput = resolve;
      this.inputBuffer = "";
      this.cursorPosition = 0;
      this.hideAutocomplete = false;
      this.historySearchQuery = null;
      this.render();

      const wasRaw = !!process.stdin.isRaw;
      if (process.stdin.setRawMode) {
        process.stdin.setRawMode(true);
      }
      process.stdin.resume();

      const onKeypress = (str: string, key: any) => {
        try {
          if (!this.isActive) {
            cleanup();
            return;
          }

          if (this.handleScrollInput(str, key)) {
            return;
          }

          if (key && key.ctrl && key.name === "c") {
            this.activeCommandIndex = 0;
            this.historySearchQuery = null;
            if (this.inputBuffer.length > 0) {
              this.inputBuffer = "";
              this.cursorPosition = 0;
              this.render();
            } else {
              if (this.ctrlCPressedOnce) {
                if (this.ctrlCTimeout) clearTimeout(this.ctrlCTimeout);
                cleanup();
                this.stop();
                process.exit(0);
              } else {
                this.ctrlCPressedOnce = true;
                if (this.ctrlCTimeout) clearTimeout(this.ctrlCTimeout);
                this.ctrlCTimeout = setTimeout(() => {
                  this.ctrlCPressedOnce = false;
                  this.render();
                }, 2000);
                this.render();
              }
            }
            return;
          }

          if (key && key.ctrl && key.name === "r") {
            const query = this.historySearchQuery ?? this.inputBuffer;
            const startIndex =
              this.historyIndex >= 0
                ? this.historyIndex
                : this.inputHistory.length;
            const match = findPreviousHistoryEntry(
              this.inputHistory,
              query,
              startIndex,
            );
            if (match) {
              this.historySearchQuery = query;
              this.historyIndex = match.index;
              this.inputBuffer = match.entry;
              this.cursorPosition = this.inputBuffer.length;
              this.activeCommandIndex = 0;
              this.hideAutocomplete = true;
              this.render();
            }
            return;
          }

          if (key && (key.name === "return" || key.name === "enter")) {
            cleanup();
            process.stdout.write("\x1b[?25l");
            const submitted =
              this.acceptActiveSlashSuggestion() || this.inputBuffer;
            this.historySearchQuery = null;
            this.resolveInput = null;
            this.historyScrollOffset = 0;
            this.hasNewOutputWhileScrolled = false;

            if (submitted.trim()) {
              const echoSubmitted =
                typeof options.echoSubmitted === "function"
                  ? options.echoSubmitted(submitted)
                  : options.echoSubmitted !== false;
              if (echoSubmitted) {
                this.history.push({ role: "user", text: submitted });
              }
              if (
                this.inputHistory[this.inputHistory.length - 1] !== submitted
              ) {
                this.inputHistory.push(submitted);
                this.saveInputHistory();
              }
            }
            this.historyIndex = -1;
            this.inputBuffer = "";
            this.cursorPosition = 0;
            this.render();
            resolve(submitted);
            return;
          }

          if (key && key.ctrl && key.name === "j") {
            this.activeCommandIndex = 0;
            this.historySearchQuery = null;
            this.hideAutocomplete = true;
            this.inputBuffer =
              this.inputBuffer.slice(0, this.cursorPosition) +
              "\n" +
              this.inputBuffer.slice(this.cursorPosition);
            this.cursorPosition += 1;
            this.render();
            return;
          }

          if (key && (key.name === "home" || (key.ctrl && key.name === "a"))) {
            this.activeCommandIndex = 0;
            this.historySearchQuery = null;
            this.cursorPosition = 0;
            this.render();
            return;
          }

          if (key && (key.name === "end" || (key.ctrl && key.name === "e"))) {
            this.activeCommandIndex = 0;
            this.historySearchQuery = null;
            this.cursorPosition = this.inputBuffer.length;
            this.render();
            return;
          }

          if (key && (key.ctrl || key.meta) && key.name === "left") {
            this.activeCommandIndex = 0;
            this.historySearchQuery = null;
            this.cursorPosition = previousWordIndex(
              this.inputBuffer,
              this.cursorPosition,
            );
            this.render();
            return;
          }

          if (key && (key.ctrl || key.meta) && key.name === "right") {
            this.activeCommandIndex = 0;
            this.historySearchQuery = null;
            this.cursorPosition = nextWordIndex(
              this.inputBuffer,
              this.cursorPosition,
            );
            this.render();
            return;
          }

          if (
            key &&
            key.ctrl &&
            (key.name === "backspace" || key.name === "w")
          ) {
            this.activeCommandIndex = 0;
            this.hideAutocomplete = false;
            this.historySearchQuery = null;
            if (this.cursorPosition > 0) {
              const targetPos = previousWordIndex(
                this.inputBuffer,
                this.cursorPosition,
              );
              this.inputBuffer =
                this.inputBuffer.slice(0, targetPos) +
                this.inputBuffer.slice(this.cursorPosition);
              this.cursorPosition = targetPos;
              this.render();
            }
            return;
          }

          if (key && key.ctrl && key.name === "delete") {
            this.activeCommandIndex = 0;
            this.hideAutocomplete = false;
            this.historySearchQuery = null;
            if (this.cursorPosition < this.inputBuffer.length) {
              const targetPos = nextWordIndex(
                this.inputBuffer,
                this.cursorPosition,
              );
              this.inputBuffer =
                this.inputBuffer.slice(0, this.cursorPosition) +
                this.inputBuffer.slice(targetPos);
              this.render();
            }
            return;
          }

          if (key && key.ctrl && key.name === "u") {
            this.activeCommandIndex = 0;
            this.hideAutocomplete = false;
            this.historySearchQuery = null;
            this.inputBuffer = "";
            this.cursorPosition = 0;
            this.render();
            return;
          }

          if (key && key.name === "up") {
            this.historySearchQuery = null;
            if (this.inputBuffer.startsWith("/")) {
              const matches = this.getActiveMatches();
              if (matches.length > 0) {
                this.activeCommandIndex =
                  (this.activeCommandIndex - 1 + matches.length) %
                  matches.length;
                this.render();
                return;
              }
            }
            if (this.inputHistory.length > 0) {
              if (this.historyIndex === -1) {
                this.tempBuffer = this.inputBuffer;
                this.historyIndex = this.inputHistory.length - 1;
              } else if (this.historyIndex > 0) {
                this.historyIndex--;
              }
              this.inputBuffer = this.inputHistory[this.historyIndex];
              this.hideAutocomplete = false;
              this.cursorPosition = this.inputBuffer.length;
              this.render();
            }
            return;
          }

          if (key && key.name === "down") {
            this.historySearchQuery = null;
            if (this.inputBuffer.startsWith("/")) {
              const matches = this.getActiveMatches();
              if (matches.length > 0) {
                this.activeCommandIndex =
                  (this.activeCommandIndex + 1) % matches.length;
                this.render();
                return;
              }
            }
            if (this.historyIndex !== -1) {
              if (this.historyIndex < this.inputHistory.length - 1) {
                this.historyIndex++;
                this.inputBuffer = this.inputHistory[this.historyIndex];
              } else {
                this.historyIndex = -1;
                this.inputBuffer = this.tempBuffer || "";
              }
              this.hideAutocomplete = false;
              this.cursorPosition = this.inputBuffer.length;
              this.render();
            }
            return;
          }

          if (key && key.name === "left") {
            this.historySearchQuery = null;
            if (this.cursorPosition > 0) {
              this.cursorPosition = previousCodePointIndex(
                this.inputBuffer,
                this.cursorPosition,
              );
              this.render();
            }
            return;
          }

          if (key && key.name === "right") {
            this.historySearchQuery = null;
            if (this.cursorPosition < this.inputBuffer.length) {
              this.cursorPosition = nextCodePointIndex(
                this.inputBuffer,
                this.cursorPosition,
              );
              this.render();
            } else {
              const accepted = this.acceptActiveSlashSuggestion();
              if (accepted) {
                this.cursorPosition = this.inputBuffer.length;
                this.render();
              }
            }
            return;
          }

          if (key && key.name === "tab") {
            this.historySearchQuery = null;
            if (this.inputBuffer.startsWith("/")) {
              const accepted = this.acceptActiveSlashSuggestion();
              if (accepted) {
                this.render();
                return;
              }
            }
            const sug = this.getSuggestion();
            if (sug) {
              this.inputBuffer += sug;
              this.cursorPosition = this.inputBuffer.length;
              this.render();
            }
            return;
          }

          if (key && key.ctrl && key.name === "l") {
            this.clearHistoryView();
            return;
          }

          if (key && key.ctrl && key.name === "p") {
            this.activeCommandIndex = 0;
            this.hideAutocomplete = false;
            this.historySearchQuery = null;
            if (!this.inputBuffer.startsWith("/")) {
              this.inputBuffer = "/" + this.inputBuffer;
              this.cursorPosition = this.inputBuffer.length;
            }
            this.render();
            return;
          }

          if (key && key.name === "delete") {
            this.activeCommandIndex = 0;
            this.hideAutocomplete = false;
            this.historySearchQuery = null;
            if (this.cursorPosition < this.inputBuffer.length) {
              const nextIndex = nextCodePointIndex(
                this.inputBuffer,
                this.cursorPosition,
              );
              this.inputBuffer =
                this.inputBuffer.substring(0, this.cursorPosition) +
                this.inputBuffer.substring(nextIndex);
              this.render();
            }
            return;
          }

          if (key && key.name === "backspace") {
            this.activeCommandIndex = 0;
            this.hideAutocomplete = false;
            this.historySearchQuery = null;
            if (this.cursorPosition > 0) {
              const previousIndex = previousCodePointIndex(
                this.inputBuffer,
                this.cursorPosition,
              );
              this.inputBuffer =
                this.inputBuffer.substring(0, previousIndex) +
                this.inputBuffer.substring(this.cursorPosition);
              this.cursorPosition = previousIndex;
            }
          } else if (key && key.name === "escape") {
            this.activeCommandIndex = 0;
            this.historySearchQuery = null;
            if (!this.hideAutocomplete) {
              this.hideAutocomplete = true;
            }
            this.render();
          } else if (
            str &&
            !/[\u0000-\u001f\u007f]/.test(str) &&
            (!key || (!key.ctrl && !key.meta && key.name !== "tab"))
          ) {
            this.activeCommandIndex = 0;
            this.hideAutocomplete = false;
            this.historySearchQuery = null;
            this.inputBuffer =
              this.inputBuffer.substring(0, this.cursorPosition) +
              str +
              this.inputBuffer.substring(this.cursorPosition);
            this.cursorPosition += str.length;
          }

          this.render();
        } catch (error) {
          const logDir = join(homedir(), ".orbit");
          try {
            if (!existsSync(logDir)) {
              mkdirSync(logDir, { recursive: true });
            }
            writeFileSync(
              join(logDir, "tui_error.log"),
              `[${new Date().toISOString()}] Error in onKeypress: ${error instanceof Error ? error.stack : error}\n`,
              { flag: "a" },
            );
          } catch {}
          try {
            this.render();
          } catch {}
        }
      };

      const cleanup = () => {
        process.stdin.removeListener("keypress", onKeypress);
        if (process.stdin.setRawMode) {
          process.stdin.setRawMode(wasRaw);
        }
        process.stdin.pause();
      };

      process.stdin.on("keypress", onKeypress);
    });
  }

  public startAttempt(attempt: number) {
    this.currentAttempt = attempt;
    this.attemptStartTime = Date.now();
    this.firstDeltaTime = 0;
    this.isThinking = true;
    this.thoughtElapsed = 0;
    this.currentThinking = "";
    this.hasRenderedAttemptDelta = false;
    this.lastRenderTime = 0;
    if (this.renderTimeout) {
      clearTimeout(this.renderTimeout);
      this.renderTimeout = null;
    }
    this.renderPending = false;

    this.history.push({
      role: "assistant",
      text: "",
      attempt: attempt,
      model: this.activeModelName || this.modelNameGetter(),
    });

    if (this.thoughtTimer) clearInterval(this.thoughtTimer);
    this.thoughtTimer = setInterval(() => {
      if (this.isThinking) {
        this.thoughtElapsed += 100;
        this.render();
      }
    }, 100);

    this.render();
  }

  public handleModelDelta(text: string) {
    const lastAsst = [...this.history]
      .reverse()
      .find((m) => m.role === "assistant");
    if (lastAsst) {
      if (this.isThinking && text.trim().length > 0) {
        this.isThinking = false;
        if (this.thoughtTimer) {
          clearInterval(this.thoughtTimer);
          this.thoughtTimer = null;
        }
        lastAsst.thoughtTime = Date.now() - this.attemptStartTime;
      }
      lastAsst.text += text;
      this.throttleRender();
    }
  }

  private throttleRender() {
    const now = Date.now();
    const minInterval = this.getStreamRenderIntervalMs();
    if (!this.hasRenderedAttemptDelta) {
      this.hasRenderedAttemptDelta = true;
      if (this.renderTimeout) {
        clearTimeout(this.renderTimeout);
        this.renderTimeout = null;
      }
      this.renderPending = false;
      this.lastRenderTime = now;
      this.render();
      return;
    }

    if (now - this.lastRenderTime >= minInterval) {
      if (this.renderTimeout) {
        clearTimeout(this.renderTimeout);
        this.renderTimeout = null;
      }
      this.renderPending = false;
      this.lastRenderTime = now;
      this.render();
    } else if (!this.renderPending) {
      this.renderPending = true;
      this.renderTimeout = setTimeout(
        () => {
          this.renderPending = false;
          this.lastRenderTime = Date.now();
          this.render();
        },
        minInterval - (now - this.lastRenderTime),
      );
    }
  }

  private getStreamRenderIntervalMs(): number {
    const lastAsst = [...this.history]
      .reverse()
      .find((m) => m.role === "assistant");
    const streamedChars =
      (lastAsst?.text.length || 0) + this.currentThinking.length;
    if (streamedChars < 1200) return 16;
    if (streamedChars < 6000) return 32;
    return 60;
  }

  public finishAttempt() {
    const lastAsst = [...this.history]
      .reverse()
      .find((m) => m.role === "assistant");
    if (lastAsst) {
      this.isThinking = false;
      if (this.thoughtTimer) {
        clearInterval(this.thoughtTimer);
        this.thoughtTimer = null;
      }
      lastAsst.totalTime = Date.now() - this.attemptStartTime;
      if (lastAsst.thoughtTime === undefined) {
        lastAsst.thoughtTime = lastAsst.totalTime;
      }
      this.render();
    }
  }

  public render(forceFull = false) {
    const columns = Math.max(40, process.stdout.columns || 80);
    const rows = Math.max(10, process.stdout.rows || 24);

    // Use the shared MORANDI constant (class-level) instead of recreating per frame
    const morandi = MORANDI;

    if (this.activePrompt) {
      const prompt = this.activePrompt;
      const options = prompt.options;
      const isZh = this.config?.language === "zh";

      const title =
        prompt.type === "confirm"
          ? isZh
            ? "确认"
            : "Confirmation"
          : prompt.type === "select"
            ? isZh
              ? "选择"
              : "Selection"
            : prompt.type === "multiselect"
              ? isZh
                ? "多选"
                : "Multi-Selection"
              : isZh
                ? "输入"
                : "Input";

      const lines: string[] = [];
      lines.push("");
      lines.push(morandi.userBold("  Orbit " + title));
      lines.push(morandi.gray("  " + "─".repeat(columns - 4)));
      lines.push("");
      const messageLines = prompt.message
        .split("\n")
        .flatMap((line) => this.wrapLine(stripAnsiCodes(line), columns - 8));
      for (let i = 0; i < Math.min(messageLines.length, 5); i++) {
        const prefix = i === 0 ? "? " : "  ";
        lines.push(
          "  " + morandi.cyan(prefix) + morandi.white(messageLines[i]),
        );
      }
      if (messageLines.length > 5) {
        lines.push(
          "  " +
            morandi.dim(
              isZh
                ? `... 还有 ${messageLines.length - 5} 行`
                : `... ${messageLines.length - 5} more line(s)`,
            ),
        );
      }
      lines.push("");

      let inputLineRow = 0;
      if (
        prompt.type === "select" ||
        prompt.type === "confirm" ||
        prompt.type === "multiselect"
      ) {
        const isSearchable =
          prompt.type === "select" || prompt.type === "multiselect";
        const filteredIndices =
          prompt.type === "confirm"
            ? options.map((_, index) => index)
            : this.ensurePromptSelectionVisible(prompt);
        const L = filteredIndices.length;
        if (isSearchable && (prompt.filterActive || prompt.filterQuery)) {
          const queryText = prompt.filterQuery || "";
          const searchLabel = isZh ? "过滤" : "filter";
          const placeholder = isZh ? "输入关键字" : "type keywords";
          const visibleQuery =
            queryText.length > 0 ? queryText : morandi.dim(placeholder);
          const cursor = prompt.filterActive ? morandi.accent("▌") : "";
          lines.push(
            "  " +
              morandi.dim(`${searchLabel}: `) +
              morandi.white(stripAnsiCodes(visibleQuery)) +
              cursor +
              morandi.dim(`  ${L}/${options.length}`),
          );
          lines.push("");
        }

        const maxVisible = Math.max(5, Math.min(12, rows - lines.length - 6));

        let startIdx = 0;
        const selectedFilteredIndex = filteredIndices.indexOf(
          prompt.selectedIndex,
        );
        if (selectedFilteredIndex >= maxVisible) {
          startIdx = selectedFilteredIndex - maxVisible + 1;
        }
        if (startIdx + maxVisible > L) {
          startIdx = L - maxVisible;
        }
        if (startIdx < 0) startIdx = 0;

        const visibleOptionIndices = filteredIndices.slice(
          startIdx,
          startIdx + maxVisible,
        );

        if (startIdx > 0) {
          lines.push(
            morandi.gray(
              isZh ? "    ▲ 上方还有更多选项" : "    ▲ more options above",
            ),
          );
        }

        if (visibleOptionIndices.length === 0) {
          lines.push(
            "    " +
              morandi.warn(
                isZh
                  ? "没有匹配项，按 Esc 清空过滤"
                  : "No matches. Press Esc to clear the filter.",
              ),
          );
        }

        for (let i = 0; i < visibleOptionIndices.length; i++) {
          const actualIdx = visibleOptionIndices[i];
          const opt = options[actualIdx];
          const isSelected = actualIdx === prompt.selectedIndex;
          const isChecked = prompt.selectedValues.has(opt.value);
          const deleteArmed =
            !!prompt.deletable && prompt.pendingDeleteValue === opt.value;

          let prefix = "    ";
          if (prompt.type === "multiselect") {
            prefix = isChecked ? "[x] " : "[ ] ";
          }

          let lineText = prefix + stripAnsiCodes(opt.label);
          if (opt.hint) {
            lineText += ` (${stripAnsiCodes(opt.hint)})`;
          }
          if (deleteArmed) {
            lineText += isZh ? "  再按 Del 删除" : "  Del again to delete";
          } else if (
            prompt.deletable &&
            prompt.type === "select" &&
            isSelected &&
            !opt.deleteDisabled
          ) {
            lineText += isZh ? "  Del 标记删除" : "  Del to delete";
          }

          const marker = isSelected ? (deleteArmed ? "  ! " : "  ❯ ") : "    ";
          const clipped = this.truncatePlainToWidth(
            lineText.trim(),
            Math.max(8, columns - this.getStringWidth(marker) - 6),
          );
          if (isSelected) {
            const paint = deleteArmed ? morandi.warn : morandi.accent;
            lines.push(paint(marker + clipped));
          } else {
            lines.push(marker + morandi.gray(clipped));
          }
        }

        if (startIdx + maxVisible < L) {
          lines.push(
            morandi.gray(
              isZh ? "    ▼ 下方还有更多选项" : "    ▼ more options below",
            ),
          );
        }
      } else if (prompt.type === "text" || prompt.type === "password") {
        inputLineRow = lines.length + 1;
        const displayVal =
          prompt.type === "password"
            ? "*".repeat(prompt.inputValue.length)
            : prompt.inputValue;
        lines.push("  " + displayVal);
        lines.push(
          "  " + morandi.gray("─".repeat(Math.max(20, displayVal.length + 4))),
        );
      }

      // Add padding space
      const remainingHeight = rows - lines.length - 5;
      for (let i = 0; i < remainingHeight; i++) {
        lines.push("");
      }

      // Slim cat watermark aligned to bottom-right
      const catWidth = 7;
      const leftPad = " ".repeat(Math.max(0, columns - catWidth - 4));
      lines.push(leftPad + morandi.gray(" /\\ /\\ "));
      lines.push(leftPad + morandi.gray("/ °_° \\"));

      // Footer
      lines.push(morandi.gray("  " + "─".repeat(columns - 4)));
      let footerHelp = "";
      if (
        (prompt.type === "select" || prompt.type === "multiselect") &&
        prompt.filterActive
      ) {
        footerHelp = isZh
          ? "输入过滤 · Backspace 删除 · Ctrl+U 清空 · ↑/↓ 选择 · Enter 确认 · Esc 退出过滤"
          : "type to filter · Backspace edit · Ctrl+U clear · ↑/↓ move · Enter confirm · Esc exit filter";
      } else if (prompt.type === "multiselect") {
        footerHelp = isZh
          ? "↑/↓/j/k 选择 · / 过滤 · Space 勾选 · Enter 确认 · Esc 取消"
          : "↑/↓/j/k move · / filter · Space toggle · Enter confirm · Esc cancel";
      } else if (prompt.type === "select" && prompt.deletable) {
        footerHelp = isZh
          ? "↑/↓/j/k 选择 · / 过滤 · Enter 打开 · Del 标记 · 再 Del 删除 · Esc 取消"
          : "↑/↓/j/k move · / filter · Enter open · Del mark · Del again delete · Esc cancel";
      } else if (prompt.type === "select") {
        footerHelp = isZh
          ? "↑/↓/j/k 选择 · / 过滤 · Enter 确认 · Esc 取消"
          : "↑/↓/j/k move · / filter · Enter select · Esc cancel";
      } else if (prompt.type === "confirm") {
        footerHelp = isZh
          ? "↑/↓/j/k 选择 · Enter 确认 · Esc 取消"
          : "↑/↓/j/k move · Enter select · Esc cancel";
      } else {
        footerHelp = isZh
          ? "Ctrl+A/E 跳转 · Ctrl+W 删词 · Enter 确认 · Esc 取消"
          : "Ctrl+A/E jump · Ctrl+W delete word · Enter confirm · Esc cancel";
      }
      lines.push(
        "  " +
          morandi.dim(
            this.truncatePlainToWidth(footerHelp, Math.max(12, columns - 4)),
          ),
      );

      let cursorSequence = "\x1b[?25l";
      if (prompt.type === "text" || prompt.type === "password") {
        cursorSequence = `\x1b[${inputLineRow};${2 + prompt.cursorPosition + 1}H\x1b[?25h`;
      }

      const output =
        "\x1b[?25l\x1b[H" +
        lines.map((line) => line + "\x1b[K").join("\n") +
        "\x1b[J" +
        cursorSequence;
      this.originalWrite(output);
      return;
    }

    const isWaitingInput = this.resolveInput !== null;
    const isInputActive =
      isWaitingInput || this.thinkingKeypressListener !== null;
    const hasInput = isInputActive && this.inputBuffer.length > 0;
    const placeholder = isWaitingInput ? "Ask anything..." : "";

    // A.1 构建底部的圆角输入框与状态行以及指令匹配浮窗
    const boxWidth = columns - 4;
    const wrapWidth = Math.max(8, boxWidth - 14);
    const fullText = hasInput ? this.inputBuffer : placeholder;

    const wrappedInputLines = this.wrapInputText(fullText, wrapWidth);
    const wrappedLines = wrappedInputLines.map((line) => line.text);
    const formattedLines = hasInput
      ? this.formatWrappedLines(wrappedLines, this.inputBuffer.length)
      : wrappedLines.map((line) => morandi.dim(line));

    const boxContentLines: string[] = [];
    const topBorder = morandi.gray("  ╭" + "─".repeat(boxWidth - 4) + "╮");
    const bottomBorder = morandi.gray("  ╰" + "─".repeat(boxWidth - 4) + "╯");

    boxContentLines.push(topBorder);
    for (let i = 0; i < formattedLines.length; i++) {
      const prefix = i === 0 ? "orbit > " : "        ";
      const rawLine = wrappedLines[i];
      const visualWidth = this.getStringWidth(rawLine);
      const remainingSpaces = wrapWidth - visualWidth;
      const padding = " ".repeat(Math.max(0, remainingSpaces));

      const lineContent =
        morandi.gray("  │ ") +
        morandi.userBold(prefix) +
        formattedLines[i] +
        padding +
        morandi.gray(" │");
      boxContentLines.push(lineContent);
    }
    boxContentLines.push(bottomBorder);

    const bottomLines: string[] = [];

    // A.2 只有以 / 开头且正在等待输入时，渲染指令下拉浮窗
    if (isWaitingInput) {
      const matches = this.getActiveMatches();

      if (matches.length > 0) {
        const isZh = this.config?.language === "zh";
        const cmdHints: Record<string, string> = isZh
          ? {
              "/help": "查看系统命令的详细帮助与指南",
              "/status": "实时诊断当前会话的健康与资源状态",
              "/doctor": "全面检查运行环境、模型、联网、skills 与安全配置",
              "/config": "查看与修改本地/全局的运行配置参数",
              "/model": "动态切换正在使用的 AI 语言大模型",
              "/chat": "会话管理器 (支持子命令: list, new, delete, switch)",
              "/chat list": "展示所有已保存的历史对话会话",
              "/chat ls": "展示所有已保存的历史对话会话",
              "/chat new": "启动并创建一个全新的对话会话",
              "/chat delete": "移除不需要的历史对话会话",
              "/chat rm": "移除不需要的历史对话会话",
              "/chat switch": "快速切换到指定的历史对话会话",
              "/commit": "自动暂存工作区修改并生成 Git 提交",
              "/exit": "安全终止并关闭当前的终端会话",
              "/quit": "安全终止并关闭当前的终端会话",
              "/rollback": "一键撤销并回滚自会话启动以来的所有修改",
              "/clear": "清空当前终端屏幕的所有历史会话渲染",
              "/add": "将选定的文件或代码资产添加到当前上下文",
              "/drop": "从当前对话上下文中移除选定的资产",
              "/mode": "动态切换系统安全确认模式 (strict, normal, auto, plan)",
              "/copy": "拷贝 AI 的上一条回复到系统剪贴板",
              "/run": "执行一条本机 Shell 命令，会先走权限检查",
              "/update": "检测并更新当前项目依赖",
              "/webui": "启动并打开 Orbit 图形控制台页面",
            }
          : {
              "/help": "Display detailed help and commands reference",
              "/status": "Diagnose session health, token usage, and limits",
              "/doctor":
                "Inspect runtime, models, web, skills, and safety config",
              "/config": "View and edit local or global configuration",
              "/model": "Switch the active language model dynamically",
              "/chat":
                "Manage chat sessions (subcommands: list, new, delete, switch)",
              "/chat list": "List all saved agent chat sessions",
              "/chat ls": "List all saved agent chat sessions",
              "/chat new": "Initialize and start a fresh chat session",
              "/chat delete": "Remove a saved session from the manager",
              "/chat rm": "Remove a saved session from the manager",
              "/chat switch": "Switch focus to a specific saved session",
              "/commit": "Automatically stage changes and create Git commit",
              "/exit": "Safely terminate and exit the active session",
              "/quit": "Safely terminate and exit the active session",
              "/rollback": "Revert all source edits made during this session",
              "/clear": "Clear the terminal screen and scrollback buffer",
              "/add": "Add files or code symbols to prompt context",
              "/drop": "Remove selected assets from prompt context",
              "/mode": "Switch permission mode (strict, normal, auto, plan)",
              "/copy": "Copy last assistant response to clipboard",
              "/run": "Run one local shell command after permission checks",
              "/update": "Detect and update current project dependencies",
              "/webui": "Start and open the Orbit graphical console",
            };

        const maxVisible = 5;
        this.activeCommandIndex = Math.min(
          Math.max(0, this.activeCommandIndex),
          matches.length - 1,
        );

        let startIdx = 0;
        if (this.activeCommandIndex >= maxVisible) {
          startIdx = this.activeCommandIndex - maxVisible + 1;
        }
        const visibleMatches = matches.slice(startIdx, startIdx + maxVisible);

        const maxPopupWidth = Math.min(92, Math.max(34, columns - 8));
        const visibleCommands = visibleMatches.map((cmd) => {
          const selectedPrefix = " ❯ ";
          const idlePrefix = "   ";
          return {
            cmd,
            width: Math.max(
              this.getStringWidth(`${selectedPrefix}${cmd}`),
              this.getStringWidth(`${idlePrefix}${cmd}`),
            ),
          };
        });
        const widestCommand = visibleCommands.reduce(
          (max, item) => Math.max(max, item.width),
          0,
        );
        const commandColumnWidth = Math.min(
          Math.max(18, widestCommand + 2),
          Math.max(18, Math.floor(maxPopupWidth * 0.45)),
        );
        const formattedMatches = visibleMatches.map((cmd) => {
          const isSelected =
            visibleMatches.indexOf(cmd) + startIdx === this.activeCommandIndex;
          const prefix = isSelected ? " ❯ " : "   ";

          let hint = cmdHints[cmd] || "";
          if (!hint) {
            if (
              cmd.startsWith("/chat delete ") ||
              cmd.startsWith("/chat rm ")
            ) {
              hint = isZh ? "删除该会话" : "Delete this session";
            } else if (cmd.startsWith("/chat switch ")) {
              hint = isZh ? "切换到该会话" : "Switch to this session";
            } else if (cmd.startsWith("/fork switch ")) {
              hint = isZh
                ? "切换到指定的会话分支"
                : "Switch to specified session branch";
            } else if (cmd === "/fork tree") {
              hint = isZh
                ? "展示所有会话分支的树状关系"
                : "Display session branch lineage tree";
            }
          }

          let leftPart = `${prefix}${cmd}`;
          let leftW = this.getStringWidth(leftPart);
          if (leftW > commandColumnWidth) {
            leftPart =
              this.truncateToWidth(leftPart, commandColumnWidth - 3) + "...";
            leftW = this.getStringWidth(leftPart);
          }

          let rightPart = "";
          let rightW = 0;
          if (hint) {
            const availableRightW = maxPopupWidth - commandColumnWidth - 2 - 2;
            if (availableRightW >= 5) {
              const rawRightW = this.getStringWidth(hint);
              if (rawRightW <= availableRightW) {
                rightPart = hint;
                rightW = rawRightW;
              } else {
                rightPart =
                  this.truncateToWidth(hint, availableRightW - 3) + "...";
                rightW = this.getStringWidth(rightPart);
              }
            }
          }

          return { cmd, isSelected, leftPart, leftW, rightPart, rightW };
        });

        const popupWidth = maxPopupWidth;

        bottomLines.push(morandi.gray("  ╭" + "─".repeat(popupWidth) + "╮"));
        for (const fm of formattedMatches) {
          const columnSpacing = Math.max(1, commandColumnWidth - fm.leftW);
          const bodyWidth = fm.leftW + columnSpacing + fm.rightW;
          const tailPadding = " ".repeat(Math.max(0, popupWidth - bodyWidth));

          const formattedLine = fm.isSelected
            ? morandi.accent(fm.leftPart) +
              " ".repeat(columnSpacing) +
              morandi.gray(fm.rightPart) +
              tailPadding
            : morandi.gray(fm.leftPart) +
              " ".repeat(columnSpacing) +
              morandi.dim(fm.rightPart) +
              tailPadding;

          bottomLines.push(
            morandi.gray("  │") + formattedLine + morandi.gray("│"),
          );
        }
        const footerText = getSlashSuggestionFooterText(isZh, matches.length);
        const footerW = this.getStringWidth(footerText);
        const footerPadding = " ".repeat(Math.max(0, popupWidth - footerW - 1));
        bottomLines.push(
          morandi.gray("  │ ") +
            morandi.dim(footerText + footerPadding) +
            morandi.gray("│"),
        );
        bottomLines.push(morandi.gray("  ╰" + "─".repeat(popupWidth) + "╯"));
      } else if (
        this.inputBuffer.startsWith("/") &&
        !this.hideAutocomplete &&
        this.inputBuffer.trim().length > 1
      ) {
        const isZh = this.config?.language === "zh";
        const popupWidth = Math.min(72, Math.max(30, columns - 8));
        const message = isZh
          ? "没有匹配的命令或候选项"
          : "No matching command or candidate";
        const hint = isZh
          ? "Esc 关闭建议 · Ctrl+P 重新打开命令面板"
          : "Esc closes suggestions · Ctrl+P reopens command palette";
        const messageText = this.truncatePlainToWidth(
          message,
          Math.max(8, popupWidth - 2),
        );
        const hintText = this.truncatePlainToWidth(
          hint,
          Math.max(8, popupWidth - 2),
        );
        bottomLines.push(morandi.gray("  ╭" + "─".repeat(popupWidth) + "╮"));
        bottomLines.push(
          morandi.gray("  │ ") +
            morandi.warn(messageText) +
            " ".repeat(
              Math.max(0, popupWidth - this.getStringWidth(messageText) - 1),
            ) +
            morandi.gray("│"),
        );
        bottomLines.push(
          morandi.gray("  │ ") +
            morandi.dim(hintText) +
            " ".repeat(
              Math.max(0, popupWidth - this.getStringWidth(hintText) - 1),
            ) +
            morandi.gray("│"),
        );
        bottomLines.push(morandi.gray("  ╰" + "─".repeat(popupWidth) + "╯"));
      }
    }

    // A.3 压入输入框
    bottomLines.push(...boxContentLines);

    // A.4 构建底部状态行
    const languageIsZh = this.config?.language === "zh";
    const mode = this.permissionsMode.toUpperCase();

    let statusText = "";
    if (this.historyScrollOffset > 0) {
      const newOutput = this.hasNewOutputWhileScrolled
        ? languageIsZh
          ? " · 有新输出"
          : " · new output"
        : "";
      statusText =
        morandi.accent(
          languageIsZh
            ? `↑ 历史 ${this.historyScrollOffset} 行`
            : `↑ history ${this.historyScrollOffset} lines`,
        ) + morandi.warn(newOutput);
    } else if (this.ctrlCPressedOnce) {
      statusText = morandi.warn(
        languageIsZh ? "再次按 Ctrl+C 退出" : "Press Ctrl+C again to exit",
      );
    } else if (this.historySearchQuery !== null) {
      const query = this.historySearchQuery || "*";
      statusText =
        morandi.accent("Ctrl+R") +
        morandi.gray("  ·  ") +
        morandi.white(
          languageIsZh
            ? `历史搜索: ${this.truncatePlainToWidth(query, 28)}`
            : `history search: ${this.truncatePlainToWidth(query, 28)}`,
        );
    } else {
      const displayedModel = this.activeModelName || this.modelNameGetter();
      const cleanModel = displayedModel.split("/").pop() || displayedModel;
      const costStr = `$` + this.sessionCost.toFixed(4);
      statusText =
        morandi.completed("●") +
        " " +
        morandi.white(languageIsZh ? `${mode} 模式` : `${mode} MODE`) +
        morandi.gray("  ·  ") +
        morandi.accent(cleanModel) +
        morandi.gray("  ·  ") +
        morandi.accent(costStr) +
        morandi.gray("  ·  ") +
        morandi.dim(`attempt: ${this.currentAttempt || 1}`);
    }

    let keybindings =
      this.historyScrollOffset > 0
        ? morandi.gray("[End]") +
          morandi.dim(languageIsZh ? " 返回底部" : " Bottom")
        : columns >= 88
          ? [
              morandi.gray("[^C]") +
                morandi.dim(languageIsZh ? " 取消" : " Cancel"),
              morandi.gray("[^J]") +
                morandi.dim(languageIsZh ? " 换行" : " Newline"),
              morandi.gray("[^R]") +
                morandi.dim(languageIsZh ? " 历史" : " History"),
              morandi.gray("[^L]") +
                morandi.dim(languageIsZh ? " 清屏" : " Clear"),
              morandi.gray("[^P]") +
                morandi.dim(languageIsZh ? " 命令" : " Cmds"),
            ].join("  ")
          : columns >= 62
            ? [
                morandi.gray("[^C]") +
                  morandi.dim(languageIsZh ? " 取消" : " Cancel"),
                morandi.gray("[^P]") +
                  morandi.dim(languageIsZh ? " 命令" : " Cmds"),
              ].join("  ")
            : morandi.gray("[^C]") +
              morandi.dim(languageIsZh ? " 退出" : " Exit");

    let statusTextLength = this.getStringWidth(statusText);
    let keybindingsLength = this.getStringWidth(keybindings);
    if (statusTextLength + keybindingsLength > columns - 8) {
      keybindings = [
        morandi.gray("[^C]") + morandi.dim(languageIsZh ? " 取消" : " Cancel"),
        morandi.gray("[^P]") + morandi.dim(languageIsZh ? " 命令" : " Cmds"),
      ].join("  ");
      keybindingsLength = this.getStringWidth(keybindings);
    }
    if (statusTextLength + keybindingsLength > columns - 8) {
      const compactMode = `${mode.slice(0, 6)} · ${this.currentAttempt || 1}`;
      statusText = morandi.completed("●") + " " + morandi.white(compactMode);
      statusTextLength = this.getStringWidth(statusText);
    }
    if (statusTextLength + keybindingsLength > columns - 8) {
      keybindings = morandi.gray("[^C]");
      keybindingsLength = this.getStringWidth(keybindings);
    }
    const spacing = Math.max(
      1,
      columns - 6 - statusTextLength - keybindingsLength,
    );

    bottomLines.push("  " + statusText + " ".repeat(spacing) + keybindings);

    const bottomHeight = bottomLines.length;

    // 全屏渲染逻辑（当无法增量时）
    // Strip all ANSI escape sequences (e.g. \x1b[1m bold) from the model name
    const displayedModel = this.activeModelName || this.modelNameGetter();
    const cleanModel = displayedModel.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");

    // 1. 获取 Git 当前分支与状态（短时缓存，避免流式输出期间阻塞重绘）
    const gitSummary = this.getGitSummary();
    const gitBranch = gitSummary.branch;

    // 2. 渲染左上角像素行星 Logo 及其右侧信息
    const heartColor = this.getNpmNeedsUpdate()
      ? `\x1b[5m\x1b[38;2;230;190;80m` // Blinking Soft Morandi yellow
      : `\x1b[38;2;230;110;110m`; // Soft Morandi red

    const logoLines = [
      `\x1b[38;2;158;184;196m  /\\___/\\  \x1b[0m`,
      `\x1b[38;2;158;184;196m (  o.o  ) \x1b[0m`,
      `\x1b[38;2;158;184;196m  / >${heartColor}♥\x1b[25m\x1b[38;2;158;184;196m< \\  \x1b[0m`,
      `\x1b[38;2;158;184;196m (__/ \\__) \x1b[0m`,
    ];

    // Logo widths are static — cache them to avoid re-computation every render frame
    if (!this._cachedLogoWidths) {
      const w0 = this.getStringWidth(logoLines[0]);
      const w1 = this.getStringWidth(logoLines[1]);
      const w2 = this.getStringWidth(logoLines[2]);
      const w3 = this.getStringWidth(logoLines[3]);
      const maxW = Math.max(w0, w1, w2, w3);
      this._cachedLogoWidths = { w0, w1, w2, w3, maxW };
    }
    const { w0, w1, w2, w3, maxW: maxLogoW } = this._cachedLogoWidths;

    const pad0 = " ".repeat(maxLogoW - w0);
    const pad1 = " ".repeat(maxLogoW - w1);
    const pad2 = " ".repeat(maxLogoW - w2);
    const pad3 = " ".repeat(maxLogoW - w3);

    const shortCwd = this.cwd.replace(/\\/g, "/");

    // Safety check to prevent left/right overflow of the header
    const availableWidth = Math.max(10, columns - 2 - maxLogoW - 2 - 20 - 2);

    let branchText = "";
    if (gitBranch !== "no-git") {
      const stats: string[] = [];
      if (gitSummary.added > 0) stats.push(`+${gitSummary.added}`);
      if (gitSummary.modified > 0) stats.push(`~${gitSummary.modified}`);
      if (gitSummary.deleted > 0) stats.push(`-${gitSummary.deleted}`);
      const gitStatusStats = stats.length > 0 ? ` (${stats.join(" ")})` : "";
      const maxBranchLen = 12;
      const displayBranch =
        gitBranch.length > maxBranchLen
          ? gitBranch.substring(0, maxBranchLen - 3) + "..."
          : gitBranch;
      branchText = `  ${morandi.dim("·")}  ${morandi.dim("⎇")} ${morandi.asst(displayBranch)}${gitStatusStats ? " " + morandi.accent(gitStatusStats) : ""}`;
    }

    // Helper to truncate path from middle/beginning to make it fit maxPathWidth
    const truncatePath = (p: string, maxLength: number): string => {
      if (p.length <= maxLength) return p;
      const parts = p.split("/");
      if (parts.length <= 1) {
        return p.substring(p.length - maxLength);
      }
      const lastPart = parts[parts.length - 1];
      if (lastPart.length + 4 > maxLength) {
        return "..." + lastPart.substring(lastPart.length - (maxLength - 3));
      }
      let result = lastPart;
      for (let i = parts.length - 2; i >= 0; i--) {
        const nextResult = parts[i] + "/" + result;
        if (nextResult.length + 4 > maxLength) {
          return ".../" + result;
        }
        result = nextResult;
      }
      return result;
    };

    const pathLabel = "workspace: ";
    const branchWidth =
      gitBranch !== "no-git" ? 5 + Math.min(12, gitBranch.length) : 0;
    const maxPathWidth = Math.max(
      6,
      availableWidth - pathLabel.length - branchWidth,
    );
    const displayPath = truncatePath(shortCwd, maxPathWidth);

    const hitRate = this.cacheTelemetry
      ? this.cacheTelemetry.hitRate * 100
      : this.totalInputTokens > 0
        ? (this.totalCacheReadTokens / this.totalInputTokens) * 100
        : 0;
    const cacheRead = this.cacheTelemetry
      ? this.cacheTelemetry.hitTokens
      : this.totalCacheReadTokens;
    const cacheInput = this.cacheTelemetry
      ? this.cacheTelemetry.inputTokens || this.totalInputTokens
      : this.totalInputTokens;
    const cacheMiss =
      this.cacheTelemetry?.missTokens || Math.max(0, cacheInput - cacheRead);
    const slabLabel = this.cacheTelemetry
      ? ` slab:${this.cacheTelemetry.slabHash.slice(0, 8)}`
      : "";
    const primerLabel = this.cacheTelemetry?.primed ? " primed" : "";
    const cachePrefix = this.cacheTelemetry?.degraded
      ? languageIsZh
        ? "[缓存!]"
        : "[cache!]"
      : languageIsZh
        ? "[缓存]"
        : "[cache]";
    let cacheText =
      cacheInput <= 0
        ? `${cachePrefix} ${this.cacheTelemetry?.primed ? (languageIsZh ? "已预热" : "primed") : languageIsZh ? "待命" : "idle"}${slabLabel}`
        : `${cachePrefix} ${languageIsZh ? "命中" : "hit"}: ${hitRate.toFixed(0)}% (${(cacheRead / 1000).toFixed(0)}k ${languageIsZh ? "命中" : "hit"}/${(cacheMiss / 1000).toFixed(0)}k ${languageIsZh ? "未命中" : "miss"})${slabLabel}${primerLabel}`;
    if (this.getStringWidth(cacheText) > availableWidth) {
      cacheText = `${cachePrefix} ${hitRate.toFixed(0)}% (${(cacheRead / 1000).toFixed(0)}k/${(cacheInput / 1000).toFixed(0)}k)${slabLabel}`;
    }
    if (this.getStringWidth(cacheText) > availableWidth) {
      cacheText = `${cachePrefix} ${hitRate.toFixed(0)}%`;
    }

    let headerLines: string[];
    if (columns < 76) {
      const compactPath = truncatePath(shortCwd, Math.max(8, columns - 15));
      const compactBranch =
        gitBranch === "no-git"
          ? ""
          : ` · ${gitBranch.length > 12 ? gitBranch.slice(0, 9) + "..." : gitBranch}`;
      headerLines = [
        `  ${morandi.whiteBold("O R B I T")}`,
        `  ${morandi.dim("workspace:")} ${morandi.gray(compactPath)}`,
        `  ${morandi.dim(cacheText)}${morandi.dim(compactBranch)}`,
      ];
    } else {
      const headerLine1 = `  ${logoLines[0]}${pad0}`;
      const headerLine2 = `  ${logoLines[1]}${pad1}  ${morandi.whiteBold("O R B I T")}      ${morandi.dim("workspace:")} ${morandi.gray(displayPath)}${branchText}`;
      const headerLine3 = `  ${logoLines[2]}${pad2}                 ${morandi.dim(cacheText)}`;
      const headerLine4 = `  ${logoLines[3]}${pad3}`;
      headerLines = [headerLine1, headerLine2, headerLine3, headerLine4];
    }

    // 3. 构建历史对话内容
    const renderedLines: string[] = [];

    // TuiTurn is now defined at file level above the class
    const turns: TuiTurn[] = [];
    let currentTurn: TuiTurn | null = null;

    for (const msg of this.history) {
      if (msg.role === "user") {
        if (currentTurn) {
          turns.push(currentTurn);
        }
        currentTurn = { user: msg, system: [] };
      } else if (msg.role === "assistant") {
        if (!currentTurn) {
          currentTurn = { system: [] };
        }
        currentTurn.assistant = msg;
      } else if (msg.role === "system") {
        if (!currentTurn) {
          currentTurn = { system: [] };
        }
        currentTurn.system.push(msg);
      }
    }
    if (currentTurn) {
      turns.push(currentTurn);
    }

    const lastAsst = [...this.history]
      .reverse()
      .find((m) => m.role === "assistant");
    const uBorder = "    ";
    const aBorder = "    ";

    for (const turn of turns) {
      if (turn.user) {
        // Render User Turn
        renderedLines.push("    " + morandi.userBold("👤 User"));
        renderedLines.push(uBorder);

        const userLines = turn.user.text.split("\n");
        const wrappedUserLines: string[] = [];
        for (const line of userLines) {
          wrappedUserLines.push(...this.wrapLine(line, columns - 10));
        }
        for (const line of wrappedUserLines) {
          renderedLines.push(uBorder + morandi.user(line));
        }
        renderedLines.push(uBorder);
        renderedLines.push(""); // spacing
      }

      // Render Assistant Turn
      if (turn.assistant) {
        const asstLines: string[] = [];
        const systemLines = this.formatSystemLinesForDisplay(turn.system, {
          prefixUnknown: true,
          preserveBlank: false,
        });

        const isThinkingNow = turn.assistant === lastAsst && this.isThinking;
        const thoughtTimeVal = isThinkingNow
          ? this.thoughtElapsed
          : turn.assistant.thoughtTime;

        if (thoughtTimeVal !== undefined) {
          const timeStr =
            thoughtTimeVal >= 1000
              ? `${(thoughtTimeVal / 1000).toFixed(1)}s`
              : `${thoughtTimeVal}ms`;

          const breatheDots = [
            "\x1b[38;2;158;184;196m·\x1b[0m",
            "\x1b[38;2;164;178;150m•\x1b[0m",
            "\x1b[38;2;224;188;124m●\x1b[0m",
            "\x1b[38;2;152;188;146m•\x1b[0m",
          ];
          const spinIdx = Math.floor(Date.now() / 250) % 4;
          const dotChar = isThinkingNow
            ? breatheDots[spinIdx]
            : morandi.gray("•");

          if (isThinkingNow) {
            asstLines.push(
              `${dotChar} ` + morandi.accent(`Thinking... ${timeStr}`),
            );
            if (this.currentThinking) {
              const lines = this.currentThinking.split("\n").filter(Boolean);
              const lastLines = lines.slice(-4);
              const maxL = columns - 14;
              for (const line of lastLines) {
                const trimmed = line.trim();
                let displayText = trimmed;
                const displayW = this.getStringWidth(displayText);
                if (displayW > maxL) {
                  displayText =
                    this.truncateToWidth(displayText, maxL - 3) + "...";
                }
                asstLines.push(
                  "    " + morandi.gray("· ") + morandi.dim(displayText),
                );
              }
            }
          } else {
            asstLines.push(
              morandi.gray("🧠 ") + morandi.dim(`Thought for ${timeStr}`),
            );
          }
        }

        if (systemLines.length > 0) {
          asstLines.push(...systemLines);
        }

        if (turn.assistant.text) {
          if (asstLines.length > 0) {
            asstLines.push("");
          }

          const asstObj = turn.assistant as any;
          const isStreaming = this.resolveInput === null;
          const nowTime = Date.now();
          const timeSinceLastRender =
            nowTime - (asstObj._lastMarkdownRenderTime || 0);

          if (
            !asstObj._formattedCached ||
            asstObj._textCached !== turn.assistant.text
          ) {
            if (
              !isStreaming ||
              timeSinceLastRender >= 150 ||
              !asstObj._formattedCached
            ) {
              asstObj._formattedCached = Renderer.formatMarkdown(
                turn.assistant.text,
              ).split("\n");
              asstObj._textCached = turn.assistant.text;
              asstObj._lastMarkdownRenderTime = nowTime;
            }
          }
          asstLines.push(...asstObj._formattedCached);
        }

        const turnModel = turn.assistant?.model || cleanModel;
        const cleanTurnModel = turnModel.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
        let footerStatusLine = "";
        const lastSys = turn.system[turn.system.length - 1];
        if (lastSys && lastSys.text.includes("Failed")) {
          footerStatusLine = `${morandi.failed("failed")}  ·  ${morandi.dim(cleanTurnModel)}`;
        } else if (turn.assistant.totalTime !== undefined) {
          const sec = (turn.assistant.totalTime / 1000).toFixed(1);
          footerStatusLine = `${morandi.completed("completed")}  ·  ${morandi.dim(cleanTurnModel)}  ·  ${morandi.dim(sec + "s")}`;
        }

        if (footerStatusLine) {
          asstLines.push("");
          asstLines.push(footerStatusLine);
        }

        const wrappedAsstLines: string[] = [];
        for (const line of asstLines) {
          wrappedAsstLines.push(...this.wrapLine(line, columns - 10));
        }

        renderedLines.push(
          "    " + morandi.asstBold(`🤖 Orbit (${cleanTurnModel})`),
        );
        renderedLines.push(aBorder);
        for (const line of wrappedAsstLines) {
          renderedLines.push(aBorder + line);
        }
        renderedLines.push(aBorder);
        renderedLines.push("");
      } else if (turn.system.length > 0) {
        // Render System Lines (Command Outputs/Status/Help) directly!
        const systemLines = this.formatSystemLinesForDisplay(turn.system, {
          prefixUnknown: false,
          preserveBlank: true,
        });

        const wrappedSysLines: string[] = [];
        for (const line of systemLines) {
          wrappedSysLines.push(...this.wrapLine(line, columns - 10));
        }
        for (const line of wrappedSysLines) {
          renderedLines.push("    " + line);
        }
        renderedLines.push("");
      }
    }

    // A.6 Read Plan Items
    let planText = "";
    const planItems = this.getPlanLines();
    if (planItems.length > 0) {
      const planContent: string[] = [];
      let activeIndex = planItems.findIndex((item) => item.startsWith("- [/]"));
      if (activeIndex === -1) {
        activeIndex = planItems.findIndex((item) => item.startsWith("- [ ]"));
      }
      if (activeIndex === -1) {
        activeIndex = planItems.length - 1;
      }

      planContent.push("  " + morandi.accent("📋 Active Plan:"));

      const startPlanIdx = Math.max(0, activeIndex - 1);
      const endPlanIdx = Math.min(planItems.length - 1, activeIndex + 1);

      if (startPlanIdx > 0) {
        planContent.push(
          "    " + morandi.dim(`... ${startPlanIdx} step(s) completed`),
        );
      }

      for (let i = startPlanIdx; i <= endPlanIdx; i++) {
        const item = planItems[i];
        const text = item.substring(5).trim();
        const isCurrentRunning =
          item.startsWith("- [/]") || item.startsWith("- [/");
        const isCompleted = item.startsWith("- [x]") || item.startsWith("- [x");

        let prefixSymbol = "";
        if (isCurrentRunning) {
          prefixSymbol = morandi.accent("●");
        } else if (isCompleted) {
          prefixSymbol = morandi.completed("✔");
        } else {
          prefixSymbol = morandi.gray("○");
        }

        let displayText = text;
        const maxTextLen = columns - 12;
        const displayW = this.getStringWidth(displayText);
        if (displayW > maxTextLen) {
          displayText =
            this.truncateToWidth(displayText, maxTextLen - 3) + "...";
        }

        const coloredText = isCurrentRunning
          ? morandi.whiteBold(displayText)
          : isCompleted
            ? morandi.dim(displayText)
            : morandi.gray(displayText);

        planContent.push("    " + prefixSymbol + " " + coloredText);
      }

      if (endPlanIdx < planItems.length - 1) {
        const remaining = planItems.length - 1 - endPlanIdx;
        planContent.push(
          "    " + morandi.dim(`... ${remaining} step(s) pending`),
        );
      }
      planText = planContent.join("\n") + "\n\n";
    }

    // A.5 Context files panel
    let contextText = "";
    if (this.activeContextFiles && this.activeContextFiles.length > 0) {
      const contextLines: string[] = [];
      contextLines.push("  " + morandi.accent("📎 Context Files:"));

      const filesStr = this.activeContextFiles
        .map((f) => `[${f.path}${f.readOnly ? " 🔒" : ""}]`)
        .join("  ");
      const maxW = columns - 10;
      const wrappedFiles = this.wrapLine(filesStr, maxW);
      for (const line of wrappedFiles) {
        contextLines.push("    " + morandi.white(line));
      }
      contextText = contextLines.join("\n") + "\n\n";
    }

    const headerText = `${headerLines.join("\n")}\n\n` + planText + contextText;
    const headerHeight = headerText.split("\n").length;

    // 6. 排版与渲染到终端 (带垂直裁剪逻辑，自底向上排布)
    // 留出 1 行用于历史记录与输入框之间的空行间隔
    const maxContentRows = Math.max(1, rows - bottomHeight - headerHeight - 1);

    const flatLines: string[] = [];
    for (const item of renderedLines) {
      flatLines.push(...item.split("\n"));
    }

    if (
      this.historyScrollOffset > 0 &&
      flatLines.length > this.lastHistoryLineCount
    ) {
      this.historyScrollOffset += flatLines.length - this.lastHistoryLineCount;
      this.hasNewOutputWhileScrolled = true;
    }
    this.lastHistoryLineCount = flatLines.length;
    this.maxHistoryScrollOffset = Math.max(
      0,
      flatLines.length - maxContentRows,
    );
    this.historyScrollOffset = Math.min(
      this.historyScrollOffset,
      this.maxHistoryScrollOffset,
    );

    const finalLines: string[] = [];
    let totalLinesCount = 0;

    const visibleEnd = Math.max(0, flatLines.length - this.historyScrollOffset);
    for (let i = visibleEnd - 1; i >= 0; i--) {
      const line = flatLines[i];
      const visibleLen = this.getStringWidth(line);
      const lineRows = Math.max(
        1,
        Math.ceil(visibleLen / Math.max(1, columns - 4)),
      );
      if (totalLinesCount + lineRows > maxContentRows) {
        break;
      }
      totalLinesCount += lineRows;
      finalLines.unshift(line);
    }

    // Trim trailing empty lines from finalLines to prevent extra blank space at the bottom
    while (
      finalLines.length > 0 &&
      finalLines[finalLines.length - 1]
        .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")
        .trim() === ""
    ) {
      finalLines.pop();
    }

    const gapHeight = finalLines.length > 0 ? 1 : 0;
    const totalHeight =
      headerHeight + finalLines.length + gapHeight + bottomHeight;
    const extraPad = Math.max(0, rows - totalHeight);

    const allLines: string[] = [];
    allLines.push(...headerText.split("\n"));

    if (extraPad > 0) {
      for (let i = 0; i < extraPad; i++) {
        allLines.push("");
      }
    }

    if (finalLines.length > 0) {
      allLines.push(...finalLines);
      // 聊天记录的下限和输入框的长方形边框隔开一行空行
      allLines.push("");
    }

    allLines.push(...bottomLines);
    const rawLines = allLines;

    const staticText = rawLines
      .slice(0, rawLines.length - bottomHeight)
      .join("\n");
    const canIncremental =
      !forceFull &&
      isInputActive &&
      this.cachedStaticLinesCount > 0 &&
      bottomHeight === this.lastRenderedBottomHeight &&
      staticText === this.cachedStaticContent;

    if (canIncremental) {
      // 局部增量重绘
      let cursorSequence = "";
      const { lineIndex: cursorLineIndex, xOffset } =
        this.getCursorPositionInWrappedInput(wrappedInputLines);
      // Use pre-calculated constant for the input prefix width instead of recomputing
      const lineStartX = cursorLineIndex === 0 ? INPUT_PREFIX_WIDTH : 12;
      const targetX = lineStartX + xOffset;
      const linesUp = formattedLines.length - cursorLineIndex + 1; // 距离状态行向上数 linesUp 行
      cursorSequence = `\x1b[${linesUp}A\x1b[${targetX + 1}G\x1b[?25h`;

      const bottomOutput =
        "\x1b[?25l" + // 隐藏光标
        `\x1b[${this.cachedStaticLinesCount + 1};1H` + // 移至底部的首行
        bottomLines.map((line) => line + "\x1b[K").join("\n") +
        "\x1b[J" + // 擦拭并重写 bottomLines
        cursorSequence;

      process.stdout.write(bottomOutput);
      return;
    }

    // 缓存静态渲染信息
    this.cachedStaticLinesCount = rawLines.length - bottomHeight;
    this.cachedStaticContent = staticText;
    this.lastRenderedBottomHeight = bottomHeight;

    let finalOutput =
      "\x1b[?25l\x1b[H" +
      rawLines.map((line) => line + "\x1b[K").join("\n") +
      "\x1b[J";

    // 7. 相对光标精确定位与原子打包输出
    let cursorSequence = "";
    if (this.resolveInput || this.thinkingKeypressListener !== null) {
      const { lineIndex: cursorLineIndex, xOffset } =
        this.getCursorPositionInWrappedInput(wrappedInputLines);
      const lineStartX = cursorLineIndex === 0 ? INPUT_PREFIX_WIDTH : 12;
      const targetX = lineStartX + xOffset;
      const linesUp = formattedLines.length - cursorLineIndex + 1; // 距离状态行向上数 linesUp 行
      cursorSequence = `\x1b[${linesUp}A\x1b[${targetX + 1}G\x1b[?25h`;
    } else {
      cursorSequence = "\x1b[?25l";
    }

    finalOutput += cursorSequence;
    process.stdout.write(finalOutput);
  }

  private isFullWidth(codePoint: number): boolean {
    if (Number.isNaN(codePoint)) {
      return false;
    }
    if (
      codePoint === 0x25e2 || // ◢
      codePoint === 0x25e3 || // ◣
      codePoint === 0x25e4 || // ◤
      codePoint === 0x25e5 || // ◥
      codePoint === 0x2590 || // ▐
      codePoint === 0x258c || // ▌
      codePoint === 0x25cf // ●
    ) {
      return true;
    }
    return (
      (codePoint >= 0x1100 && codePoint <= 0x115f) || // Hangul Jamo
      codePoint === 0x2329 || // LEFT-POINTING ANGLE BRACKET
      codePoint === 0x232a || // RIGHT-POINTING ANGLE BRACKET
      (codePoint >= 0x2e80 && codePoint <= 0x3247 && codePoint !== 0x303f) || // CJK Radicals Supplement .. Enclosed CJK Letters and Months
      (codePoint >= 0x3250 && codePoint <= 0x4dbf) || // Enclosed CJK Letters and Months .. CJK Unified Ideographs Extension A
      (codePoint >= 0x4e00 && codePoint <= 0xa4c6) || // CJK Unified Ideographs .. Yi Radicals
      (codePoint >= 0xa960 && codePoint <= 0xa97c) || // Hangul Jamo Extended-A
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) || // Hangul Syllables
      (codePoint >= 0xf900 && codePoint <= 0xfaff) || // CJK Compatibility Ideographs
      (codePoint >= 0xfe10 && codePoint <= 0xfe19) || // Vertical Forms
      (codePoint >= 0xfe30 && codePoint <= 0xfe6b) || // CJK Compatibility Forms .. Small Form Variants
      (codePoint >= 0xff01 && codePoint <= 0xff60) || // Halfwidth and Fullwidth Forms
      (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
      (codePoint >= 0x1b000 && codePoint <= 0x1b001) || // Kana Supplement
      (codePoint >= 0x1f200 && codePoint <= 0x1f251) || // Enclosed Ideographic Supplement
      (codePoint >= 0x20000 && codePoint <= 0x3fffd) || // CJK Unified Ideographs Extension B .. Tertiary Ideographic Plane
      (codePoint >= 0x1f300 && codePoint <= 0x1f9ff) || // Emojis
      (codePoint >= 0x1f600 && codePoint <= 0x1f64f) || // Emoticons
      (codePoint >= 0x1f680 && codePoint <= 0x1f6ff) // Transport & Map
    );
  }

  private truncateToWidth(str: string, maxW: number): string {
    let width = 0;
    let result = "";
    for (const char of str) {
      const code = char.codePointAt(0);
      if (code === undefined) continue;
      const charW = this.isFullWidth(code) ? 2 : 1;
      if (width + charW > maxW) {
        break;
      }
      width += charW;
      result += char;
    }
    return result;
  }

  private wrapLine(line: string, maxWidth: number): string[] {
    const cleanLine = line.replace(
      /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g,
      "",
    );
    if (this.getStringWidth(cleanLine) <= maxWidth) {
      return [line];
    }

    const lines: string[] = [];
    let currentLine = "";
    let currentWidth = 0;

    const ansiRegex =
      /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;
    let activeColor = "";

    let i = 0;
    while (i < line.length) {
      ansiRegex.lastIndex = i;
      const match = ansiRegex.exec(line);
      if (match && match.index === i) {
        const ansiCode = match[0];
        currentLine += ansiCode;
        if (ansiCode.includes("m") && !ansiCode.includes("[0m")) {
          activeColor = ansiCode;
        } else if (ansiCode.includes("[0m")) {
          activeColor = "";
        }
        i += ansiCode.length;
        continue;
      }

      const code = line.codePointAt(i);
      let charLen = 1;
      if (code && code > 0xffff) {
        charLen = 2;
      }
      const charStr = line.substring(i, i + charLen);
      const charW = this.isFullWidth(code || 0) ? 2 : 1;

      if (currentWidth + charW > maxWidth) {
        if (activeColor) {
          currentLine += "\x1b[0m";
        }
        lines.push(currentLine);
        currentLine = activeColor + charStr;
        currentWidth = charW;
      } else {
        currentLine += charStr;
        currentWidth += charW;
      }
      i += charLen;
    }

    if (currentLine) {
      lines.push(currentLine);
    }
    return lines;
  }

  private getStringWidth(str: string): number {
    const cleanStr = str.replace(
      /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g,
      "",
    );
    let width = 0;
    for (let i = 0; i < cleanStr.length; i++) {
      const code = cleanStr.codePointAt(i);
      if (!code) continue;
      if (code > 0xffff) {
        i++;
      }
      if (this.isFullWidth(code)) {
        width += 2;
      } else {
        width += 1;
      }
    }
    return width;
  }

  private wrapText(str: string, maxWidth: number): string[] {
    const lines: string[] = [];
    let currentLine = "";
    let currentWidth = 0;

    for (let i = 0; i < str.length; i++) {
      const code = str.codePointAt(i);
      if (!code) continue;
      let char = str.charAt(i);
      if (code > 0xffff) {
        char = str.substring(i, i + 2);
        i++;
      }
      const charWidth = this.isFullWidth(code) ? 2 : 1;
      if (currentWidth + charWidth > maxWidth) {
        lines.push(currentLine);
        currentLine = char;
        currentWidth = charWidth;
      } else {
        currentLine += char;
        currentWidth += charWidth;
      }
    }
    if (currentLine || lines.length === 0) {
      lines.push(currentLine);
    }
    return lines;
  }

  private wrapInputText(str: string, maxWidth: number): WrappedInputLine[] {
    const lines: WrappedInputLine[] = [];
    let currentLine = "";
    let currentWidth = 0;
    let currentStart = 0;

    for (let i = 0; i < str.length; ) {
      const code = str.codePointAt(i);
      if (!code) {
        i++;
        continue;
      }

      if (code === 10) {
        lines.push({ text: currentLine, start: currentStart, end: i });
        i++;
        currentLine = "";
        currentWidth = 0;
        currentStart = i;
        continue;
      }

      const charLen = code > 0xffff ? 2 : 1;
      const char = str.substring(i, i + charLen);
      const charWidth = this.isFullWidth(code) ? 2 : 1;
      if (currentLine && currentWidth + charWidth > maxWidth) {
        lines.push({ text: currentLine, start: currentStart, end: i });
        currentLine = "";
        currentWidth = 0;
        currentStart = i;
      }

      currentLine += char;
      currentWidth += charWidth;
      i += charLen;
    }

    lines.push({ text: currentLine, start: currentStart, end: str.length });
    return lines;
  }

  private formatWrappedLines(
    wrappedLines: string[],
    inputLength: number,
  ): string[] {
    let charIndex = 0;
    const formattedLines: string[] = [];

    for (const line of wrappedLines) {
      let formattedLine = "";
      for (let i = 0; i < line.length; i++) {
        const char = line.charAt(i);
        const code = line.codePointAt(i);
        let increment = 1;
        let charStr = char;
        if (code && code > 0xffff) {
          charStr = line.substring(i, i + 2);
          i++;
          increment = 2;
        }

        if (charIndex < inputLength) {
          formattedLine += `\x1b[1;38;2;245;242;232m${charStr}\x1b[0m`; // morandi.whiteBold
        } else {
          formattedLine += `\x1b[38;2;148;146;138m${charStr}\x1b[0m`; // morandi.dim
        }
        charIndex += increment;
      }
      formattedLines.push(formattedLine);
    }
    return formattedLines;
  }
}
