import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { SessionStore } from './SessionStore.js';

describe('SessionStore file logging', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `orbit-session-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should create session and append events', () => {
    const store = new SessionStore(tempDir);
    const session = store.createSession('deepseek', 'v4-pro');

    expect(session.provider).toBe('deepseek');
    expect(session.model).toBe('v4-pro');

    store.appendEvent(session.id, 'user_message', { text: 'hello' });
    store.appendEvent(session.id, 'assistant_message', { text: 'hi' });

    const events = store.getEvents(session.id);
    expect(events.length).toBe(2);
    expect(events[0].type).toBe('user_message');
    expect(events[0].payload.text).toBe('hello');
  });
});
