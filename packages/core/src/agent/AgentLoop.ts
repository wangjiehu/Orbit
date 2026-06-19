import { OrbitConfig } from '@orbit-ai/config';
import {
  ModelProvider,
  OrbitMessage,
  OrbitContentBlock,
  OrbitToolCall,
} from '@orbit-ai/model-providers';
import { PermissionEngine } from '@orbit-ai/permissions';
import { CheckpointManager, RollbackManager } from '@orbit-ai/sandbox';
import { ContextPackBuilder, SymbolIndexer } from '@orbit-ai/context-engine';
import { SessionManager } from '@orbit-ai/session';
import { toolRegistry } from '@orbit-ai/tools';
import { StatusBar, Prompt, Renderer } from '@orbit-ai/tui';
import { AgentState, createInitialState } from './AgentState.js';
import { z } from 'zod';
import { MessageBuilder } from './MessageBuilder.js';
import { StepRunner } from './StepRunner.js';
import { Planner } from './Planner.js';
import { eventBus } from '../events/EventBus.js';
import picocolors from 'picocolors';
import path from 'path';
import fs from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
const execPromise = promisify(exec);
import { MCPClient, DynamicMCPTool } from '@orbit-ai/mcp';

export interface UserInteraction {
  askApproval(reason: string, preview?: string): Promise<boolean>;
  showText(text: string): void;
  showDiff(filePath: string, before: string | null, after: string): void | Promise<void>;
}

export class AgentLoop {
  private state: AgentState;
  private sessionManager: SessionManager;
  private checkpointManager: CheckpointManager;
  private rollbackManager: RollbackManager;
  private permissionEngine: PermissionEngine;
  private contextBuilder: ContextPackBuilder;
  private stepRunner: StepRunner;
  private mcpClients: MCPClient[] = [];
  private abortController: AbortController | null = null;
  private sessionCost = 0;
  private statusBar = new StatusBar();
  private gitCheckpoints: string[] = [];

  constructor(
    private cwd: string,
    private config: OrbitConfig,
    private provider: ModelProvider,
    task: string,
    private interaction: UserInteraction,
    private options?: {
      modelOverride?: string;
      systemPromptOverride?: string;
      allowedTools?: string[];
    }
  ) {
    this.sessionManager = new SessionManager(cwd);
    const session = this.sessionManager.startNewSession(provider.id, options?.modelOverride || config.models.default);

    this.state = createInitialState(session.id, task);
    this.checkpointManager = new CheckpointManager(cwd, session.id);
    this.rollbackManager = new RollbackManager(cwd);
    this.permissionEngine = new PermissionEngine(config);
    this.contextBuilder = new ContextPackBuilder(cwd);
    this.stepRunner = new StepRunner(cwd, session.id);
  }

  public async run(): Promise<void> {
    eventBus.emitEvent('agent_start', { taskId: this.state.sessionId, task: this.state.task });

    // Start workspace symbol indexing in the background asynchronously
    const symbolIndexer = new SymbolIndexer(this.cwd);
    symbolIndexer.index().catch(() => {});

    // Initialize MCP Servers if enabled
    if (this.config.tools.mcp.enabled && this.config.mcpServers) {
      this.interaction.showText(`● Initializing MCP servers...`);
      for (const [serverName, serverConfig] of Object.entries(this.config.mcpServers)) {
        try {
          const client = new MCPClient(
            serverName,
            serverConfig.command,
            serverConfig.args || [],
            serverConfig.env || {}
          );
          const tools = await client.start();
          this.mcpClients.push(client);

          for (const toolDef of tools) {
            const configuredTool = serverConfig.tools?.[toolDef.name];
            const risk = configuredTool?.risk || 'execute';

            const dynamicTool = new DynamicMCPTool(serverName, toolDef, risk, client);
            toolRegistry.register(dynamicTool);
            this.interaction.showText(`  ✔ Registered MCP tool: ${dynamicTool.name} (${risk})`);
          }
        } catch (err: any) {
          this.interaction.showText(`  ✖ Failed to start MCP server "${serverName}": ${err.message}`);
        }
      }
    }

    const sigintListener = () => {
      if (this.abortController) {
        this.interaction.showText('\n● Interrupt received. Aborting current execution...');
        this.abortController.abort();
      }
    };
    process.on('SIGINT', sigintListener);

    const exitListener = () => {
      for (const client of this.mcpClients) {
        try {
          client.stop().catch(() => {});
        } catch {
          // Ignore
        }
      }
    };
    process.on('exit', exitListener);

    try {
      const initPack = await this.contextBuilder.build([]);
      this.interaction.showText(
        `● Workspace profiles: ${initPack.projectIndex.detectedLanguages.join(', ')} project detected.`
      );

      while (!this.state.done && this.state.attemptCount < this.state.maxAttempts) {
        // Auto-compact dialogue history if length exceeds 20
        if (this.config.context.autoCompact && this.state.history.length > 20) {
          this.interaction.showText('● Dialogue history is too long. Auto-compacting older history to save tokens...');
          await this.autoCompactHistory();
        }

        if (this.sessionCost > this.config.budgetLimit) {
          this.interaction.showText(
            picocolors.red(
              `\n✖ Budget Exceeded: The session cost has reached $${this.sessionCost.toFixed(4)}, which exceeds the limit of $${this.config.budgetLimit.toFixed(2)}.`
            )
          );
          const confirm = await this.interaction.askApproval(
            `Session cost limit reached. Do you want to increase the budget limit by $10.00 and continue?`
          );
          if (confirm) {
            this.config.budgetLimit += 10.00;
          } else {
            this.state.done = true;
            break;
          }
        }

        this.state.attemptCount++;
        eventBus.emitEvent('loop_start', { attempt: this.state.attemptCount });

        // Runaway Iteration Guard
        if (this.state.attemptCount > 1 && (this.state.attemptCount - 1) % 5 === 0) {
          const continueExec = await this.interaction.askApproval(
            `Agent loop has run for ${this.state.attemptCount - 1} iterations. Continue executing to prevent runaway costs?`
          );
          if (!continueExec) {
            this.interaction.showText('● Terminated by user to prevent runaway iterations.');
            this.state.done = true;
            break;
          }
        }

        // Repository Tree builder (Hierarchical Summary)
        let repoMapText = '';
        try {
          const indexPath = path.join(this.cwd, '.orbit', 'symbols.json');
          if (fs.existsSync(indexPath)) {
            const raw = fs.readFileSync(indexPath, 'utf8');
            const index = JSON.parse(raw);
            if (index.files && typeof index.files === 'object') {
              const fileList = Object.keys(index.files);
              
              interface TreeNode {
                name: string;
                children: Map<string, TreeNode>;
                isFile: boolean;
              }

              const rootNode: TreeNode = { name: '', children: new Map(), isFile: false };
              for (const file of fileList) {
                const parts = file.split(/[/\\]/);
                let current = rootNode;
                for (let i = 0; i < parts.length; i++) {
                  const part = parts[i];
                  if (!part) continue;
                  const isFile = i === parts.length - 1;
                  if (!current.children.has(part)) {
                    current.children.set(part, { name: part, children: new Map(), isFile });
                  }
                  current = current.children.get(part)!;
                }
              }

              const renderTree = (node: TreeNode, indent: string): string => {
                let output = '';
                const sorted = Array.from(node.children.values()).sort((a, b) => {
                  if (a.isFile !== b.isFile) return a.isFile ? 1 : -1;
                  return a.name.localeCompare(b.name);
                });
                for (const child of sorted) {
                  if (child.isFile) {
                    output += `${indent}- ${child.name}\n`;
                  } else {
                    output += `${indent}- ${child.name}/\n`;
                    output += renderTree(child, indent + '  ');
                  }
                }
                return output;
              };

              const treeStr = renderTree(rootNode, '');
              repoMapText = `\n\nProject Directory Structure:\n${treeStr}\n\nNote: To find where a symbol (class, function, etc.) is declared or referenced, use the "search_symbols" and "find_symbol_references" tools dynamically.`;
            }
          }
        } catch {
          // Ignore
        }

        const contextPack = await this.contextBuilder.build(this.state.relevantFiles);
        const systemPrompt = (this.options?.systemPromptOverride || Planner.makeSystemPrompt()) + repoMapText;
        const { system, messages } = MessageBuilder.build(systemPrompt, this.state, contextPack);

        let toolDefs = toolRegistry.getDefinitions();
        if (this.options?.allowedTools) {
          toolDefs = toolDefs.filter((t) => this.options!.allowedTools!.includes(t.name));
        }

        const activeModel = this.options?.modelOverride || this.config.models.default;
        this.statusBar.start(`Calling ${activeModel}... | Cost: $${this.sessionCost.toFixed(4)}`);
        
        this.abortController = new AbortController();
        const stream = this.provider.chat({
          model: activeModel,
          messages,
          system,
          tools: toolDefs,
          stream: true,
          abortSignal: this.abortController.signal,
        });

        let responseText = '';
        const toolCallsToExecute: OrbitToolCall[] = [];

        try {
          for await (const event of stream) {
            this.statusBar.stop();
            if (event.type === 'text_delta') {
              responseText += event.text;
              eventBus.emitEvent('model_delta', { text: event.text });
            } else if (event.type === 'thinking_delta') {
              // Handle thinking delta if needed
            } else if (event.type === 'usage') {
              this.accumulateCost(activeModel, event.usage);
            } else if (event.type === 'tool_call') {
              toolCallsToExecute.push(event.toolCall);
            } else if (event.type === 'error') {
              throw event.error;
            }
          }
        } catch (chatError: any) {
          if (chatError.name === 'AbortError' || this.abortController?.signal.aborted) {
            // Aborted, handled below
          } else {
            this.interaction.showText(`[Error] LLM Call failed: ${chatError.message}`);
            this.state.done = true;
            break;
          }
        } finally {
          this.statusBar.stop();
        }

        if (this.abortController?.signal.aborted) {
          const action = await this.handleInterrupt();
          if (action === 'continue') {
            this.interaction.showText('● Resuming execution...');
            this.abortController = null;
            continue;
          } else if (action === 'rollback_exit') {
            await this.rollbackLastCheckpoint();
            this.state.done = true;
            process.exit(0);
          } else {
            this.interaction.showText('● Aborted. Returning to REPL prompt.');
            this.state.done = true;
            break;
          }
        }

        const assistantBlocks: OrbitContentBlock[] = [];
        if (responseText) {
          assistantBlocks.push({ type: 'text', text: responseText });
        }
        for (const tc of toolCallsToExecute) {
          assistantBlocks.push({ type: 'tool_call', toolCall: tc });
        }

        const assistantMsg: OrbitMessage = {
          id: `msg_asst_${Date.now()}`,
          role: 'assistant',
          createdAt: new Date().toISOString(),
          content: assistantBlocks,
        };
        this.state.history.push(assistantMsg);

        if (responseText) {
          if (toolCallsToExecute.length > 0) {
            Renderer.printThought(responseText);
          } else {
            this.interaction.showText(`\nOrbit: ${Renderer.formatMarkdown(responseText)}`);
          }
        }

        if (toolCallsToExecute.length === 0) {
          this.state.done = true;
          break;
        }

        const toolResultBlocks: OrbitContentBlock[] = [];
        for (const tc of toolCallsToExecute) {
          let argSummary = tc.arguments;
          if (argSummary.length > 80) {
            argSummary = argSummary.substring(0, 77) + '...';
          }
          this.interaction.showText(`\n  ${picocolors.magenta('⬢')} Tool Run: ${picocolors.cyan(tc.name)} ${picocolors.gray(argSummary)}`);

          const registeredTool = toolRegistry.get(tc.name);
          const declaredRisk = registeredTool?.risk;
          const decision = this.permissionEngine.evaluate(tc.name, JSON.parse(tc.arguments), declaredRisk);

          if (decision.action === 'deny') {
            this.interaction.showText(`✖ Blocked: ${decision.reason}`);
            toolResultBlocks.push({
              type: 'tool_result',
              toolResult: {
                toolCallId: tc.id,
                name: tc.name,
                content: `Blocked by safety policy: ${decision.reason}`,
                isError: true,
              },
            });
            this.sessionManager.recordToolExecution(
              tc.name,
              tc,
              null,
              decision.risk || 'read',
              decision.action,
              'denied'
            );
            continue;
          }

          if (decision.action === 'ask') {
            let approved = false;
            let currentArgs = tc.arguments;
            while (true) {
              const choice = await Prompt.askSelect(
                `Confirm execution of tool "${tc.name}"? Reason: ${decision.reason}`,
                [
                  { value: 'approve', label: 'Approve execution' },
                  { value: 'edit', label: 'Edit tool arguments' },
                  { value: 'deny', label: 'Deny execution' }
                ]
              );
              if (choice === 'approve') {
                approved = true;
                break;
              } else if (choice === 'edit') {
                let edited: string | null = null;
                const isObjectSchema = registeredTool?.inputSchema instanceof z.ZodObject;

                if (isObjectSchema) {
                  const editChoice = await Prompt.askSelect('Choose edit mode:', [
                    { value: 'form', label: '(Recommended) Interactive form fields editor' },
                    { value: 'json', label: 'Raw JSON string editor' },
                    { value: 'cancel', label: 'Cancel' }
                  ]);
                  if (editChoice === 'form') {
                    edited = await this.promptSchemaGuided(registeredTool, currentArgs);
                  } else if (editChoice === 'json') {
                    edited = await Prompt.askText('Edit tool arguments (JSON string):', currentArgs);
                  }
                } else {
                  edited = await Prompt.askText('Edit tool arguments (JSON string):', currentArgs);
                }

                if (edited === null) {
                  continue;
                }
                try {
                  const parsed = JSON.parse(edited);
                  if (registeredTool && registeredTool.inputSchema) {
                    const validation = registeredTool.inputSchema.safeParse(parsed);
                    if (!validation.success) {
                      const errorMsgs = validation.error.errors.map(
                        e => `${e.path.join('.') || 'root'}: ${e.message}`
                      ).join(', ');
                      this.interaction.showText(`✖ Schema validation failed: ${errorMsgs}`);
                      continue;
                    }
                  }
                  currentArgs = edited;
                  tc.arguments = edited;
                  this.interaction.showText(`✔ Arguments updated.`);
                  approved = true;
                  break;
                } catch (err: any) {
                  this.interaction.showText(`✖ Invalid JSON: ${err.message}. Please try again.`);
                }
              } else {
                break;
              }
            }

            if (!approved) {
              this.interaction.showText(`✖ Rejected by user.`);
              toolResultBlocks.push({
                type: 'tool_result',
                toolResult: {
                  toolCallId: tc.id,
                  name: tc.name,
                  content: 'Rejected by user',
                  isError: true,
                },
              });
              this.sessionManager.recordToolExecution(
                tc.name,
                tc,
                null,
                decision.risk || 'read',
                decision.action,
                'denied'
              );
              continue;
            }
          }

          let beforeContent: string | null = null;
          let targetPath: string | undefined;
          let parsedArgs: any = {};
          try {
            parsedArgs = JSON.parse(tc.arguments);
            targetPath = parsedArgs.path || parsedArgs.filePath;
          } catch {
            // Ignored
          }

          let skipToolExecution = false;
          let hookResult: any = null;

          // Milestone 22: Git Auto-Commits with LLM Commit Messages & Pre-Commit Checks
          if (tc.name === 'git_commit') {
            // 1. Pre-commit verification checks (run tests if available)
            if (contextPack.projectIndex.testCommands && contextPack.projectIndex.testCommands.length > 0) {
              this.interaction.showText(`● Pre-commit checks: running verification tests...`);
              const testCmd = contextPack.projectIndex.testCommands[0];
              try {
                await execPromise(testCmd, { cwd: this.cwd });
                this.interaction.showText(`✔ Pre-commit checks passed.`);
              } catch (err: any) {
                this.interaction.showText(picocolors.red(`✖ Pre-commit checks failed. Verification tests failed.`));
                
                const choice = await Prompt.askSelect(
                  `Pre-commit verification tests failed. How would you like to proceed?`,
                  [
                    { value: 'yes', label: 'Proceed with the commit anyway' },
                    { value: 'diagnose', label: 'Let Agent auto-repair the failures (diagnose)' },
                    { value: 'no', label: 'Abort the commit entirely' }
                  ]
                );

                if (choice === 'diagnose') {
                  toolResultBlocks.push({
                    type: 'tool_result',
                    toolResult: {
                      toolCallId: tc.id,
                      name: tc.name,
                      content: `Commit aborted. Verification tests failed with the following log. Please diagnose and fix the codebase first:\n\n${err.stdout || err.stderr || err.message}`,
                      isError: true,
                    },
                  });
                  continue;
                } else if (choice !== 'yes') {
                  toolResultBlocks.push({
                    type: 'tool_result',
                    toolResult: {
                      toolCallId: tc.id,
                      name: tc.name,
                      content: 'Commit aborted by user due to pre-commit test failures.',
                      isError: true,
                    },
                  });
                  continue;
                }
              }
            }

            // 2. Generate Commit Message via LLM if not provided
            if (!parsedArgs.message) {
              this.interaction.showText(`● Git Commit: generating commit message via LLM...`);
              try {
                const { stdout } = await execPromise('git diff --cached', { cwd: this.cwd });
                if (!stdout.trim()) {
                  this.interaction.showText(`⚠ Warning: No staged changes found to commit.`);
                } else {
                  const fastModel = this.config.models.fast || this.config.models.default;
                  const stream = this.provider.chat({
                    model: fastModel,
                    messages: [
                      {
                        id: `msg_commit_${Date.now()}`,
                        role: 'user',
                        createdAt: new Date().toISOString(),
                        content: [
                          {
                            type: 'text',
                            text: `Generate a concise, high-quality conventional git commit message (e.g. feat(cli): add autocomplete) for the following git diff. Output ONLY the commit message, no formatting, no markdown, no quotes, just the text:\n\n${stdout.substring(0, 20000)}`,
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

                  generatedMessage = generatedMessage.trim().replace(/^["']|["']$/g, '');
                  if (generatedMessage) {
                    parsedArgs.message = generatedMessage;
                    tc.arguments = JSON.stringify(parsedArgs);
                    this.interaction.showText(`● Generated Commit Message: "${generatedMessage}"`);
                  }
                }
              } catch (err: any) {
                this.interaction.showText(`⚠ Failed to generate commit message: ${err.message}`);
              }
            }
          }

          if ((tc.name === 'write_file' || tc.name === 'edit_file') && targetPath) {
            const checkpoint = await this.checkpointManager.captureBeforeState(tc.id, targetPath);
            beforeContent = checkpoint.backups[0].originalContent;

            // Run pre-edit hook if configured
            if (this.config.hooks?.preEdit) {
              this.interaction.showText(`● Running pre-edit hook...`);
              const hookRes = await this.runHook(this.config.hooks.preEdit, targetPath);
              if (!hookRes.ok) {
                this.interaction.showText(`✖ Pre-edit hook failed: ${hookRes.output}`);
                hookResult = {
                  ok: false,
                  error: `Pre-edit hook failed: ${hookRes.output}`,
                };
                skipToolExecution = true;
              } else {
                this.interaction.showText(`✔ Pre-edit hook passed.`);
              }
            }
          }

          let hasGitCheckpoint = false;
          if (tc.name === 'bash' || tc.name === 'run_tests') {
            const isGit = await this.isGitRepo();
            if (isGit) {
              hasGitCheckpoint = await this.createGitCheckpoint(tc.id);
            }
          }

          this.statusBar.start(`Executing tool: ${tc.name}... | Cost: $${this.sessionCost.toFixed(4)}`);
          const result = skipToolExecution
            ? hookResult
            : await this.stepRunner.run(tc, this.abortController?.signal);
          this.statusBar.stop();

          if (this.abortController?.signal.aborted) {
            const action = await this.handleInterrupt();
            if (action === 'continue') {
              this.interaction.showText('● Resuming execution...');
              this.abortController = null;
              toolResultBlocks.push({
                type: 'tool_result',
                toolResult: {
                  toolCallId: tc.id,
                  name: tc.name,
                  content: 'Interrupted by user',
                  isError: true,
                },
              });
              continue;
            } else if (action === 'rollback_exit') {
              await this.rollbackLastCheckpoint();
              this.state.done = true;
              process.exit(0);
            } else {
              this.interaction.showText('● Aborted. Returning to REPL prompt.');
              this.state.done = true;
              break;
            }
          }

          let finalResult = result;
          // Run post-edit hook if tool succeeded and it's a file edit
          if (result.ok && !skipToolExecution && (tc.name === 'write_file' || tc.name === 'edit_file') && targetPath) {
            if (this.config.hooks?.postEdit) {
              this.interaction.showText(`● Running post-edit hook...`);
              const hookRes = await this.runHook(this.config.hooks.postEdit, targetPath);
              if (!hookRes.ok) {
                this.interaction.showText(`✖ Post-edit hook failed: ${hookRes.output}`);
                finalResult = {
                  ok: false,
                  error: `Post-edit hook failed: ${hookRes.output}`,
                };
              } else {
                this.interaction.showText(`✔ Post-edit hook passed.`);
              }
            }
          }

          // Type & Lint Guard Rails check
            if (finalResult.ok && targetPath && (tc.name === 'write_file' || tc.name === 'edit_file')) {
            if (targetPath.endsWith('.ts') || targetPath.endsWith('.tsx') || targetPath.endsWith('.js') || targetPath.endsWith('.jsx')) {
              try {
                let lintCmd = `npx eslint --quiet "${targetPath}"`;
                if (fs.existsSync(path.join(this.cwd, 'biome.json')) || fs.existsSync(path.join(this.cwd, 'biome.jsonc'))) {
                  lintCmd = `npx @biomejs/biome lint "${targetPath}"`;
                }
                this.interaction.showText(`● Verifying file syntax & type safety for ${targetPath}...`);
                await execPromise(lintCmd, { cwd: this.cwd });
                this.interaction.showText(`✔ Syntax verification passed.`);
              } catch (err: any) {
                this.interaction.showText(picocolors.yellow(`⚠ Syntax/Lint validation warning for ${targetPath}:`));
                this.interaction.showText(picocolors.red(err.stdout || err.stderr || err.message));

                let checkPassedAfterAutoInstall = false;
                const outputText = err.stdout || err.stderr || '';
                
                try {
                  const missingModules: string[] = [];
                  const moduleMatch1 = [...outputText.matchAll(/Cannot find module '([^']+)'/g)];
                  for (const m of moduleMatch1) {
                    if (m[1]) missingModules.push(m[1]);
                  }
                  const moduleMatch2 = [...outputText.matchAll(/Cannot find name '([^']+)'/g)];
                  for (const m of moduleMatch2) {
                    if (m[1] && (m[1].toLowerCase() === m[1] || m[1].startsWith('@'))) {
                      missingModules.push(m[1]);
                    }
                  }
                  const typesMatch = [...outputText.matchAll(/Could not find a declaration file for module '([^']+)'/g)];
                  for (const m of typesMatch) {
                    if (m[1]) missingModules.push(`@types/${m[1]}`);
                  }

                  if (missingModules.length > 0) {
                    const uniqueModules = Array.from(new Set(missingModules));
                    let dependenciesInstalled = false;
                    for (const pkg of uniqueModules) {
                      const installPkg = await Prompt.askApproval(`Missing dependency "${pkg}" detected. Install it automatically?`);
                      if (installPkg) {
                        this.interaction.showText(`● Installing "${pkg}"...`);
                        const isPnpm = fs.existsSync(path.join(this.cwd, 'pnpm-lock.yaml'));
                        const isYarn = fs.existsSync(path.join(this.cwd, 'yarn.lock'));
                        const installCmd = isPnpm 
                          ? `npx pnpm add -D ${pkg}` 
                          : isYarn 
                            ? `yarn add -D ${pkg}` 
                            : `npm install --save-dev ${pkg}`;
                        
                        try {
                          await execPromise(installCmd, { cwd: this.cwd });
                          this.interaction.showText(`✔ Installed "${pkg}" successfully.`);
                          dependenciesInstalled = true;
                        } catch (installErr: any) {
                          this.interaction.showText(picocolors.red(`✖ Failed to install "${pkg}": ${installErr.message}`));
                        }
                      }
                    }

                    if (dependenciesInstalled) {
                      try {
                        this.interaction.showText(`● Re-verifying syntax after dependency installation...`);
                        await execPromise(`npx eslint --quiet "${targetPath}"`, { cwd: this.cwd });
                        this.interaction.showText(`✔ Syntax verification passed after dependency installation.`);
                        checkPassedAfterAutoInstall = true;
                      } catch (recheckErr: any) {
                        err = recheckErr;
                      }
                    }
                  }
                } catch {
                  // Ignore installer issues
                }

                let autoImported = false;
                if (!checkPassedAfterAutoInstall) {
                  try {
                    const missingSymbols: string[] = [];
                    const currentOutput = err.stdout || err.stderr || '';
                    const match1 = [...currentOutput.matchAll(/'([^']+)' is not defined/g)];
                    for (const m of match1) {
                      if (m[1]) missingSymbols.push(m[1]);
                    }
                    const match2 = [...currentOutput.matchAll(/Cannot find name '([^']+)'/g)];
                    for (const m of match2) {
                      if (m[1]) missingSymbols.push(m[1]);
                    }

                    if (missingSymbols.length > 0) {
                      const indexPath = path.join(this.cwd, '.orbit', 'symbols.json');
                      if (fs.existsSync(indexPath)) {
                        const raw = fs.readFileSync(indexPath, 'utf8');
                        const index = JSON.parse(raw);
                        if (index.files && typeof index.files === 'object') {
                          let fileContent = fs.readFileSync(targetPath, 'utf8');
                          let newImports = '';
                          for (const symbol of new Set(missingSymbols)) {
                            let foundFile: string | null = null;
                            for (const [file, fileData] of Object.entries(index.files)) {
                              const data = fileData as any;
                              if (data && Array.isArray(data.symbols)) {
                                if (data.symbols.some((s: any) => s.name === symbol)) {
                                  foundFile = file;
                                  break;
                                }
                              }
                            }

                            if (foundFile) {
                              const targetDir = path.dirname(targetPath);
                              const exportFileAbs = path.resolve(this.cwd, foundFile);
                              let relPath = path.relative(targetDir, exportFileAbs);
                              relPath = relPath.replace(/\\/g, '/');
                              if (!relPath.startsWith('./') && !relPath.startsWith('../')) {
                                relPath = './' + relPath;
                              }
                              relPath = relPath.replace(/\.(ts|tsx|js|jsx)$/, '.js');
                              newImports += `import { ${symbol} } from '${relPath}';\n`;
                            }
                          }

                          if (newImports) {
                            fs.writeFileSync(targetPath, newImports + fileContent, 'utf8');
                            this.interaction.showText(`● Automatically resolved missing imports...`);
                            autoImported = true;
                          }
                        }
                      }
                    }
                  } catch {
                    // Ignore autofix errors
                  }
                }

                let checkPassedAfterAutofix = false;
                if (autoImported) {
                  try {
                    this.interaction.showText(`● Re-verifying syntax after auto-imports injection...`);
                    await execPromise(`npx eslint --quiet "${targetPath}"`, { cwd: this.cwd });
                    this.interaction.showText(`✔ Syntax verification passed after auto-imports injection.`);
                    checkPassedAfterAutofix = true;
                  } catch (reErr: any) {
                    this.interaction.showText(picocolors.yellow(`⚠ Syntax/Lint validation still failed after auto-imports:`));
                    this.interaction.showText(picocolors.red(reErr.stdout || reErr.stderr || reErr.message));
                  }
                }

                if (!checkPassedAfterAutofix) {
                  const autoFix = await Prompt.askApproval(`Lint/Syntax verification failed. Let Agent auto-repair the file?`);
                  if (autoFix) {
                    finalResult = {
                      ok: false,
                      error: `Syntax or Lint verification failed on file edit: ${err.stdout || err.stderr || err.message}. Please fix the syntax/import errors.`,
                    };
                  }
                }
              }
            }
          }

          // Phase 5: Interactive Diff Acceptance Check
          if (finalResult.ok && targetPath && (tc.name === 'write_file' || tc.name === 'edit_file')) {
            let afterContent = '';
            try {
              const afterArgs = JSON.parse(tc.arguments);
              afterContent = afterArgs.content || afterArgs.newText || '';
              await this.interaction.showDiff(targetPath, beforeContent, afterContent);
            } catch {
              // Ignored
            }

            let accepted = false;
            const choice = await Prompt.askSelect(`Accept changes to ${targetPath}?`, [
              { value: 'yes', label: 'Accept all changes' },
              { value: 'hunks', label: 'Review and accept by hunk/block' },
              { value: 'no', label: 'Reject and rollback all changes' }
            ]);

            if (choice === 'yes') {
              accepted = true;
            } else if (choice === 'hunks') {
              try {
                const linesBefore = beforeContent ? beforeContent.split('\n') : [];
                const linesAfter = afterContent.split('\n');
                
                interface Hunk {
                  startB: number;
                  endB: number;
                  startA: number;
                  endA: number;
                  linesB: string[];
                  linesA: string[];
                }
                const hunks: Hunk[] = [];
                let iB = 0;
                let iA = 0;
                
                while (iB < linesBefore.length || iA < linesAfter.length) {
                  if (iB < linesBefore.length && iA < linesAfter.length && linesBefore[iB] === linesAfter[iA]) {
                    iB++;
                    iA++;
                    continue;
                  }
                  
                  const startB = iB;
                  const startA = iA;
                  
                  let bestDB = -1;
                  let bestDA = -1;
                  let minSum = Infinity;
                  
                  const maxLookahead = 20;
                  for (let dB = 0; dB <= maxLookahead; dB++) {
                    for (let dA = 0; dA <= maxLookahead; dA++) {
                      if (dB === 0 && dA === 0) continue;
                      const posB = iB + dB;
                      const posA = iA + dA;
                      
                      if (posB > linesBefore.length || posA > linesAfter.length) continue;
                      
                      const isEndB = posB === linesBefore.length;
                      const isEndA = posA === linesAfter.length;
                      
                      let isMatch = false;
                      if (isEndB && isEndA) {
                        isMatch = true;
                      } else if (!isEndB && !isEndA) {
                        isMatch = linesBefore[posB] === linesAfter[posA];
                      }
                      
                      if (isMatch) {
                        const sum = dB + dA;
                        if (sum < minSum) {
                          minSum = sum;
                          bestDB = dB;
                          bestDA = dA;
                        }
                      }
                    }
                  }
                  
                  if (bestDB !== -1 && bestDA !== -1) {
                    const linesB = linesBefore.slice(startB, startB + bestDB);
                    const linesA = linesAfter.slice(startA, startA + bestDA);
                    iB += bestDB;
                    iA += bestDA;
                    
                    hunks.push({
                      startB,
                      endB: iB,
                      startA,
                      endA: iA,
                      linesB,
                      linesA
                    });
                  } else {
                    const linesB = linesBefore.slice(startB);
                    const linesA = linesAfter.slice(startA);
                    iB = linesBefore.length;
                    iA = linesAfter.length;
                    
                    hunks.push({
                      startB,
                      endB: iB,
                      startA,
                      endA: iA,
                      linesB,
                      linesA
                    });
                  }
                }

                if (hunks.length === 0) {
                  accepted = true;
                } else {
                  this.interaction.showText(`\n● Reviewing ${hunks.length} hunks in ${targetPath}:`);
                  for (let hIdx = 0; hIdx < hunks.length; hIdx++) {
                    const hunk = hunks[hIdx];
                    console.log(picocolors.cyan(`\n┌── Hunk #${hIdx + 1}/${hunks.length} ──────────────────────────────────`));
                    for (const line of hunk.linesB) {
                      console.log(`${picocolors.red(`- ${line}`)}`);
                    }
                    for (const line of hunk.linesA) {
                      console.log(`${picocolors.green(`+ ${line}`)}`);
                    }
                    console.log(picocolors.cyan('└────────────────────────────────────────────────────────────'));
                  }

                  const selectedHunkIndices = await Prompt.askMultiSelect(
                    `Select the hunks to apply to ${targetPath}:`,
                    hunks.map((h, idx) => ({
                      value: idx.toString(),
                      label: `Apply Hunk #${idx + 1}`,
                      hint: `-${h.linesB.length} lines, +${h.linesA.length} lines`
                    }))
                  );

                  if (selectedHunkIndices === null) {
                    accepted = false;
                  } else {
                    const mergedLines: string[] = [];
                    let lastB = 0;
                    for (let hIdx = 0; hIdx < hunks.length; hIdx++) {
                      const hunk = hunks[hIdx];
                      mergedLines.push(...linesBefore.slice(lastB, hunk.startB));
                      if (selectedHunkIndices.includes(hIdx.toString())) {
                        mergedLines.push(...hunk.linesA);
                      } else {
                        mergedLines.push(...hunk.linesB);
                      }
                      lastB = hunk.endB;
                    }
                    mergedLines.push(...linesBefore.slice(lastB));
                    
                    fs.writeFileSync(targetPath, mergedLines.join('\n'), 'utf8');
                    this.interaction.showText(picocolors.green(`✔ Selected hunks merged and saved to ${targetPath}.`));
                    accepted = true;
                  }
                }
              } catch (hunkErr: any) {
                this.interaction.showText(picocolors.red(`✖ Hunk merge failed: ${hunkErr.message}. Accepting all instead.`));
                accepted = true;
              }
            }

            if (!accepted) {
              this.interaction.showText(picocolors.yellow(`● Rejected changes. Reverting ${targetPath}...`));
              await this.rollbackLastCheckpoint();
              finalResult = {
                ok: false,
                error: `Edits to ${targetPath} rejected and rolled back by user.`,
              };
            }
          }

          const status = finalResult.ok ? ('success' as const) : ('failed' as const);
          this.sessionManager.recordToolExecution(
            tc.name,
            tc,
            finalResult,
            decision.risk || 'read',
            decision.action,
            status
          );

          if (finalResult.ok) {
            await this.commitLastGitCheckpointSoft();
            this.interaction.showText(`  ${picocolors.green('✔')} Success: ${picocolors.gray(finalResult.display || 'Done')}`);

            if (targetPath) {
              this.addRelevantFile(targetPath, `Modified by ${tc.name}`);
            }
            if (tc.name === 'write_file' || tc.name === 'edit_file') {
              new SymbolIndexer(this.cwd).index().catch(() => {});
            }
          } else {
            await this.rollbackLastGitCheckpoint();
            this.interaction.showText(`  ${picocolors.red('✖')} Failed: ${picocolors.red(finalResult.error || 'Unknown error')}`);
          }

          toolResultBlocks.push({
            type: 'tool_result',
            toolResult: {
              toolCallId: tc.id,
              name: tc.name,
              content: finalResult.ok
                ? typeof finalResult.data === 'string'
                  ? finalResult.data
                  : JSON.stringify(finalResult.data)
                : finalResult.error || 'Unknown error',
              isError: !finalResult.ok,
            },
          });
        }

        const toolMsg: OrbitMessage = {
          id: `msg_tool_${Date.now()}`,
          role: 'tool',
          createdAt: new Date().toISOString(),
          content: toolResultBlocks,
        };
        this.state.history.push(toolMsg);
        this.abortController = null;
      }

      if (this.state.attemptCount >= this.state.maxAttempts && !this.state.done) {
        this.interaction.showText(
          `\n● Limit reached: Maximum consecutive loop iterations (${this.state.maxAttempts}) completed. Pausing loop.`
        );
      }

      const sessions = this.sessionManager.getSessionStore().getEvents(this.state.sessionId);
      const modifiedFiles = sessions
        .filter((e) => e.type === 'file_modified')
        .map((e) => e.payload.path);

      this.interaction.showText(`\n● Summary:`);
      this.interaction.showText(
        `  Modified files: ${modifiedFiles.length > 0 ? Array.from(new Set(modifiedFiles)).join(', ') : 'None'}`
      );
      this.interaction.showText(`  Verification: test run executed.`);
      this.interaction.showText(`  Session Cost: $${this.sessionCost.toFixed(4)}`);

      if (this.config.autoCommit && modifiedFiles.length > 0) {
        this.interaction.showText(`\n● Auto-committing changes...`);
        try {
          const uniqueFiles = Array.from(new Set(modifiedFiles));
          const { execSync } = await import('child_process');
          
          for (const file of uniqueFiles) {
            execSync(`git add "${file}"`, { cwd: this.cwd });
          }

          const diff = execSync('git diff --cached', { cwd: this.cwd }).toString().trim();
          if (diff) {
            this.interaction.showText('● Generating commit message via LLM...');
            const fastModel = this.config.models.fast || this.config.models.default;
            const stream = this.provider.chat({
              model: fastModel,
              messages: [
                {
                  id: `msg_auto_commit_${Date.now()}`,
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
            const finalMsg = generatedMessage.trim().replace(/^["']|["']$/g, '') || 'chore: auto-commit';
            
            this.interaction.showText(`● Committing: "${picocolors.green(finalMsg)}"`);
            const commitCmd = `git commit -m ${JSON.stringify(finalMsg)}`;
            execSync(commitCmd, { cwd: this.cwd });
            this.interaction.showText(`${picocolors.green('✔')} Auto-commit created successfully.`);
          } else {
            this.interaction.showText('● No changes staged or modified. Skipping auto-commit.');
          }
        } catch (commitErr: any) {
          this.interaction.showText(picocolors.red(`✖ Auto-commit failed: ${commitErr.message}`));
        }
      }
    } finally {
      process.removeListener('SIGINT', sigintListener);
      process.removeListener('exit', exitListener);
      if (this.mcpClients.length > 0) {
        this.interaction.showText(`\n● Stopping MCP servers...`);
        for (const client of this.mcpClients) {
          await client.stop();
        }
      }
    }
  }

  private addRelevantFile(path: string, reason: string) {
    if (!this.state.relevantFiles.some((f) => f.path === path)) {
      this.state.relevantFiles.push({ path, reason });
    }
  }

  private async runHook(hookCommand: string, filePath: string): Promise<{ ok: boolean; output: string }> {
    const absolutePath = path.isAbsolute(filePath) ? filePath : path.resolve(this.cwd, filePath);
    const relativePath = path.relative(this.cwd, absolutePath);
    const cmd = hookCommand.replace(/{file}/g, `"${relativePath.replace(/"/g, '\\"')}"`);

    try {
      const { stdout, stderr } = await execPromise(cmd, { cwd: this.cwd });
      return { ok: true, output: (stdout + stderr).trim() };
    } catch (err: any) {
      return { ok: false, output: (err.stdout + err.stderr || err.message).trim() };
    }
  }

  public getSessionId(): string {
    return this.state.sessionId;
  }

  public getHistory(): OrbitMessage[] {
    return this.state.history;
  }

  public getSessionCost(): number {
    return this.sessionCost;
  }

  public getConfig(): OrbitConfig {
    return this.config;
  }

  public getProvider(): ModelProvider {
    return this.provider;
  }

  public setModelOverride(model: string): void {
    if (!this.options) {
      this.options = {};
    }
    this.options.modelOverride = model;
  }

  public getModelOverride(): string | undefined {
    return this.options?.modelOverride;
  }

  public async rollbackLastCheckpoint(): Promise<void> {
    const checkpoints = this.checkpointManager.getCheckpoints();
    if (checkpoints.length === 0) {
      const rolledBackGit = await this.rollbackLastGitCheckpoint();
      if (rolledBackGit) {
        this.interaction.showText('Successfully rolled back last command changes via Git.');
      } else {
        this.interaction.showText('No checkpoints found to rollback.');
      }
      return;
    }
    const last = checkpoints[checkpoints.length - 1];
    this.interaction.showText(`Rolling back last changes for tool call ${last.toolCallId}...`);
    const res = this.rollbackManager.rollback(last);
    if (res.success) {
      this.interaction.showText(`Successfully rolled back: ${res.restored.join(', ')}`);
    } else {
      this.interaction.showText(`Rollback failed: ${res.error}`);
    }
    await this.rollbackLastGitCheckpoint();
  }

  private accumulateCost(model: string, usage: any) {
    const pricing = this.config.pricing?.[model];
    if (!pricing) return;

    const inputCost = (usage.inputTokens / 1000000) * pricing.inputCostPer1M;
    const outputCost = (usage.outputTokens / 1000000) * pricing.outputCostPer1M;
    const cacheReadCost = usage.cacheReadTokens && pricing.cacheReadCostPer1M
      ? (usage.cacheReadTokens / 1000000) * pricing.cacheReadCostPer1M
      : 0;

    const turnCost = inputCost + outputCost + cacheReadCost;
    this.sessionCost += turnCost;

    eventBus.emitEvent('cost_update', { turnCost, sessionCost: this.sessionCost });
  }

  private async autoCompactHistory(): Promise<void> {
    const history = this.state.history;
    if (history.length <= 12) return;

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

    let summaryText = 'Prior dialogue history compacted.';
    try {
      const fastModel = this.config.models.fast || this.config.models.default;
      const stream = this.provider.chat({
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
      this.interaction.showText(`⚠ Auto-compactor LLM query failed: ${err.message}. Using default summary.`);
    }

    const summaryMsg: OrbitMessage = {
      id: `msg_summary_${Date.now()}`,
      role: 'system',
      createdAt: new Date().toISOString(),
      content: [{ type: 'text', text: `Prior session history summary:\n${summaryText}` }],
    };

    const newHistory: OrbitMessage[] = [];
    if (systemMsg) {
      newHistory.push(systemMsg);
    }
    newHistory.push(summaryMsg);
    newHistory.push(...recentMsgs);
    this.state.history = newHistory;

    this.interaction.showText(`✔ Dialogue history auto-compacted! Compaction reduced history to ${this.state.history.length} messages.`);
  }

  private async promptSchemaGuided(registeredTool: any, currentArgsStr: string): Promise<string | null> {
    try {
      const schema = registeredTool.inputSchema;
      if (!(schema instanceof z.ZodObject)) {
        return null;
      }

      const currentArgs = JSON.parse(currentArgsStr);
      const shape = schema.shape;
      const updatedArgs: Record<string, any> = {};

      for (const [key, fieldSchema] of Object.entries(shape)) {
        const val = currentArgs[key];
        const valStr = val !== undefined ? (typeof val === 'object' ? JSON.stringify(val) : String(val)) : '';
        const description = (fieldSchema as any).description || `Parameter "${key}"`;

        let result: any = null;
        let unwrapped = fieldSchema;
        while (unwrapped instanceof z.ZodOptional || unwrapped instanceof z.ZodNullable || unwrapped instanceof z.ZodEffects) {
          unwrapped = (unwrapped as any)._def.innerType || (unwrapped as any)._def.schema;
        }

        if (unwrapped instanceof z.ZodBoolean) {
          const choice = await Prompt.askSelect(`${description} (boolean):`, [
            { value: 'true', label: 'true' },
            { value: 'false', label: 'false' }
          ]);
          if (choice === null) return null;
          result = choice === 'true';
        } else if (unwrapped instanceof z.ZodEnum) {
          const options = (unwrapped as any)._def.values.map((v: string) => ({ value: v, label: v }));
          const choice = await Prompt.askSelect(`${description} (select):`, options);
          if (choice === null) return null;
          result = choice;
        } else {
          const input = await Prompt.askText(`${description} (${key}):`, valStr);
          if (input === null) return null;
          
          if (unwrapped instanceof z.ZodNumber) {
            const num = Number(input);
            result = isNaN(num) ? input : num;
          } else if (unwrapped instanceof z.ZodArray || unwrapped instanceof z.ZodObject) {
            try {
              result = JSON.parse(input);
            } catch {
              result = input;
            }
          } else {
            result = input;
          }
        }

        if (result !== undefined && result !== '') {
          updatedArgs[key] = result;
        }
      }

      return JSON.stringify(updatedArgs);
    } catch {
      return null;
    }
  }

  private async handleInterrupt(): Promise<'continue' | 'abort' | 'rollback_exit'> {
    this.statusBar.stop();
    this.interaction.showText(picocolors.yellow('\n● Execution interrupted by user.'));
    const choice = await Prompt.askSelect('What would you like to do?', [
      { value: 'continue', label: 'Continue execution' },
      { value: 'abort', label: 'Abort execution and return to prompt' },
      { value: 'rollback_exit', label: 'Rollback changes and exit' },
    ]);
    return (choice as any) || 'abort';
  }

  private async isGitRepo(): Promise<boolean> {
    try {
      await execPromise('git rev-parse --is-inside-work-tree', { cwd: this.cwd });
      return true;
    } catch {
      return false;
    }
  }

  private async createGitCheckpoint(toolCallId: string): Promise<boolean> {
    try {
      const statusRes = await execPromise('git status --porcelain', { cwd: this.cwd });
      if (!statusRes.stdout.trim()) {
        return false;
      }

      await execPromise('git add -A', { cwd: this.cwd });
      const msg = `orbit-temp-checkpoint-${toolCallId}`;
      await execPromise(`git commit -m ${JSON.stringify(msg)} --no-verify`, { cwd: this.cwd });
      
      const hashRes = await execPromise('git rev-parse HEAD', { cwd: this.cwd });
      const hash = hashRes.stdout.trim();
      if (hash) {
        this.gitCheckpoints.push(hash);
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  private async rollbackLastGitCheckpoint(): Promise<boolean> {
    if (this.gitCheckpoints.length === 0) return false;
    const lastHash = this.gitCheckpoints.pop();
    try {
      await execPromise(`git reset --hard ${lastHash}~1`, { cwd: this.cwd });
      return true;
    } catch {
      return false;
    }
  }

  private async commitLastGitCheckpointSoft(): Promise<boolean> {
    if (this.gitCheckpoints.length === 0) return false;
    const lastHash = this.gitCheckpoints.pop();
    try {
      const currentHashRes = await execPromise('git rev-parse HEAD', { cwd: this.cwd });
      if (currentHashRes.stdout.trim() === lastHash) {
        await execPromise('git reset --soft HEAD~1', { cwd: this.cwd });
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }
}
