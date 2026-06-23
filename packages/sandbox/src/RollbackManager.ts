import { existsSync, writeFileSync, unlinkSync } from "fs";
import { resolveSafePath } from "@orbit-build/shared";
import { Checkpoint } from "./types.js";

export class RollbackManager {
  constructor(private cwd: string) {}

  public rollback(checkpoint: Checkpoint): {
    success: boolean;
    error?: string;
    restored: string[];
  } {
    const restored: string[] = [];

    for (const backup of checkpoint.backups) {
      const safePath = resolveSafePath(this.cwd, backup.path);

      if (backup.originalContent === null) {
        // File did not exist before the tool execution, so delete it on rollback
        if (existsSync(safePath)) {
          unlinkSync(safePath);
          restored.push(backup.path);
        }
      } else {
        // Restore previous content
        writeFileSync(safePath, backup.originalContent, "utf8");
        restored.push(backup.path);
      }
    }

    return {
      success: true,
      restored,
    };
  }
}
