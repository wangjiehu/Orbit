import { z } from "zod";
import { OrbitTool, ToolContext, ToolResult } from "../types.js";

export const WebSearchInputSchema = z.object({
  query: z
    .string()
    .describe(
      "Search query. Resolve relative dates using the Runtime Context current date before adding date terms; do not add stale years from model memory.",
    ),
  maxResults: z.number().int().min(1).max(20).optional(),
});

export type WebSearchInput = z.infer<typeof WebSearchInputSchema>;

interface SearchResult {
  title: string;
  link: string;
  snippet: string;
}

interface SearchStrategy {
  name: string;
  url: string;
  method?: "GET" | "POST";
  userAgent?: string;
  headers?: Record<string, string>;
  body?: string;
  parser: (body: string) => SearchResult[];
  timeoutMs: number;
}

interface OpenMeteoLocation {
  name?: string;
  country?: string;
  admin1?: string;
  latitude?: number;
  longitude?: number;
  timezone?: string;
}

interface OpenMeteoGeocodingResponse {
  results?: OpenMeteoLocation[];
}

interface OpenMeteoForecastResponse {
  current?: Record<string, string | number | null>;
  current_units?: Record<string, string>;
  daily?: Record<string, Array<string | number | null>>;
  daily_units?: Record<string, string>;
  timezone?: string;
}

export class WebSearchTool implements OrbitTool<WebSearchInput, string> {
  name = "web_search";
  description =
    "Search the live web for current documentation, API usage, technical references, weather, or news. Resolve today/tomorrow/yesterday/latest against the Runtime Context date before forming the query. Weather queries use a direct no-key Open-Meteo data source first, then configured SearXNG/Tavily/Bing/DuckDuckGo backends as fallback.";
  inputSchema = WebSearchInputSchema;
  risk = "network" as const;

  private normalizeBaseUrl(url: string): string {
    return url.replace(/\/+$/, "");
  }

  private envList(...names: string[]): string[] {
    return names
      .flatMap((name) => (process.env[name] || "").split(","))
      .map((value) => value.trim())
      .filter(Boolean);
  }

  private readPositiveInteger(value: unknown): number | undefined {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
    return Math.trunc(parsed);
  }

  private resolveMaxResults(input: WebSearchInput, ctx: ToolContext): number {
    const config = ctx.config?.tools?.webSearch;
    const configured =
      this.readPositiveInteger(input.maxResults) ??
      this.readPositiveInteger(process.env.ORBIT_WEB_SEARCH_MAX_RESULTS) ??
      this.readPositiveInteger(config?.maxResults) ??
      5;
    return Math.max(1, Math.min(20, configured));
  }

  private resolveTimeoutMs(ctx: ToolContext): number {
    const config = ctx.config?.tools?.webSearch;
    const configured =
      this.readPositiveInteger(process.env.ORBIT_WEB_SEARCH_TIMEOUT_MS) ??
      this.readPositiveInteger(config?.timeoutMs) ??
      8000;
    return Math.max(1000, Math.min(30000, configured));
  }

  private limitResults(results: SearchResult[], maxResults: number) {
    const seen = new Set<string>();
    const deduped: SearchResult[] = [];
    for (const result of results) {
      if (!result.link || seen.has(result.link)) continue;
      seen.add(result.link);
      deduped.push(result);
      if (deduped.length >= maxResults) break;
    }
    return deduped;
  }

  private isWeatherQuery(query: string): boolean {
    return /(?:天气|气温|温度|预报|降雨|下雨|小雨|中雨|大雨|weather|forecast|temperature|rain|precipitation)/i.test(
      query,
    );
  }

  private extractWeatherLocation(query: string): string {
    const cleaned = query
      .replace(/site:\S+/gi, " ")
      .replace(/https?:\/\/\S+/gi, " ")
      .replace(
        /\b\d{4}\s*[-/.年]\s*\d{1,2}\s*(?:[-/.月]\s*)\d{1,2}\s*(?:日|号)?\b/g,
        " ",
      )
      .replace(
        /\b(?:today|tomorrow|yesterday|now|current|weather|forecast|temperature|temp|rain|raining|precipitation|in|for|on|the|please|check|search|query)\b/gi,
        " ",
      )
      .replace(
        /(?:今天|今日|明天|后天|昨天|现在|当前|实时|天气|气温|温度|预报|降雨|下雨|小雨|中雨|大雨|暴雨|查询|查查|看看|帮我|一下|的|多少|怎么样|如何)/g,
        " ",
      )
      .replace(/[?？,，。.;；:：()[\]{}"'“”‘’]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const tokens = cleaned
      .split(/\s+/)
      .map((token) => token.trim())
      .filter((token) => token.length > 0 && !/^\d+$/.test(token));
    return tokens.slice(0, 3).join(" ") || query.trim();
  }

  private formatDate(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  private addDays(date: Date, days: number): Date {
    const next = new Date(date);
    next.setDate(next.getDate() + days);
    return next;
  }

  private extractRequestedDate(query: string): string | null {
    const normalized = query
      .replace(/[年月]/g, "-")
      .replace(/[日号]/g, "")
      .replace(/\//g, "-");
    const explicit = /(\d{4})\s*[-.]\s*(\d{1,2})\s*[-.]\s*(\d{1,2})/.exec(
      normalized,
    );
    if (explicit) {
      const [, year, month, day] = explicit;
      return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
    }

    const now = new Date();
    if (/(?:今天|今日|\btoday\b|\bnow\b|\bcurrent\b)/i.test(query)) {
      return this.formatDate(now);
    }
    if (/(?:明天|\btomorrow\b)/i.test(query)) {
      return this.formatDate(this.addDays(now, 1));
    }
    if (/(?:后天)/i.test(query)) {
      return this.formatDate(this.addDays(now, 2));
    }
    if (/(?:昨天|\byesterday\b)/i.test(query)) {
      return this.formatDate(this.addDays(now, -1));
    }
    return null;
  }

  private daysBetween(baseDate: string, targetDate: string): number {
    const base = Date.parse(`${baseDate}T00:00:00Z`);
    const target = Date.parse(`${targetDate}T00:00:00Z`);
    if (!Number.isFinite(base) || !Number.isFinite(target)) return 0;
    return Math.round((target - base) / 86400000);
  }

  private numericValue(
    value: string | number | null | undefined,
  ): number | null {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value !== "string") return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  private metric(
    value: string | number | null | undefined,
    unit: string | undefined,
    digits = 1,
  ): string {
    const numeric = this.numericValue(value);
    if (numeric === null) return "n/a";
    return `${numeric.toFixed(digits)}${unit ? ` ${unit}` : ""}`;
  }

  private weatherCodeLabel(code: number | null): string {
    if (code === null) return "unknown";
    const labels: Record<number, string> = {
      0: "晴",
      1: "大部晴朗",
      2: "局部多云",
      3: "阴",
      45: "雾",
      48: "霜雾",
      51: "小毛毛雨",
      53: "中等毛毛雨",
      55: "强毛毛雨",
      56: "小冻毛毛雨",
      57: "强冻毛毛雨",
      61: "小雨",
      63: "中雨",
      65: "大雨",
      66: "小冻雨",
      67: "强冻雨",
      71: "小雪",
      73: "中雪",
      75: "大雪",
      77: "雪粒",
      80: "小阵雨",
      81: "中阵雨",
      82: "强阵雨",
      85: "小阵雪",
      86: "强阵雪",
      95: "雷暴",
      96: "雷暴伴小冰雹",
      99: "雷暴伴强冰雹",
    };
    return labels[code] || `天气代码 ${code}`;
  }

  private locationLabel(location: OpenMeteoLocation): string {
    const parts = [location.name, location.admin1, location.country]
      .map((part) => (part || "").trim())
      .filter(Boolean);
    return parts.join(", ") || "unknown location";
  }

  private async fetchJson<T>(
    url: URL,
    ctx: ToolContext,
    timeoutMs: number,
  ): Promise<T> {
    const timeout = this.makeTimeoutSignal(ctx.abortSignal, timeoutMs);
    try {
      const response = await fetch(url.toString(), {
        headers: {
          "User-Agent": "Orbit/0.1 (+https://github.com/orbit-build/orbit)",
        },
        signal: timeout.signal,
      });
      if (response.status !== 200) {
        throw new Error(`status ${response.status}: ${response.statusText}`);
      }
      return JSON.parse(await response.text()) as T;
    } finally {
      timeout.cleanup();
    }
  }

  private formatWeatherData(
    location: OpenMeteoLocation,
    forecast: OpenMeteoForecastResponse,
    requestedDate: string | null,
    maxResults: number,
  ): string | null {
    const label = this.locationLabel(location);
    const lines = [
      "Source: Open-Meteo weather API",
      `Location: ${label} (${this.metric(location.latitude, undefined, 4)}, ${this.metric(location.longitude, undefined, 4)})`,
      `Timezone: ${forecast.timezone || location.timezone || "auto"}`,
    ];

    const current = forecast.current;
    const currentTime = String(current?.time || "");
    if (
      current &&
      (!requestedDate || currentTime.startsWith(`${requestedDate}T`))
    ) {
      const currentUnits = forecast.current_units || {};
      const code = this.numericValue(current.weather_code);
      lines.push(
        `Current: ${String(current.time || "unknown")}; ${this.weatherCodeLabel(code)}; temperature ${this.metric(current.temperature_2m, currentUnits.temperature_2m)}; feels like ${this.metric(current.apparent_temperature, currentUnits.apparent_temperature)}; humidity ${this.metric(current.relative_humidity_2m, currentUnits.relative_humidity_2m, 0)}; wind ${this.metric(current.wind_speed_10m, currentUnits.wind_speed_10m)}; precipitation ${this.metric(current.precipitation, currentUnits.precipitation, 2)}; rain ${this.metric(current.rain, currentUnits.rain, 2)}`,
      );
    }

    const daily = forecast.daily;
    const dates = daily?.time || [];
    if (daily && dates.length > 0) {
      const dailyUnits = forecast.daily_units || {};
      const dateLimit = requestedDate
        ? dates.length
        : Math.min(dates.length, Math.max(1, Math.min(7, maxResults)));
      lines.push(requestedDate ? "Daily weather:" : "Daily forecast:");
      for (let i = 0; i < dateLimit; i++) {
        const date = String(dates[i] || "");
        if (requestedDate && date !== requestedDate) continue;
        const code = this.numericValue(daily.weather_code?.[i]);
        lines.push(
          `- ${date}: ${this.weatherCodeLabel(code)}; high ${this.metric(daily.temperature_2m_max?.[i], dailyUnits.temperature_2m_max)}; low ${this.metric(daily.temperature_2m_min?.[i], dailyUnits.temperature_2m_min)}; precipitation ${this.metric(daily.precipitation_sum?.[i], dailyUnits.precipitation_sum, 2)}`,
        );
      }
    }

    return lines.length > 3 ? lines.join("\n") : null;
  }

  private async tryOpenMeteoWeather(
    input: WebSearchInput,
    ctx: ToolContext,
    maxResults: number,
  ): Promise<ToolResult<string> | null> {
    if (
      process.env.ORBIT_DISABLE_OPEN_METEO === "1" ||
      !this.isWeatherQuery(input.query)
    ) {
      return null;
    }

    const locationQuery = this.extractWeatherLocation(input.query);
    if (!locationQuery) return null;

    try {
      const timeoutMs = Math.min(this.resolveTimeoutMs(ctx), 10000);
      const geocodeUrl = new URL(
        "https://geocoding-api.open-meteo.com/v1/search",
      );
      geocodeUrl.searchParams.set("name", locationQuery);
      geocodeUrl.searchParams.set("count", "1");
      geocodeUrl.searchParams.set("language", "zh");
      geocodeUrl.searchParams.set("format", "json");
      const geocode = await this.fetchJson<OpenMeteoGeocodingResponse>(
        geocodeUrl,
        ctx,
        timeoutMs,
      );
      const location = geocode.results?.find(
        (item) =>
          typeof item.latitude === "number" &&
          typeof item.longitude === "number",
      );
      if (
        !location ||
        location.latitude === undefined ||
        location.longitude === undefined
      ) {
        return null;
      }

      const requestedDate = this.extractRequestedDate(input.query);
      const today = this.formatDate(new Date());
      const requestedOffset = requestedDate
        ? this.daysBetween(today, requestedDate)
        : 0;
      const useArchive = requestedDate !== null && requestedOffset < -7;
      const forecastUrl = new URL(
        useArchive
          ? "https://archive-api.open-meteo.com/v1/archive"
          : "https://api.open-meteo.com/v1/forecast",
      );
      forecastUrl.searchParams.set("latitude", String(location.latitude));
      forecastUrl.searchParams.set("longitude", String(location.longitude));
      forecastUrl.searchParams.set(
        "daily",
        "weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum",
      );
      forecastUrl.searchParams.set("timezone", location.timezone || "auto");
      const includeCurrent = !requestedDate || requestedDate === today;
      if (requestedDate) {
        forecastUrl.searchParams.set("start_date", requestedDate);
        forecastUrl.searchParams.set("end_date", requestedDate);
      }
      if (includeCurrent) {
        forecastUrl.searchParams.set(
          "current",
          "temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,rain,weather_code,wind_speed_10m",
        );
      }
      if (!requestedDate) {
        forecastUrl.searchParams.set(
          "forecast_days",
          String(Math.min(7, Math.max(1, Math.min(3, maxResults)))),
        );
      }

      const forecast = await this.fetchJson<OpenMeteoForecastResponse>(
        forecastUrl,
        ctx,
        timeoutMs,
      );
      const formatted = this.formatWeatherData(
        location,
        forecast,
        requestedDate,
        maxResults,
      );
      if (!formatted) return null;

      const dateSuffix = requestedDate ? ` for ${requestedDate}` : "";
      return {
        ok: true,
        data: formatted,
        display: `Weather data returned for ${this.locationLabel(location)}${dateSuffix} via Open-Meteo.`,
      };
    } catch {
      return null;
    }
  }

  private decodeBingRedirectUrl(link: string): string {
    const cleaned = link.replace(/&amp;/g, "&");
    try {
      const url = new URL(cleaned);
      const encodedTarget = url.searchParams.get("u");
      if (!encodedTarget) return cleaned;
      const payload = encodedTarget.startsWith("a1")
        ? encodedTarget.slice(2)
        : encodedTarget;
      const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
      const decoded = Buffer.from(normalized, "base64").toString("utf8");
      return decoded.startsWith("http") ? decoded : cleaned;
    } catch {
      return cleaned;
    }
  }

  private cleanText(str: string): string {
    return str
      .replace(/<[^>]*>/g, "")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#x27;/g, "'")
      .replace(/\s+/g, " ")
      .trim();
  }

  private parseHtmlResults(html: string): SearchResult[] {
    const results: SearchResult[] = [];
    const resultBlockRegex =
      /<div class="[^"]*result__body[^"]*">([\s\S]*?)<div class="clear"><\/div>/g;

    let match;
    while ((match = resultBlockRegex.exec(html)) !== null) {
      const block = match[1];

      const anchorRegex =
        /<a\s+[^>]*class="[^"]*result__a[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
      const anchorMatch = anchorRegex.exec(block);
      if (!anchorMatch) continue;

      const anchorTag = anchorMatch[0];
      const titleText = anchorMatch[1];

      const hrefMatch = /href="([^"]+)"/i.exec(anchorTag);
      if (!hrefMatch) continue;

      let link = hrefMatch[1];
      if (link.startsWith("//")) {
        link = "https:" + link;
      }
      if (link.includes("uddg=")) {
        const parts = link.split("uddg=");
        if (parts[1]) {
          link = decodeURIComponent(parts[1].split("&")[0]);
        }
      }

      const title = this.cleanText(titleText);

      const snippetRegex =
        /<(?:a|span|div)\s+[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|span|div)>/gi;
      const snippetMatch = snippetRegex.exec(block);
      const snippet = snippetMatch ? this.cleanText(snippetMatch[1]) : "";

      if (
        link.includes("y.js") ||
        link.includes("/y.js") ||
        link.includes("ad_provider=")
      ) {
        continue;
      }

      results.push({ title, link, snippet });
    }

    if (results.length === 0) {
      const fallbackRegex =
        /<a\s+[^>]*class="[^"]*result__a[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
      while ((match = fallbackRegex.exec(html)) !== null) {
        const anchorTag = match[0];
        const titleText = match[1];
        const hrefMatch = /href="([^"]+)"/i.exec(anchorTag);
        if (!hrefMatch) continue;

        let link = hrefMatch[1];
        if (link.startsWith("//")) {
          link = "https:" + link;
        }
        if (link.includes("uddg=")) {
          const parts = link.split("uddg=");
          if (parts[1]) {
            link = decodeURIComponent(parts[1].split("&")[0]);
          }
        }
        const title = this.cleanText(titleText);

        if (
          link.includes("y.js") ||
          link.includes("/y.js") ||
          link.includes("ad_provider=")
        ) {
          continue;
        }

        results.push({ title, link, snippet: "" });
      }
    }

    return results;
  }

  private parseLiteResults(html: string): SearchResult[] {
    const results: SearchResult[] = [];
    const regex =
      /(\d+)\.&nbsp;\s*<\/td>\s*<td>\s*(<a\s+[^>]*class=['"]result-link['"][^>]*>([\s\S]*?)<\/a>)/gi;

    let match;
    while ((match = regex.exec(html)) !== null) {
      const anchorTag = match[2];
      const titleText = match[3];

      const hrefMatch =
        /href="([^"]+)"/i.exec(anchorTag) || /href='([^']+)'/i.exec(anchorTag);
      if (!hrefMatch) continue;

      let link = hrefMatch[1];
      if (link.startsWith("//")) {
        link = "https:" + link;
      }
      if (link.includes("uddg=")) {
        const parts = link.split("uddg=");
        if (parts[1]) {
          link = decodeURIComponent(parts[1].split("&")[0]);
        }
      }

      const title = this.cleanText(titleText);

      const subHtml = html.substring(match.index, match.index + 2000);
      const snippetMatch =
        /<td\s+[^>]*class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/i.exec(
          subHtml,
        );
      const snippet = snippetMatch ? this.cleanText(snippetMatch[1]) : "";

      if (
        link.includes("y.js") ||
        link.includes("/y.js") ||
        link.includes("ad_provider=")
      ) {
        continue;
      }

      results.push({ title, link, snippet });
    }

    return results;
  }

  private parseBingResults(html: string): SearchResult[] {
    const results: SearchResult[] = [];
    const blockRegex = /<li\s+class="b_algo"[\s\S]*?<\/li>/gi;
    let match;
    while ((match = blockRegex.exec(html)) !== null) {
      const block = match[0];
      const anchorMatch =
        /<h2[^>]*>\s*<a\s+[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<\/h2>/i.exec(
          block,
        );
      if (!anchorMatch) continue;
      const snippetMatch = /<p[^>]*>([\s\S]*?)<\/p>/i.exec(block);
      const link = this.decodeBingRedirectUrl(anchorMatch[1]);
      if (!link.startsWith("http")) continue;
      results.push({
        title: this.cleanText(anchorMatch[2]),
        link,
        snippet: snippetMatch ? this.cleanText(snippetMatch[1]) : "",
      });
    }
    return results;
  }

  private parseSearxngResults(body: string): SearchResult[] {
    const data = JSON.parse(body);
    const rawResults = Array.isArray(data.results) ? data.results : [];
    return rawResults
      .map((result: any) => ({
        title: this.cleanText(result.title || ""),
        link: String(result.url || result.link || ""),
        snippet: this.cleanText(result.content || result.snippet || ""),
      }))
      .filter((result: SearchResult) => result.title && result.link);
  }

  private parseTavilyResults(body: string): SearchResult[] {
    const data = JSON.parse(body);
    const rawResults = Array.isArray(data.results) ? data.results : [];
    return rawResults
      .map((result: any) => ({
        title: this.cleanText(result.title || ""),
        link: String(result.url || ""),
        snippet: this.cleanText(result.content || result.snippet || ""),
      }))
      .filter((result: SearchResult) => result.title && result.link);
  }

  private makeTimeoutSignal(
    parentSignal: AbortSignal | undefined,
    timeoutMs: number,
  ): { signal: AbortSignal; cleanup: () => void } {
    const controller = new AbortController();
    const abort = () => controller.abort();
    const timeoutId = setTimeout(abort, timeoutMs);
    timeoutId.unref?.();
    if (parentSignal) {
      if (parentSignal.aborted) {
        controller.abort();
      } else {
        parentSignal.addEventListener("abort", abort, { once: true });
      }
    }
    return {
      signal: controller.signal,
      cleanup: () => {
        clearTimeout(timeoutId);
        parentSignal?.removeEventListener("abort", abort);
      },
    };
  }

  private buildStrategies(
    input: WebSearchInput,
    ctx: ToolContext,
  ): SearchStrategy[] {
    const query = input.query;
    const config = ctx.config?.tools?.webSearch;
    const provider =
      process.env.ORBIT_WEB_SEARCH_PROVIDER || config?.provider || "auto";
    const timeoutMs = this.resolveTimeoutMs(ctx);
    const maxResults = this.resolveMaxResults(input, ctx);
    const strategies: SearchStrategy[] = [];

    const configuredSearxngUrls = [
      ...(config?.searxngUrls || []),
      ...this.envList("ORBIT_SEARXNG_URL", "SEARXNG_URL"),
    ];
    const localSearxngUrls =
      process.env.ORBIT_DISABLE_LOCAL_SEARXNG === "1"
        ? []
        : ["http://127.0.0.1:8888", "http://localhost:8888"];
    const searxngUrls = [...configuredSearxngUrls, ...localSearxngUrls];

    if (provider === "auto" || provider === "searxng") {
      for (const baseUrl of searxngUrls) {
        const normalized = this.normalizeBaseUrl(baseUrl);
        strategies.push({
          name: `SearXNG (${normalized})`,
          url: `${normalized}/search?q=${encodeURIComponent(query)}&format=json&language=auto&safesearch=0`,
          userAgent: "Orbit/0.1 (+https://github.com/orbit-build/orbit)",
          parser: (body) =>
            this.limitResults(this.parseSearxngResults(body), maxResults),
          timeoutMs: Math.min(timeoutMs, 5000),
        });
      }
    }

    const tavilyApiKeyEnv = config?.tavilyApiKeyEnv || "TAVILY_API_KEY";
    const tavilyApiKey =
      process.env.ORBIT_TAVILY_API_KEY || process.env[tavilyApiKeyEnv];
    const tavilyBaseUrl =
      process.env.ORBIT_TAVILY_API_URL ||
      config?.tavilyBaseUrl ||
      "https://api.tavily.com/search";
    if ((provider === "auto" || provider === "tavily") && tavilyApiKey) {
      strategies.push({
        name: "Tavily",
        url: tavilyBaseUrl,
        method: "POST",
        headers: {
          Authorization: `Bearer ${tavilyApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query,
          max_results: maxResults,
          search_depth: "basic",
          include_answer: false,
          include_raw_content: false,
        }),
        parser: (body) =>
          this.limitResults(this.parseTavilyResults(body), maxResults),
        timeoutMs,
      });
    }

    if (provider === "auto" || provider === "bing") {
      const bingBase =
        process.env.ORBIT_BING_SEARCH_URL || "https://www.bing.com/search";
      strategies.push({
        name: "Bing HTML",
        url: `${bingBase}?q=${encodeURIComponent(query)}&setlang=zh-CN`,
        userAgent:
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        parser: (body) =>
          this.limitResults(this.parseBingResults(body), maxResults),
        timeoutMs,
      });
    }

    if (provider === "auto" || provider === "duckduckgo") {
      const duckHtmlBase =
        process.env.ORBIT_DUCKDUCKGO_HTML_URL ||
        "https://html.duckduckgo.com/html/";
      const duckLiteBase =
        process.env.ORBIT_DUCKDUCKGO_LITE_URL ||
        "https://lite.duckduckgo.com/lite/";
      strategies.push(
        {
          name: "DuckDuckGo HTML",
          url: `${duckHtmlBase}?q=${encodeURIComponent(query)}`,
          userAgent:
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:115.0) Gecko/20100101 Firefox/115.0",
          parser: (body) =>
            this.limitResults(this.parseHtmlResults(body), maxResults),
          timeoutMs,
        },
        {
          name: "DuckDuckGo Lite",
          url: `${duckLiteBase}?q=${encodeURIComponent(query)}`,
          userAgent:
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          parser: (body) =>
            this.limitResults(this.parseLiteResults(body), maxResults),
          timeoutMs,
        },
      );
    }

    return strategies;
  }

  async execute(
    input: WebSearchInput,
    _ctx: ToolContext,
  ): Promise<ToolResult<string>> {
    const maxResults = this.resolveMaxResults(input, _ctx);
    const weatherResult = await this.tryOpenMeteoWeather(
      input,
      _ctx,
      maxResults,
    );
    if (weatherResult) return weatherResult;

    const strategies = this.buildStrategies(input, _ctx);

    const errors: string[] = [];
    if (strategies.length === 0) {
      return {
        ok: false,
        error:
          "No web search backend is available. Configure tools.webSearch.searxngUrls, ORBIT_SEARXNG_URL, TAVILY_API_KEY, or set provider to duckduckgo.",
      };
    }

    for (const strategy of strategies) {
      const timeout = this.makeTimeoutSignal(
        _ctx.abortSignal,
        strategy.timeoutMs,
      );
      try {
        const response = await fetch(strategy.url, {
          method: strategy.method || "GET",
          headers: {
            ...(strategy.userAgent ? { "User-Agent": strategy.userAgent } : {}),
            ...(strategy.headers || {}),
          },
          body: strategy.body,
          signal: timeout.signal,
        });

        if (response.status !== 200) {
          errors.push(
            `${strategy.name} status ${response.status}: ${response.statusText}`,
          );
          continue;
        }

        const body = await response.text();
        const results = strategy.parser(body);

        if (results.length > 0) {
          const formatted = results
            .map(
              (r, i) =>
                `[${i + 1}] Title: ${r.title}\n    Link: ${r.link}\n    Summary: ${r.snippet}`,
            )
            .join("\n\n");

          return {
            ok: true,
            data: formatted,
            display: `Web search returned ${results.length} results via ${strategy.name}.`,
          };
        } else {
          errors.push(`${strategy.name} returned 0 results`);
        }
      } catch (e: any) {
        errors.push(`${strategy.name} error: ${e.message}`);
      } finally {
        timeout.cleanup();
      }
    }

    return {
      ok: false,
      error: `All search strategies failed. Logged errors:\n- ${errors.join("\n- ")}`,
    };
  }
}
