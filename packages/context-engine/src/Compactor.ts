import { OrbitMessage } from '@orbit-ai/model-providers';

export class Compactor {
  public compact(messages: OrbitMessage[]): string {
    const steps: string[] = [];

    for (const msg of messages) {
      if (msg.role === 'user') {
        const text = msg.content
          .filter((c: any) => c.type === 'text')
          .map((c: any) => c.text)
          .join(' ');
        if (text) steps.push(`User Goal: ${text}`);
      } else if (msg.role === 'assistant') {
        const text = msg.content
          .filter((c: any) => c.type === 'text')
          .map((c: any) => c.text)
          .join(' ');
        const tools = msg.content
          .filter((c: any) => c.type === 'tool_call')
          .map((c: any) => `Called ${c.toolCall.name}`)
          .join(', ');

        if (tools) steps.push(`Action: ${tools}`);
        if (text) steps.push(`Orchestrator plan: ${text}`);
      } else if (msg.role === 'tool') {
        const results = msg.content
          .filter((c: any) => c.type === 'tool_result')
          .map((c: any) => {
            const tr = c.toolResult;
            return `Result of ${tr.name}: ${tr.isError ? 'Failed' : 'Success'} (${tr.content.substring(0, 100)}...)`;
          })
          .join('\n');
        if (results) steps.push(results);
      }
    }

    return `### COMPACTED CONTEXT SUMMARY\n\n${steps.join('\n\n')}`;
  }
}
