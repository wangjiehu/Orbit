import { OrbitMessage } from '@orbit-ai/model-providers';
import { ContextPack } from '@orbit-ai/context-engine';
import { AgentState } from './AgentState.js';

export class MessageBuilder {
  public static build(
    systemPrompt: string,
    state: AgentState,
    contextPack: ContextPack
  ): { system: string; messages: OrbitMessage[] } {
    const fullSystem = [
      systemPrompt,
      '\n### Workspace Context',
      `Language profile: ${contextPack.projectIndex.detectedLanguages.join(', ')}`,
      `Framework profile: ${contextPack.projectIndex.frameworks.join(', ') || 'None'}`,
      `Entrypoints: ${contextPack.projectIndex.entrypoints.join(', ') || 'None'}`,
      `PM: ${contextPack.projectIndex.packageManager || 'None'}`,
      contextPack.projectInstructions
        ? `\nInstructions from ORBIT.md:\n${contextPack.projectInstructions}`
        : '',
    ]
      .filter(Boolean)
      .join('\n');

    const filesContent = contextPack.relevantFiles
      .map((f) => {
        return `File: ${f.path}\nReason: ${f.reason}\nSummary: ${f.summary}\n\`\`\`\n${f.excerpt}\n\`\`\``;
      })
      .join('\n\n');

    const contextMessage: OrbitMessage = {
      id: 'msg_context',
      role: 'user',
      createdAt: new Date().toISOString(),
      content: [
        {
          type: 'text',
          text: `### Relevant Files Excerpts:\n\n${filesContent || 'No files indexed yet.'}`,
        },
      ],
    };

    const taskMessage: OrbitMessage = {
      id: 'msg_task',
      role: 'user',
      createdAt: new Date().toISOString(),
      content: [
        {
          type: 'text',
          text: `### Current User Request:\n\n${state.task}`,
        },
      ],
    };

    const messages: OrbitMessage[] = [contextMessage, taskMessage, ...state.history];

    return {
      system: fullSystem,
      messages,
    };
  }
}
