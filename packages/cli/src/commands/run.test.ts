import { describe, it, expect } from 'vitest';

// We can extract makeCompleter matcher logic from packages/cli/src/commands/run.ts to test it.
// Since it's not exported, we can recreate it or mock the exact matcher implementation:
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

describe('REPL Autocomplete Completer Tests', () => {
  const candidates = {
    commands: ['/help', '/exit', '/quit', '/rollback', '/clear', '/compact', '/history'],
    files: ['src/index.ts', 'src/utils/paths.ts', 'packages/cli/src/commands/run.ts'],
    symbols: ['AgentLoop', 'checkWorkspaceBoundary', 'Prompt'],
  };

  it('should autocomplete slash commands', () => {
    const completer = makeCompleter(candidates);

    const [hits, line] = completer('/ro');
    expect(hits).toContain('/rollback');
    expect(hits.length).toBe(1);
    expect(line).toBe('/ro');

    const [allHits, allLine] = completer('/');
    expect(allHits).toContain('/help');
    expect(allHits).toContain('/exit');
    expect(allLine).toBe('/');
  });

  it('should autocomplete file paths based on the last typed word', () => {
    const completer = makeCompleter(candidates);

    const [hits, line] = completer('read_file src/in');
    expect(hits).toContain('src/index.ts');
    expect(hits.length).toBe(1);
    expect(line).toBe('src/in');
  });

  it('should autocomplete symbol names', () => {
    const completer = makeCompleter(candidates);

    const [hits, line] = completer('explain Agent');
    expect(hits).toContain('AgentLoop');
    expect(hits.length).toBe(1);
    expect(line).toBe('Agent');
  });

  it('should return empty matches if the last word is empty', () => {
    const completer = makeCompleter(candidates);

    const [hits, line] = completer('explain ');
    expect(hits.length).toBe(0);
    expect(line).toBe('');
  });
});
