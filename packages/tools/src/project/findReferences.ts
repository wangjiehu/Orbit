import { z } from 'zod';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { OrbitTool, ToolContext, ToolResult } from '../types.js';

export const FindSymbolReferencesInputSchema = z.object({
  symbol: z.string().describe('The symbol name to search references for.'),
});

export type FindSymbolReferencesInput = z.infer<typeof FindSymbolReferencesInputSchema>;

export interface SymbolReferenceEntry {
  file: string;
  line: number;
  content: string;
}

export class FindSymbolReferencesTool implements OrbitTool<FindSymbolReferencesInput, SymbolReferenceEntry[]> {
  name = 'find_symbol_references';
  description = 'Find all references, call sites, and usages of a specific symbol in the workspace files.';
  inputSchema = FindSymbolReferencesInputSchema;
  risk = 'read' as const;

  async execute(input: FindSymbolReferencesInput, ctx: ToolContext): Promise<ToolResult<SymbolReferenceEntry[]>> {
    try {
      const indexPath = join(ctx.cwd, '.orbit', 'symbols.json');
      if (!existsSync(indexPath)) {
        return {
          ok: true,
          data: [],
          display: 'Symbol index is not yet built. Please run a task first to generate the symbol map.',
        };
      }

      const raw = readFileSync(indexPath, 'utf8');
      const index = JSON.parse(raw);

      if (!index.files || typeof index.files !== 'object') {
        return {
          ok: true,
          data: [],
          display: 'Symbol index format is invalid.',
        };
      }

      const results: SymbolReferenceEntry[] = [];
      const symbolRegex = new RegExp(`\\b${input.symbol}\\b`);

      for (const [file, fileData] of Object.entries(index.files)) {
        const absPath = join(ctx.cwd, file);
        if (existsSync(absPath)) {
          const lines = readFileSync(absPath, 'utf8').split('\n');
          for (let idx = 0; idx < lines.length; idx++) {
            const line = lines[idx];
            const trimmed = line.trim();
            
            // Skip comments to avoid false positives
            if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
              continue;
            }
            
            if (symbolRegex.test(line) && !line.includes('export ') && !line.includes('symbols.some')) {
              results.push({
                file,
                line: idx + 1,
                content: trimmed,
              });
            }
          }
        }
      }

      const display = results.length > 0
        ? `Found ${results.length} references for symbol "${input.symbol}":\n` +
          results.map((r) => `- ${r.file}:${r.line} -> ${r.content.substring(0, 100)}`).join('\n')
        : `No references found for symbol "${input.symbol}".`;

      return {
        ok: true,
        data: results,
        display,
      };
    } catch (e: any) {
      return {
        ok: false,
        error: `Failed to find references: ${e.message}`,
      };
    }
  }
}
