import { describe, it, expect } from 'vitest';
import { checkWorkspaceBoundary, resolveSafePath, normalizePath } from './paths.js';

describe('paths boundary and safety checks', () => {
  it('should normalize paths with forward slashes', () => {
    expect(normalizePath('foo\\bar\\baz')).toBe('foo/bar/baz');
  });

  it('should detect paths inside boundaries', () => {
    const root = 'C:/workspace';
    expect(checkWorkspaceBoundary(root, 'C:/workspace/foo/bar.txt')).toBe(true);
    expect(checkWorkspaceBoundary(root, 'C:/workspace/')).toBe(true);
    expect(checkWorkspaceBoundary(root, 'C:/workspace')).toBe(true);
  });

  it('should detect paths outside boundaries', () => {
    const root = 'C:/workspace';
    expect(checkWorkspaceBoundary(root, 'C:/workspace-other/foo')).toBe(false);
    expect(checkWorkspaceBoundary(root, 'C:/other/bar')).toBe(false);
  });

  it('should throw on resolveSafePath if outside boundary', () => {
    const root = 'C:/workspace';
    expect(() => resolveSafePath(root, '../other/file.txt')).toThrow();
    expect(resolveSafePath(root, 'src/main.ts')).toBe('C:/workspace/src/main.ts');
  });
});
