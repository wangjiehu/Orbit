import { z } from "zod";

// --- Model Request & Response Events ---
export const ModelRequestEventSchema = z.object({
  type: z.literal("model_request"),
  payload: z.object({
    model: z.string(),
    messages: z.array(z.any()),
  }),
});

export const ModelResponseEventSchema = z.object({
  type: z.literal("model_response"),
  payload: z.object({
    model: z.string(),
    text: z.string().optional(),
    reasoning_content: z.string().optional(),
    usage: z.object({
      inputTokens: z.number(),
      outputTokens: z.number(),
      cacheReadTokens: z.number().optional(),
      cacheWriteTokens: z.number().optional(),
    }).optional(),
    toolCalls: z.array(z.any()).optional(),
  }),
});

// --- Agent Lifecycle Events ---
export const AgentStartEventSchema = z.object({
  type: z.literal("agent_start"),
  payload: z.object({
    taskId: z.string(),
    task: z.string(),
  }),
});

export const AgentSpawnEventSchema = z.object({
  type: z.literal("agent_spawn"),
  payload: z.object({
    parentId: z.string(),
    childId: z.string(),
    role: z.string(),
    task: z.string(),
  }),
});

export const AgentStatusEventSchema = z.object({
  type: z.literal("agent_status"),
  payload: z.object({
    taskId: z.string(),
    status: z.string(),
    detail: z.string().optional(),
  }),
});

export const AgentCompletedEventSchema = z.object({
  type: z.literal("agent_completed"),
  payload: z.object({
    taskId: z.string(),
    success: z.boolean(),
    result: z.any().optional(),
    error: z.string().optional(),
  }),
});

export const LoopStartEventSchema = z.object({
  type: z.literal("loop_start"),
  payload: z.object({
    attempt: z.number(),
  }),
});

// --- Streaming Delta Events ---
export const ModelDeltaEventSchema = z.object({
  type: z.literal("model_delta"),
  payload: z.object({
    text: z.string(),
  }),
});

export const ThinkingDeltaEventSchema = z.object({
  type: z.literal("thinking_delta"),
  payload: z.object({
    text: z.string(),
  }),
});

// --- Cost & Tokens Events ---
export const CostUpdateEventSchema = z.object({
  type: z.literal("cost_update"),
  payload: z.object({
    turnCost: z.number(),
    sessionCost: z.number(),
    totalInputTokens: z.number(),
    totalCacheReadTokens: z.number(),
    totalOutputTokens: z.number(),
  }),
});

// --- Tool Proposal, Approval & Execution Events ---
export const ToolProposalEventSchema = z.object({
  type: z.literal("tool_proposal"),
  payload: z.object({
    toolCallId: z.string().optional(),
    toolName: z.string(),
    arguments: z.any(),
    explanation: z.string().optional(),
  }),
});

export const ToolApprovalEventSchema = z.object({
  type: z.literal("tool_approval"),
  payload: z.object({
    toolCallId: z.string().optional(),
    approved: z.boolean(),
    reason: z.string().optional(),
  }),
});

export const ToolResultEventSchema = z.object({
  type: z.literal("tool_result"),
  payload: z.object({
    toolCallId: z.string().optional(),
    toolName: z.string(),
    result: z.any().optional(),
    error: z.string().optional(),
  }),
});

// --- File Changes & Checkpoints Events ---
export const FileChangeEventSchema = z.object({
  type: z.literal("file_change"),
  payload: z.object({
    filePath: z.string(),
    type: z.enum(["write", "edit", "create", "delete"]),
    explanation: z.string().optional(),
  }),
});

export const CheckpointCreatedEventSchema = z.object({
  type: z.literal("checkpoint_created"),
  payload: z.object({
    checkpointId: z.string(),
    timestamp: z.string(),
    message: z.string().optional(),
  }),
});

// --- Verification Events ---
export const VerificationStartedEventSchema = z.object({
  type: z.literal("verification_started"),
  payload: z.object({
    type: z.string(),
  }),
});

export const VerificationEndedEventSchema = z.object({
  type: z.literal("verification_ended"),
  payload: z.object({
    success: z.boolean(),
    results: z.any().optional(),
  }),
});

// --- Session Lifecycle Events ---
export const SessionForkEventSchema = z.object({
  type: z.literal("session_fork"),
  payload: z.object({
    parentSessionId: z.string(),
    childSessionId: z.string(),
  }),
});

export const SessionEndedEventSchema = z.object({
  type: z.literal("session_ended"),
  payload: z.object({
    sessionId: z.string(),
  }),
});

// --- Logging & Error Events ---
export const InfoEventSchema = z.object({
  type: z.literal("info"),
  payload: z.object({
    message: z.string(),
  }),
});

export const WarningEventSchema = z.object({
  type: z.literal("warning"),
  payload: z.object({
    message: z.string(),
  }),
});

export const ErrorEventSchema = z.object({
  type: z.literal("error"),
  payload: z.object({
    message: z.string(),
    stack: z.string().optional(),
  }),
});

// --- Discriminated Union ---
export const OrbitEventSchema = z.discriminatedUnion("type", [
  ModelRequestEventSchema,
  ModelResponseEventSchema,
  AgentStartEventSchema,
  AgentSpawnEventSchema,
  AgentStatusEventSchema,
  AgentCompletedEventSchema,
  LoopStartEventSchema,
  ModelDeltaEventSchema,
  ThinkingDeltaEventSchema,
  CostUpdateEventSchema,
  ToolProposalEventSchema,
  ToolApprovalEventSchema,
  ToolResultEventSchema,
  FileChangeEventSchema,
  CheckpointCreatedEventSchema,
  VerificationStartedEventSchema,
  VerificationEndedEventSchema,
  SessionForkEventSchema,
  SessionEndedEventSchema,
  InfoEventSchema,
  WarningEventSchema,
  ErrorEventSchema,
]);

export type OrbitEvent = z.infer<typeof OrbitEventSchema>;
