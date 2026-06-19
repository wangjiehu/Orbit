import { z } from 'zod';
import { readFileSync, writeFileSync } from 'fs';
import { resolveSafePath } from '@orbit-ai/shared';
import { OrbitTool, ToolContext, ToolResult } from '../types.js';

export const EditFileInputSchema = z.object({
  path: z.string(),
  oldText: z.string(),
  newText: z.string(),
  replaceAll: z.boolean().optional(),
});

export type EditFileInput = z.infer<typeof EditFileInputSchema>;

export class EditFileTool implements OrbitTool<EditFileInput, void> {
  name = 'edit_file';
  description =
    'Replace oldText with newText inside a file. If replaceAll is false (default), oldText must occur exactly once in the file to prevent accidental edits.';
  inputSchema = EditFileInputSchema;
  risk = 'write' as const;

  async execute(input: EditFileInput, ctx: ToolContext): Promise<ToolResult<void>> {
    try {
      const safePath = resolveSafePath(ctx.cwd, input.path);
      const content = readFileSync(safePath, 'utf8');

      const parts = content.split(input.oldText);
      const occurrences = parts.length - 1;

      if (occurrences === 0) {
        return {
          ok: false,
          error: `Could not find target content "oldText" in file "${input.path}". No replacement made. Ensure indentation and line endings match exactly.`,
        };
      }

      if (occurrences > 1 && !input.replaceAll) {
        return {
          ok: false,
          error: `Found ${occurrences} occurrences of target content "oldText" in file "${input.path}". Provide more surrounding lines to make it unique, or set replaceAll to true.`,
        };
      }

      const newContent = content.split(input.oldText).join(input.newText);
      writeFileSync(safePath, newContent, 'utf8');

      return {
        ok: true,
        display: `Successfully replaced content in ${input.path}`,
      };
    } catch (e: any) {
      return {
        ok: false,
        error: e.message,
      };
    }
  }
}
