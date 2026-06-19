import { z } from 'zod';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { OrbitTool, ToolContext, ToolResult } from '../types.js';

export const SearchSymbolsInputSchema = z.object({
  query: z.string().describe('The symbol name or part of the name to search for.'),
});

export type SearchSymbolsInput = z.infer<typeof SearchSymbolsInputSchema>;

export interface SymbolSearchResult {
  name: string;
  type: 'class' | 'interface' | 'function' | 'constant' | 'type';
  filePath: string;
  line: number;
}

export class SearchSymbolsTool implements OrbitTool<SearchSymbolsInput, SymbolSearchResult[]> {
  name = 'search_symbols';
  description = 'Search for symbol declarations (classes, functions, interfaces, constants) in the workspace symbol index.';
  inputSchema = SearchSymbolsInputSchema;
  risk = 'read' as const;

  async execute(input: SearchSymbolsInput, ctx: ToolContext): Promise<ToolResult<SymbolSearchResult[]>> {
    try {
      const indexPath = join(ctx.cwd, '.orbit', 'symbols.json');
      if (!existsSync(indexPath)) {
        return {
          ok: true,
          data: [],
          display: 'Symbol index is not yet built. Please try again in a few moments.',
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

      const results: SymbolSearchResult[] = [];
      const queryLower = input.query.toLowerCase();

      for (const [filePath, fileData] of Object.entries(index.files)) {
        const data = fileData as any;
        if (data && Array.isArray(data.symbols)) {
          for (const sym of data.symbols) {
            if (sym.name && sym.name.toLowerCase().includes(queryLower)) {
              results.push({
                name: sym.name,
                type: sym.type,
                filePath,
                line: sym.line,
              });
            }
          }
        }
      }

      // Sort results by similarity or name
      results.sort((a, b) => a.name.localeCompare(b.name));

      const display = results.length > 0
        ? `Found ${results.length} matching symbol(s):\n` +
          results.map((r) => `- [${r.type}] ${r.name} in ${r.filePath}:${r.line}`).join('\n')
        : `No symbols matching "${input.query}" found.`;

      return {
        ok: true,
        data: results,
        display,
      };
    } catch (e: any) {
      return {
        ok: false,
        error: `Failed to search symbols: ${e.message}`,
      };
    }
  }
}
