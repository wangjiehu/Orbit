import http, { type IncomingMessage, type ServerResponse } from "http";
import { spawn } from "child_process";
import type { OrbitConfig } from "@orbit-build/config";
import { eventBus } from "@orbit-build/core";
import { buildCacheDiagnostics } from "./CacheDiagnostics.js";

type WebUiLoopSnapshot = {
  getSessionId?: () => string;
  getSessions?: () => unknown[];
  getRelevantFiles?: () => Array<{ path: string; reason?: string }>;
  getHistory?: () => unknown[];
  getSessionCost?: () => number;
  getTotalInputTokens?: () => number;
  getTotalCacheReadTokens?: () => number;
  getTotalOutputTokens?: () => number;
  getModelOverride?: () => string | undefined;
};

export interface WebUiSettingsPatch {
  model?: string;
  permissionMode?: "strict" | "normal" | "auto" | "plan";
  webSearchEnabled?: boolean;
  webSearchProvider?: "auto" | "searxng" | "tavily" | "bing" | "duckduckgo";
  webSearchMaxResults?: number;
}

export interface WebUiOptions {
  cwd: string;
  config: OrbitConfig;
  loop?: WebUiLoopSnapshot;
  port?: number;
  open?: boolean;
  submitPrompt?: (prompt: string) => Promise<{ ok: boolean; message?: string }>;
  updateSettings?: (
    patch: WebUiSettingsPatch,
  ) => Promise<{ ok: boolean; message?: string }>;
}

export interface WebUiHandle {
  url: string;
  port: number;
  close(): Promise<void>;
}

let activeHandle: WebUiHandle | undefined;
let activeOptions: WebUiOptions | undefined;
const sseClients = new Set<ServerResponse>();
let eventBridge:
  | ((event: { type: string; payload: unknown }) => void)
  | undefined;

export function parseWebUiArgs(rawArgs: string): {
  port?: number;
  open: boolean;
} {
  const args = rawArgs
    .split(/\s+/)
    .map((item) => item.trim())
    .filter(Boolean);
  let port: number | undefined;
  let open = true;

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--no-open") {
      open = false;
      continue;
    }
    if (arg === "--port") {
      const next = args[index + 1];
      if (/^\d+$/.test(next || "")) {
        const parsed = Number(next);
        if (Number.isInteger(parsed) && parsed >= 0 && parsed <= 65535) {
          port = parsed;
        }
        index++;
      }
      continue;
    }
    const match = arg.match(/^--port=(\d+)$/);
    const rawPort = match?.[1] || (/^\d+$/.test(arg) ? arg : undefined);
    if (rawPort) {
      const parsed = Number(rawPort);
      if (Number.isInteger(parsed) && parsed >= 0 && parsed <= 65535) {
        port = parsed;
      }
    }
  }

  return { port, open };
}

function collectStatus(options: WebUiOptions) {
  const { cwd, config, loop } = options;
  const sessions = safeCall(() => loop?.getSessions?.()) || [];
  const relevantFiles = safeCall(() => loop?.getRelevantFiles?.()) || [];
  const history = safeCall(() => loop?.getHistory?.()) || [];
  const sessionId = safeCall(() => loop?.getSessionId?.()) || "";
  const providerId = config.provider.default || "unknown";
  const provider = config.providers[providerId] || {};
  const activeModel =
    safeCall(() => loop?.getModelOverride?.()) || config.models.default;

  return {
    workspace: cwd,
    provider: {
      id: providerId,
      type: provider.type || "unknown",
      baseUrl: provider.baseUrl || "",
    },
    models: config.models,
    activeModel,
    permissions: config.permissions,
    tools: {
      webSearch: config.tools.webSearch,
      mcp: config.tools.mcp,
    },
    skills: config.skills,
    session: {
      activeId: sessionId,
      count: Array.isArray(sessions) ? sessions.length : 0,
      historyMessages: Array.isArray(history) ? history.length : 0,
      cost: safeCall(() => loop?.getSessionCost?.()) || 0,
      inputTokens: safeCall(() => loop?.getTotalInputTokens?.()) || 0,
      cacheReadTokens: safeCall(() => loop?.getTotalCacheReadTokens?.()) || 0,
      outputTokens: safeCall(() => loop?.getTotalOutputTokens?.()) || 0,
    },
    context: {
      relevantFiles: Array.isArray(relevantFiles) ? relevantFiles.length : 0,
      maxFiles: config.context.maxFilesToIndex,
      compactThreshold: config.context.compactThreshold,
    },
    cacheDiagnostics: stripAnsi(buildCacheDiagnostics(cwd)),
    updatedAt: new Date().toISOString(),
  };
}

function collectMessages(loop?: WebUiLoopSnapshot) {
  const history = safeCall(() => loop?.getHistory?.()) || [];
  if (!Array.isArray(history)) return [];
  return history.map((message, index) => normalizeMessage(message, index));
}

function normalizeMessage(message: unknown, index: number) {
  const record = isRecord(message) ? message : {};
  return {
    id: typeof record.id === "string" ? record.id : `message-${index}`,
    role: typeof record.role === "string" ? record.role : "assistant",
    createdAt:
      typeof record.createdAt === "string" ? record.createdAt : undefined,
    text: extractText(record.content),
  };
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (!isRecord(block)) return "";
      if (block.type === "text" && typeof block.text === "string") {
        return block.text;
      }
      if (block.type === "tool_result" && typeof block.content === "string") {
        return block.content;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function getSettings(options: WebUiOptions) {
  const { config, loop } = options;
  return {
    model: safeCall(() => loop?.getModelOverride?.()) || config.models.default,
    permissionMode: config.permissions.mode,
    webSearchEnabled: config.tools.webSearch.enabled,
    webSearchProvider: config.tools.webSearch.provider,
    webSearchMaxResults: config.tools.webSearch.maxResults,
  };
}

function json(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(data));
}

function text(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const body = Buffer.concat(chunks).toString("utf8").trim();
  return body ? JSON.parse(body) : {};
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, "");
}

function safeCall<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

function renderHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Orbit Web UI</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #08090b;
      --surface: #101317;
      --surface-2: #151a20;
      --line: #303844;
      --text: #e7eaee;
      --muted: #b7c0ca;
      --soft: #8b98a6;
      --green: #9dca9b;
      --cyan: #9fcbdb;
      --yellow: #dfc372;
      --red: #df8c8c;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background: var(--bg);
      color: var(--text);
      font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }
    header {
      height: 54px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding: 0 18px;
      border-bottom: 1px solid var(--line);
      background: #0d1013;
    }
    h1 { margin: 0; font-size: 17px; letter-spacing: 0.08em; }
    .status { display: flex; gap: 14px; color: var(--muted); white-space: nowrap; }
    .layout {
      height: calc(100vh - 54px);
      display: grid;
      grid-template-columns: minmax(0, 1fr) 320px;
    }
    main {
      min-width: 0;
      display: grid;
      grid-template-rows: minmax(0, 1fr) auto;
    }
    #messages {
      overflow: auto;
      padding: 18px;
      display: flex;
      flex-direction: column;
      gap: 14px;
    }
    .message {
      max-width: 980px;
      border-left: 3px solid var(--line);
      padding: 2px 0 2px 12px;
    }
    .message.user { border-left-color: var(--cyan); }
    .message.assistant { border-left-color: var(--green); }
    .role {
      color: var(--muted);
      font-weight: 700;
      margin-bottom: 5px;
    }
    .body {
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    .composer {
      border-top: 1px solid var(--line);
      padding: 12px;
      background: #0d1013;
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 10px;
    }
    textarea {
      width: 100%;
      min-height: 48px;
      max-height: 180px;
      resize: vertical;
      color: var(--text);
      background: var(--surface);
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 10px;
      font: inherit;
    }
    button, select, input {
      color: var(--text);
      background: var(--surface-2);
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 8px 10px;
      font: inherit;
    }
    button { cursor: pointer; }
    button:hover { border-color: var(--cyan); }
    button:disabled { cursor: not-allowed; opacity: 0.55; }
    aside {
      min-width: 0;
      overflow: auto;
      border-left: 1px solid var(--line);
      background: var(--surface);
      padding: 14px;
    }
    section {
      border-bottom: 1px solid var(--line);
      padding: 0 0 14px;
      margin-bottom: 14px;
    }
    h2 {
      margin: 0 0 10px;
      color: var(--cyan);
      font-size: 13px;
    }
    label {
      display: grid;
      gap: 5px;
      margin-bottom: 10px;
      color: var(--muted);
    }
    input[type="checkbox"] { justify-self: start; }
    dl {
      display: grid;
      grid-template-columns: 112px 1fr;
      gap: 7px 10px;
      margin: 0;
    }
    dt { color: var(--soft); }
    dd { margin: 0; overflow-wrap: anywhere; }
    pre {
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      color: var(--muted);
      margin: 0;
    }
    #events {
      max-height: 170px;
      overflow: auto;
      color: var(--muted);
      display: grid;
      gap: 6px;
    }
    .ok { color: var(--green); }
    .warn { color: var(--yellow); }
    .error { color: var(--red); }
    @media (max-width: 900px) {
      .layout { grid-template-columns: 1fr; grid-template-rows: minmax(0, 1fr) auto; }
      aside { border-left: 0; border-top: 1px solid var(--line); max-height: 42vh; }
      .status { display: none; }
    }
  </style>
</head>
<body>
  <header>
    <h1>ORBIT</h1>
    <div class="status">
      <span id="modelLine">model</span>
      <span id="cacheLine">cache</span>
      <span id="sessionLine">session</span>
    </div>
  </header>
  <div class="layout">
    <main>
      <div id="messages"></div>
      <form id="composer" class="composer">
        <textarea id="prompt" placeholder="Ask Orbit..." autocomplete="off"></textarea>
        <button id="send" type="submit">Send</button>
      </form>
    </main>
    <aside>
      <section>
        <h2>Runtime</h2>
        <dl id="runtime"></dl>
      </section>
      <section>
        <h2>Controls</h2>
        <label>Model <input id="model" /></label>
        <label>Permission
          <select id="permission">
            <option value="strict">strict</option>
            <option value="normal">normal</option>
            <option value="auto">auto</option>
            <option value="plan">plan</option>
          </select>
        </label>
        <label>Search provider
          <select id="searchProvider">
            <option value="auto">auto</option>
            <option value="searxng">searxng</option>
            <option value="tavily">tavily</option>
            <option value="bing">bing</option>
            <option value="duckduckgo">duckduckgo</option>
          </select>
        </label>
        <label>Search max results <input id="searchMax" type="number" min="1" max="20" /></label>
        <label>Web search <input id="searchEnabled" type="checkbox" /></label>
        <button id="saveSettings" type="button">Save Settings</button>
      </section>
      <section>
        <h2>Live Events</h2>
        <div id="events"></div>
      </section>
      <section>
        <h2>DeepSeek Cache</h2>
        <pre id="cache">Loading...</pre>
      </section>
    </aside>
  </div>
  <script>
    const messagesEl = document.getElementById('messages');
    const eventsEl = document.getElementById('events');
    const promptEl = document.getElementById('prompt');
    const sendEl = document.getElementById('send');
    let streamingEl = null;
    let busy = false;

    const api = async (url, options) => {
      const response = await fetch(url, options);
      const data = await response.json();
      if (!response.ok || data.ok === false) {
        throw new Error(data.message || data.error || response.statusText);
      }
      return data;
    };

    const appendEvent = (text, className) => {
      const row = document.createElement('div');
      if (className) row.className = className;
      row.textContent = text;
      eventsEl.append(row);
      eventsEl.scrollTop = eventsEl.scrollHeight;
    };

    const messageNode = (role, text) => {
      const root = document.createElement('article');
      root.className = 'message ' + role;
      const title = document.createElement('div');
      title.className = 'role';
      title.textContent = role === 'user' ? 'User' : role === 'assistant' ? 'Orbit' : role;
      const body = document.createElement('div');
      body.className = 'body';
      body.textContent = text || '';
      root.append(title, body);
      return { root, body };
    };

    const renderMessages = async () => {
      const data = await api('/api/messages');
      messagesEl.replaceChildren();
      for (const msg of data.messages) {
        if (!msg.text) continue;
        messagesEl.append(messageNode(msg.role, msg.text).root);
      }
      messagesEl.scrollTop = messagesEl.scrollHeight;
    };

    const fill = (id, rows) => {
      const root = document.getElementById(id);
      root.replaceChildren();
      for (const [k, v] of rows) {
        const dt = document.createElement('dt');
        const dd = document.createElement('dd');
        dt.textContent = k;
        dd.textContent = String(v ?? '');
        root.append(dt, dd);
      }
    };

    const loadStatus = async () => {
      const data = await api('/api/status');
      document.getElementById('modelLine').textContent = data.activeModel;
      document.getElementById('sessionLine').textContent = data.session.activeId || 'no session';
      document.getElementById('cacheLine').textContent = 'cache read ' + data.session.cacheReadTokens;
      fill('runtime', [
        ['Workspace', data.workspace],
        ['Provider', data.provider.id],
        ['Mode', data.permissions.mode],
        ['Messages', data.session.historyMessages],
        ['Cost', '$' + Number(data.session.cost || 0).toFixed(4)],
        ['Context files', data.context.relevantFiles],
      ]);
      document.getElementById('cache').textContent = data.cacheDiagnostics;
      document.getElementById('model').value = data.activeModel || '';
      document.getElementById('permission').value = data.permissions.mode;
      document.getElementById('searchEnabled').checked = !!data.tools.webSearch.enabled;
      document.getElementById('searchProvider').value = data.tools.webSearch.provider || 'auto';
      document.getElementById('searchMax').value = data.tools.webSearch.maxResults || 8;
    };

    document.getElementById('composer').addEventListener('submit', async (event) => {
      event.preventDefault();
      const prompt = promptEl.value.trim();
      if (!prompt || busy) return;
      busy = true;
      sendEl.disabled = true;
      promptEl.value = '';
      messagesEl.append(messageNode('user', prompt).root);
      streamingEl = messageNode('assistant', '');
      messagesEl.append(streamingEl.root);
      messagesEl.scrollTop = messagesEl.scrollHeight;
      try {
        await api('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt }),
        });
      } catch (error) {
        appendEvent(String(error), 'error');
      } finally {
        busy = false;
        sendEl.disabled = false;
        streamingEl = null;
        await renderMessages();
        await loadStatus();
      }
    });

    document.getElementById('saveSettings').addEventListener('click', async () => {
      try {
        await api('/api/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: document.getElementById('model').value.trim(),
            permissionMode: document.getElementById('permission').value,
            webSearchEnabled: document.getElementById('searchEnabled').checked,
            webSearchProvider: document.getElementById('searchProvider').value,
            webSearchMaxResults: Number(document.getElementById('searchMax').value),
          }),
        });
        appendEvent('Settings saved', 'ok');
        await loadStatus();
      } catch (error) {
        appendEvent(String(error), 'error');
      }
    });

    const events = new EventSource('/api/events');
    events.onmessage = (message) => {
      const event = JSON.parse(message.data);
      if (event.kind === 'orbit_event') {
        if (event.type === 'model_delta' && streamingEl) {
          streamingEl.body.textContent += event.payload.text || '';
          messagesEl.scrollTop = messagesEl.scrollHeight;
        } else if (event.type === 'thinking_delta') {
          appendEvent('thinking ' + (event.payload.text || '').slice(0, 120));
        } else if (event.type === 'tool_proposal') {
          appendEvent('tool ' + event.payload.toolName, 'warn');
        } else if (event.type === 'tool_result') {
          appendEvent('done ' + event.payload.toolName, event.payload.error ? 'error' : 'ok');
        } else if (event.type === 'cache_update' || event.type === 'cost_update') {
          loadStatus().catch(() => {});
        } else if (event.type === 'info' || event.type === 'warning' || event.type === 'error') {
          appendEvent(event.payload.message || event.type, event.type === 'error' ? 'error' : event.type === 'warning' ? 'warn' : undefined);
        }
      } else if (event.kind === 'turn_done') {
        renderMessages().catch(() => {});
        loadStatus().catch(() => {});
      } else if (event.kind === 'system') {
        appendEvent(event.message);
      }
    };

    Promise.all([renderMessages(), loadStatus()]).catch((error) => {
      appendEvent(String(error), 'error');
    });
  </script>
</body>
</html>`;
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const options = activeOptions;
  if (!options) {
    json(res, 503, { error: "Orbit Web UI is not initialized." });
    return;
  }

  const url = new URL(req.url || "/", "http://127.0.0.1");
  if (req.method === "GET" && url.pathname === "/") {
    text(res, 200, renderHtml());
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/status") {
    json(res, 200, collectStatus(options));
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/messages") {
    json(res, 200, { messages: collectMessages(options.loop) });
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/settings") {
    json(res, 200, getSettings(options));
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/events") {
    attachSseClient(req, res);
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/chat") {
    await handleChat(req, res, options);
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/settings") {
    await handleSettings(req, res, options);
    return;
  }
  json(res, 404, { error: "Not found" });
}

async function handleChat(
  req: IncomingMessage,
  res: ServerResponse,
  options: WebUiOptions,
): Promise<void> {
  if (!options.submitPrompt) {
    json(res, 409, { ok: false, message: "Chat bridge is not available." });
    return;
  }
  try {
    const body = await readJson(req);
    const prompt = isRecord(body) && typeof body.prompt === "string"
      ? body.prompt.trim()
      : "";
    if (!prompt) {
      json(res, 400, { ok: false, message: "Prompt is required." });
      return;
    }
    const result = await options.submitPrompt(prompt);
    broadcast({ kind: "turn_done" });
    json(res, result.ok ? 200 : 500, result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    broadcast({ kind: "turn_done" });
    json(res, 500, { ok: false, message });
  }
}

async function handleSettings(
  req: IncomingMessage,
  res: ServerResponse,
  options: WebUiOptions,
): Promise<void> {
  if (!options.updateSettings) {
    json(res, 409, { ok: false, message: "Settings bridge is not available." });
    return;
  }
  try {
    const body = await readJson(req);
    if (!isRecord(body)) {
      json(res, 400, { ok: false, message: "Invalid settings payload." });
      return;
    }
    const result = await options.updateSettings(normalizeSettingsPatch(body));
    json(res, result.ok ? 200 : 400, result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    json(res, 500, { ok: false, message });
  }
}

function normalizeSettingsPatch(body: Record<string, unknown>): WebUiSettingsPatch {
  const patch: WebUiSettingsPatch = {};
  if (typeof body.model === "string" && body.model.trim()) {
    patch.model = body.model.trim();
  }
  if (
    body.permissionMode === "strict" ||
    body.permissionMode === "normal" ||
    body.permissionMode === "auto" ||
    body.permissionMode === "plan"
  ) {
    patch.permissionMode = body.permissionMode;
  }
  if (typeof body.webSearchEnabled === "boolean") {
    patch.webSearchEnabled = body.webSearchEnabled;
  }
  if (
    body.webSearchProvider === "auto" ||
    body.webSearchProvider === "searxng" ||
    body.webSearchProvider === "tavily" ||
    body.webSearchProvider === "bing" ||
    body.webSearchProvider === "duckduckgo"
  ) {
    patch.webSearchProvider = body.webSearchProvider;
  }
  if (typeof body.webSearchMaxResults === "number") {
    patch.webSearchMaxResults = body.webSearchMaxResults;
  }
  return patch;
}

function attachSseClient(req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });
  res.write(`data: ${JSON.stringify({ kind: "system", message: "connected" })}\n\n`);
  sseClients.add(res);
  req.on("close", () => {
    sseClients.delete(res);
  });
}

function broadcast(event: unknown): void {
  const line = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of sseClients) {
    client.write(line);
  }
}

function ensureEventBridge(): void {
  if (eventBridge) return;
  eventBridge = (event) => {
    broadcast({
      kind: "orbit_event",
      type: event.type,
      payload: event.payload,
    });
  };
  eventBus.on("*", eventBridge);
}

function removeEventBridge(): void {
  if (!eventBridge) return;
  eventBus.off("*", eventBridge);
  eventBridge = undefined;
}

function listen(server: http.Server, port: number): Promise<number> {
  return new Promise((resolveListen, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      const address = server.address();
      resolveListen(
        typeof address === "object" && address ? address.port : port,
      );
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
}

export async function openBrowser(url: string): Promise<void> {
  const command =
    process.platform === "win32"
      ? "cmd"
      : process.platform === "darwin"
        ? "open"
        : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.on("error", () => {});
  child.unref();
}

export async function startOrbitWebUi(
  options: WebUiOptions,
): Promise<WebUiHandle> {
  activeOptions = options;
  ensureEventBridge();
  const preferredPort = options.port ?? 6047;
  if (activeHandle && (!options.port || options.port === activeHandle.port)) {
    if (options.open !== false) {
      await openBrowser(activeHandle.url);
    }
    return activeHandle;
  }
  if (activeHandle) {
    await activeHandle.close();
    activeHandle = undefined;
  }

  let lastError: unknown;
  const attempts =
    preferredPort === 0
      ? [0]
      : Array.from({ length: 20 }, (_, i) => preferredPort + i);
  for (const port of attempts) {
    const server = http.createServer((req, res) => {
      handleRequest(req, res).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        json(res, 500, { ok: false, message });
      });
    });
    try {
      const actualPort = await listen(server, port);
      const handle: WebUiHandle = {
        port: actualPort,
        url: `http://127.0.0.1:${actualPort}/`,
        close: () =>
          new Promise((resolveClose) => {
            for (const client of sseClients) {
              client.end();
            }
            sseClients.clear();
            removeEventBridge();
            server.close(() => resolveClose());
          }),
      };
      activeHandle = handle;
      if (options.open !== false) {
        await openBrowser(handle.url);
      }
      return handle;
    } catch (error: unknown) {
      lastError = error;
      if (
        !isNodeError(error) ||
        error.code !== "EADDRINUSE" ||
        preferredPort === 0
      ) {
        throw error;
      }
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Unable to start Orbit Web UI.");
}

export async function stopOrbitWebUi(): Promise<void> {
  if (!activeHandle) return;
  const handle = activeHandle;
  activeHandle = undefined;
  activeOptions = undefined;
  await handle.close();
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
