import { readFileSync, existsSync } from 'fs';
import { resolveSafePath } from '@orbit-ai/shared';

export class FileSummarizer {
  constructor(private cwd: string) {}

  public summarize(filePath: string, maxLines = 100): { summary: string; excerpt: string } {
    try {
      const safePath = resolveSafePath(this.cwd, filePath);
      if (!existsSync(safePath)) {
        return { summary: 'File not found', excerpt: '' };
      }

      const content = readFileSync(safePath, 'utf8');
      const lines = content.split('\n');

      const summary = `File size: ${content.length} bytes, total lines: ${lines.length}`;
      const excerpt =
        lines.slice(0, maxLines).join('\n') +
        (lines.length > maxLines ? '\n... [TRUNCATED] ...' : '');

      return { summary, excerpt };
    } catch (e: any) {
      return { summary: `Error reading file: ${e.message}`, excerpt: '' };
    }
  }
}
