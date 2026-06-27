#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import fetch from "node-fetch";
import * as cheerio from "cheerio";
import TurndownService from "turndown";

// ─── Config ───────────────────────────────────────────────
const TIMEOUT_MS = parseInt(process.env.FETCH_TIMEOUT || "10000");
const MAX_CONTENT_LENGTH = 5 * 1024 * 1024; // 5MB
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";
const SEARCH_ENGINE = process.env.SEARCH_ENGINE || "duckduckgo"; // duckduckgo | brave
const BRAVE_API_KEY = process.env.BRAVE_API_KEY || "";

// ─── Markdown Converter ───────────────────────────────────
const td = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
});

td.addRule("removeExtra", {
  filter: () => false, // handled in pre-processing
});

// Elements to strip before conversion — keeps output clean
const STRIP_SELECTORS = [
  "script", "style", "noscript", "iframe", "svg",
  "nav", "footer", "header", "aside",
  "[role='navigation']", "[role='banner']", "[role='contentinfo']", "[role='complementary']",
  ".ad", ".ads", ".advertisement", ".sidebar", ".cookie-banner",
  ".popup", ".modal", ".overlay", "#comments", ".related",
  "[class*='cookie']", "[class*='newsletter']", "[class*='popup']",
  "[class*='sidebar']", "[class*='footer']", "[class*='nav']",
];

function cleanHtml(html: string, baseUrl?: string): string {
  const $ = cheerio.load(html);

  // Remove noise elements
  STRIP_SELECTORS.forEach((sel) => $(sel).remove());

  // Remove hidden elements
  $("[hidden], [style*='display:none'], [style*='display: none']").remove();

  // Remove empty paragraphs and divs
  $("p, div").each(function () {
    const text = $(this).text().trim();
    if (!text && !$(this).find("img, video, iframe").length) {
      $(this).remove();
    }
  });

  // Resolve relative URLs to absolute
  if (baseUrl) {
    try {
      const base = new URL(baseUrl);
      $("a[href]").each(function () {
        try {
          const href = $(this).attr("href");
          if (href && !href.startsWith("http") && !href.startsWith("#") && !href.startsWith("mailto:")) {
            $(this).attr("href", new URL(href, base).href);
          }
        } catch {}
      });
      $("img[src]").each(function () {
        try {
          const src = $(this).attr("src");
          if (src && !src.startsWith("http") && !src.startsWith("data:")) {
            $(this).attr("src", new URL(src, base).href);
          }
        } catch {}
      });
    } catch {}
  }

  return $.html("body") || $.html();
}

function htmlToMarkdown(html: string, baseUrl?: string): string {
  const cleaned = cleanHtml(html, baseUrl);
  return td.turndown(cleaned).trim();
}

// ─── Fetch Helper ─────────────────────────────────────────
async function safeFetch(url: string, options?: Record<string, unknown>) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      ...options,
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/json,application/xml,text/plain,*/*",
        "Accept-Language": "en-US,en;q=0.9",
        ...(options?.headers as Record<string, string> || {}),
      },
      signal: controller.signal,
      follow: 5,
      redirect: "follow",
    });

    return res;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Search Implementations ───────────────────────────────
async function searchDuckDuckGo(query: string, maxResults: number) {
  const res = await safeFetch(
    `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
  );
  const html = await res.text();
  const $ = cheerio.load(html);
  const results: Array<{
    title: string;
    url: string;
    snippet: string;
  }> = [];

  $(".result").each(function () {
    if (results.length >= maxResults) return false;
    const titleEl = $(this).find(".result__title a");
    const snippetEl = $(this).find(".result__snippet");
    const title = titleEl.text().trim();
    const href = titleEl.attr("href") || "";
    // DuckDuckGo uses redirect URLs — extract actual URL
    const urlMatch = href.match(/uddg=([^&]+)/);
    const url = urlMatch ? decodeURIComponent(urlMatch[1]) : href;
    const snippet = snippetEl.text().trim();

    if (title && url && snippet) {
      results.push({ title, url, snippet });
    }
  });

  return results;
}

async function searchBrave(query: string, maxResults: number) {
  if (!BRAVE_API_KEY) {
    throw new Error(
      "Brave Search requires BRAVE_API_KEY env var. Get one free at https://brave.com/search/api/ (2000 queries/month free)",
    );
  }
  const res = await safeFetch(
    `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${maxResults}`,
    { headers: { "X-Subscription-Token": BRAVE_API_KEY } },
  );
  const data = (await res.json()) as {
    web?: { results?: Array<{ title: string; url: string; description: string }> };
  };
  return (
    data.web?.results?.map((r) => ({
      title: r.title,
      url: r.url,
      snippet: r.description,
    })) || []
  );
}

// ─── Tool Definitions ─────────────────────────────────────
const TOOLS = [
  {
    name: "fetch_url",
    description:
      "Fetches any public webpage and returns its content as clean markdown. Automatically removes navigation, ads, sidebars, footers, and other clutter. Resolves relative URLs to absolute. Use this when you need to read, analyze, or summarize web page content. Returns the page title, URL, and cleaned markdown body.",
    inputSchema: {
      type: "object" as const,
      properties: {
        url: {
          type: "string",
          description: "The URL to fetch",
        },
        include_metadata: {
          type: "boolean",
          description: "If true, also return page metadata (description, OG tags, language)",
          default: false,
        },
      },
      required: ["url"],
    },
  },
  {
    name: "search_web",
    description:
      "Searches the web and returns structured results with titles, URLs, and snippets. Use this when you need to find information, discover URLs, or research a topic. Returns up to 10 results ranked by relevance.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Search query",
        },
        max_results: {
          type: "number",
          description: "Maximum number of results (1-20)",
          default: 8,
        },
      },
      required: ["query"],
    },
  },
  {
    name: "extract_links",
    description:
      "Extracts all links from a webpage, grouped by type (internal, external, anchor). Returns the link text, URL, and whether it's nofollow. Use this to map a site's structure, find related pages, or analyze link patterns.",
    inputSchema: {
      type: "object" as const,
      properties: {
        url: { type: "string", description: "URL to extract links from" },
        group_by: {
          type: "string",
          enum: ["type", "none"],
          description: "Group links by internal/external/anchor, or return flat list",
          default: "type",
        },
      },
      required: ["url"],
    },
  },
  {
    name: "extract_metadata",
    description:
      "Extracts metadata from a webpage: title, meta description, Open Graph tags, Twitter Card tags, canonical URL, language, and other SEO-relevant information. Use this to understand what a page is about without fetching the full content, or to audit page metadata.",
    inputSchema: {
      type: "object" as const,
      properties: {
        url: { type: "string", description: "URL to extract metadata from" },
      },
      required: ["url"],
    },
  },
  {
    name: "check_status",
    description:
      "Checks the HTTP status of one or more URLs. Returns status code, content type, response time, and whether the page is alive. Use this to verify links, check site availability, or audit a list of URLs. Supports batch checking up to 20 URLs at once.",
    inputSchema: {
      type: "object" as const,
      properties: {
        urls: {
          type: "array",
          items: { type: "string" },
          description: "Array of URLs to check (max 20)",
        },
      },
      required: ["urls"],
    },
  },
  {
    name: "sitemap_parse",
    description:
      "Parses a sitemap.xml file and returns all URLs found in it, along with lastmod dates and priorities if available. Use this to discover all pages on a website, or to check what a site has submitted to search engines.",
    inputSchema: {
      type: "object" as const,
      properties: {
        url: {
          type: "string",
          description: "URL of the sitemap.xml (e.g. https://example.com/sitemap.xml)",
        },
        limit: {
          type: "number",
          description: "Max URLs to return (default 100)",
          default: 100,
        },
      },
      required: ["url"],
    },
  },
  {
    name: "rss_parse",
    description:
      "Parses an RSS or Atom feed and returns the latest entries with titles, links, dates, summaries, and authors. Use this to monitor blogs, news sites, podcasts, or any RSS/Atom feed.",
    inputSchema: {
      type: "object" as const,
      properties: {
        url: { type: "string", description: "URL of the RSS or Atom feed" },
        limit: {
          type: "number",
          description: "Max entries to return (default 15)",
          default: 15,
        },
      },
      required: ["url"],
    },
  },
  {
    name: "find_contact",
    description:
      "Extracts contact information from a webpage: email addresses, phone numbers, social media profile URLs, and contact page links. Use this to find how to reach a person or organization from their website.",
    inputSchema: {
      type: "object" as const,
      properties: {
        url: { type: "string", description: "URL to scan for contact info" },
      },
      required: ["url"],
    },
  },
];

// ─── Tool Handlers ────────────────────────────────────────
async function handleFetchUrl(args: { url: string; include_metadata?: boolean }) {
  const res = await safeFetch(args.url);
  const contentType = res.headers.get("content-type") || "";
  const body = await res.text();

  if (body.length > MAX_CONTENT_LENGTH) {
    return {
      content: [
        {
          type: "text",
          text: `Page too large (${(body.length / 1024 / 1024).toFixed(1)}MB). Max is ${MAX_CONTENT_LENGTH / 1024 / 1024}MB.`,
        },
      ],
    };
  }

  const $ = cheerio.load(body);
  const title = $("title").text().trim();
  const markdown = htmlToMarkdown(body, args.url);

  let result = `# ${title}\n\nSource: ${args.url}\nStatus: ${res.status}\n\n---\n\n${markdown}`;

  if (args.include_metadata) {
    const meta = extractMetaFromCheerio($, args.url);
    result = `## Metadata\n${formatMetadata(meta)}\n\n---\n\n${result}`;
  }

  return {
    content: [{ type: "text", text: result }],
  };
}

async function handleSearchWeb(args: { query: string; max_results?: number }) {
  const max = Math.min(Math.max(args.max_results || 8, 1), 20);
  const results =
    SEARCH_ENGINE === "brave"
      ? await searchBrave(args.query, max)
      : await searchDuckDuckGo(args.query, max);

  if (!results.length) {
    return {
      content: [{ type: "text", text: `No results found for "${args.query}"` }],
    };
  }

  const formatted = results
    .map(
      (r, i) =>
        `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.snippet}`,
    )
    .join("\n\n");

  return {
    content: [
      {
        type: "text",
        text: `## Search results for "${args.query}"\n\n${formatted}\n\n---\n${results.length} result${results.length > 1 ? "s" : ""} returned`,
      },
    ],
  };
}

async function handleExtractLinks(args: { url: string; group_by?: string }) {
  const res = await safeFetch(args.url);
  const html = await res.text();
  const $ = cheerio.load(html);
  let baseUrl: URL;
  try {
    baseUrl = new URL(args.url);
  } catch {
    return { content: [{ type: "text", text: "Invalid URL" }] };
  }

  const links: Array<{
    text: string;
    href: string;
    type: string;
    nofollow: boolean;
  }> = [];

  $("a[href]").each(function () {
    const href = $(this).attr("href") || "";
    if (!href || href.startsWith("#") || href.startsWith("javascript:")) return;

    let fullUrl: string;
    try {
      fullUrl = new URL(href, baseUrl).href;
    } catch {
      return;
    }

    let linkUrl: URL;
    try {
      linkUrl = new URL(fullUrl);
    } catch {
      return;
    }

    const rel = ($(this).attr("rel") || "").toLowerCase();
    const nofollow = rel.includes("nofollow");
    const text = $(this).text().trim().substring(0, 100);

    let type: string;
    if (href.startsWith("#")) type = "anchor";
    else if (linkUrl.hostname === baseUrl.hostname) type = "internal";
    else if (href.startsWith("mailto:")) type = "email";
    else type = "external";

    links.push({ text: text || "(no text)", href: fullUrl, type, nofollow });
  });

  // Deduplicate by URL
  const seen = new Set<string>();
  const unique = links.filter((l) => {
    if (seen.has(l.href)) return false;
    seen.add(l.href);
    return true;
  });

  let output: string;
  if (args.group_by === "type") {
    const groups: Record<string, typeof unique> = {};
    unique.forEach((l) => {
      if (!groups[l.type]) groups[l.type] = [];
      groups[l.type].push(l);
    });
    output = Object.entries(groups)
      .map(
        ([type, items]) =>
          `### ${type.charAt(0).toUpperCase() + type.slice(1)} (${items.length})\n${items.map((l) => `- ${l.text} — ${l.href}${l.nofollow ? " [nofollow]" : ""}`).join("\n")}`,
      )
      .join("\n\n");
  } else {
    output = unique
      .map(
        (l) =>
          `- ${l.text} — ${l.href} (${l.type}${l.nofollow ? ", nofollow" : ""})`,
      )
      .join("\n");
  }

  return {
    content: [
      {
        type: "text",
        text: `## Links from ${args.url}\n\n${output}\n\n---\n${unique.length} unique links found`,
      },
    ],
  };
}

function extractMetaFromCheerio(
  $: cheerio.CheerioAPI,
  url: string,
): Record<string, string> {
  const meta: Record<string, string> = {};

  meta["title"] = $("title").text().trim();
  meta["canonical"] = $('link[rel="canonical"]').attr("href") || "";
  meta["description"] = $('meta[name="description"]').attr("content") || "";
  meta["language"] = $("html").attr("lang") || "";
  meta["viewport"] = $('meta[name="viewport"]').attr("content") || "";

  // Open Graph
  $('meta[property^="og:"]').each(function () {
    const prop = $(this).attr("property")?.replace("og:", "og_") || "";
    const content = $(this).attr("content") || "";
    if (prop && content) meta[prop] = content;
  });

  // Twitter Card
  $('meta[name^="twitter:"]').each(function () {
    const name = $(this).attr("name") || "";
    const content = $(this).attr("content") || "";
    if (name && content) meta[name] = content;
  });

  // Robots
  meta["robots"] = $('meta[name="robots"]').attr("content") || "";

  // Clean up empty values
  Object.keys(meta).forEach((k) => {
    if (!meta[k]) delete meta[k];
  });

  return meta;
}

function formatMetadata(meta: Record<string, string>): string {
  return Object.entries(meta)
    .map(([k, v]) => `- **${k}**: ${v}`)
    .join("\n");
}

async function handleExtractMetadata(args: { url: string }) {
  const res = await safeFetch(args.url);
  const html = await res.text();
  const $ = cheerio.load(html);
  const meta = extractMetaFromCheerio($, args.url);
  meta["url"] = args.url;
  meta["status"] = String(res.status);
  meta["content_type"] = res.headers.get("content-type") || "";

  return {
    content: [
      {
        type: "text",
        text: `## Page Metadata\n\n${formatMetadata(meta)}`,
      },
    ],
  };
}

async function handleCheckStatus(args: { urls: string[] }) {
  const urls = args.urls.slice(0, 20);
  const results = await Promise.all(
    urls.map(async (url) => {
      const start = Date.now();
      try {
        const res = await safeFetch(url, { method: "HEAD" });
        const ms = Date.now() - start;
        return {
          url,
          status: res.status,
          statusText: res.statusText,
          contentType: res.headers.get("content-type") || "unknown",
          responseTimeMs: ms,
          alive: res.status >= 200 && res.status < 400,
        };
      } catch (err) {
        const ms = Date.now() - start;
        return {
          url,
          status: 0,
          statusText: err instanceof Error ? err.message : "failed",
          contentType: "unknown",
          responseTimeMs: ms,
          alive: false,
        };
      }
    }),
  );

  const output = results
    .map(
      (r) =>
        `- **${r.url}**\n  Status: ${r.status} ${r.statusText}\n  Type: ${r.contentType}\n  Time: ${r.responseTimeMs}ms\n  ${r.alive ? "✅ Alive" : "❌ Down"}`,
    )
    .join("\n\n");

  const alive = results.filter((r) => r.alive).length;

  return {
    content: [
      {
        type: "text",
        text: `## URL Status Check\n\n${output}\n\n---\n${alive}/${results.length} URLs are alive`,
      },
    ],
  };
}

async function handleSitemapParse(args: { url: string; limit?: number }) {
  const res = await safeFetch(args.url);
  const xml = await res.text();
  const $ = cheerio.load(xml, { xmlMode: true });
  const urls: Array<{ loc: string; lastmod?: string; priority?: string }> = [];

  $("url").each(function () {
    if (urls.length >= (args.limit || 100)) return false;
    urls.push({
      loc: $(this).find("loc").text().trim(),
      lastmod: $(this).find("lastmod").text().trim() || undefined,
      priority: $(this).find("priority").text().trim() || undefined,
    });
  });

  // Also handle sitemap index
  if (!urls.length) {
    $("sitemap").each(function () {
      if (urls.length >= (args.limit || 100)) return false;
      urls.push({
        loc: $(this).find("loc").text().trim(),
        lastmod: $(this).find("lastmod").text().trim() || undefined,
      });
    });
  }

  const output = urls
    .map(
      (u) =>
        `- ${u.loc}${u.lastmod ? ` (updated: ${u.lastmod})` : ""}${u.priority ? ` [priority: ${u.priority}]` : ""}`,
    )
    .join("\n");

  return {
    content: [
      {
        type: "text",
        text: `## Sitemap: ${args.url}\n\n${output}\n\n---\n${urls.length} URLs found`,
      },
    ],
  };
}

async function handleRssParse(args: { url: string; limit?: number }) {
  const res = await safeFetch(args.url);
  const xml = await res.text();
  const $ = cheerio.load(xml, { xmlMode: true });
  const entries: Array<{
    title: string;
    link: string;
    date: string;
    author: string;
    summary: string;
  }> = [];

  // RSS 2.0
  $("item").each(function () {
    if (entries.length >= (args.limit || 15)) return false;
    entries.push({
      title: $(this).find("title").text().trim(),
      link: $(this).find("link").text().trim(),
      date: $(this).find("pubDate").text().trim(),
      author: $(this).find("author").text().trim() || $(this).find("dc\\:creator").text().trim(),
      summary: $(this).find("description").text().trim().substring(0, 300),
    });
  });

  // Atom
  if (!entries.length) {
    $("entry").each(function () {
      if (entries.length >= (args.limit || 15)) return false;
      entries.push({
        title: $(this).find("title").text().trim(),
        link: $(this).find("link").attr("href") || "",
        date: $(this).find("published").text().trim() || $(this).find("updated").text().trim(),
        author: $(this).find("author > name").text().trim(),
        summary: $(this).find("summary").text().trim().substring(0, 300) || $(this).find("content").text().trim().substring(0, 300),
      });
    });
  }

  const output = entries
    .map(
      (e, i) =>
        `${i + 1}. **${e.title}**\n   ${e.link}\n   ${e.date ? `Date: ${e.date}` : ""}${e.author ? ` | Author: ${e.author}` : ""}\n   ${e.summary ? `${e.summary}...` : ""}`,
    )
    .join("\n\n");

  return {
    content: [
      {
        type: "text",
        text: `## Feed: ${args.url}\n\n${output}\n\n---\n${entries.length} entries`,
      },
    ],
  };
}

async function handleFindContact(args: { url: string }) {
  // Fetch main page
  const res = await safeFetch(args.url);
  const html = await res.text();
  const $ = cheerio.load(html);
  let allText = $.text() + " " + html;

  // Also try common contact pages
  const contactPaths = ["/contact", "/about", "/team"];
  for (const path of contactPaths) {
    try {
      const cRes = await safeFetch(new URL(path, args.url).href);
      const cHtml = await cRes.text();
      allText += " " + cHtml;
    } catch {}
  }

  // Extract emails
  const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  const emails = [...new Set(allText.match(emailRegex) || [])].filter(
    (e) => !e.includes(".png") && !e.includes(".jpg") && !e.includes(".svg"),
  );

  // Extract phone numbers (basic pattern)
  const phoneRegex =
    /(?:\+?\d{1,3}[-.\s]?)?\(?\d{2,4}\)?[-.\s]?\d{3,4}[-.\s]?\d{3,4}/g;
  const phones = [...new Set(allText.match(phoneRegex) || [])].filter(
    (p) => p.length >= 7,
  );

  // Extract social links
  const socialPatterns: Record<string, RegExp> = {
    twitter: /twitter\.com\/[a-zA-Z0-9_]+/g,
    x: /x\.com\/[a-zA-Z0-9_]+/g,
    linkedin: /linkedin\.com\/in\/[a-zA-Z0-9-]+/g,
    github: /github\.com\/[a-zA-Z0-9-]+/g,
    facebook: /facebook\.com\/[a-zA-Z0-9.-]+/g,
    instagram: /instagram\.com\/[a-zA-Z0-9._]+/g,
    youtube: /youtube\.com\/(?:channel|@|c\/)[a-zA-Z0-9@_-]+/g,
    mastodon: /@[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+/g,
  };

  const socials: Record<string, string[]> = {};
  for (const [platform, regex] of Object.entries(socialPatterns)) {
    const matches = [...new Set(html.match(regex) || [])].map(
      (m) => (m.startsWith("http") ? m : `https://${m}`),
    );
    if (matches.length) socials[platform] = matches;
  }

  let output = "## Contact Information\n\n";
  if (emails.length) output += `### Emails\n${emails.map((e) => `- ${e}`).join("\n")}\n\n`;
  if (phones.length) output += `### Phone Numbers\n${phones.map((p) => `- ${p}`).join("\n")}\n\n`;
  if (Object.keys(socials).length) {
    output += `### Social Profiles\n`;
    for (const [platform, urls] of Object.entries(socials)) {
      output += `**${platform}**: ${urls.join(", ")}\n`;
    }
    output += "\n";
  }

  if (!emails.length && !phones.length && !Object.keys(socials).length) {
    output += "No contact information found on this page.\n";
  }

  output += `\n---\nScanned: ${args.url}` + contactPaths.map((p) => `, ${new URL(p, args.url).href}`).join("");

  return { content: [{ type: "text", text: output }] };
}

// ─── Tool Router ──────────────────────────────────────────
async function handleToolCall(
  name: string,
  args: Record<string, unknown>,
): Promise<{ content: Array<{ type: string; text: string }> }> {
  switch (name) {
    case "fetch_url":
      return handleFetchUrl(args as { url: string; include_metadata?: boolean });
    case "search_web":
      return handleSearchWeb(args as { query: string; max_results?: number });
    case "extract_links":
      return handleExtractLinks(args as { url: string; group_by?: string });
    case "extract_metadata":
      return handleExtractMetadata(args as { url: string });
    case "check_status":
      return handleCheckStatus(args as { urls: string[] });
    case "sitemap_parse":
      return handleSitemapParse(args as { url: string; limit?: number });
    case "rss_parse":
      return handleRssParse(args as { url: string; limit?: number });
    case "find_contact":
      return handleFindContact(args as { url: string });
    default:
      return {
        content: [{ type: "text", text: `Unknown tool: ${name}` }],
      };
  }
}

// ─── Server Setup ─────────────────────────────────────────
const server = new Server(
  { name: "web-pilot-mcp", version: "1.0.0" },
  {
    capabilities: {
      tools: {},
    },
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    return await handleToolCall(name, args || {});
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown error occurred";
    return {
      content: [
        {
          type: "text",
          text: `Error: ${message}`,
        },
      ],
      isError: true,
    };
  }
});

// ─── Start ────────────────────────────────────────────────
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Log to stderr so it doesn't interfere with stdio protocol
  console.error("Web Pilot MCP server running on stdio");
}


(globalThis as any).__WEB_PILOT_TOOLS__ = TOOLS;
(globalThis as any).__WEB_PILOT_HANDLE__ = handleToolCall;

import express from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const app = express();
const PORT = process.env.PORT || 8080;

app.get('/sse', (req, res) => {
  console.log("SSE connection");
  const transport = new SSEServerTransport('/messages', res);
  const server = new Server({ name: 'web-pilot-mcp', version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    return handleToolCall(name, args || {});
  });
  server.connect(transport);
});

app.post('/messages', express.json(), (req, res) => res.status(200).end());
app.get('/', (req, res) => res.json({ name: 'web-pilot-mcp', sse: '/sse' }));
app.get('/.well-known/mcp/server-card.json', (req, res) => res.json({ name: 'web-pilot-mcp', description: '8 web tools for AI. Fetch pages as markdown, search, extract links, metadata, contacts, parse sitemaps and RSS.', url: '/sse' }));
app.listen(PORT, () => console.log('HTTP server on port ' + PORT));

