import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'fs';
import { join } from 'path';
import glob from 'fast-glob';
import { z } from 'zod';
import { ConfigLoader } from '@orbit-ai/config';
import { resolveSafePath } from '@orbit-ai/shared';

export const SymbolEntrySchema = z.object({
  name: z.string(),
  type: z.enum(['class', 'interface', 'function', 'constant', 'type']),
  line: z.number(),
});

export const FileIndexSchema = z.object({
  mtime: z.number(),
  symbols: z.array(SymbolEntrySchema),
});

export const SymbolIndexSchema = z.object({
  files: z.record(FileIndexSchema),
  indexedAt: z.string(),
});

export type SymbolEntry = z.infer<typeof SymbolEntrySchema>;
export type FileIndex = z.infer<typeof FileIndexSchema>;
export type SymbolIndex = z.infer<typeof SymbolIndexSchema>;

export class SymbolIndexer {
  private indexPath: string;

  constructor(private cwd: string) {
    this.indexPath = join(cwd, '.orbit', 'symbols.json');
  }

  /**
   * Run the indexer asynchronously and incrementally.
   */
  public async index(): Promise<void> {
    try {
      const config = ConfigLoader.loadSync(this.cwd);
      const ignorePatterns = config.context?.ignore || [];

      // Load existing index if present
      let indexData: SymbolIndex = { files: {}, indexedAt: new Date().toISOString() };
      if (existsSync(this.indexPath)) {
        try {
          const raw = readFileSync(this.indexPath, 'utf8');
          const parsed = JSON.parse(raw);
          const validated = SymbolIndexSchema.safeParse(parsed);
          if (validated.success) {
            indexData = validated.data;
          }
        } catch {
          // Ignore parse errors and start fresh
        }
      }

      // Find JS/TS files using glob matching context.ignore
      const files = await glob('**/*.{ts,tsx,js,jsx}', {
        cwd: this.cwd,
        ignore: ignorePatterns,
        onlyFiles: true,
        absolute: false,
      });

      const activeFiles = new Set<string>();
      let changed = false;

      for (const relativePath of files) {
        // Resolve absolute path safely to avoid path traversal
        const absolutePath = resolveSafePath(this.cwd, relativePath);
        activeFiles.add(relativePath);

        try {
          const stats = statSync(absolutePath);
          const mtime = stats.mtimeMs;
          const cached = indexData.files[relativePath];

          if (cached && cached.mtime === mtime) {
            continue;
          }

          // Read and parse file symbols
          const content = readFileSync(absolutePath, 'utf8');
          const symbols = this.parseSymbols(content);

          indexData.files[relativePath] = {
            mtime,
            symbols,
          };
          changed = true;
        } catch {
          // Skip file if unreadable
        }
      }

      // Remove files no longer in active workspace list
      for (const relativePath of Object.keys(indexData.files)) {
        if (!activeFiles.has(relativePath)) {
          delete indexData.files[relativePath];
          changed = true;
        }
      }

      if (changed) {
        indexData.indexedAt = new Date().toISOString();
        const parentDir = join(this.cwd, '.orbit');
        if (!existsSync(parentDir)) {
          mkdirSync(parentDir, { recursive: true });
        }
        writeFileSync(this.indexPath, JSON.stringify(indexData, null, 2), 'utf8');
      }
    } catch {
      // Fail silently to avoid blocking process lifecycle
    }
  }

  /**
   * Helper to query matched symbols by name query.
   */
  public async search(query: string): Promise<Array<SymbolEntry & { filePath: string }>> {
    const results: Array<SymbolEntry & { filePath: string }> = [];
    if (!existsSync(this.indexPath)) {
      return results;
    }

    try {
      const raw = readFileSync(this.indexPath, 'utf8');
      const parsed = JSON.parse(raw);
      const validated = SymbolIndexSchema.safeParse(parsed);
      if (!validated.success) return results;

      const lowercaseQuery = query.toLowerCase();
      for (const [filePath, fileData] of Object.entries(validated.data.files)) {
        const fileIndex = fileData as FileIndex;
        for (const sym of fileIndex.symbols) {
          if (sym.name.toLowerCase().includes(lowercaseQuery)) {
            results.push({
              ...sym,
              filePath,
            });
          }
        }
      }
    } catch {
      // Fail silently
    }

    return results;
  }

  private parseSymbols(content: string): SymbolEntry[] {
    const symbols: SymbolEntry[] = [];
    const lines = content.split(/\r?\n/);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNumber = i + 1;

      // Ignore comment lines
      if (/^\s*(\/\/|\/\*|\*)/.test(line)) {
        continue;
      }

      // Match Class
      const classMatch = line.match(/^\s*(?:export\s+)?(?:default\s+)?class\s+([a-zA-Z0-9_$]+)/);
      if (classMatch) {
        symbols.push({ name: classMatch[1], type: 'class', line: lineNumber });
        continue;
      }

      // Match Interface
      const interfaceMatch = line.match(/^\s*(?:export\s+)?interface\s+([a-zA-Z0-9_$]+)/);
      if (interfaceMatch) {
        symbols.push({ name: interfaceMatch[1], type: 'interface', line: lineNumber });
        continue;
      }

      // Match Type
      const typeMatch = line.match(/^\s*(?:export\s+)?type\s+([a-zA-Z0-9_$]+)/);
      if (typeMatch) {
        symbols.push({ name: typeMatch[1], type: 'type', line: lineNumber });
        continue;
      }

      // Match Function
      const functionMatch = line.match(/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([a-zA-Z0-9_$]+)/);
      if (functionMatch) {
        symbols.push({ name: functionMatch[1], type: 'function', line: lineNumber });
        continue;
      }

      // Match Exported Constant
      const constMatch = line.match(/^\s*export\s+const\s+([a-zA-Z0-9_$]+)/);
      if (constMatch) {
        symbols.push({ name: constMatch[1], type: 'constant', line: lineNumber });
        continue;
      }
    }

    return symbols;
  }
}
