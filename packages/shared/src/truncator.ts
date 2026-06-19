export class LogTruncator {
  public static truncate(output: string, maxLines = 150, maxChars = 20000): string {
    if (!output) return '';

    let truncated = false;
    let result = output;

    if (result.length > maxChars) {
      result = result.substring(0, maxChars);
      truncated = true;
    }

    const lines = result.split(/\r?\n/);
    if (lines.length > maxLines) {
      const keepHalf = Math.floor(maxLines / 2);
      const firstPart = lines.slice(0, keepHalf);
      const lastPart = lines.slice(lines.length - keepHalf);

      result = [
        ...firstPart,
        `\n... [Truncated ${lines.length - maxLines} lines of output to prevent token overflow] ...\n`,
        ...lastPart,
      ].join('\n');
    } else if (truncated) {
      result += '\n... [Truncated output due to size limit] ...';
    }

    return result;
  }
}
