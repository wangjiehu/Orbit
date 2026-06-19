import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { FindSymbolReferencesTool } from './findReferences.js';

describe('FindSymbolReferencesTool tests', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `orbit-find-references-tool-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should find symbol references in actual workspace files', async () => {
    const orbitDir = join(tempDir, '.orbit');
    mkdirSync(orbitDir, { recursive: true });

    const indexContent = {
      files: {
        'src/utils.ts': {
          symbols: [{ name: 'formatDate', type: 'function', line: 12 }],
        },
        'src/main.ts': {
          symbols: [],
        },
      },
    };
    writeFileSync(join(orbitDir, 'symbols.json'), JSON.stringify(indexContent, null, 2), 'utf8');

    mkdirSync(join(tempDir, 'src'), { recursive: true });
    writeFileSync(join(tempDir, 'src/utils.ts'), 'export function formatDate() {\n  return "date";\n}', 'utf8');
    writeFileSync(
      join(tempDir, 'src/main.ts'),
      'import { formatDate } from "./utils.js";\n\nconst formatted = formatDate();\n// formatDate comment should be skipped\nconsole.log(formatted);',
      'utf8'
    );

    const tool = new FindSymbolReferencesTool();
    const result = await tool.execute({ symbol: 'formatDate' }, { cwd: tempDir, sessionId: 'test' });

    expect(result.ok).toBe(true);
    expect(result.data).toBeDefined();
    // It should find references in src/main.ts (import line and call line)
    expect(result.data!.length).toBe(2);

    const files = result.data!.map((r) => r.file);
    expect(files).toContain('src/main.ts');
  });
});
