# Orbit

Orbit is a local AI coding agent runtime for your terminal.

## Features
- DeepSeek-first
- Multi-provider model support
- Claude Code-like terminal workflow
- Safe file editing
- Bash command permission control
- Git diff and rollback
- Project context indexing
- Session history
- MCP-ready architecture

## Install

```bash
npm install -g @orbit-ai/cli
```

## Quick Start

```bash
cd your-project
orbit
```

## Configure DeepSeek

```bash
export ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic
export ANTHROPIC_AUTH_TOKEN=your_api_key
export ANTHROPIC_MODEL=deepseek-v4-pro[1m]

orbit
```

## Safety

Orbit protects sensitive files, asks before edits, blocks dangerous commands, and records every change.
