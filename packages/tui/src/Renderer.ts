import picocolors from 'picocolors';

export class Renderer {
  public static printHeader(sessionId: string, model: string, cwd: string): void {
    const sessionShort = sessionId.substring(0, 8);
    console.log('\n' + picocolors.bold(picocolors.magenta('  Orbit')) + picocolors.gray(' • Local AI Programming Shell'));
    console.log(picocolors.gray('  ' + '─'.repeat(60)));
    console.log(`  ${picocolors.cyan('Session')} : ${picocolors.green(sessionShort)}  ${picocolors.gray('|')}  ${picocolors.cyan('Model')} : ${picocolors.yellow(model)}`);
    console.log(`  ${picocolors.cyan('Path')}    : ${picocolors.gray(cwd)}`);
    console.log(picocolors.gray('  ' + '─'.repeat(60)));
    console.log(`  ${picocolors.gray('Type')} ${picocolors.white('/help')} ${picocolors.gray('to list commands, or type a task to start.')}\n`);
  }

  public static printStatus(label: string, value: string): void {
    console.log(`${picocolors.bold(label)}: ${picocolors.green(value)}`);
  }

  public static printStep(msg: string): void {
    console.log(`● ${msg}`);
  }

  public static printThought(thought: string): void {
    if (!thought.trim()) return;
    const lines = thought.trim().split('\n');
    console.log(`\n${picocolors.dim(picocolors.cyan('│'))} ${picocolors.bold(picocolors.cyan('Thought'))}`);
    for (const line of lines) {
      console.log(`${picocolors.dim(picocolors.cyan('│'))} ${picocolors.gray(line)}`);
    }
    console.log();
  }

  public static formatMarkdown(text: string): string {
    if (!text) return '';
    return text
      // Bold: **text** -> bold green
      .replace(/\*\*(.*?)\*\*/g, (_, p1) => picocolors.bold(picocolors.green(p1)))
      // Italic: *text* -> italic
      .replace(/\*(.*?)\*/g, (_, p1) => `\x1b[3m${p1}\x1b[23m`)
      // Inline Code: `code` -> cyan
      .replace(/`(.*?)`/g, (_, p1) => picocolors.cyan(p1))
      // Headers: # Header -> Bold Underline Cyan
      .replace(/^#\s+(.*?)$/gm, (_, p1) => picocolors.bold(picocolors.underline(picocolors.cyan(p1))))
      .replace(/^##\s+(.*?)$/gm, (_, p1) => picocolors.bold(picocolors.cyan(p1)))
      .replace(/^###\s+(.*?)$/gm, (_, p1) => picocolors.bold(picocolors.white(p1)))
      // Bullet points: - item or * item -> ● item
      .replace(/^-\s+(.*?)$/gm, (_, p1) => `  ${picocolors.magenta('●')} ${p1}`)
      .replace(/^\*\s+(.*?)$/gm, (_, p1) => `  ${picocolors.magenta('●')} ${p1}`);
  }
}

