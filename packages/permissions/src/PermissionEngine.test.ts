import { describe, it, expect } from 'vitest';
import { PermissionEngine } from './PermissionEngine.js';
import { OrbitConfig } from '@orbit-ai/config';

const mockConfig = (mode: 'strict' | 'normal' | 'auto' | 'plan'): OrbitConfig => ({
  name: 'test',
  provider: { default: 'deepseek-openai' },
  models: {
    default: 'foo',
    fast: 'foo',
    planner: 'foo',
    coder: 'foo',
    reviewer: 'foo',
    summarizer: 'foo',
  },
  providers: {},
  permissions: {
    mode,
    allowRead: true,
    requireApprovalForWrite: true,
    requireApprovalForBash: true,
    blockDangerousCommands: true,
    protectSecrets: true,
    protectedPaths: ['.env', 'id_rsa'],
  },
  context: {
    maxFilesToIndex: 100,
    maxFileSizeKb: 10,
    ignore: [],
    autoCompact: false,
    compactThreshold: 0.8,
  },
  tools: {
    bash: { enabled: true, timeoutMs: 1000 },
    webSearch: { enabled: false },
    mcp: { enabled: false },
  },
  session: { store: 'sqlite', path: 'foo.db' },
});

describe('PermissionEngine tests', () => {
  it('should allow read tools in all modes', () => {
    const engine = new PermissionEngine(mockConfig('normal'));
    const decision = engine.evaluate('read_file', { path: 'src/main.ts' });
    expect(decision.action).toBe('allow');
  });

  it('should require prompt for write tools in normal/strict modes', () => {
    const engine = new PermissionEngine(mockConfig('normal'));
    const decision = engine.evaluate('write_file', { path: 'src/main.ts', content: 'hello' });
    expect(decision.action).toBe('ask');
  });

  it('should block dangerous operations under normal/strict/auto modes', () => {
    const engine = new PermissionEngine(mockConfig('normal'));
    const decision = engine.evaluate('bash', { command: 'rm -rf /' });
    expect(decision.action).toBe('deny');
  });

  it('should block access to protected files under strict mode, but prompt under normal', () => {
    const strictEngine = new PermissionEngine(mockConfig('strict'));
    const normalEngine = new PermissionEngine(mockConfig('normal'));

    expect(strictEngine.evaluate('read_file', { path: '.env' }).action).toBe('deny');
    expect(normalEngine.evaluate('read_file', { path: '.env' }).action).toBe('ask');
  });
});
