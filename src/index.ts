/*
 * Copyright (c) 2026 Sidney Anderson
 * All Rights Reserved — Proprietary Software
 *
 * This software is confidential and provided for authorized internal use only.
 * Redistribution, modification, reverse-engineering, AI-training use,
 * commercial deployment, or disclosure to third parties is prohibited
 * without prior written permission.
 *
 * See LICENSE and NOTICE.txt for full terms.
 */
// src/index.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const ECFR_BASE = "https://www.ecfr.gov";

/**
 * Wrap any value as pretty-printed JSON text for MCP content.
 */
function jsonText(payload: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}

/**
 * Standard error wrapper for tools.
 */
function errorText(message: string) {
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: message,
      },
    ],
  };
}

/**
 * Helper to fetch JSON with basic error reporting.
 */
async function fetchJson(url: string) {
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `HTTP ${res.status} ${res.statusText} from ${url}` +
        (body ? ` — body: ${body.slice(0, 500)}` : "")
    );
  }
  return res.json();
}

async function main() {
  const server = new McpServer({
    name: "ecfr-mcp",
    version: "0.2.0",
  });

  // Cast to any to avoid deep generic type instantiation with Zod + MCP
  const anyServer = server as any;

  // ---------------------------------------------------------------------------
  // TOOL: ecfr_search_results
  // Full-text search of eCFR using /api/search/v1/results.json
  // ---------------------------------------------------------------------------
  anyServer.tool(
    "ecfr_search_results",
    {
      query: z
        .string()
        .min(1)
        .describe(
          "Search string, e.g. '21 CFR 1306.04', 'legitimate medical purpose prescription', or 'inventory requirements schedule II'."
        ),
      date: z
        .string()
        .optional()
        .describe("Point-in-time date in YYYY-MM-DD format, or 'current'. Defaults to 'current'."),
      order: z
        .enum(["relevance", "newest", "oldest"])
        .optional()
        .describe("Sort order. Defaults to 'relevance'."),
      results: z
        .number()
        .int()
        .min(1)
        .max(1000)
        .optional()
        .describe("Maximum number of results to return. Defaults to 50."),
    },
    async (args: any) => {
      const { query, date, order, results } = args;
      try {
        const url = new URL("/api/search/v1/results.json", ECFR_BASE);

        // eCFR usage examples:
        //   /api/search/v1/results.json?date=current&order=relevance&query=$x&results=1000
        url.searchParams.set("query", query);
        url.searchParams.set("date", date ?? "current");
        url.searchParams.set("order", order ?? "relevance");
        url.searchParams.set("results", String(results ?? 50));

        const data = await fetchJson(url.toString());

        return jsonText({
          endpoint: "/api/search/v1/results.json",
          params: {
            query,
            date: date ?? "current",
            order: order ?? "relevance",
            results: results ?? 50,
          },
          data,
        });
      } catch (err: any) {
        return errorText(
          `Error calling eCFR search results API: ${err?.message || String(err)}`
        );
      }
    }
  );

  // ---------------------------------------------------------------------------
  // TOOL: ecfr_search_summary
  // Aggregated summary of search results via /api/search/v1/summary.json
  // ---------------------------------------------------------------------------
  anyServer.tool(
    "ecfr_search_summary",
    {
      query: z
        .string()
        .min(1)
        .describe("Search string, e.g. 'opioid prescribing requirements'."),
      date: z
        .string()
        .optional()
        .describe("Point-in-time date in YYYY-MM-DD format, or 'current'. Defaults to 'current'."),
      order: z
        .enum(["relevance", "newest", "oldest"])
        .optional()
        .describe("Sort order. Defaults to 'relevance'."),
    },
    async (args: any) => {
      const { query, date, order } = args;
      try {
        const url = new URL("/api/search/v1/summary.json", ECFR_BASE);

        url.searchParams.set("query", query);
        url.searchParams.set("date", date ?? "current");
        url.searchParams.set("order", order ?? "relevance");

        const data = await fetchJson(url.toString());

        return jsonText({
          endpoint: "/api/search/v1/summary.json",
          params: {
            query,
            date: date ?? "current",
            order: order ?? "relevance",
          },
          data,
        });
      } catch (err: any) {
        return errorText(
          `Error calling eCFR search summary API: ${err?.message || String(err)}`
        );
      }
    }
  );

  // ---------------------------------------------------------------------------
  // TOOL: ecfr_list_titles
  // List CFR titles from /api/versioner/v1/titles.json
  // ---------------------------------------------------------------------------
  anyServer.tool(
    "ecfr_list_titles",
    {},
    async () => {
      try {
        const url = new URL("/api/versioner/v1/titles.json", ECFR_BASE);
        const data = await fetchJson(url.toString());

        return jsonText({
          endpoint: "/api/versioner/v1/titles.json",
          data,
        });
      } catch (err: any) {
        return errorText(
          `Error calling eCFR titles endpoint: ${err?.message || String(err)}`
        );
      }
    }
  );

  // ---------------------------------------------------------------------------
  // TOOL: ecfr_list_agencies
  // List agencies from /api/admin/v1/agencies.json
  // ---------------------------------------------------------------------------
  anyServer.tool(
    "ecfr_list_agencies",
    {},
    async () => {
      try {
        const url = new URL("/api/admin/v1/agencies.json", ECFR_BASE);
        const data = await fetchJson(url.toString());

        return jsonText({
          endpoint: "/api/admin/v1/agencies.json",
          data,
        });
      } catch (err: any) {
        return errorText(
          `Error calling eCFR agencies endpoint: ${err?.message || String(err)}`
        );
      }
    }
  );

  // ---------------------------------------------------------------------------
  // TOOL: ecfr_get_title_xml
  // Get full XML for a title at a given date; can be filtered by part/section
  // ---------------------------------------------------------------------------
  anyServer.tool(
    "ecfr_get_title_xml",
    {
      date: z
        .string()
        .min(1)
        .describe("Snapshot date in YYYY-MM-DD format, e.g. '2025-01-05'."),
      title: z
        .number()
        .int()
        .min(1)
        .max(50)
        .describe("CFR title number, e.g. 21."),
      part: z
        .string()
        .optional()
        .describe("Optional CFR part to hint at area of interest, e.g. '1306'."),
      section: z
        .string()
        .optional()
        .describe("Optional CFR section number, e.g. '1306.04'."),
    },
    async (args: any) => {
      const { date, title, part, section } = args;
      try {
        const path = `/api/versioner/v1/full/${encodeURIComponent(
          date
        )}/title-${encodeURIComponent(String(title))}.xml`;
        const url = new URL(path, ECFR_BASE);

        if (part) url.searchParams.set("part", part);
        if (section) url.searchParams.set("section", section);

        const res = await fetch(url.toString());
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          throw new Error(
            `HTTP ${res.status} ${res.statusText} from ${url.toString()}` +
              (body ? ` — body: ${body.slice(0, 500)}` : "")
          );
        }

        const xml = await res.text();

        return {
          content: [
            {
              type: "text" as const,
              text: xml,
            },
          ],
        };
      } catch (err: any) {
        return errorText(`Error fetching eCFR XML: ${err?.message || String(err)}`);
      }
    }
  );

  // ---------------------------------------------------------------------------
  // Connect over stdio
  // ---------------------------------------------------------------------------
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Fatal error in eCFR MCP server:", err);
  process.exit(1);
});

