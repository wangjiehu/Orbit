import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import { generateId } from "@orbit-build/shared";

export interface WorktreeSession {
  path: string;
  branchName: string;
}

export class WorktreeManager {
  constructor(private cwd: string) {}

  public isGitRepo(): boolean {
    try {
      execSync("git rev-parse --is-inside-work-tree", { cwd: this.cwd, stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  }

  public createWorktree(subagentId: string): WorktreeSession {
    if (!this.isGitRepo()) {
      throw new Error("Cannot create git worktree: directory is not a git repository.");
    }

    const branchName = `orbit-wt-${subagentId}-${generateId("lbl").slice(0, 8)}`;
    const wtPath = path.join(this.cwd, ".orbit", "worktrees", subagentId);

    // Create parent directory if needed
    fs.mkdirSync(path.dirname(wtPath), { recursive: true });

    // If worktree path already exists, clean it up first
    if (fs.existsSync(wtPath)) {
      try {
        execSync(`git worktree remove --force "${wtPath}"`, { cwd: this.cwd, stdio: "ignore" });
      } catch {
        try {
          fs.rmSync(wtPath, { recursive: true, force: true });
        } catch {}
      }
    }

    // Add worktree pointing to a new branch off current HEAD
    execSync(`git worktree add -b "${branchName}" "${wtPath}" HEAD`, {
      cwd: this.cwd,
      stdio: "pipe",
    });

    return {
      path: wtPath,
      branchName,
    };
  }

  public mergeAndCleanup(session: WorktreeSession): { success: boolean; conflictFiles?: string[] } {
    if (!this.isGitRepo()) {
      return { success: false };
    }

    // 1. Commit any changes inside the worktree if not clean
    try {
      execSync("git add -A", { cwd: session.path, stdio: "ignore" });
      const status = execSync("git status --porcelain", { cwd: session.path }).toString().trim();
      if (status.length > 0) {
        execSync('git commit --no-verify -m "subagent automatic worktree commit"', {
          cwd: session.path,
          stdio: "ignore",
        });
      }
    } catch {
      // Ignore if commit failed (e.g. no changes or git hooks failed)
    }

    // 2. Remove the worktree first before merge so branch is not checked out
    try {
      execSync(`git worktree remove --force "${session.path}"`, {
        cwd: this.cwd,
        stdio: "ignore",
      });
    } catch {
      // Ignore
    }

    // 3. Merge the branch back to the main repository
    try {
      execSync(`git merge "${session.branchName}"`, {
        cwd: this.cwd,
        stdio: "pipe",
      });
    } catch {
      // Conflict occurred
      const conflictStatus = execSync("git status --porcelain", { cwd: this.cwd }).toString();
      const conflictFiles = conflictStatus
        .split("\n")
        .filter((line) => {
          const status = line.slice(0, 2);
          return ["DD", "AU", "UD", "UA", "DU", "AA", "UU"].includes(status);
        })
        .map((line) => {
          let filePart = line.slice(3).trim();
          if (filePart.startsWith('"') && filePart.endsWith('"')) {
            filePart = filePart.slice(1, -1);
          }
          return filePart;
        });

      return {
        success: false,
        conflictFiles,
      };
    }

    // 4. Delete the branch since it was merged successfully
    try {
      execSync(`git branch -d "${session.branchName}"`, {
        cwd: this.cwd,
        stdio: "ignore",
      });
    } catch {
      // Force delete if needed
      try {
        execSync(`git branch -D "${session.branchName}"`, {
          cwd: this.cwd,
          stdio: "ignore",
        });
      } catch {}
    }

    return { success: true };
  }
}
