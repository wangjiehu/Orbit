import { join } from 'path';
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, readdirSync } from 'fs';
import { generateId } from '@orbit-ai/shared';
import { Session, SessionEvent, ToolCallRecord, FileChangeRecord } from './types.js';

export class SessionStore {
  private sessionDir: string;

  constructor(private cwd: string) {
    this.sessionDir = join(cwd, '.orbit', 'sessions');
    mkdirSync(this.sessionDir, { recursive: true });
  }

  public createSession(provider: string, model: string): Session {
    const session: Session = {
      id: generateId('sess'),
      cwd: this.cwd,
      title: 'New Orbit Session',
      status: 'active',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      provider,
      model,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCostEstimate: 0,
    };

    const dir = join(this.sessionDir, session.id);
    mkdirSync(dir, { recursive: true });

    writeFileSync(join(dir, 'session.json'), JSON.stringify(session, null, 2), 'utf8');

    return session;
  }

  public getSession(id: string): Session | undefined {
    const sessionFile = join(this.sessionDir, id, 'session.json');
    if (!existsSync(sessionFile)) return undefined;
    try {
      return JSON.parse(readFileSync(sessionFile, 'utf8'));
    } catch {
      return undefined;
    }
  }

  public updateSession(session: Session): void {
    const sessionFile = join(this.sessionDir, session.id, 'session.json');
    session.updatedAt = new Date().toISOString();
    writeFileSync(sessionFile, JSON.stringify(session, null, 2), 'utf8');
  }

  public listSessions(): Session[] {
    if (!existsSync(this.sessionDir)) return [];
    const dirs = readdirSync(this.sessionDir);
    const sessions: Session[] = [];
    for (const dir of dirs) {
      const sess = this.getSession(dir);
      if (sess) sessions.push(sess);
    }
    return sessions.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  }

  public appendEvent(sessionId: string, type: string, payload: any): SessionEvent {
    const event: SessionEvent = {
      id: generateId('evt'),
      sessionId,
      type,
      payload,
      createdAt: new Date().toISOString(),
    };

    const file = join(this.sessionDir, sessionId, 'events.jsonl');
    appendFileSync(file, JSON.stringify(event) + '\n', 'utf8');
    return event;
  }

  public getEvents(sessionId: string): SessionEvent[] {
    const file = join(this.sessionDir, sessionId, 'events.jsonl');
    if (!existsSync(file)) return [];
    const content = readFileSync(file, 'utf8');
    return content
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line));
  }

  public recordToolCall(record: Omit<ToolCallRecord, 'startedAt'>): ToolCallRecord {
    const fullRecord: ToolCallRecord = {
      ...record,
      startedAt: new Date().toISOString(),
    };

    const file = join(this.sessionDir, record.sessionId, 'tool_calls.jsonl');
    appendFileSync(file, JSON.stringify(fullRecord) + '\n', 'utf8');
    return fullRecord;
  }

  public recordFileChange(record: Omit<FileChangeRecord, 'createdAt' | 'id'>): FileChangeRecord {
    const fullRecord: FileChangeRecord = {
      ...record,
      id: generateId('fc'),
      createdAt: new Date().toISOString(),
    };

    const file = join(this.sessionDir, record.sessionId, 'file_changes.jsonl');
    appendFileSync(file, JSON.stringify(fullRecord) + '\n', 'utf8');
    return fullRecord;
  }
}
