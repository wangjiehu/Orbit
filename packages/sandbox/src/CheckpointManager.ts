import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  rmSync,
} from "fs";
import { join, dirname } from "path";
import { generateId, resolveSafePath } from "@orbit-build/shared";
import { FileBackup, Checkpoint } from "./types.js";

export class CheckpointManager {
  private checkpoints: Checkpoint[] = [];

  constructor(
    private cwd: string,
    private sessionId: string,
  ) {
    this.loadPersistedCheckpoints();
  }

  private getSessionCheckpointDir(): string {
    return join(this.cwd, ".orbit", "checkpoints", this.sessionId);
  }

  private loadPersistedCheckpoints(): void {
    const sessionDir = this.getSessionCheckpointDir();
    if (!existsSync(sessionDir)) return;

    const loaded: Checkpoint[] = [];
    for (const entry of readdirSync(sessionDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const checkpointDir = join(sessionDir, entry.name);
      const metaPath = join(checkpointDir, "meta.json");
      if (!existsSync(metaPath)) continue;
      try {
        const meta = JSON.parse(readFileSync(metaPath, "utf8"));
        if (
          typeof meta.id !== "string" ||
          typeof meta.timestamp !== "string" ||
          typeof meta.toolCallId !== "string" ||
          typeof meta.filePath !== "string"
        ) {
          continue;
        }
        const backupPath = join(checkpointDir, "backup_content.txt");
        const originalContent =
          meta.exists === true && existsSync(backupPath)
            ? readFileSync(backupPath, "utf8")
            : null;
        loaded.push({
          id: meta.id,
          sessionId: this.sessionId,
          timestamp: meta.timestamp,
          toolCallId: meta.toolCallId,
          backups: [
            {
              path: meta.filePath,
              originalContent,
            },
          ],
        });
      } catch {
        // Ignore incomplete checkpoints instead of blocking session recovery.
      }
    }
    loaded.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
    this.checkpoints = loaded;
  }

  public async captureBeforeState(
    toolCallId: string,
    filePath: string,
  ): Promise<Checkpoint> {
    let originalContent: string | null = null;
    try {
      const safePath = resolveSafePath(this.cwd, filePath);
      if (existsSync(safePath)) {
        originalContent = readFileSync(safePath, "utf8");
      }
    } catch (e) {
      // File does not exist yet or read failed
    }

    const backup: FileBackup = {
      path: filePath,
      originalContent,
    };

    const checkpoint: Checkpoint = {
      id: generateId("cp"),
      sessionId: this.sessionId,
      timestamp: new Date().toISOString(),
      toolCallId,
      backups: [backup],
    };

    this.checkpoints.push(checkpoint);

    const checkpointDir = join(this.getSessionCheckpointDir(), checkpoint.id);
    mkdirSync(checkpointDir, { recursive: true });

    if (originalContent !== null) {
      writeFileSync(
        join(checkpointDir, "backup_content.txt"),
        originalContent,
        "utf8",
      );
    }
    writeFileSync(
      join(checkpointDir, "meta.json"),
      JSON.stringify({
        id: checkpoint.id,
        timestamp: checkpoint.timestamp,
        toolCallId,
        filePath,
        exists: originalContent !== null,
      }),
      "utf8",
    );

    return checkpoint;
  }

  public getCheckpoints(): Checkpoint[] {
    return [...this.checkpoints];
  }

  public removeCheckpoint(checkpointId: string): void {
    this.checkpoints = this.checkpoints.filter(
      (checkpoint) => checkpoint.id !== checkpointId,
    );
    const checkpointDir = join(this.getSessionCheckpointDir(), checkpointId);
    if (existsSync(checkpointDir)) {
      rmSync(checkpointDir, { recursive: true, force: true });
    }
  }
}
