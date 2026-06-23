import { ToolRisk } from "@orbit-build/shared";

export type PermissionAction = "allow" | "ask" | "deny";

export interface PermissionDecision {
  action: PermissionAction;
  reason: string;
  risk?: ToolRisk;
  preview?: string;
}
