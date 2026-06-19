import { z } from 'zod';
import { OrbitTool, ToolContext, ToolResult } from '../types.js';

export const WebSearchInputSchema = z.object({
  query: z.string(),
});

export type WebSearchInput = z.infer<typeof WebSearchInputSchema>;

export class WebSearchTool implements OrbitTool<WebSearchInput, string> {
  name = 'web_search';
  description = 'Search the web using DuckDuckGo to find documentation, API usage, or code examples.';
  inputSchema = WebSearchInputSchema;
  risk = 'network' as const;

  async execute(input: WebSearchInput, ctx: ToolContext): Promise<ToolResult<string>> {
    try {
      const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(input.query)}`;
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36'
        }
      });

      if (!response.ok) {
        return {
          ok: false,
          error: `DuckDuckGo search request failed with status ${response.status}: ${response.statusText}`,
        };
      }

      const html = await response.text();

      const cleanText = (str: string) => {
        return str
          .replace(/<[^>]*>/g, '')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/&#x27;/g, "'")
          .replace(/\s+/g, ' ')
          .trim();
      };

      const results: { title: string; link: string; snippet: string }[] = [];
      const resultBlockRegex = /<div class="result__body">([\s\S]*?)<\/div>/g;

      let match;
      while ((match = resultBlockRegex.exec(html)) !== null && results.length < 5) {
        const block = match[1];

        const linkMatch = /<a class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(block);
        if (!linkMatch) continue;

        let link = linkMatch[1];
        if (link.startsWith('//')) {
          link = 'https:' + link;
        }
        if (link.includes('uddg=')) {
          const parts = link.split('uddg=');
          if (parts[1]) {
            link = decodeURIComponent(parts[1].split('&')[0]);
          }
        }

        const title = cleanText(linkMatch[2]);

        const snippetMatch = /<(?:a|span|div) class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|span|div)>/.exec(block);
        const snippet = snippetMatch ? cleanText(snippetMatch[1]) : '';

        results.push({ title, link, snippet });
      }

      if (results.length === 0) {
        const fallbackRegex = /<a href="([^"]+)"[^>]*class="result__a"[^>]*>([\s\S]*?)<\/a>/g;
        while ((match = fallbackRegex.exec(html)) !== null && results.length < 5) {
          let link = match[1];
          if (link.includes('uddg=')) {
            const parts = link.split('uddg=');
            if (parts[1]) {
              link = decodeURIComponent(parts[1].split('&')[0]);
            }
          }
          const title = cleanText(match[2]);
          results.push({ title, link, snippet: '' });
        }
      }

      if (results.length === 0) {
        return {
          ok: true,
          data: 'No search results found.',
          display: 'Search returned 0 results.',
        };
      }

      const formatted = results
        .map((r, i) => `[${i + 1}] Title: ${r.title}\n    Link: ${r.link}\n    Summary: ${r.snippet}`)
        .join('\n\n');

      return {
        ok: true,
        data: formatted,
        display: `Web search returned ${results.length} results.`,
      };
    } catch (e: any) {
      return {
        ok: false,
        error: `Search error: ${e.message}`,
      };
    }
  }
}
