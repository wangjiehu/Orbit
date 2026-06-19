import { describe, it, expect } from 'vitest';
import { Orchestrator } from './Orchestrator.js';
import { OrbitConfig } from '@orbit-ai/config';
import { ModelProvider } from '@orbit-ai/model-providers';
import fs from 'fs';
import path from 'path';

describe('Orchestrator Multi-Agent Flow', () => {
  const dummyConfig: OrbitConfig = {
    name: 'test',
    provider: { default: 'openai' },
    models: {
      default: 'gpt-4',
      planner: 'planner-model',
      coder: 'coder-model',
      reviewer: 'reviewer-model',
      fast: 'fast-model',
      summarizer: 'fast-model',
    },
    providers: { openai: { type: 'openai', apiKey: 'test' } },
    permissions: {
      mode: 'auto',
      allowRead: true,
      requireApprovalForWrite: false,
      requireApprovalForBash: false,
      blockDangerousCommands: false,
      protectSecrets: false,
      protectedPaths: [],
    },
    context: {
      maxFilesToIndex: 10,
      maxFileSizeKb: 10,
      ignore: [],
      autoCompact: false,
      compactThreshold: 0.75,
    },
    tools: {
      bash: { enabled: false, timeoutMs: 1000 },
      webSearch: { enabled: false },
      mcp: { enabled: false },
    },
    mcpServers: {},
    hooks: {},
    session: { store: 'jsonl', path: '.orbit/test-sessions' },
  };

  const dummyInteraction = {
    askApproval: async () => true,
    showText: () => {},
    showDiff: () => {},
  };

  it('should run the Planner, Coder, and Reviewer flow and pass on APPROVED', async () => {
    let plannerCalled = false;
    let coderCalled = false;
    let reviewerCalled = false;

    const mockProvider: ModelProvider = {
      id: 'openai',
      chat: (params: any) => {
        return (async function* () {
          if (params.model === 'planner-model') {
            plannerCalled = true;
            yield { type: 'text_delta' as const, text: 'Plan: Add a new test file.' };
          } else if (params.model === 'coder-model') {
            coderCalled = true;
            yield { type: 'text_delta' as const, text: 'Coder finished.' };
          } else if (params.model === 'reviewer-model') {
            reviewerCalled = true;
            yield { type: 'text_delta' as const, text: 'Verification APPROVED' };
          }
        })();
      },
    } as any;

    const orchestrator = new Orchestrator(
      process.cwd(),
      dummyConfig,
      mockProvider,
      'Test user task',
      dummyInteraction
    );

    await orchestrator.run();

    expect(plannerCalled).toBe(true);
    expect(coderCalled).toBe(true);
    expect(reviewerCalled).toBe(true);

    // Verify plan file was written
    const planPath = path.resolve(process.cwd(), 'orbit_plan.md');
    expect(fs.existsSync(planPath)).toBe(true);
    expect(fs.readFileSync(planPath, 'utf8')).toContain('Plan: Add a new test file.');

    // Cleanup
    try {
      fs.unlinkSync(planPath);
    } catch {
      // Ignored
    }
  });
});
