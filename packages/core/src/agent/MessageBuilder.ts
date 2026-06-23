import { OrbitMessage, OrbitToolResult } from "@orbit-build/model-providers";
import { ContextPack } from "@orbit-build/context-engine";
import { AgentState } from "./AgentState.js";

export class MessageBuilder {
  public static build(
    systemPrompt: string,
    state: AgentState,
    contextPack: ContextPack,
  ): { system: string; messages: OrbitMessage[] } {
    const sortedLanguages = [...contextPack.projectIndex.detectedLanguages].sort();
    const sortedFrameworks = [...contextPack.projectIndex.frameworks].sort();
    const sortedEntrypoints = [...contextPack.projectIndex.entrypoints].sort();

    const sortedFiles = [...contextPack.relevantFiles].sort((a, b) => a.path.localeCompare(b.path));
    const filesContent = sortedFiles
      .map((f) => {
        const readOnlySuffix = (f as any).readOnly ? " (READ-ONLY REFERENCE - DO NOT EDIT OR CALL WRITE TOOLS ON THIS FILE)" : "";
        return `File: ${f.path}${readOnlySuffix}\nReason: ${f.reason}\nSummary: ${f.summary}\n\`\`\`\n${f.excerpt}\n\`\`\``;
      })
      .join("\n\n");

    const dynamicContextParts = [
      "### Workspace Context",
      `Language profile: ${sortedLanguages.join(", ")}`,
      `Framework profile: ${sortedFrameworks.join(", ") || "None"}`,
      `Entrypoints: ${sortedEntrypoints.join(", ") || "None"}`,
      `PM: ${contextPack.projectIndex.packageManager || "None"}`,
      contextPack.projectInstructions
        ? `\nInstructions from ORBIT.md:\n${contextPack.projectInstructions}`
        : "",
      contextPack.codebaseContext
        ? `\n### Codebase Context:\n\n${contextPack.codebaseContext}`
        : "",
      `\n### Relevant Files Excerpts:\n\n${filesContent || "No files indexed yet."}`,
      `\n### Context Instructions:\n- You are strictly prohibited from calling any tools (like write_file, edit_file) to modify any files marked as "READ-ONLY REFERENCE". Those files are for your reference only.`,
    ];

    const dynamicContextStr = dynamicContextParts.filter(Boolean).join("\n");

    const system = `${systemPrompt}\n<!-- CACHE_BOUNDARY -->\n${dynamicContextStr}`;

    return {
      system,
      messages: [...state.history],
    };
  }
}
