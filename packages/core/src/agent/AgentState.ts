import { OrbitMessage } from "@orbit-build/model-providers";

export interface AgentState {
  sessionId: string;
  task: string;
  history: OrbitMessage[];
  relevantFiles: Array<{ path: string; reason: string; readOnly?: boolean }>;
  done: boolean;
  attemptCount: number;
  maxAttempts: number;
}

export function createInitialState(
  sessionId: string,
  task: string,
): AgentState {
  return {
    sessionId,
    task,
    history: [],
    relevantFiles: [],
    done: false,
    attemptCount: 0,
    maxAttempts: 3,
  };
}
