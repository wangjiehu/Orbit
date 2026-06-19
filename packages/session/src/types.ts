export interface Session {
  id: string;
  cwd: string;
  title: string;
  status: 'active' | 'completed' | 'failed';
  createdAt: string;
  updatedAt: string;
  provider: string;
  model: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostEstimate: number;
}

export interface SessionEvent {
  id: string;
  sessionId: string;
  type: string;
  payload: any;
  createdAt: string;
}

export interface ToolCallRecord {
  id: string;
  sessionId: string;
  toolName: string;
  inputJson: string;
  outputJson?: string;
  risk: string;
  permissionDecision: string;
  status: 'pending' | 'success' | 'failed' | 'denied';
  startedAt: string;
  endedAt?: string;
}

export interface FileChangeRecord {
  id: string;
  sessionId: string;
  path: string;
  beforeHash?: string;
  afterHash?: string;
  diff: string;
  createdAt: string;
}
