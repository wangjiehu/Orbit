import { ToolRisk } from '@orbit-ai/shared';

export type PermissionAction = 'allow' | 'ask' | 'deny';

export interface PermissionDecision {
  action: PermissionAction;
  reason: string;
  risk?: ToolRisk;
  preview?: string;
}
