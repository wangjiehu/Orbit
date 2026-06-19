import { ConfigLoader } from '@orbit-ai/config';
import { AgentLoop } from '@orbit-ai/core';
import { join } from 'path';

class MockProvider {
  id = 'mock-provider';
  type = 'openai-compatible';
  capabilities = {
    streaming: true,
    toolCalls: true,
    jsonMode: true,
    thinking: false,
    vision: false,
    promptCaching: false,
  };

  constructor() {
    this.step = 0;
  }

  async *chat(input) {
    this.step++;
    if (this.step === 1) {
      yield {
        type: 'tool_call',
        toolCall: {
          id: 'call_1',
          name: 'read_file',
          arguments: JSON.stringify({ path: 'math.js' }),
        },
      };
    } else if (this.step === 2) {
      yield {
        type: 'tool_call',
        toolCall: {
          id: 'call_2',
          name: 'edit_file',
          arguments: JSON.stringify({
            path: 'math.js',
            oldText: 'return a - b;',
            newText: 'return a + b;',
          }),
        },
      };
    } else if (this.step === 3) {
      yield {
        type: 'tool_call',
        toolCall: {
          id: 'call_3',
          name: 'run_tests',
          arguments: '{}',
        },
      };
    } else {
      yield {
        type: 'text_delta',
        text: 'I have successfully located and fixed the bug in math.js! The test suite is now passing.',
      };
      yield { type: 'done' };
    }
  }
}

async function verify() {
  // Path points to mock-project
  const cwd = join(process.cwd(), '..', '..', 'mock-project');
  const config = ConfigLoader.loadSync(cwd);

  config.permissions.mode = 'auto';

  const interaction = {
    async askApproval(reason, preview) {
      console.log(`[Interaction] Auto-approving action for verification: ${reason}`);
      return true;
    },
    showText(text) {
      console.log(text);
    },
    showDiff(filePath, before, after) {
      console.log(`[Interaction] File Modified Diff (${filePath}):`);
      console.log(`- Before: ${before?.trim()}`);
      console.log(`+ After: ${after?.trim()}`);
    },
  };

  const provider = new MockProvider();
  const loop = new AgentLoop(cwd, config, provider, 'fix the math tests', interaction);
  await loop.run();
}

verify().catch(console.error);
