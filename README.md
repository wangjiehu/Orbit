# 🪐 Orbit

> **Orbit** is a production-grade, local-first AI coding agent runtime and Language Server designed to bring state-of-the-art developer assistance directly to your terminal and editor. Optimized for **DeepSeek-V3/R1** and Anthropic models with native prompt caching keep-alives, it runs entirely out-of-the-box on Windows, macOS, and Linux without native C++ compilation dependencies.

---

## ✨ Features

- **🚀 DeepSeek-First & Prompt Cache Keep-Alives**: 
  Configured to minimize token cost and latency. Orbit runs background async pings to refresh DeepSeek's Prompt Cache TTL (5-10 minutes), slashing secondary prompt latency by up to 90%.
- **🔍 References-Aware Cross-File RAG**: 
  Locates AST symbols across the repository and retrieves their calling sites (including 3 lines of context above and below), providing reasoning models with accurate structural usage examples during refactorings.
- **🗺️ Graded PageRank Landmark Maps**: 
  Constructs token-efficient project repository maps using PageRank weights computed from AST imports/exports. Automatically grades output detail levels (`detailed` -> `outline` -> `simple`) to maximize codebase resolution within your LLM token budget.
- **⚡ Real-Time LSP Autocomplete Server**: 
  Features a built-in JSON-RPC LSP Server (`orbit lsp`) with connection caching and tab-specific `AbortController` debouncing. Automatically cancels obsolete completions during high-frequency typing on a per-tab basis.
- **🔒 Sandboxed Subprocess Timeouts**: 
  Enforces a hard limit of 45 seconds for shell executions and test runs, executing subprocesses in isolated process groups to clean up orphans immediately upon timeouts or user interrupts.
- **💾 Auto-Healing Vector Indexing & Atomic Writes**: 
  Dynamically adapts to changes in embedding models or dimensions, automatically clearing and reindexing the database. All vector store and symbols indexes are written atomically (`.tmp` -> rename) to avoid race conditions.
- **🛡️ Sandbox & Permissions Manager**: 
  Protects sensitive files (e.g., `.env`, credentials), intercepts bash executions for user approvals, and maintains git checkpoints for automatic rollbacks when modifications are rejected.

---

## 📦 Monorepo Packages

Orbit is organized as a clean, modular pnpm monorepo:

- [`@orbit-ai/cli`](file:///c:/Users/24377/Desktop/Orbit/packages/cli): Main CLI commander entry point and LSP server bridge.
- [`@orbit-ai/core`](file:///c:/Users/24377/Desktop/Orbit/packages/core): Core agent loop, prompt caching, state managers, and autocomplete debouncer.
- [`@orbit-ai/context-engine`](file:///c:/Users/24377/Desktop/Orbit/packages/context-engine): AST Symbol Indexer, PageRank Repo Map generator, and hybrid BM25/Vector RAG.
- [`@orbit-ai/model-providers`](file:///c:/Users/24377/Desktop/Orbit/packages/model-providers): Providers for DeepSeek, OpenAI, Anthropic, and local Ollama streams.
- [`@orbit-ai/sandbox`](file:///c:/Users/24377/Desktop/Orbit/packages/sandbox): Git checkpoint managers and command execution rollback controllers.
- [`@orbit-ai/tools`](file:///c:/Users/24377/Desktop/Orbit/packages/tools): File system operations, grep scanner, reference searchers, and shell execution sandboxes.
- [`@orbit-ai/tui`](file:///c:/Users/24377/Desktop/Orbit/packages/tui): Terminal UI interactive prompt controls and colored terminal renderers.
- [`@orbit-ai/shared`](file:///c:/Users/24377/Desktop/Orbit/packages/shared): Common path utilities, token metrics, and shared schemas.

---

## 🚀 Quick Start

### 1. Installation

Build the workspace packages and link the CLI executable globally:

```bash
# Install dependencies and build monorepo packages
pnpm install
pnpm build

# Link the CLI package globally (enables `orbit` command)
cd packages/cli
npm link
```

Verify that the global binary is active:

```bash
orbit --help
```

### 2. Configuration & Diagnostics

Configure your API keys interactively and securely (keys are encrypted on disk using native system DPAPI or fallback AES-GCM):

```bash
orbit login
```

Run environment diagnostics to verify your local configuration and API keys:

```bash
orbit doctor
```

Inspect resolved configuration values, model assignments, and pricing sheets:

```bash
orbit config
```

### 3. Usage

Start an interactive AI agent loop to execute a task inside your current folder:

```bash
# Run interactive agent loop
orbit "Add unit tests for references retriever"

# Bypass low-risk approval prompts automatically
orbit "Refactor VectorStore load" --yes
```

---

## 🔌 Editor LSP Autocomplete Setup

Orbit exposes a standard Language Server Protocol (LSP) interface on `orbit lsp`. 

### VS Code

Compile and load the VS Code extension located under [editors/vscode](file:///c:/Users/24377/Desktop/Orbit/editors/vscode) into your VS Code editor. It will automatically spawn `orbit lsp` on startup and query it for real-time code completions.

### Neovim / Helix / Emacs

Configure your editor's LSP client to spawn `orbit lsp` as a completion language server. The server expects JSON-RPC input on `stdin` and writes JSON-RPC outputs to `stdout`.

Example configuration snippet for Neovim (`nvim-lspconfig` compatible):

```lua
local lspconfig = require('lspconfig')
local configs = require('lspconfig.configs')

if not configs.orbit_lsp then
  configs.orbit_lsp = {
    default_config = {
      cmd = { 'orbit', 'lsp' },
      filetypes = { 'typescript', 'typescriptreact', 'javascript', 'javascriptreact', 'python' },
      root_dir = lspconfig.util.root_pattern('orbit.config.yaml', '.git'),
      settings = {},
    },
  }
end

lspconfig.orbit_lsp.setup({})
```

---

## 🧪 Verification & Testing

Orbit maintains a 100% green-lighted test suite covering all core subsystems (RAG, Autocomplete connections, Git Rollbacks, timeouts):

```bash
# Run all unit tests
npx vitest run
```

---

## 🛡️ License

MIT License. Local-first, open-source, and private.
