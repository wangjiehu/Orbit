import { afterEach, describe, it, expect, vi } from "vitest";
import { WebSearchTool } from "./search.js";

describe("WebSearchTool", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("should scrape search results from mock HTML response", async () => {
    const mockHtml = `
      <html>
        <body>
          <div class="links_main links_deep result__body">
            <a class="result__a" href="https://example.com/test-result">Test Page Title</a>
            <span class="result__snippet">This is a description snippet of the test result.</span>
            <div class="clear"></div>
          </div>
        </body>
      </html>
    `;

    global.fetch = async () => {
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        text: async () => mockHtml,
      } as any;
    };

    const tool = new WebSearchTool();
    const res = await tool.execute(
      { query: "test query" },
      { cwd: process.cwd(), sessionId: "test" },
    );
    expect(res.ok).toBe(true);
    expect(res.data).toContain("https://example.com/test-result");
    expect(res.data).toContain("Test Page Title");
    expect(res.data).toContain(
      "This is a description snippet of the test result.",
    );
  });

  it("uses configured SearXNG JSON endpoint before HTML fallbacks", async () => {
    const fetchMock = vi.fn(async () => {
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        text: async () =>
          JSON.stringify({
            results: [
              {
                title: "DeepSeek API Docs",
                url: "https://api-docs.deepseek.com/",
                content: "Official DeepSeek API documentation.",
              },
            ],
          }),
      } as any;
    });
    global.fetch = fetchMock as any;

    const tool = new WebSearchTool();
    const res = await tool.execute(
      { query: "deepseek api docs", maxResults: 3 },
      {
        cwd: process.cwd(),
        sessionId: "test",
        config: {
          tools: {
            webSearch: {
              enabled: true,
              provider: "searxng",
              searxngUrls: ["https://search.local"],
              tavilyApiKeyEnv: "TAVILY_API_KEY",
              tavilyBaseUrl: "https://api.tavily.com/search",
              timeoutMs: 8000,
              maxResults: 5,
            },
          },
        } as any,
      },
    );

    expect(res.ok).toBe(true);
    expect(res.data).toContain("DeepSeek API Docs");
    expect(fetchMock.mock.calls[0][0]).toContain(
      "https://search.local/search?",
    );
    expect(fetchMock.mock.calls[0][0]).toContain("format=json");
  });

  it("decodes Bing redirect links into direct result URLs", async () => {
    const targetUrl = "https://api-docs.deepseek.com/guides/kv_cache";
    const redirectPayload = "a1" + Buffer.from(targetUrl).toString("base64url");
    global.fetch = vi.fn(async () => {
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        text: async () => `
          <ol>
            <li class="b_algo">
              <h2><a href="https://www.bing.com/ck/a?u=${redirectPayload}">DeepSeek Context Caching</a></h2>
              <p>DeepSeek context caching guide.</p>
            </li>
          </ol>
        `,
      } as any;
    }) as any;

    const tool = new WebSearchTool();
    const res = await tool.execute(
      { query: "deepseek context caching", maxResults: 1 },
      {
        cwd: process.cwd(),
        sessionId: "test",
        config: {
          tools: {
            webSearch: {
              enabled: true,
              provider: "bing",
              searxngUrls: [],
              tavilyApiKeyEnv: "TAVILY_API_KEY",
              tavilyBaseUrl: "https://api.tavily.com/search",
              timeoutMs: 8000,
              maxResults: 5,
            },
          },
        } as any,
      },
    );

    expect(res.ok).toBe(true);
    expect(res.data).toContain(targetUrl);
    expect(res.data).not.toContain("bing.com/ck/a");
  });

  it("returns structured Open-Meteo data for weather queries before generic search", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("geocoding-api.open-meteo.com")) {
        return {
          status: 200,
          statusText: "OK",
          text: async () =>
            JSON.stringify({
              results: [
                {
                  name: "杭州",
                  admin1: "浙江省",
                  country: "中国",
                  latitude: 30.29365,
                  longitude: 120.16142,
                  timezone: "Asia/Shanghai",
                },
              ],
            }),
        } as any;
      }

      if (url.includes("api.open-meteo.com/v1/forecast")) {
        return {
          status: 200,
          statusText: "OK",
          text: async () =>
            JSON.stringify({
              timezone: "Asia/Shanghai",
              daily_units: {
                temperature_2m_max: "°C",
                temperature_2m_min: "°C",
                precipitation_sum: "mm",
              },
              daily: {
                time: ["2026-06-29"],
                weather_code: [61],
                temperature_2m_max: [29.1],
                temperature_2m_min: [24.3],
                precipitation_sum: [12.4],
              },
            }),
        } as any;
      }

      throw new Error(`unexpected url ${url}`);
    });
    global.fetch = fetchMock as any;

    const tool = new WebSearchTool();
    const res = await tool.execute(
      { query: "杭州天气 2026/6/29", maxResults: 5 },
      {
        cwd: process.cwd(),
        sessionId: "test",
        config: {
          tools: {
            webSearch: {
              enabled: true,
              provider: "bing",
              searxngUrls: [],
              tavilyApiKeyEnv: "TAVILY_API_KEY",
              tavilyBaseUrl: "https://api.tavily.com/search",
              timeoutMs: 8000,
              maxResults: 5,
            },
          },
        } as any,
      },
    );

    expect(res.ok).toBe(true);
    expect(res.display).toContain("Open-Meteo");
    expect(res.data).toContain("Source: Open-Meteo weather API");
    expect(res.data).toContain("Location: 杭州, 浙江省, 中国");
    expect(res.data).toContain("2026-06-29");
    expect(res.data).toContain("小雨");
    expect(String(fetchMock.mock.calls[1][0])).toContain(
      "start_date=2026-06-29",
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("includes current Open-Meteo conditions for today's weather queries", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-30T02:00:00+08:00"));

    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("geocoding-api.open-meteo.com")) {
        return {
          status: 200,
          statusText: "OK",
          text: async () =>
            JSON.stringify({
              results: [
                {
                  name: "杭州",
                  country: "中国",
                  latitude: 30.29365,
                  longitude: 120.16142,
                  timezone: "Asia/Shanghai",
                },
              ],
            }),
        } as any;
      }

      return {
        status: 200,
        statusText: "OK",
        text: async () =>
          JSON.stringify({
            timezone: "Asia/Shanghai",
            current_units: {
              temperature_2m: "°C",
              apparent_temperature: "°C",
              relative_humidity_2m: "%",
              wind_speed_10m: "km/h",
              precipitation: "mm",
              rain: "mm",
            },
            current: {
              time: "2026-06-30T02:00",
              temperature_2m: 25.2,
              apparent_temperature: 31.4,
              relative_humidity_2m: 99,
              precipitation: 0.2,
              rain: 0.1,
              weather_code: 95,
              wind_speed_10m: 3.3,
            },
            daily_units: {
              temperature_2m_max: "°C",
              temperature_2m_min: "°C",
              precipitation_sum: "mm",
            },
            daily: {
              time: ["2026-06-30"],
              weather_code: [95],
              temperature_2m_max: [28.2],
              temperature_2m_min: [24.7],
              precipitation_sum: [33.5],
            },
          }),
      } as any;
    });
    global.fetch = fetchMock as any;

    const tool = new WebSearchTool();
    const res = await tool.execute(
      { query: "杭州今天天气", maxResults: 5 },
      { cwd: process.cwd(), sessionId: "test" },
    );

    expect(res.ok).toBe(true);
    expect(res.data).toContain("Current: 2026-06-30T02:00");
    expect(res.data).toContain("temperature 25.2 °C");
    expect(res.data).toContain("Daily weather:");
    expect(String(fetchMock.mock.calls[1][0])).toContain("current=");
    expect(String(fetchMock.mock.calls[1][0])).toContain(
      "start_date=2026-06-30",
    );
  });

  it("passes the full 20-result cap to configured search providers", async () => {
    const previousApiKey = process.env.TEST_TAVILY_API_KEY;
    process.env.TEST_TAVILY_API_KEY = "test-key";
    const fetchMock = vi.fn(async () => {
      return {
        status: 200,
        statusText: "OK",
        text: async () =>
          JSON.stringify({
            results: [
              {
                title: "Result",
                url: "https://example.com/result",
                content: "Result summary",
              },
            ],
          }),
      } as any;
    });
    global.fetch = fetchMock as any;

    try {
      const tool = new WebSearchTool();
      const res = await tool.execute(
        { query: "deepseek api docs", maxResults: 20 },
        {
          cwd: process.cwd(),
          sessionId: "test",
          config: {
            tools: {
              webSearch: {
                enabled: true,
                provider: "tavily",
                searxngUrls: [],
                tavilyApiKeyEnv: "TEST_TAVILY_API_KEY",
                tavilyBaseUrl: "https://api.tavily.com/search",
                timeoutMs: 8000,
                maxResults: 8,
              },
            },
          } as any,
        },
      );

      const requestInit = fetchMock.mock.calls[0][1] as RequestInit;
      expect(res.ok).toBe(true);
      expect(JSON.parse(String(requestInit.body)).max_results).toBe(20);
    } finally {
      if (previousApiKey === undefined) {
        delete process.env.TEST_TAVILY_API_KEY;
      } else {
        process.env.TEST_TAVILY_API_KEY = previousApiKey;
      }
    }
  });

  it("runs auto fallback HTML providers concurrently after configured providers", async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      calls.push(url);
      if (url.includes("127.0.0.1") || url.includes("localhost")) {
        return {
          status: 200,
          statusText: "OK",
          text: async () => JSON.stringify({ results: [] }),
        } as any;
      }
      if (url.includes("bing.com")) {
        return {
          status: 200,
          statusText: "OK",
          text: async () => `
            <ol>
              <li class="b_algo">
                <h2><a href="https://example.com/bing">Bing Result</a></h2>
                <p>Bing summary.</p>
              </li>
            </ol>
          `,
        } as any;
      }
      return {
        status: 200,
        statusText: "OK",
        text: async () => "",
      } as any;
    });
    global.fetch = fetchMock as any;

    const tool = new WebSearchTool();
    const res = await tool.execute(
      { query: "deepseek context caching", maxResults: 3 },
      {
        cwd: process.cwd(),
        sessionId: "test",
        config: {
          tools: {
            webSearch: {
              enabled: true,
              provider: "auto",
              searxngUrls: [],
              tavilyApiKeyEnv: "NO_TAVILY_KEY",
              tavilyBaseUrl: "https://api.tavily.com/search",
              timeoutMs: 8000,
              maxResults: 5,
            },
          },
        } as any,
      },
    );

    expect(res.ok).toBe(true);
    expect(res.data).toContain("Bing Result");
    expect(calls.some((url) => url.includes("127.0.0.1"))).toBe(true);
    expect(calls.some((url) => url.includes("bing.com"))).toBe(true);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
  });
});
