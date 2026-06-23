import { ProjectIndex } from "@orbit-build/tools";

export interface ContextPack {
  projectInstructions: string;
  projectIndex: ProjectIndex;
  relevantFiles: Array<{
    path: string;
    reason: string;
    summary?: string;
    excerpt?: string;
  }>;
  recentChanges: string;
  currentDiff: string;
  previousErrors: string;
  codebaseContext?: string;
  tokenBudget: {
    max: number;
    usedEstimate: number;
  };
}
