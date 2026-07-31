/**
 * Web Search Plugin for pi
 *
 * Registers a `web_search` tool that searches the web via DuckDuckGo Lite.
 * Works out of the box with zero configuration — no API key needed.
 *
 * Optional config file at ~/.pi/agent/web-search.json:
 *   { "maxResults": 10 }
 *
 * Project-local override at .pi/web-search.json works too.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SearchResult {
  title: string;
  url: string;
  description: string;
}

interface SearchDetails {
  query: string;
  resultCount: number;
  results: SearchResult[];
  cached: boolean;
}

interface SearchConfig {
  maxResults: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DDG_URL = "https://lite.duckduckgo.com/lite/";
const DEFAULT_MAX_RESULTS = 10;
const MAX_RESULTS = 20;
const CONFIG_FILE_NAME = "web-search.json";
const MIN_QUERY_LENGTH = 2;
const MAX_QUERY_LENGTH = 256;
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 1000;

// ---------------------------------------------------------------------------
// Configuration loader
// ---------------------------------------------------------------------------

function loadConfig(ctx?: ExtensionContext): SearchConfig {
  const config: SearchConfig = { maxResults: DEFAULT_MAX_RESULTS };

  const globalConfigPath = join(homedir(), ".pi", "agent", CONFIG_FILE_NAME);
  loadConfigFile(globalConfigPath, config);

  if (ctx?.cwd) {
    const projectConfigPath = join(ctx.cwd, ".pi", CONFIG_FILE_NAME);
    loadConfigFile(projectConfigPath, config);
  }

  config.maxResults = Math.min(Math.max(1, config.maxResults), MAX_RESULTS);
  return config;
}

function loadConfigFile(path: string, config: SearchConfig): void {
  if (!existsSync(path)) return;
  try {
    const data = JSON.parse(readFileSync(path, "utf-8"));
    if (typeof data.maxResults === "number") config.maxResults = data.maxResults;
  } catch {
    // Ignore invalid config file
  }
}

// ---------------------------------------------------------------------------
// HTML helpers
// ---------------------------------------------------------------------------

const RE_HTML_TAG = /<[^>]*>/g;

function stripHtml(html: string): string {
  return html
    .replace(RE_HTML_TAG, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/\s+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// Query validation
// ---------------------------------------------------------------------------

interface ValidationResult {
  valid: boolean;
  message?: string;
}

function validateQuery(query: string): ValidationResult {
  if (!query || query.trim().length === 0) {
    return { valid: false, message: "Search query cannot be empty." };
  }
  if (query.trim().length < MIN_QUERY_LENGTH) {
    return { valid: false, message: `Search query is too short (minimum ${MIN_QUERY_LENGTH} characters).` };
  }
  if (query.length > MAX_QUERY_LENGTH) {
    return { valid: false, message: `Search query is too long (maximum ${MAX_QUERY_LENGTH} characters).` };
  }
  return { valid: true };
}

// ---------------------------------------------------------------------------
// DuckDuckGo Lite search
// ---------------------------------------------------------------------------

// DuckDuckGo Lite returns simple tabular HTML:
//   <tr class="result-...">
//     <td>
//       <a href="...">Title</a>
//       <span class="result-snippet">Snippet...</span>
//     </td>
//   </tr>
//
// No CAPTCHAs, no redirects, no API key needed.

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function searchDuckDuckGo(
  query: string,
  count: number,
  signal?: AbortSignal,
): Promise<SearchResult[]> {
  const body = new URLSearchParams({ q: query });

  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (signal?.aborted) throw new Error("Search aborted");

    let response: Response;
    try {
      response = await fetch(DDG_URL, {
        method: "POST",
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; PiAgent/1.0)",
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "text/html",
        },
        body: body.toString(),
        signal,
      });
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < MAX_RETRIES) await sleep(RETRY_DELAY_MS);
      else throw lastError;
      continue;
    }

    if (!response.ok) {
      lastError = new Error(`DuckDuckGo returned HTTP ${response.status} ${response.statusText}`);
      if (response.status === 403 || response.status === 429) {
        if (attempt < MAX_RETRIES) {
          await sleep(RETRY_DELAY_MS * (attempt + 1));
          continue;
        }
      }
      throw lastError;
    }

    const html = await response.text();
    return parseDdgResults(html, count);
  }

  throw lastError ?? new Error("Search failed unexpectedly");
}

function parseDdgResults(html: string, count: number): SearchResult[] {
  const results: SearchResult[] = [];
  const resultBlocks = html.split("<tr");

  for (const block of resultBlocks) {
    if (results.length >= count) break;
    if (!block.includes("result-")) continue;

    // Extract title link
    const linkMatch = block.match(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/);
    if (!linkMatch) continue;

    const url = linkMatch[1]!;
    const title = stripHtml(linkMatch[2]!);
    if (!title || !url) continue;

    // Extract snippet
    const snippetMatch = block.match(/class="result-snippet">([\s\S]*?)<\/td>/);
    const description = snippetMatch ? stripHtml(snippetMatch[1]!) : "";

    results.push({
      title,
      url: url.startsWith("http") ? url : `https://${url.replace(/^\/+/, "")}`,
      description,
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Result formatting
// ---------------------------------------------------------------------------

function formatSearchResults(
  query: string,
  results: SearchResult[],
  cached: boolean,
): string {
  let output = `# Web Search Results for: "${query}"` + "\n\n";

  if (cached) {
    output += "*(cached results from earlier this session)*\n\n";
  }

  if (results.length === 0) {
    output += "No results found.\n";
    return output;
  }

  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    output += `## ${i + 1}. ${r.title}\n`;
    output += `**URL:** ${r.url}\n`;
    output += `${r.description}\n\n`;
  }

  return output;
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  // Per-session result cache to avoid repeated API calls
  let queryCache = new Map<string, { results: SearchResult[]; timestamp: number }>();

  // Reset cache on new session
  pi.on("session_start", async () => {
    queryCache = new Map();
  });

  // Register the web_search tool
  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description:
      "Search the web using DuckDuckGo. No API key required. " +
      "Returns titles, URLs, and descriptions of search results. " +
      "Use this to find current information, documentation, or answer questions about recent events. " +
      `Results are limited to ${MAX_RESULTS} per query. ` +
      "Results are cached per session to avoid duplicate searches.",
    promptSnippet: "web_search(query, count?) - search the web and return results",
    promptGuidelines: [
      "Use web_search to find current information, up-to-date documentation, or answers about recent events.",
      "Use web_search before answering questions about libraries, APIs, or technologies you may not know the latest about.",
      "web_search results are cached per session, so you can call it with the same query without extra cost.",
      "When web_search returns results, cite the URLs in your response so the user knows the source.",
    ],

    parameters: Type.Object({
      query: Type.String({
        description:
          "Search query string. Be specific and include relevant keywords for best results.",
      }),
      count: Type.Optional(
        Type.Number({
          description: `Number of results to return (default: ${DEFAULT_MAX_RESULTS}, max: ${MAX_RESULTS})`,
        }),
      ),
    }),

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      // Validate query
      const validation = validateQuery(params.query);
      if (!validation.valid) {
        return {
          content: [{ type: "text" as const, text: validation.message! }],
          details: {
            query: params.query,
            resultCount: 0,
            results: [],
            cached: false,
          } satisfies SearchDetails,
        };
      }

      const config = loadConfig(ctx);
      const count = Math.max(1, Math.min(params.count ?? config.maxResults, MAX_RESULTS));

      // Check cache
      const cacheKey = `${params.query}|${count}`;
      const cached = queryCache.get(cacheKey);
      if (cached) {
        return {
          content: [
            {
              type: "text" as const,
              text: formatSearchResults(params.query, cached.results, true),
            },
          ],
          details: {
            query: params.query,
            resultCount: cached.results.length,
            results: cached.results,
            cached: true,
          } satisfies SearchDetails,
        };
      }

      // Search via DuckDuckGo
      let results: SearchResult[];
      try {
        results = await searchDuckDuckGo(params.query, count, signal ?? undefined);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes("403") || message.includes("429")) {
          return {
            content: [{ type: "text" as const, text: `Search failed: Rate limit exceeded. Please try again in a moment.` }],
            details: {
              query: params.query,
              resultCount: 0,
              results: [],
              cached: false,
            } satisfies SearchDetails,
          };
        }
        return {
          content: [{ type: "text" as const, text: `Search failed: ${message}` }],
          details: {
            query: params.query,
            resultCount: 0,
            results: [],
            cached: false,
          } satisfies SearchDetails,
        };
      }

      // Cache results
      queryCache.set(cacheKey, { results, timestamp: Date.now() });

      return {
        content: [
          {
            type: "text" as const,
            text: formatSearchResults(params.query, results, false),
          },
        ],
        details: {
          query: params.query,
          resultCount: results.length,
          results,
          cached: false,
        } satisfies SearchDetails,
      };
    },

    // Custom rendering of the tool call
    renderCall(args, theme, _context) {
      let text = theme.fg("toolTitle", theme.bold("web_search "));
      text += theme.fg("accent", `"${args.query}"`);
      if (args.count) {
        text += theme.fg("muted", ` (${args.count} results)`);
      }
      return new Text(text, 0, 0);
    },

    // Custom rendering of the tool result
    renderResult(result, { expanded, isPartial }, theme, _context) {
      if (isPartial) {
        return new Text(theme.fg("warning", "Searching the web..."), 0, 0);
      }

      const details = result.details as SearchDetails | undefined;
      if (!details) {
        return new Text(theme.fg("dim", "No results"), 0, 0);
      }

      // Compact summary view
      let text = theme.fg("success", `✓ ${details.resultCount} results`);
      if (details.cached) {
        text += theme.fg("dim", " (cached)");
      }
      text += theme.fg("dim", ` for "${details.query}"`);

      // Expanded view: show result titles and URLs
      if (expanded) {
        for (let i = 0; i < details.results.length; i++) {
          const r = details.results[i]!;
          text += `\n  ${theme.fg("accent", `${i + 1}.`)} ${theme.bold(r.title)}`;
          text += `\n    ${theme.fg("dim", r.url)}`;
          if (r.description) {
            const desc =
              r.description.length > 120
                ? r.description.slice(0, 120) + "..."
                : r.description;
            text += `\n    ${theme.fg("muted", desc)}`;
          }
        }
      }

      return new Text(text, 0, 0);
    },
  });
}
