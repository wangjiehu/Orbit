import { join } from 'path';
import { existsSync, readFileSync } from 'fs';
import { estimateTokenCount } from '@orbit-ai/shared';
import { ContextPack } from './types.js';
import { ProjectIndexer } from './ProjectIndexer.js';
import { FileSummarizer } from './FileSummarizer.js';

export class ContextPackBuilder {
  private indexer: ProjectIndexer;
  private summarizer: FileSummarizer;

  constructor(private cwd: string) {
    this.indexer = new ProjectIndexer(cwd);
    this.summarizer = new FileSummarizer(cwd);
  }

  public async build(relevantFiles: Array<{ path: string; reason: string }>): Promise<ContextPack> {
    const projectIndex = await this.indexer.index();
    const projectInstructions = this.loadInstructions();

    const packedFiles = relevantFiles.map((f) => {
      const { summary, excerpt } = this.summarizer.summarize(f.path);
      return {
        path: f.path,
        reason: f.reason,
        summary,
        excerpt,
      };
    });

    const payload = JSON.stringify({ projectIndex, projectInstructions, packedFiles });
    const usedEstimate = estimateTokenCount(payload);

    return {
      projectInstructions,
      projectIndex,
      relevantFiles: packedFiles,
      recentChanges: '',
      currentDiff: '',
      previousErrors: '',
      tokenBudget: {
        max: 128000,
        usedEstimate,
      },
    };
  }

  private loadInstructions(): string {
    const candidates = ['ORBIT.md', 'AGENTS.md', 'CLAUDE.md', 'README.md'];
    for (const name of candidates) {
      const p = join(this.cwd, name);
      if (existsSync(p)) {
        try {
          return readFileSync(p, 'utf8');
        } catch {
          // Ignored
        }
      }
    }
    return '';
  }
}
