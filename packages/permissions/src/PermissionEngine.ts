import { ToolRisk } from '@orbit-ai/shared';
import { OrbitConfig } from '@orbit-ai/config';
import { PermissionDecision } from './types.js';
import { RiskClassifier } from './RiskClassifier.js';

export class PermissionEngine {
  constructor(private config: OrbitConfig) {}

  public evaluate(toolName: string, args: any, declaredRisk?: ToolRisk): PermissionDecision {
    const mode = this.config.permissions.mode;
    const protectedPaths = this.config.permissions.protectedPaths;

    let risk: ToolRisk = declaredRisk || 'read';
    let targetPath: string | undefined;
    let cmdString: string | undefined;

    if (toolName === 'read_file' || toolName === 'write_file' || toolName === 'edit_file') {
      targetPath = args.path;
      risk = toolName === 'read_file' ? 'read' : 'write';
    } else if (toolName === 'bash') {
      cmdString = args.command;
      risk = RiskClassifier.classifyBashCommand(cmdString || '');
    } else if (toolName === 'run_tests' || toolName === 'git_commit') {
      risk = 'execute';
    } else if (toolName === 'git_restore') {
      risk = 'dangerous';
    }

    if (targetPath && RiskClassifier.isProtectedPath(targetPath, protectedPaths)) {
      if (mode === 'strict') {
        return {
          action: 'deny',
          reason: `Access to protected path "${targetPath}" is blocked under strict mode.`,
          risk,
        };
      }
      return {
        action: 'ask',
        reason: `Tool requested access to protected path "${targetPath}".`,
        risk,
      };
    }

    if (mode === 'plan') {
      if (risk === 'read') {
        return { action: 'allow', reason: 'Read is allowed under plan mode.', risk };
      }
      return {
        action: 'deny',
        reason: `Action requires "${risk}" permission, which is blocked under plan mode.`,
        risk,
      };
    }

    if (mode === 'strict') {
      if (risk === 'read') {
        return { action: 'allow', reason: 'Read operations are allowed.', risk };
      }
      if (risk === 'dangerous' || risk === 'network') {
        return {
          action: 'deny',
          reason: `Dangerous or network operations ("${toolName}") are blocked under strict mode.`,
          risk,
        };
      }
      return {
        action: 'ask',
        reason: `Strict mode requires confirmation for all write and execution operations.`,
        risk,
      };
    }

    if (mode === 'normal') {
      if (risk === 'read') {
        return { action: 'allow', reason: 'Read operations are allowed.', risk };
      }
      if (risk === 'dangerous') {
        return {
          action: 'deny',
          reason: `Dangerous operation "${toolName}" is blocked under normal mode.`,
          risk,
        };
      }
      return {
        action: 'ask',
        reason: `Normal mode requires user confirmation for "${toolName}" (${risk}).`,
        risk,
      };
    }

    if (mode === 'auto') {
      if (risk === 'read' || risk === 'write' || risk === 'execute') {
        return {
          action: 'allow',
          reason: `Automatically allowed under auto mode.`,
          risk,
        };
      }
      if (risk === 'dangerous') {
        return {
          action: 'deny',
          reason: `Dangerous operation "${toolName}" is blocked under auto mode.`,
          risk,
        };
      }
      return {
        action: 'ask',
        reason: `Auto mode requires user confirmation for "${toolName}" (${risk}).`,
        risk,
      };
    }

    return { action: 'ask', reason: 'Unclassified tool risk, prompting user.', risk };
  }
}
