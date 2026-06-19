import { ToolRisk, checkWorkspaceBoundary, normalizePath } from '@orbit-ai/shared';

const DANGEROUS_COMMAND_REGEXES = [
  /\brm\s+-rf\b/i,
  /\bdel\s+\/s\b/i,
  /\brmdir\b/i,
  /\bchmod\s+-R\b/i,
  /\bchown\s+-R\b/i,
  /\bsudo\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\b/i,
  /\bgit\s+push\s+.*--force\b/i,
  /\bssh\b/i,
  /\bscp\b/i,
  /\brsync\b/i,
];

const NETWORK_COMMAND_REGEXES = [
  /\bcurl\b/i,
  /\bwget\b/i,
  /\bnpm\s+install\b/i,
  /\bpnpm\s+install\b/i,
  /\bpnpm\s+add\b/i,
  /\byarn\s+install\b/i,
  /\byarn\s+add\b/i,
  /\bpip\s+install\b/i,
  /\bgo\s+get\b/i,
];

export class RiskClassifier {
  public static isProtectedPath(filePath: string, protectedPaths: string[]): boolean {
    const normalized = normalizePath(filePath).toLowerCase();

    for (const pattern of protectedPaths) {
      const cleanPattern = pattern.replace(/\\/g, '/').toLowerCase();

      // Simple glob replacement matching
      const escaped = cleanPattern
        .replace(/\./g, '\\.')
        .replace(/\*\*/g, '.*')
        .replace(/\*/g, '[^/]*');

      const regex = new RegExp(`^${escaped}$`);
      const regexEndsWith = new RegExp(`${escaped}$`);

      if (
        regex.test(normalized) ||
        regexEndsWith.test(normalized) ||
        normalized.includes(cleanPattern.replace(/\*/g, ''))
      ) {
        return true;
      }
    }

    return false;
  }

  public static classifyBashCommand(command: string): ToolRisk {
    for (const regex of DANGEROUS_COMMAND_REGEXES) {
      if (regex.test(command)) {
        return 'dangerous';
      }
    }

    for (const regex of NETWORK_COMMAND_REGEXES) {
      if (regex.test(command)) {
        return 'network';
      }
    }

    return 'execute';
  }
}
