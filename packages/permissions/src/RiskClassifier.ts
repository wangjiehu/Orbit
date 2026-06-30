import {
  ToolRisk,
  normalizePath,
} from "@orbit-build/shared";

const DANGEROUS_COMMAND_REGEXES = [
  /\brm\s+-rf\b/i,
  /\brm\s+.*(?:--recursive|-r)\b/i,
  /\bdel\s+\/s\b/i,
  /\b(?:rmdir|rd)\s+\/s\b/i,
  /\bremove-item\b.*(?:-recurse|-force)\b/i,
  /\bchmod\s+-R\b/i,
  /\bchown\s+-R\b/i,
  /\bsudo\b/i,
  /\bformat(?:\.com)?\b/i,
  /\bdiskpart\b/i,
  /\bshutdown\b/i,
  /\bstop-computer\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\b/i,
  /\bgit\s+(?:checkout|restore)\s+.*(?:--|\.)\b/i,
  /\bgit\s+push\s+.*--force(?:-with-lease)?\b/i,
  /\bssh\b/i,
  /\bscp\b/i,
  /\brsync\b/i,
];

const NETWORK_COMMAND_REGEXES = [
  /\bcurl\b/i,
  /\bwget\b/i,
  /\binvoke-webrequest\b/i,
  /\binvoke-restmethod\b/i,
  /\bnpm\s+install\b/i,
  /\bnpm\s+publish\b/i,
  /\bpnpm\s+install\b/i,
  /\bpnpm\s+add\b/i,
  /\bpnpm\s+publish\b/i,
  /\byarn\s+install\b/i,
  /\byarn\s+add\b/i,
  /\byarn\s+publish\b/i,
  /\bpip\s+install\b/i,
  /\bgo\s+get\b/i,
  /\bgit\s+(?:fetch|pull|push|clone)\b/i,
  /\bgh\s+(?:api|pr|issue|release|repo|workflow|run)\b/i,
];

export class RiskClassifier {
  public static isProtectedPath(
    filePath: string,
    protectedPaths: string[],
  ): boolean {
    const normalized = normalizePath(filePath).toLowerCase();

    for (const pattern of protectedPaths) {
      const cleanPattern = pattern.replace(/\\/g, "/").toLowerCase();

      // Simple glob replacement matching
      const escaped = cleanPattern
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*\*/g, "__DOUBLE_STAR__")
        .replace(/\*/g, "[^/]*")
        .replace(/__DOUBLE_STAR__\/?/g, "(?:|.*/)");

      const regex = new RegExp(`^${escaped}$`);
      const regexEndsWith = new RegExp(`${escaped}$`);

      if (
        regex.test(normalized) ||
        regexEndsWith.test(normalized) ||
        normalized.includes(cleanPattern.replace(/\*/g, ""))
      ) {
        return true;
      }
    }

    return false;
  }

  public static classifyBashCommand(command: string): ToolRisk {
    for (const regex of DANGEROUS_COMMAND_REGEXES) {
      if (regex.test(command)) {
        return "dangerous";
      }
    }

    for (const regex of NETWORK_COMMAND_REGEXES) {
      if (regex.test(command)) {
        return "network";
      }
    }

    return "execute";
  }
}
