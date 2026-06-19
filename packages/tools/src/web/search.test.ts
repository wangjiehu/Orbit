import { describe, it, expect } from 'vitest';
import { WebSearchTool } from './search.js';

describe('WebSearchTool', () => {
  it('should scrape search results from mock HTML response', async () => {
    const mockHtml = `
      <html>
        <body>
          <div class="result__body">
            <a class="result__a" href="https://example.com/test-result">Test Page Title</a>
            <span class="result__snippet">This is a description snippet of the test result.</span>
          </div>
        </body>
      </html>
    `;

    const originalFetch = global.fetch;
    global.fetch = async () => {
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => mockHtml,
      } as any;
    };

    try {
      const tool = new WebSearchTool();
      const res = await tool.execute({ query: 'test query' }, { cwd: process.cwd(), sessionId: 'test' });
      expect(res.ok).toBe(true);
      expect(res.data).toContain('https://example.com/test-result');
      expect(res.data).toContain('Test Page Title');
      expect(res.data).toContain('This is a description snippet of the test result.');
    } finally {
      global.fetch = originalFetch;
    }
  });
});
