import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ContextPackBuilder } from './ContextPackBuilder.js';

describe('ContextPackBuilder tests', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `orbit-context-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should load project instructions and summarize relevant files', async () => {
    writeFileSync(join(tempDir, 'README.md'), '# Test Project Instruction', 'utf8');
    writeFileSync(join(tempDir, 'src.js'), 'console.log("hello");', 'utf8');

    const builder = new ContextPackBuilder(tempDir);
    const pack = await builder.build([{ path: 'src.js', reason: 'Initial entry' }]);

    expect(pack.projectInstructions).toContain('Test Project Instruction');
    expect(pack.relevantFiles.length).toBe(1);
    expect(pack.relevantFiles[0].path).toBe('src.js');
    expect(pack.relevantFiles[0].excerpt).toContain('console.log("hello");');
  });
});
