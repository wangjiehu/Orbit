import { ToolRisk } from "@orbit-build/shared";
import { OrbitConfig } from "@orbit-build/config";
import { PermissionDecision } from "./types.js";
import { RiskClassifier } from "./RiskClassifier.js";

export class PermissionEngine {
  constructor(private config: OrbitConfig) {}

  public evaluate(
    toolName: string,
    args: any,
    declaredRisk?: ToolRisk,
  ): PermissionDecision {
    const mode = this.config.permissions.mode;
    const protectedPaths = this.config.permissions.protectedPaths;

    let risk: ToolRisk = declaredRisk || "read";
    let targetPath: string | undefined;
    let cmdString: string | undefined;

    const readTools = new Set([
      "read_file",
      "list_files",
      "glob",
      "grep",
      "inspect_project",
      "detect_project",
      "search_symbols",
      "find_symbol_references",
      "git_status",
      "git_diff",
    ]);
    const writeTools = new Set([
      "write_file",
      "edit_file",
      "replace_file_content",
      "multi_replace_file_content",
    ]);

    if (readTools.has(toolName) || writeTools.has(toolName)) {
      targetPath = args.path || args.TargetFile || args.filePath || args.file;
      risk = readTools.has(toolName) ? "read" : "write";
    } else if (toolName === "bash") {
      cmdString = args.command;
      risk = RiskClassifier.classifyBashCommand(cmdString || "");
    } else if (toolName === "run_tests" || toolName === "git_commit") {
      risk = "execute";
    } else if (toolName === "git_restore") {
      risk = "dangerous";
    }

    if (
      targetPath &&
      RiskClassifier.isProtectedPath(targetPath, protectedPaths)
    ) {
      if (mode === "strict") {
        return {
          action: "deny",
          reason: `Access to protected path "${targetPath}" is blocked under strict mode.`,
          risk,
        };
      }
      return {
        action: "ask",
        reason: `Tool requested access to protected path "${targetPath}".`,
        risk,
      };
    }

    if (mode === "plan") {
      if (risk === "read") {
        return {
          action: "allow",
          reason: "Read is allowed under plan mode.",
          risk,
        };
      }
      return {
        action: "deny",
        reason: `Action requires "${risk}" permission, which is blocked under plan mode.`,
        risk,
      };
    }

    if (mode === "strict") {
      if (risk === "read") {
        return {
          action: "allow",
          reason: "Read operations are allowed.",
          risk,
        };
      }
      if (risk === "dangerous" || risk === "network") {
        return {
          action: "deny",
          reason: `Dangerous or network operations ("${toolName}") are blocked under strict mode.`,
          risk,
        };
      }
      return {
        action: "ask",
        reason: `Strict mode requires confirmation for all write and execution operations.`,
        risk,
      };
    }

    if (mode === "normal") {
      if (risk === "read") {
        return {
          action: "allow",
          reason: "Read operations are allowed.",
          risk,
        };
      }
      if (risk === "dangerous") {
        return {
          action: "deny",
          reason: `Dangerous operation "${toolName}" is blocked under normal mode.`,
          risk,
        };
      }
      return {
        action: "ask",
        reason: `Normal mode requires user confirmation for "${toolName}" (${risk}).`,
        risk,
      };
    }

    if (mode === "auto") {
      if (risk === "read" || risk === "write" || risk === "execute") {
        return {
          action: "allow",
          reason: `Automatically allowed under auto mode.`,
          risk,
        };
      }
      if (risk === "dangerous") {
        return {
          action: "deny",
          reason: `Dangerous operation "${toolName}" is blocked under auto mode.`,
          risk,
        };
      }
      return {
        action: "ask",
        reason: `Auto mode requires user confirmation for "${toolName}" (${risk}).`,
        risk,
      };
    }

    return {
      action: "ask",
      reason: "Unclassified tool risk, prompting user.",
      risk,
    };
  }
}
