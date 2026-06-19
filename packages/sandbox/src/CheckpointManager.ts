import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { generateId, resolveSafePath } from '@orbit-ai/shared';
import { FileBackup, Checkpoint } from './types.js';

export class CheckpointManager {
  private checkpoints: Checkpoint[] = [];

  constructor(private cwd: string, private sessionId: string) {}

  public async captureBeforeState(toolCallId: string, filePath: string): Promise<Checkpoint> {
    let originalContent: string | null = null;
    try {
      const safePath = resolveSafePath(this.cwd, filePath);
      if (existsSync(safePath)) {
        originalContent = readFileSync(safePath, 'utf8');
      }
    } catch (e) {
      // File does not exist yet or read failed
    }

    const backup: FileBackup = {
      path: filePath,
      originalContent,
    };

    const checkpoint: Checkpoint = {
      id: generateId('cp'),
      sessionId: this.sessionId,
      timestamp: new Date().toISOString(),
      toolCallId,
      backups: [backup],
    };

    this.checkpoints.push(checkpoint);

    const checkpointDir = join(this.cwd, '.orbit', 'checkpoints', this.sessionId, checkpoint.id);
    mkdirSync(checkpointDir, { recursive: true });

    if (originalContent !== null) {
      writeFileSync(join(checkpointDir, 'backup_content.txt'), originalContent, 'utf8');
    }
    writeFileSync(
      join(checkpointDir, 'meta.json'),
      JSON.stringify({
        id: checkpoint.id,
        timestamp: checkpoint.timestamp,
        toolCallId,
        filePath,
        exists: originalContent !== null,
      }),
      'utf8'
    );

    return checkpoint;
  }

  public getCheckpoints(): Checkpoint[] {
    return this.checkpoints;
  }
}
