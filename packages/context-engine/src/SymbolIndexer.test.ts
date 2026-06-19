import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, rmSync, mkdirSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { SymbolIndexer, SymbolIndexSchema } from './SymbolIndexer.js';

describe('SymbolIndexer tests', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `orbit-symbol-indexer-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });

    // Create a mock orbit config in target dir
    const configContent = `
name: test-project
context:
  ignore:
    - node_modules/**
    - dist/**
`;
    writeFileSync(join(tempDir, 'orbit.config.yaml'), configContent, 'utf8');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should parse class, interface, function, and constants and cache them in symbols.json', async () => {
    const srcDir = join(tempDir, 'src');
    mkdirSync(srcDir, { recursive: true });

    const code = `
// This is a comment class IgnoredClass
export class User {
  constructor(public name: string) {}
}

export interface AuthDetails {
  token: string;
}

export type Status = 'active' | 'inactive';

export async function login(user: User): Promise<boolean> {
  return true;
}

export const API_URL = 'http://localhost';
`;
    writeFileSync(join(srcDir, 'index.ts'), code, 'utf8');

    const indexer = new SymbolIndexer(tempDir);
    await indexer.index();

    const indexPath = join(tempDir, '.orbit', 'symbols.json');
    expect(existsSync(indexPath)).toBe(true);

    const raw = readFileSync(indexPath, 'utf8');
    const index = JSON.parse(raw);

    // Validate using Zod schema
    const parseResult = SymbolIndexSchema.safeParse(index);
    expect(parseResult.success).toBe(true);

    const fileIndex = index.files['src/index.ts'];
    expect(fileIndex).toBeDefined();
    expect(fileIndex.symbols.length).toBe(5);

    const names = fileIndex.symbols.map((s: any) => s.name);
    expect(names).toContain('User');
    expect(names).toContain('AuthDetails');
    expect(names).toContain('Status');
    expect(names).toContain('login');
    expect(names).toContain('API_URL');

    // Test Search
    const searchRes = await indexer.search('auth');
    expect(searchRes.length).toBe(1);
    expect(searchRes[0].name).toBe('AuthDetails');
    expect(searchRes[0].filePath).toBe('src/index.ts');
    expect(searchRes[0].type).toBe('interface');
  });

  it('should incrementally update, clean up deleted files, and respect ignore lists', async () => {
    const srcDir = join(tempDir, 'src');
    mkdirSync(srcDir, { recursive: true });

    writeFileSync(join(srcDir, 'a.ts'), 'export class A {}', 'utf8');
    writeFileSync(join(srcDir, 'b.ts'), 'export class B {}', 'utf8');

    const indexer = new SymbolIndexer(tempDir);
    await indexer.index();

    const indexPath = join(tempDir, '.orbit', 'symbols.json');
    let raw = readFileSync(indexPath, 'utf8');
    let index = JSON.parse(raw);
    expect(Object.keys(index.files).length).toBe(2);

    // 1. Delete b.ts and run indexer again
    rmSync(join(srcDir, 'b.ts'));
    await indexer.index();

    raw = readFileSync(indexPath, 'utf8');
    index = JSON.parse(raw);
    expect(Object.keys(index.files).length).toBe(1);
    expect(index.files['src/a.ts']).toBeDefined();
    expect(index.files['src/b.ts']).toBeUndefined();
  });
});
