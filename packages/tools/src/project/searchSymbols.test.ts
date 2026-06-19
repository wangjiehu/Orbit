import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { SearchSymbolsTool } from './searchSymbols.js';

describe('SearchSymbolsTool tests', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `orbit-search-symbols-tool-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should search matching symbols from the index file', async () => {
    const orbitDir = join(tempDir, '.orbit');
    mkdirSync(orbitDir, { recursive: true });

    const indexContent = {
      files: {
        'src/utils.ts': {
          mtime: 123456,
          symbols: [
            { name: 'formatDate', type: 'function', line: 12 },
            { name: 'parseDate', type: 'function', line: 20 },
          ],
        },
        'src/User.ts': {
          mtime: 789012,
          symbols: [
            { name: 'User', type: 'class', line: 5 },
          ],
        },
      },
      indexedAt: '2026-06-18T23:51:14Z',
    };

    writeFileSync(join(orbitDir, 'symbols.json'), JSON.stringify(indexContent, null, 2), 'utf8');

    const tool = new SearchSymbolsTool();
    const result = await tool.execute({ query: 'date' }, { cwd: tempDir, sessionId: 'test' });

    expect(result.ok).toBe(true);
    expect(result.data).toBeDefined();
    expect(result.data!.length).toBe(2);

    const names = result.data!.map((s) => s.name);
    expect(names).toContain('formatDate');
    expect(names).toContain('parseDate');

    // Test query with no match
    const noMatchResult = await tool.execute({ query: 'unknown' }, { cwd: tempDir, sessionId: 'test' });
    expect(noMatchResult.ok).toBe(true);
    expect(noMatchResult.data!.length).toBe(0);
    expect(noMatchResult.display).toContain('No symbols matching "unknown" found');
  });

  it('should handle missing index file gracefully', async () => {
    const tool = new SearchSymbolsTool();
    const result = await tool.execute({ query: 'User' }, { cwd: tempDir, sessionId: 'test' });
    expect(result.ok).toBe(true);
    expect(result.data!.length).toBe(0);
    expect(result.display).toContain('Symbol index is not yet built');
  });
});
