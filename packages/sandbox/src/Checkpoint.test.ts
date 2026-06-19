import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { CheckpointManager } from './CheckpointManager.js';
import { RollbackManager } from './RollbackManager.js';

describe('Sandbox Checkpoints and Rollbacks', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `orbit-sandbox-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should capture JIT snapshot before edit and rollback successfully', async () => {
    const filePath = 'test.txt';
    const absPath = join(tempDir, filePath);

    writeFileSync(absPath, 'initial-content', 'utf8');

    const cpManager = new CheckpointManager(tempDir, 'session-123');
    const rbManager = new RollbackManager(tempDir);

    const checkpoint = await cpManager.captureBeforeState('call-1', filePath);

    writeFileSync(absPath, 'modified-content', 'utf8');
    expect(readFileSync(absPath, 'utf8')).toBe('modified-content');

    rbManager.rollback(checkpoint);
    expect(readFileSync(absPath, 'utf8')).toBe('initial-content');
  });

  it('should delete newly created files on rollback', async () => {
    const filePath = 'new-file.txt';
    const absPath = join(tempDir, filePath);

    const cpManager = new CheckpointManager(tempDir, 'session-123');
    const rbManager = new RollbackManager(tempDir);

    const checkpoint = await cpManager.captureBeforeState('call-1', filePath);

    writeFileSync(absPath, 'brand-new-file', 'utf8');
    expect(existsSync(absPath)).toBe(true);

    rbManager.rollback(checkpoint);
    expect(existsSync(absPath)).toBe(false);
  });
});
