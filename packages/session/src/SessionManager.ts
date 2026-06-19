import { SessionStore } from './SessionStore.js';
import { Session } from './types.js';

export class SessionManager {
  private store: SessionStore;
  private currentSession?: Session;

  constructor(cwd: string) {
    this.store = new SessionStore(cwd);
  }

  public startNewSession(provider: string, model: string): Session {
    this.currentSession = this.store.createSession(provider, model);
    this.logEvent('session_start', { provider, model });
    return this.currentSession;
  }

  public resumeSession(id: string): Session | undefined {
    const session = this.store.getSession(id);
    if (session) {
      this.currentSession = session;
      this.logEvent('session_resume', { id });
    }
    return session;
  }

  public getActiveSession(): Session | undefined {
    return this.currentSession;
  }

  public logEvent(type: string, payload: any): void {
    if (!this.currentSession) return;
    this.store.appendEvent(this.currentSession.id, type, payload);
  }

  public recordToolExecution(
    toolName: string,
    input: any,
    output: any,
    risk: string,
    decision: string,
    status: 'success' | 'failed' | 'denied'
  ): void {
    if (!this.currentSession) return;

    this.store.recordToolCall({
      sessionId: this.currentSession.id,
      id: input.id || 'tc_unknown',
      toolName,
      inputJson: JSON.stringify(input),
      outputJson: JSON.stringify(output),
      risk,
      permissionDecision: decision,
      status,
    });

    this.logEvent('tool_execution', { toolName, status });
  }

  public recordFileModification(
    path: string,
    diff: string,
    beforeHash?: string,
    afterHash?: string
  ): void {
    if (!this.currentSession) return;

    this.store.recordFileChange({
      sessionId: this.currentSession.id,
      path,
      beforeHash,
      afterHash,
      diff,
    });

    this.logEvent('file_modified', { path });
  }

  public getSessionStore(): SessionStore {
    return this.store;
  }
}
