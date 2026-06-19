export type OrbitErrorCode =
  | 'CONFIG_NOT_FOUND'
  | 'API_KEY_MISSING'
  | 'MODEL_PROVIDER_ERROR'
  | 'TOOL_NOT_FOUND'
  | 'TOOL_SCHEMA_INVALID'
  | 'PERMISSION_DENIED'
  | 'FILE_NOT_FOUND'
  | 'FILE_TOO_LARGE'
  | 'PATH_OUTSIDE_WORKSPACE'
  | 'PROTECTED_FILE'
  | 'COMMAND_TIMEOUT'
  | 'COMMAND_BLOCKED'
  | 'TEST_FAILED'
  | 'CHECKPOINT_FAILED'
  | 'ROLLBACK_CONFLICT';

export interface OrbitError {
  code: OrbitErrorCode;
  message: string;
  cause?: unknown;
  recoverable?: boolean;
  suggestion?: string;
}

export class OrbitException extends Error {
  public readonly code: OrbitErrorCode;
  public readonly recoverable: boolean;
  public readonly suggestion?: string;

  constructor(error: OrbitError) {
    super(error.message);
    this.name = 'OrbitException';
    this.code = error.code;
    this.recoverable = error.recoverable ?? false;
    this.suggestion = error.suggestion;
    if (error.cause) {
      this.cause = error.cause;
    }
  }

  toOrbitError(): OrbitError {
    return {
      code: this.code,
      message: this.message,
      cause: this.cause,
      recoverable: this.recoverable,
      suggestion: this.suggestion,
    };
  }
}

export type ToolRisk = 'read' | 'write' | 'execute' | 'network' | 'dangerous';
