import { ConfigLoader, ConfigSchema } from '@orbit-ai/config';
import { AgentLoop, UserInteraction, Orchestrator } from '@orbit-ai/core';
import { resolveSafePath } from '@orbit-ai/shared';
import {
  DeepSeekAnthropicProvider,
  DeepSeekOpenAIProvider,
  OpenAIProvider,
  AnthropicProvider,
  OllamaProvider,
} from '@orbit-ai/model-providers';
import { Prompt, DiffView, Renderer } from '@orbit-ai/tui';
import picocolors from 'picocolors';
import glob from 'fast-glob';
import { existsSync, readFileSync, watch } from 'fs';
import { join } from 'path';
import readline from 'readline';
import { SymbolIndexer } from '@orbit-ai/context-engine';

async function pageText(text: string): Promise<void> {
  const lines = text.split('\n');
  const rows = process.stdout.rows || 24;
  const pageSize = rows - 2;

  if (lines.length <= pageSize) {
    console.log(text);
    return;
  }

  let cursor = 0;
  const wasRaw = process.stdin.isRaw;
  process.stdin.setRawMode(true);
  process.stdin.resume();

  readline.emitKeypressEvents(process.stdin);

  const keypressPromise = (): Promise<string> => {
    return new Promise((resolve) => {
      const onKeypress = (str: string, key: any) => {
        process.stdin.removeListener('keypress', onKeypress);
        if (key.ctrl && key.name === 'c') {
          process.stdin.setRawMode(wasRaw);
          process.exit(0);
        }
        resolve(key.name || str);
      };
      process.stdin.on('keypress', onKeypress);
    });
  };

  try {
    while (cursor < lines.length) {
      const chunk = lines.slice(cursor, cursor + pageSize);
      console.log(chunk.join('\n'));
      cursor += pageSize;

      if (cursor >= lines.length) {
        break;
      }

      process.stdout.write(`\r\x1b[36m-- More (${Math.round((cursor / lines.length) * 100)}%) [Space/Enter to continue, q to quit] --\x1b[39m`);

      const key = await keypressPromise();
      process.stdout.write('\r\x1b[K');

      if (key === 'q') {
        break;
      }
      if (key === 'return' || key === 'enter') {
        cursor = cursor - pageSize + 1;
      }
    }
  } finally {
    process.stdin.setRawMode(wasRaw);
    process.stdin.pause();
  }
}

export async function runAgent(cwd: string, task?: string, cliOverrides?: any, multi?: boolean): Promise<void> {
  const config = ConfigLoader.loadSync(cwd, cliOverrides);

  const providerName = config.provider.default;
  const pConfig = config.providers[providerName];
  if (!pConfig) {
    console.error(picocolors.red(`Provider "${providerName}" is not defined in configuration.`));
    return;
  }

  let providerInstance: any;
  if (pConfig.type === 'anthropic-compatible') {
    providerInstance = new DeepSeekAnthropicProvider(pConfig.apiKey, pConfig.baseUrl);
  } else if (pConfig.type === 'openai-compatible') {
    providerInstance = new DeepSeekOpenAIProvider(pConfig.apiKey, pConfig.baseUrl);
  } else if (pConfig.type === 'openai') {
    providerInstance = new OpenAIProvider(pConfig.apiKey, pConfig.baseUrl);
  } else if (pConfig.type === 'anthropic') {
    providerInstance = new AnthropicProvider(pConfig.apiKey, pConfig.baseUrl);
  } else if (pConfig.type === 'ollama') {
    providerInstance = new OllamaProvider(pConfig.baseUrl);
  }

  if (!providerInstance) {
    console.error(picocolors.red(`Unsupported provider type "${pConfig.type}".`));
    return;
  }

  const interaction: UserInteraction = {
    async askApproval(reason: string, preview?: string): Promise<boolean> {
      console.log(`\nRisk Warning: ${reason}`);
      if (preview) {
        console.log(picocolors.gray(`Parameters: ${preview}`));
      }
      return await Prompt.askApproval('Confirm action?');
    },
    showText(text: string): void {
      console.log(text);
    },
    async showDiff(filePath: string, before: string | null, after: string): Promise<void> {
      await pageText(DiffView.render(filePath, before, after));
    },
  };

  let activeTask = task;
  if (!activeTask) {
    await runRepl(cwd, config, providerInstance, interaction, multi);
    return;
  }

  if (multi) {
    const orchestrator = new Orchestrator(cwd, config, providerInstance, activeTask, interaction);
    await orchestrator.run();
  } else {
    const loop = new AgentLoop(cwd, config, providerInstance, activeTask, interaction);
    await loop.run();
  }
}

async function runRepl(
  cwd: string,
  config: any,
  providerInstance: any,
  interaction: UserInteraction,
  multi?: boolean
): Promise<void> {
  const loop = new AgentLoop(cwd, config, providerInstance, 'REPL Interactive Shell Started', interaction);

  Renderer.printHeader(loop.getSessionId(), config.models.default, cwd);

  // Load autocomplete candidates
  let candidates = await getAutocompleteCandidates(cwd, config);

  // Start background file watcher (Dynamic Incremental Watcher with Config Ignores)
  let watchTimeout: NodeJS.Timeout | null = null;
  const ignorePatterns = config.context?.ignore || [];
  const ignoreRegexes = ignorePatterns.map((pattern: string) => {
    const escaped = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, '.*')
      .replace(/\*/g, '[^/]*');
    const finalPattern = escaped.endsWith('.*') ? '^' + escaped + '$' : '(^' + escaped + '$|^' + escaped + '\/.*)';
    return new RegExp(finalPattern);
  });

  const indexer = new SymbolIndexer(cwd);
  const watcher = watch(cwd, { recursive: true }, (eventType, filename) => {
    if (filename && /\.(ts|tsx|js|jsx)$/.test(filename) && !filename.includes('.orbit')) {
      const normalized = filename.replace(/\\/g, '/');
      const isIgnored = ignoreRegexes.some((rx: RegExp) => rx.test(normalized));
      if (isIgnored) return;

      if (watchTimeout) clearTimeout(watchTimeout);
      watchTimeout = setTimeout(() => {
        indexer.index().catch(() => {});
      }, 500); // debounce 500ms
    }
  });

  try {
    while (true) {
    const input = await Prompt.askTextWithAutocomplete(
      'Type your task or command...',
      makeCompleter(candidates),
      `${picocolors.bold(picocolors.magenta('orbit'))}${picocolors.gray(' ❯ ')}`
    );

    if (input === null) {
      console.log(picocolors.yellow('Exiting Orbit Interactive Shell. Goodbye!'));
      break;
    }
    if (!input) continue;

    const trimmed = input.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith('/')) {
      const parts = trimmed.split(' ');
      const command = parts[0].toLowerCase();

      if (command === '/exit' || command === '/quit') {
        console.log(picocolors.yellow('Exiting Orbit Interactive Shell. Goodbye!'));
        break;
      }

      if (command === '/help') {
        console.log('\nAvailable Slash Commands:');
        console.log('  /help           - Show this help message');
        console.log('  /status         - Display session provider, active model, cost, and budget');
        console.log('  /config [k=v]   - View or modify configurations interactively or via key=value');
        console.log('  /model [name]   - Get or set the active model dynamically');
        console.log('  /commit [msg]   - Stage changes and commit them (LLM message generation if empty)');
        console.log('  /exit, /quit    - Terminate the REPL session');
        console.log('  /rollback       - Revert the last file edits checkpoint');
        console.log('  /clear          - Clear terminal screen');
        console.log('  /compact        - Compact older agent chat history');
        console.log('  /history        - Display command history of this session');
        console.log('  /edit           - Open external editor for long/multiline prompts');
        console.log('  /inspect        - (CodeWhale) Visualize codebase outline and stats');
        console.log('  /doc [file]     - (Codex) Generate TSDoc/JSDoc documentation for a file');
        console.log('  /diagnose       - (AtomCode) Run tests and auto-repair failures');
        console.log('  /resolve [file] - Resolve merge conflicts in a file semantically using LLM');
        console.log('  /references [s] - Find all call sites and usages of symbol s in workspace\n');
        continue;
      }

      if (command === '/edit') {
        const tempFile = join(cwd, '.orbit', 'orbit_prompt.md');
        try {
          const fs = await import('fs');
          const orbitDir = join(cwd, '.orbit');
          if (!fs.existsSync(orbitDir)) {
            fs.mkdirSync(orbitDir, { recursive: true });
          }
          fs.writeFileSync(tempFile, '# Describe your task or prompt here\n\n', 'utf8');
          console.log(picocolors.cyan(`Opening editor... Please save and close the file when finished.`));
          const editor = config.editor || process.env.EDITOR || 'notepad.exe';
          const { execSync } = await import('child_process');
          execSync(`${editor} "${tempFile}"`);
          const promptContent = fs.readFileSync(tempFile, 'utf8')
            .replace(/#.*?\n/, '') // Strip header
            .trim();
          if (fs.existsSync(tempFile)) {
            fs.unlinkSync(tempFile);
          }
          if (!promptContent) {
            console.log(picocolors.yellow('Empty prompt. Aborting.'));
            continue;
          }
          console.log(picocolors.green(`Loaded prompt: "${promptContent.substring(0, 60)}..."`));
          
          const state = (loop as any).state;
          state.task = promptContent;
          state.done = false;
          state.attemptCount = 0;

          state.history.push({
            id: `msg_user_${Date.now()}`,
            role: 'user',
            createdAt: new Date().toISOString(),
            content: [{ type: 'text', text: promptContent }],
          });

          if (multi) {
            const orchestrator = new Orchestrator(cwd, config, providerInstance, promptContent, interaction);
            await orchestrator.run();
          } else {
            await loop.run();
          }
        } catch (err: any) {
          console.log(picocolors.red(`Failed to open editor: ${err.message}`));
        }
        continue;
      }

      if (command === '/rollback') {
        await loop.rollbackLastCheckpoint();
        continue;
      }

      if (command === '/status') {
        const config = loop.getConfig();
        const provider = loop.getProvider();
        const activeModel = loop.getModelOverride() || config.models.default;
        const budgetLimit = config.budgetLimit;
        const currentCost = loop.getSessionCost();
        const mode = config.permissions.mode;

        console.log(picocolors.bold(picocolors.cyan('\n┌── Orbit Session Status ──────────────────────────────────')));
        console.log(`${picocolors.gray('│')} 🆔 Session ID:   ${picocolors.green(loop.getSessionId())}`);
        console.log(`${picocolors.gray('│')} 🔌 Provider:     ${picocolors.green(provider.id)} (${provider.baseUrl || 'Default URL'})`);
        console.log(`${picocolors.gray('│')} 🤖 Active Model:  ${picocolors.green(activeModel)}`);
        console.log(`${picocolors.gray('│')} 💰 Session Cost: $${currentCost.toFixed(4)} / $${budgetLimit.toFixed(2)} (Limit)`);
        console.log(`${picocolors.gray('│')} 🛡️ Security Mode: ${picocolors.green(mode.toUpperCase())}`);
        console.log(picocolors.cyan('└───────────────────────────────────────────────────────────\n'));
        continue;
      }

      if (command === '/config') {
        const configArg = parts.slice(1).join(' ').trim();
        const activeConfig = loop.getConfig();

        if (configArg) {
          const eqIndex = configArg.indexOf('=');
          if (eqIndex === -1) {
            console.log(picocolors.yellow('Usage: /config <key>=<value> or just /config for interactive menu.'));
            continue;
          }
          const key = configArg.slice(0, eqIndex).trim();
          const rawVal = configArg.slice(eqIndex + 1).trim();

          const currentVal = getNestedProperty(activeConfig, key);
          if (currentVal === undefined) {
            console.log(picocolors.red(`Error: Unknown configuration key "${key}".`));
            continue;
          }

          let parsedVal: any = rawVal;
          if (typeof currentVal === 'boolean') {
            const lowerVal = rawVal.toLowerCase();
            if (lowerVal === 'true' || lowerVal === '1') parsedVal = true;
            else if (lowerVal === 'false' || lowerVal === '0') parsedVal = false;
            else {
              console.log(picocolors.red(`Error: Key "${key}" expects a boolean value (true/false).`));
              continue;
            }
          } else if (typeof currentVal === 'number') {
            const num = Number(rawVal);
            if (isNaN(num)) {
              console.log(picocolors.red(`Error: Key "${key}" expects a numeric value.`));
              continue;
            }
            parsedVal = num;
          } else if (Array.isArray(currentVal)) {
            parsedVal = rawVal.split(',').map(s => s.trim()).filter(Boolean);
          }

          const testConfig = JSON.parse(JSON.stringify(activeConfig));
          setNestedProperty(testConfig, key, parsedVal);

          const parseResult = ConfigSchema.safeParse(testConfig);
          if (!parseResult.success) {
            console.log(picocolors.red(`Configuration validation failed: ${parseResult.error.message}`));
            continue;
          }

          setNestedProperty(activeConfig, key, parsedVal);
          console.log(picocolors.green(`✔ Updated "${key}" to: ${parsedVal}`));
          continue;
        }

        while (true) {
          const currentMode = activeConfig.permissions.mode;
          const currentBudget = activeConfig.budgetLimit;
          const currentAllowRead = activeConfig.permissions.allowRead;
          const currentApprovalWrite = activeConfig.permissions.requireApprovalForWrite;
          const currentApprovalBash = activeConfig.permissions.requireApprovalForBash;
          const currentBlockDangerous = activeConfig.permissions.blockDangerousCommands;
          const currentProtectSecrets = activeConfig.permissions.protectSecrets;
          const currentBashEnabled = activeConfig.tools.bash.enabled;
          const currentSearchEnabled = activeConfig.tools.webSearch.enabled;
          const currentMcpEnabled = activeConfig.tools.mcp.enabled;
          const currentEditor = activeConfig.editor;
          const currentAutoCommit = activeConfig.autoCommit;
          const currentProtectedPaths = activeConfig.permissions.protectedPaths;
          const currentIgnore = activeConfig.context.ignore;

          const choice = await Prompt.askSelect('Select a configuration key to modify:', [
            { value: 'permissions.mode', label: `🛡️  permissions.mode (current: ${currentMode})` },
            { value: 'budgetLimit', label: `💰 budgetLimit (current: $${currentBudget})` },
            { value: 'permissions.allowRead', label: `📄 permissions.allowRead (current: ${currentAllowRead})` },
            { value: 'permissions.requireApprovalForWrite', label: `✏️  permissions.requireApprovalForWrite (current: ${currentApprovalWrite})` },
            { value: 'permissions.requireApprovalForBash', label: `🐚 permissions.requireApprovalForBash (current: ${currentApprovalBash})` },
            { value: 'permissions.blockDangerousCommands', label: `🚫 permissions.blockDangerousCommands (current: ${currentBlockDangerous})` },
            { value: 'permissions.protectSecrets', label: `🔑 permissions.protectSecrets (current: ${currentProtectSecrets})` },
            { value: 'tools.bash.enabled', label: `💻 tools.bash.enabled (current: ${currentBashEnabled})` },
            { value: 'tools.webSearch.enabled', label: `🌐 tools.webSearch.enabled (current: ${currentSearchEnabled})` },
            { value: 'tools.mcp.enabled', label: `🔌 tools.mcp.enabled (current: ${currentMcpEnabled})` },
            { value: 'permissions.protectedPaths', label: `🔒 permissions.protectedPaths (current: ${currentProtectedPaths.join(', ')})` },
            { value: 'context.ignore', label: `🗂️  context.ignore (current: ${currentIgnore.join(', ')})` },
            { value: 'editor', label: `📝 editor (current: ${currentEditor})` },
            { value: 'autoCommit', label: `🚀 autoCommit (current: ${currentAutoCommit})` },
            { value: 'exit', label: '❌ Exit Menu' }
          ]);

          if (choice === null || choice === 'exit' || choice === '') {
            break;
          }

          const currentVal = getNestedProperty(activeConfig, choice);
          if (typeof currentVal === 'boolean') {
            const nextVal = await Prompt.askSelect(`Set ${choice} to:`, [
              { value: 'true', label: 'true' },
              { value: 'false', label: 'false' }
            ]);
            if (nextVal !== null && nextVal !== '') {
              const boolVal = nextVal === 'true';
              const testConfig = JSON.parse(JSON.stringify(activeConfig));
              setNestedProperty(testConfig, choice, boolVal);
              const parseResult = ConfigSchema.safeParse(testConfig);
              if (parseResult.success) {
                setNestedProperty(activeConfig, choice, boolVal);
                console.log(picocolors.green(`✔ Updated "${choice}" to: ${boolVal}`));
              } else {
                console.log(picocolors.red(`Validation error: ${parseResult.error.message}`));
              }
            }
          } else if (choice === 'permissions.mode') {
            const nextVal = await Prompt.askSelect('Set permissions.mode to:', [
              { value: 'strict', label: 'strict (High security, ask for write/exec, block dangerous)' },
              { value: 'normal', label: 'normal (Standard safety, ask for all write/exec)' },
              { value: 'auto', label: 'auto (Allow write/exec automatically, block dangerous)' },
              { value: 'plan', label: 'plan (Interactive planning mode - read-only)' }
            ]);
            if (nextVal !== null && nextVal !== '') {
              const testConfig = JSON.parse(JSON.stringify(activeConfig));
              setNestedProperty(testConfig, choice, nextVal);
              const parseResult = ConfigSchema.safeParse(testConfig);
              if (parseResult.success) {
                setNestedProperty(activeConfig, choice, nextVal);
                console.log(picocolors.green(`✔ Updated "${choice}" to: ${nextVal}`));
              } else {
                console.log(picocolors.red(`Validation error: ${parseResult.error.message}`));
              }
            }
          } else if (choice === 'budgetLimit') {
            const nextValStr = await Prompt.askText(`Enter new budget limit (number):`, String(currentVal));
            if (nextValStr !== null && nextValStr !== '') {
              const numVal = Number(nextValStr);
              if (isNaN(numVal)) {
                console.log(picocolors.red('Error: budgetLimit must be a valid number.'));
              } else {
                const testConfig = JSON.parse(JSON.stringify(activeConfig));
                setNestedProperty(testConfig, choice, numVal);
                const parseResult = ConfigSchema.safeParse(testConfig);
                if (parseResult.success) {
                  setNestedProperty(activeConfig, choice, numVal);
                  console.log(picocolors.green(`✔ Updated "${choice}" to: ${numVal}`));
                } else {
                  console.log(picocolors.red(`Validation error: ${parseResult.error.message}`));
                }
              }
            }
          } else if (Array.isArray(currentVal)) {
            const nextValStr = await Prompt.askText(`Enter comma-separated values for ${choice}:`, currentVal.join(', '));
            if (nextValStr !== null && nextValStr !== '') {
              const arrVal = nextValStr.split(',').map(s => s.trim()).filter(Boolean);
              const testConfig = JSON.parse(JSON.stringify(activeConfig));
              setNestedProperty(testConfig, choice, arrVal);
              const parseResult = ConfigSchema.safeParse(testConfig);
              if (parseResult.success) {
                setNestedProperty(activeConfig, choice, arrVal);
                console.log(picocolors.green(`✔ Updated "${choice}" to: [${arrVal.join(', ')}]`));
              } else {
                console.log(picocolors.red(`Validation error: ${parseResult.error.message}`));
              }
            }
          } else if (typeof currentVal === 'string' && choice !== 'permissions.mode') {
            const nextValStr = await Prompt.askText(`Enter value for ${choice}:`, String(currentVal));
            if (nextValStr !== null && nextValStr !== '') {
              const testConfig = JSON.parse(JSON.stringify(activeConfig));
              setNestedProperty(testConfig, choice, nextValStr);
              const parseResult = ConfigSchema.safeParse(testConfig);
              if (parseResult.success) {
                setNestedProperty(activeConfig, choice, nextValStr);
                console.log(picocolors.green(`✔ Updated "${choice}" to: ${nextValStr}`));
              } else {
                console.log(picocolors.red(`Validation error: ${parseResult.error.message}`));
              }
            }
          }
        }
        continue;
      }

      if (command === '/model') {
        const modelArg = parts.slice(1).join(' ').trim();
        const config = loop.getConfig();
        if (!modelArg) {
          const activeModel = loop.getModelOverride() || config.models.default;
          console.log(`Current active model: ${picocolors.green(activeModel)}`);
          console.log(`To switch model, run: ${picocolors.yellow('/model <model_name>')}`);
          continue;
        }

        loop.setModelOverride(modelArg);
        console.log(`Switched active model to: ${picocolors.green(modelArg)}`);
        continue;
      }

      if (command === '/commit') {
        const commitMsg = parts.slice(1).join(' ').trim();
        const config = loop.getConfig();
        const { execSync } = await import('child_process');
        try {
          const diff = execSync('git diff --cached', { cwd }).toString().trim();
          if (!diff) {
            console.log(picocolors.yellow('No staged changes found to commit. Run "git add" first.'));
            continue;
          }

          let finalMsg = commitMsg;
          if (!finalMsg) {
            console.log('Generating commit message via LLM...');
            const fastModel = config.models.fast || config.models.default;
            const stream = providerInstance.chat({
              model: fastModel,
              messages: [
                {
                  id: `msg_commit_cmd_${Date.now()}`,
                  role: 'user',
                  createdAt: new Date().toISOString(),
                  content: [
                    {
                      type: 'text',
                      text: `Generate a concise, high-quality conventional git commit message (e.g. feat(cli): add autocomplete) for the following git diff. Output ONLY the commit message, no formatting, no markdown, no quotes, just the text:\n\n${diff.substring(0, 20000)}`,
                    },
                  ],
                },
              ],
              tools: [],
            });

            let generatedMessage = '';
            for await (const event of stream) {
              if (event.type === 'text_delta') {
                generatedMessage += event.text;
              }
            }
            finalMsg = generatedMessage.trim().replace(/^["']|["']$/g, '');
            if (!finalMsg) {
              finalMsg = 'chore: auto-commit';
            }
          }

          console.log(`Committing changes with message: "${picocolors.green(finalMsg)}"`);
          const commitCmd = `git commit -m ${JSON.stringify(finalMsg)}`;
          execSync(commitCmd, { cwd });
          console.log(picocolors.green('✔ Git commit created successfully.'));
        } catch (err: any) {
          console.log(picocolors.red(`✖ Commit failed: ${err.message}`));
        }
        continue;
      }

      if (command === '/clear') {
        console.clear();
        continue;
      }

      if (command === '/compact') {
        console.log('Compacting history...');
        const history = loop.getHistory();
        if (history.length > 12) {
          const systemMsg = history[0];
          const discarded = history.slice(1, history.length - 10);
          const recentMsgs = history.slice(history.length - 10);

          let rawText = '';
          for (const msg of discarded) {
            rawText += `[${msg.role.toUpperCase()}]: ` + msg.content.map(c => {
              if (c.type === 'text') return c.text;
              if (c.type === 'tool_call') return `[Tool Call: ${c.toolCall?.name}]`;
              if (c.type === 'tool_result') return `[Tool Result: ${c.toolResult?.name}]`;
              return '';
            }).join(' ') + '\n';
          }

          console.log('Generating session summary via LLM...');
          let summaryText = 'Prior dialogue history compacted.';
          try {
            const fastModel = config.models.fast || config.models.default;
            const stream = providerInstance.chat({
              model: fastModel,
              messages: [
                {
                  id: `msg_compact_${Date.now()}`,
                  role: 'user',
                  createdAt: new Date().toISOString(),
                  content: [
                    {
                      type: 'text',
                      text: `Summarize the following dialog history of an AI coding session in a brief, concise paragraph (max 150 words). Focus on what files were modified, what tasks were accomplished, and any critical developer rules established. Do not include introductory text, just the summary:\n\n${rawText.substring(0, 15000)}`,
                    },
                  ],
                },
              ],
              tools: [],
            });

            let responseContent = '';
            for await (const event of stream) {
              if (event.type === 'text_delta') {
                responseContent += event.text;
              }
            }
            if (responseContent.trim()) {
              summaryText = responseContent.trim();
            }
          } catch (err: any) {
            console.log(picocolors.yellow(`⚠ LLM compaction query failed: ${err.message}. Using default compaction.`));
          }

          const summaryMsg = {
            id: `msg_summary_${Date.now()}`,
            role: 'system',
            createdAt: new Date().toISOString(),
            content: [{ type: 'text', text: `Prior session history summary:\n${summaryText}` }],
          };

          history.length = 0;
          if (systemMsg) {
            history.push(systemMsg);
          }
          history.push(summaryMsg);
          history.push(...recentMsgs);

          console.log(picocolors.green(`✔ History compacted! Retained first system message, generated history summary, and last 10 messages. Total: ${history.length}`));
        } else {
          console.log(picocolors.yellow('History is too short to compact.'));
        }
        continue;
      }

      if (command === '/history') {
        console.log('\nSession History:');
        const history = loop.getHistory();
        for (const msg of history) {
          const text = msg.content.map(c => c.type === 'text' ? c.text : `[Tool Call: ${c.toolCall?.name}]`).join(' ');
          console.log(`- [${msg.role.toUpperCase()}] ${text.substring(0, 80)}${text.length > 80 ? '...' : ''}`);
        }
        console.log();
        continue;
      }

      if (command === '/inspect') {
        const indexPath = join(cwd, '.orbit', 'symbols.json');
        if (!existsSync(indexPath)) {
          console.log(picocolors.yellow('No symbols index found. Please run a task first to generate the symbol map.'));
          continue;
        }

        try {
          const raw = readFileSync(indexPath, 'utf8');
          const index = JSON.parse(raw);
          if (index.files && typeof index.files === 'object') {
            console.log(picocolors.bold(picocolors.cyan('\n┌── CodeWhale Codebase Visual Outline ──────────────────────')));
            
            let totalFiles = 0;
            let totalSymbols = 0;
            let tsFiles = 0;

            for (const [file, fileData] of Object.entries(index.files)) {
              totalFiles++;
              if (file.endsWith('.ts') || file.endsWith('.tsx')) {
                tsFiles++;
              }
              const data = fileData as any;
              if (data && Array.isArray(data.symbols)) {
                console.log(`${picocolors.gray('│')} 📄 ${picocolors.bold(picocolors.blue(file))}`);
                for (const sym of data.symbols) {
                  totalSymbols++;
                  const symbolColor = sym.type === 'class' ? picocolors.magenta : picocolors.green;
                  console.log(`${picocolors.gray('│')}    ├── ${symbolColor(sym.name)} (${picocolors.gray(sym.type)})`);
                }
              }
            }

            const tsRatio = totalFiles > 0 ? ((tsFiles / totalFiles) * 100).toFixed(1) : '0.0';
            console.log(picocolors.gray('├───────────────────────────────────────────────────────────'));
            console.log(`${picocolors.gray('│')} ${picocolors.bold('Codebase Stats:')}`);
            console.log(`${picocolors.gray('│')}   • Total Indexed Files: ${picocolors.green(totalFiles)}`);
            console.log(`${picocolors.gray('│')}   • TypeScript Ratio   : ${picocolors.yellow(tsRatio + '%')}`);
            console.log(`${picocolors.gray('│')}   • Exported Symbols   : ${picocolors.magenta(totalSymbols)}`);
            console.log(picocolors.cyan('└───────────────────────────────────────────────────────────\n'));
          }
        } catch (err: any) {
          console.log(picocolors.red(`Failed to parse symbol index: ${err.message}`));
        }
        continue;
      }

      if (command === '/doc') {
        const fileArg = parts.slice(1).join(' ').trim();
        if (!fileArg) {
          console.log(picocolors.yellow('Usage: /doc <file_path>'));
          continue;
        }

        let targetFilePath: string;
        try {
          targetFilePath = resolveSafePath(cwd, fileArg);
        } catch (err: any) {
          console.log(picocolors.red(`Error: ${err.message}`));
          continue;
        }
        if (!existsSync(targetFilePath)) {
          console.log(picocolors.red(`Error: File not found: ${fileArg}`));
          continue;
        }

        console.log(picocolors.cyan(`Generating documentation for ${fileArg} via LLM...`));
        try {
          const content = readFileSync(targetFilePath, 'utf8');
          const fastModel = config.models.fast || config.models.default;
          
          const stream = providerInstance.chat({
            model: fastModel,
            messages: [
              {
                id: `msg_doc_${Date.now()}`,
                role: 'user',
                createdAt: new Date().toISOString(),
                content: [
                  {
                    type: 'text',
                    text: `Analyze the following code file and add clean, professional TSDoc/JSDoc comments for all exported functions, classes, interfaces, and methods. Preserve all existing logic, code, and comments exactly. Return ONLY the complete modified code file, with no markdown, no quotes, and no explanations:\n\n${content}`,
                  },
                ],
              },
            ],
            tools: [],
          });

          let documentedCode = '';
          for await (const event of stream) {
            if (event.type === 'text_delta') {
              documentedCode += event.text;
            }
          }

          documentedCode = documentedCode.trim().replace(/^```[a-zA-Z]*\n/, '').replace(/\n```$/, '');
          if (!documentedCode) {
            console.log(picocolors.red('Failed to generate documented code.'));
            continue;
          }

          const state = (loop as any).state;
          state.task = `Add TSDoc/JSDoc comments to ${fileArg}`;
          state.done = false;
          state.attemptCount = 0;

          const writeToolCall = {
            id: `tc_doc_${Date.now()}`,
            name: 'write_file',
            arguments: JSON.stringify({
              path: targetFilePath,
              content: documentedCode,
            }),
          };

          state.history.push({
            id: `msg_user_${Date.now()}`,
            role: 'user',
            createdAt: new Date().toISOString(),
            content: [{ type: 'text', text: `Write JSDoc comments to ${fileArg}` }],
          });

          const assistantMsg = {
            id: `msg_asst_doc_${Date.now()}`,
            role: 'assistant',
            createdAt: new Date().toISOString(),
            content: [{ type: 'tool_call', toolCall: writeToolCall }],
          };
          state.history.push(assistantMsg);

          await loop.run();
        } catch (err: any) {
          console.log(picocolors.red(`Failed to generate documentation: ${err.message}`));
        }
        continue;
      }

      if (command === '/diagnose') {
        const testCommand = (config.context?.testCommands && config.context.testCommands[0]) || 'npm test';
        console.log(picocolors.cyan(`Running test suite: "${testCommand}"...`));

        const { exec } = await import('child_process');
        const runTestPromise = () => new Promise<{ stdout: string; stderr: string; code: number }>((resolve) => {
          exec(testCommand, { cwd }, (err, stdout, stderr) => {
            resolve({
              stdout,
              stderr,
              code: err ? err.code || 1 : 0,
            });
          });
        });

        const testResult = await runTestPromise();
        if (testResult.code === 0) {
          console.log(picocolors.green(`✔ All tests passed successfully! No diagnostics needed.`));
          continue;
        }

        console.log(picocolors.red(`✖ Tests failed! Outputting diagnostics...`));
        console.log(picocolors.gray(testResult.stdout || testResult.stderr));

        const repairPrompt = `The test command "${testCommand}" failed. The output log is:\n\n${testResult.stdout || testResult.stderr}\n\nPlease analyze the failure logs, locate the files causing assertion or syntax errors, and fix the codebase so that the test suite passes successfully.`;

        const confirmRepair = await Prompt.askApproval('Launch Agent Loop to auto-repair the test failures?');
        if (!confirmRepair) {
          console.log(picocolors.yellow('Diagnostics aborted.'));
          continue;
        }

        const state = (loop as any).state;
        state.task = `Auto-repair test failures for "${testCommand}"`;
        state.done = false;
        state.attemptCount = 0;

        state.history.push({
          id: `msg_user_${Date.now()}`,
          role: 'user',
          createdAt: new Date().toISOString(),
          content: [{ type: 'text', text: repairPrompt }],
        });

        if (multi) {
          const orchestrator = new Orchestrator(cwd, config, providerInstance, repairPrompt, interaction);
          await orchestrator.run();
        } else {
          await loop.run();
        }
        continue;
      }

      if (command === '/resolve') {
        const fileArg = parts.slice(1).join(' ').trim();
        if (!fileArg) {
          console.log(picocolors.yellow('Usage: /resolve <file_path>'));
          continue;
        }

        let targetFilePath: string;
        try {
          targetFilePath = resolveSafePath(cwd, fileArg);
        } catch (err: any) {
          console.log(picocolors.red(`Error: ${err.message}`));
          continue;
        }
        if (!existsSync(targetFilePath)) {
          console.log(picocolors.red(`Error: File not found: ${fileArg}`));
          continue;
        }

        try {
          const content = readFileSync(targetFilePath, 'utf8');
          if (!content.includes('<<<<<<<') || !content.includes('=======') || !content.includes('>>>>>>>')) {
            console.log(picocolors.yellow('No git merge conflict markers found in this file.'));
            continue;
          }

          console.log(picocolors.cyan(`Resolving conflicts in ${fileArg} via LLM...`));
          const fastModel = config.models.fast || config.models.default;
          
          const stream = providerInstance.chat({
            model: fastModel,
            messages: [
              {
                id: `msg_resolve_${Date.now()}`,
                role: 'user',
                createdAt: new Date().toISOString(),
                content: [
                  {
                    type: 'text',
                    text: `Resolve the git merge conflict markers in this file. Merge the changes logically. Preserve all other code structure and logic exactly. Return ONLY the complete resolved code file, with no markdown, no quotes, and no explanations:\n\n${content}`,
                  },
                ],
              },
            ],
            tools: [],
          });

          let resolvedCode = '';
          for await (const event of stream) {
            if (event.type === 'text_delta') {
              resolvedCode += event.text;
            }
          }

          resolvedCode = resolvedCode.trim().replace(/^```[a-zA-Z]*\n/, '').replace(/\n```$/, '');
          if (!resolvedCode) {
            console.log(picocolors.red('Failed to generate resolved code.'));
            continue;
          }

          const state = (loop as any).state;
          state.task = `Resolve git merge conflicts in ${fileArg}`;
          state.done = false;
          state.attemptCount = 0;

          const writeToolCall = {
            id: `tc_resolve_${Date.now()}`,
            name: 'write_file',
            arguments: JSON.stringify({
              path: targetFilePath,
              content: resolvedCode,
            }),
          };

          state.history.push({
            id: `msg_user_${Date.now()}`,
            role: 'user',
            createdAt: new Date().toISOString(),
            content: [{ type: 'text', text: `Resolve git merge conflicts in ${fileArg}` }],
          });

          const assistantMsg = {
            id: `msg_asst_resolve_${Date.now()}`,
            role: 'assistant',
            createdAt: new Date().toISOString(),
            content: [{ type: 'tool_call', toolCall: writeToolCall }],
          };
          state.history.push(assistantMsg);

          await loop.run();
        } catch (err: any) {
          console.log(picocolors.red(`Failed to resolve conflicts: ${err.message}`));
        }
        continue;
      }

      if (command === '/references') {
        const symbolArg = parts.slice(1).join(' ').trim();
        if (!symbolArg) {
          console.log(picocolors.yellow('Usage: /references <symbol_name>'));
          continue;
        }

        const indexPath = join(cwd, '.orbit', 'symbols.json');
        if (!existsSync(indexPath)) {
          console.log(picocolors.yellow('No symbols index found. Please run a task first to generate the symbol map.'));
          continue;
        }

        try {
          const raw = readFileSync(indexPath, 'utf8');
          const index = JSON.parse(raw);
          let exportedFile: string | null = null;
          if (index.files && typeof index.files === 'object') {
            for (const [file, fileData] of Object.entries(index.files)) {
              const data = fileData as any;
              if (data && Array.isArray(data.symbols)) {
                if (data.symbols.some((s: any) => s.name === symbolArg)) {
                  exportedFile = file;
                  break;
                }
              }
            }

            console.log(picocolors.bold(picocolors.cyan(`\n┌── Symbol References Finder: ${symbolArg} ──────────────`)));
            if (exportedFile) {
              console.log(`${picocolors.gray('│')} 🔑 Exported by: ${picocolors.green(exportedFile)}`);
            } else {
              console.log(`${picocolors.gray('│')} 🔑 Exported by: ${picocolors.gray('Unknown (Internal / Not exported)')}`);
            }
            console.log(picocolors.gray('├───────────────────────────────────────────────────────────'));

            let refCount = 0;
            const symbolRegex = new RegExp(`\\b${symbolArg}\\b`);
            for (const [file, fileData] of Object.entries(index.files)) {
              const absPath = join(cwd, file);
              if (existsSync(absPath)) {
                const lines = readFileSync(absPath, 'utf8').split('\n');
                for (let idx = 0; idx < lines.length; idx++) {
                  const line = lines[idx];
                  const trimmed = line.trim();
                  
                  if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
                    continue;
                  }
                  
                  if (symbolRegex.test(line) && !line.includes('export ') && !line.includes('symbols.some')) {
                    refCount++;
                    console.log(`${picocolors.gray('│')} 📁 ${picocolors.blue(file)}:${picocolors.yellow(idx + 1)}`);
                    console.log(`${picocolors.gray('│')}    ${picocolors.gray(line.trim().substring(0, 80))}`);
                  }
                }
              }
            }

            console.log(picocolors.gray('├───────────────────────────────────────────────────────────'));
            console.log(`${picocolors.gray('│')} Total Usages Found: ${picocolors.green(refCount)}`);
            console.log(picocolors.cyan('└───────────────────────────────────────────────────────────\n'));
          }
        } catch (err: any) {
          console.log(picocolors.red(`Failed to search references: ${err.message}`));
        }
        continue;
      }

      console.log(picocolors.red(`Unknown command: ${command}. Type /help for available commands.`));
      continue;
    }

    const state = (loop as any).state;
    state.task = trimmed;
    state.done = false;
    state.attemptCount = 0;

    state.history.push({
      id: `msg_user_${Date.now()}`,
      role: 'user',
      createdAt: new Date().toISOString(),
      content: [{ type: 'text', text: trimmed }],
    });

    if (multi) {
      const orchestrator = new Orchestrator(cwd, config, providerInstance, trimmed, interaction);
      await orchestrator.run();
    } else {
      await loop.run();
    }

    // Refresh candidates in the background asynchronously
    getAutocompleteCandidates(cwd, config)
      .then((c) => {
        candidates = c;
      })
      .catch(() => {});
    }
  } finally {
    watcher.close();
    if (watchTimeout) clearTimeout(watchTimeout);
  }
}

async function getAutocompleteCandidates(cwd: string, config: any): Promise<{
  commands: string[];
  files: string[];
  symbols: string[];
}> {
  const commands = ['/help', '/status', '/config', '/model', '/commit', '/exit', '/quit', '/rollback', '/clear', '/compact', '/history', '/edit', '/inspect', '/doc', '/diagnose', '/resolve', '/references'];
  const files: string[] = [];
  const symbols: string[] = [];

  try {
    const ignorePatterns = config.context?.ignore || [];
    const globbedFiles = await glob('**/*', {
      cwd,
      ignore: ignorePatterns,
      onlyFiles: true,
      dot: true,
    });
    files.push(...globbedFiles);
  } catch {
    // Ignored
  }

  try {
    const indexPath = join(cwd, '.orbit', 'symbols.json');
    if (existsSync(indexPath)) {
      const raw = readFileSync(indexPath, 'utf8');
      const index = JSON.parse(raw);
      if (index.files && typeof index.files === 'object') {
        for (const fileData of Object.values(index.files)) {
          const data = fileData as any;
          if (data && Array.isArray(data.symbols)) {
            for (const sym of data.symbols) {
              if (sym.name) {
                symbols.push(sym.name);
              }
            }
          }
        }
      }
    }
  } catch {
    // Ignored
  }

  return {
    commands,
    files,
    symbols: Array.from(new Set(symbols)),
  };
}

function makeCompleter(candidates: { commands: string[]; files: string[]; symbols: string[] }) {
  return (line: string): [string[], string] => {
    if (line.startsWith('/')) {
      const hits = candidates.commands.filter((c) => c.startsWith(line));
      return [hits.length ? hits : candidates.commands, line];
    }

    const words = line.split(/\s+/);
    const lastWord = words[words.length - 1] || '';

    if (!lastWord) {
      return [[], lastWord];
    }

    const fileHits = candidates.files.filter((f) => f.startsWith(lastWord));
    const symbolHits = candidates.symbols.filter((s) => s.startsWith(lastWord));
    const allHits = [...fileHits, ...symbolHits];

    return [allHits, lastWord];
  };
}

function getNestedProperty(obj: any, path: string): any {
  const parts = path.split('.');
  let current = obj;
  for (const part of parts) {
    if (current == null || typeof current !== 'object') {
      return undefined;
    }
    current = current[part];
  }
  return current;
}

function setNestedProperty(obj: any, path: string, value: any): void {
  const parts = path.split('.');
  let current = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (!(part in current) || current[part] == null || typeof current[part] !== 'object') {
      current[part] = {};
    }
    current = current[part];
  }
  current[parts[parts.length - 1]] = value;
}
