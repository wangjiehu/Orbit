import { z } from "zod";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { execa } from "execa";
import { OrbitTool, ToolContext, ToolResult } from "../types.js";
import { LogTruncator } from "@orbit-build/shared";

export const RunTestsInputSchema = z.object({
  command: z.string().optional(),
});

export type RunTestsInput = z.infer<typeof RunTestsInputSchema>;

export class RunTestsTool implements OrbitTool<
  RunTestsInput,
  { stdout: string; stderr: string; exitCode: number }
> {
  name = "run_tests";
  description =
    "Run project tests. If no command is provided, it auto-detects and triggers the appropriate runner (e.g. npm test, cargo test, pytest, go test).";
  inputSchema = RunTestsInputSchema;
  risk = "execute" as const;

  async execute(
    input: RunTestsInput,
    ctx: ToolContext,
  ): Promise<ToolResult<{ stdout: string; stderr: string; exitCode: number }>> {
    let testCommand = input.command;

    if (!testCommand) {
      testCommand = this.inferTestCommand(ctx.cwd);
    }

    try {
      const result = await execa(testCommand, {
        shell: true,
        cwd: ctx.cwd,
        reject: false,
        signal: ctx.abortSignal,
        timeout: 60000,
      });

      const stdout = result.stdout || "";
      const stderr = result.stderr || "";
      const exitCode = result.exitCode ?? 0;

      const displayStdout = LogTruncator.truncate(stdout, 150, 20000);
      const displayStderr = LogTruncator.truncate(stderr, 150, 20000);

      return {
        ok: exitCode === 0,
        data: { stdout, stderr, exitCode },
        display: `Ran tests using command "${testCommand}":\n\nStdout:\n${displayStdout}\n\nStderr:\n${displayStderr}\n\nExit code: ${exitCode}`,
        error:
          exitCode !== 0
            ? `Tests failed with exit code ${exitCode}`
            : undefined,
      };
    } catch (e: any) {
      if (e.name === "AbortError" || ctx.abortSignal?.aborted) {
        return {
          ok: false,
          error: `Test execution was interrupted by the user.`,
        };
      }
      return {
        ok: false,
        error: `Failed to run tests: ${e.message}`,
      };
    }
  }

  private inferTestCommand(cwd: string): string {
    if (existsSync(join(cwd, "Cargo.toml"))) {
      return "cargo test";
    }
    if (existsSync(join(cwd, "go.mod"))) {
      return "go test ./...";
    }
    if (existsSync(join(cwd, "pom.xml"))) {
      return "mvn test";
    }
    if (existsSync(join(cwd, "build.gradle"))) {
      return "./gradlew test";
    }
    if (existsSync(join(cwd, "package.json"))) {
      try {
        const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"));
        if (pkg.scripts?.test) {
          if (existsSync(join(cwd, "pnpm-lock.yaml"))) return "pnpm test";
          if (existsSync(join(cwd, "yarn.lock"))) return "yarn test";
          return "npm test";
        }
      } catch (e) {
        // Fallback
      }
      return "npm test";
    }
    if (
      existsSync(join(cwd, "pytest.ini")) ||
      existsSync(join(cwd, "pyproject.toml"))
    ) {
      return "pytest";
    }
    return "npm test";
  }
}
