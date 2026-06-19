import { DetectProjectTool, ProjectIndex } from '@orbit-ai/tools';

export class ProjectIndexer {
  constructor(private cwd: string) {}

  public async index(): Promise<ProjectIndex> {
    const tool = new DetectProjectTool();
    const result = await tool.execute(undefined, { cwd: this.cwd, sessionId: 'indexer' });
    if (result.ok && result.data) {
      return result.data;
    }
    throw new Error(result.error || 'Failed to index project');
  }
}
