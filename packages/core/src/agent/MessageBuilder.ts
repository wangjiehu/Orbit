import { OrbitMessage } from "@orbit-build/model-providers";
import { ContextPack } from "@orbit-build/context-engine";
import { AgentState } from "./AgentState.js";

export interface MessageBuilderOptions {
  now?: Date;
}

export class MessageBuilder {
  public static build(
    systemPrompt: string,
    state: AgentState,
    contextPack: ContextPack,
    options: MessageBuilderOptions = {},
  ): { system: string; messages: OrbitMessage[] } {
    const dynamicContextStr = this.buildVolatileContext(contextPack, options);

    const system = `${systemPrompt}\n${dynamicContextStr}`;

    return {
      system,
      messages: [...state.history],
    };
  }

  public static buildVolatileContext(
    contextPack: ContextPack,
    options: MessageBuilderOptions = {},
  ): string {
    const filesByPath = new Map<
      string,
      {
        path: string;
        reasons: Set<string>;
        summary?: string;
        excerpt?: string;
        readOnly?: boolean;
      }
    >();

    for (const file of contextPack.relevantFiles) {
      const existing = filesByPath.get(file.path);
      if (existing) {
        existing.reasons.add(file.reason);
        existing.readOnly ||= file.readOnly;
        existing.summary ||= file.summary;
        existing.excerpt ||= file.excerpt;
      } else {
        filesByPath.set(file.path, {
          path: file.path,
          reasons: new Set([file.reason]),
          summary: file.summary,
          excerpt: file.excerpt,
          readOnly: file.readOnly,
        });
      }
    }

    const sortedFiles = [...filesByPath.values()].sort((a, b) => {
      if (a.readOnly !== b.readOnly) return a.readOnly ? -1 : 1;
      return a.path.localeCompare(b.path);
    });
    const filesContent = sortedFiles
      .map((f) => {
        const readOnlySuffix = f.readOnly
          ? " (READ-ONLY REFERENCE - DO NOT EDIT OR CALL WRITE TOOLS ON THIS FILE)"
          : "";
        const reason = [...f.reasons].sort().join("; ");
        return [
          `File: ${this.normalizeContextText(f.path)}${readOnlySuffix}`,
          `Reason: ${this.normalizeContextText(reason)}`,
          `Summary: ${this.normalizeContextText(f.summary || "")}`,
          "```",
          this.normalizeContextText(f.excerpt || ""),
          "```",
        ].join("\n");
      })
      .join("\n\n");
    const activeSkillsContent = (contextPack.activeSkills || [])
      .map((skill) => {
        return [
          `Skill: ${this.normalizeContextText(skill.name)}`,
          `Path: ${this.normalizeContextText(skill.path)}`,
          skill.description
            ? `Description: ${this.normalizeContextText(skill.description)}`
            : "",
          "```markdown",
          this.normalizeContextText(skill.content),
          "```",
        ]
          .filter(Boolean)
          .join("\n");
      })
      .join("\n\n");

    const dynamicContextParts = [
      "### Volatile Context",
      this.buildRuntimeContext(options.now || new Date()),
      `\n### Context Instructions:\n- You are strictly prohibited from calling any tools (like write_file, edit_file) to modify any files marked as "READ-ONLY REFERENCE". Those files are for your reference only.`,
      activeSkillsContent
        ? `\n### Active Skills\nUse these skill instructions only when they apply to this turn. Follow any progressive-loading instructions before using optional references.\n\n${activeSkillsContent}`
        : "",
      `\n### Relevant Files Excerpts:\n\n${filesContent || "No files indexed yet."}`,
      contextPack.codebaseContext
        ? `\n### Codebase Context:\n\n${this.normalizeContextText(contextPack.codebaseContext)}`
        : "",
    ];

    return dynamicContextParts.filter(Boolean).join("\n");
  }

  private static buildRuntimeContext(now: Date): string {
    const timezone =
      Intl.DateTimeFormat().resolvedOptions().timeZone || "local";
    const offsetMinutes = -now.getTimezoneOffset();
    const offsetSign = offsetMinutes >= 0 ? "+" : "-";
    const absOffset = Math.abs(offsetMinutes);
    const offset = `UTC${offsetSign}${this.pad(Math.floor(absOffset / 60))}:${this.pad(absOffset % 60)}`;
    const localDate = [
      now.getFullYear(),
      this.pad(now.getMonth() + 1),
      this.pad(now.getDate()),
    ].join("-");
    const localTime = [
      this.pad(now.getHours()),
      this.pad(now.getMinutes()),
      this.pad(now.getSeconds()),
    ].join(":");

    return [
      "\n### Runtime Context:",
      `- Current local date: ${localDate}`,
      `- Current local time: ${localTime}`,
      `- Time zone: ${timezone} (${offset})`,
      `- Current ISO time: ${now.toISOString()}`,
      "- Resolve relative dates such as today, tomorrow, yesterday, latest, current, and now against this runtime date.",
      "- For weather, news, prices, laws, model/API docs, schedules, or other time-sensitive facts, use web_search and trust live results over model training memory.",
    ].join("\n");
  }

  private static pad(value: number): string {
    return value.toString().padStart(2, "0");
  }

  private static normalizeContextText(text: string): string {
    return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  }
}
