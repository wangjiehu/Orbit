import { confirm, text, spinner, select, multiselect, isCancel } from '@clack/prompts';
import picocolors from 'picocolors';
import readline from 'readline';

export class Prompt {
  public static async askApproval(message: string): Promise<boolean> {
    const response = await confirm({
      message: `${picocolors.yellow(message)} Approve?`,
    });
    if (isCancel(response)) return false;
    return !!response;
  }

  public static async askText(message: string, initialValue?: string): Promise<string | null> {
    const response = await text({
      message,
      placeholder: 'Type your task or command...',
      initialValue,
    });
    if (isCancel(response)) return null;
    return typeof response === 'string' ? response : '';
  }

  public static async askTextWithAutocomplete(
    message: string,
    completerFn: (line: string) => [string[], string],
    promptPrefix?: string
  ): Promise<string | null> {
    return new Promise((resolve) => {
      const promptStr = promptPrefix !== undefined
        ? promptPrefix
        : `${picocolors.cyan('?')} ${message} › `;

      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        completer: completerFn,
        prompt: promptStr,
      });

      rl.prompt();

      rl.on('SIGINT', () => {
        rl.close();
        process.stdout.write('\n');
        resolve(null);
      });

      rl.on('line', (line) => {
        rl.close();
        resolve(line);
      });
    });
  }

  public static async askSelect(message: string, options: { value: string; label: string }[]): Promise<string | null> {
    const response = await select({
      message,
      options,
    });
    if (isCancel(response)) return null;
    return typeof response === 'string' ? response : '';
  }

  public static async askMultiSelect(
    message: string,
    options: { value: string; label: string; hint?: string }[]
  ): Promise<string[] | null> {
    const response = await multiselect({
      message,
      options,
      required: false,
    });
    if (isCancel(response)) return null;
    return Array.isArray(response) ? (response as string[]) : [];
  }

  public static makeSpinner() {
    return spinner();
  }
}


