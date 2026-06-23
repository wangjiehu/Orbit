import { z } from "zod";
import fs from "fs";
import path from "path";
import { exec } from "child_process";
import { promisify } from "util";
import { eventBus } from "../events/EventBus.js";
import { CheckpointManager } from "@orbit-build/sandbox";

const execPromise = promisify(exec);

export const VerificationContractSchema = z.object({
  suites: z.record(z.string()).default({}),
  allowedModifiedFiles: z.array(z.string()).optional(),
  requiredFiles: z.array(z.string()).optional(),
});

export type VerificationContract = z.infer<typeof VerificationContractSchema>;

export class VerificationContractManager {
  private contract: VerificationContract | null = null;

  constructor(
    private cwd: string,
    private sessionId: string,
    private checkpointManager: CheckpointManager,
  ) {
    this.loadContract();
  }

  private loadContract(): void {
    const contractPath = path.join(this.cwd, ".orbit", "verification.json");
    if (fs.existsSync(contractPath)) {
      try {
        const content = fs.readFileSync(contractPath, "utf8");
        const parsed = JSON.parse(content);
        const validated = VerificationContractSchema.safeParse(parsed);
        if (validated.success) {
          this.contract = validated.data;
        } else {
          console.error(`[VerificationContract] Validation failed:`, validated.error);
        }
      } catch (e: any) {
        console.error(`[VerificationContract] Failed to load/parse: ${e.message}`);
      }
    }
  }

  public hasContract(): boolean {
    return this.contract !== null;
  }

  public async runVerification(): Promise<{ success: boolean; error?: string }> {
    if (!this.contract) {
      return { success: true };
    }

    eventBus.emitEvent("verification_started", { type: "contract" });

    try {
      // 1. Run configured suites
      const suites = this.contract.suites;
      for (const [name, command] of Object.entries(suites)) {
        if (command) {
          eventBus.emitEvent("info", { message: `Running verification suite: ${name} (${command})...` });
          try {
            await execPromise(command, { cwd: this.cwd });
          } catch (err: any) {
            const output = err.stdout || err.stderr || err.message;
            eventBus.emitEvent("verification_ended", {
              success: false,
              results: { suite: name, error: output },
            });
            return {
              success: false,
              error: `Verification suite "${name}" failed with output:\n${output}`,
            };
          }
        }
      }

      // 2. Check allowed modified files bounds
      if (this.contract.allowedModifiedFiles && this.contract.allowedModifiedFiles.length > 0) {
        eventBus.emitEvent("info", { message: "Checking modified files bounds..." });
        let modifiedFiles: string[] = [];
        try {
          const { stdout } = await execPromise("git status --porcelain", { cwd: this.cwd });
          modifiedFiles = stdout
            .split("\n")
            .filter((line) => line.length > 3)
            .map((line) => {
              let filePart = line.slice(3).trim();
              if (filePart.startsWith('"') && filePart.endsWith('"')) {
                filePart = filePart.slice(1, -1);
              }
              if (filePart.includes(" -> ")) {
                const parts = filePart.split(" -> ");
                filePart = parts[parts.length - 1].trim();
              }
              return filePart;
            })
            .filter((file) => file.length > 0 && !file.startsWith(".orbit/") && file !== ".orbit");
        } catch {
          // Fallback if git is not initialized
        }

        const patterns = this.contract.allowedModifiedFiles;
        for (const file of modifiedFiles) {
          const matched = patterns.some((pattern) => {
            const escaped = pattern
              .replace(/[.+^${}()|[\]\\]/g, "\\$&")
              .replace(/\*\*/g, ".*")
              .replace(/\*/g, "[^/]*");
            const regex = new RegExp("^" + escaped + "$");
            return regex.test(file);
          });

          if (!matched) {
            eventBus.emitEvent("verification_ended", {
              success: false,
              results: { fileBoundsViolation: file },
            });
            return {
              success: false,
              error: `Modified file "${file}" violates the allowed bounds pattern(s): ${patterns.join(", ")}`,
            };
          }
        }
      }

      // 3. Verify required files are produced
      if (this.contract.requiredFiles && this.contract.requiredFiles.length > 0) {
        eventBus.emitEvent("info", { message: "Verifying required files existence..." });
        for (const requiredFile of this.contract.requiredFiles) {
          const filePath = path.resolve(this.cwd, requiredFile);
          if (!fs.existsSync(filePath)) {
            eventBus.emitEvent("verification_ended", {
              success: false,
              results: { missingRequiredFile: requiredFile },
            });
            return {
              success: false,
              error: `Required file "${requiredFile}" was not produced/found.`,
            };
          }
        }
      }

      eventBus.emitEvent("verification_ended", { success: true });
      return { success: true };
    } catch (e: any) {
      eventBus.emitEvent("verification_ended", {
        success: false,
        results: { error: e.message },
      });
      return { success: false, error: e.message };
    }
  }
}
