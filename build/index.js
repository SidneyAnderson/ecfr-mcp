#!/usr/bin/env node
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
function jsonText(payload) {
    return {
        content: [
            {
                type: "text",
                text: JSON.stringify(payload, null, 2),
            },
        ],
    };
}
/**
 * Standard error wrapper for tools.
 */
function errorText(message) {
    return {
        isError: true,
        content: [
            {
                type: "text",
                text: message,
            },
        ],
    };
}
/**
 * Helper to fetch JSON with basic error reporting.
 */
async function fetchJson(url) {
    const res = await fetch(url);
    if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status} ${res.statusText} from ${url}` +
            (body ? ` — body: ${body.slice(0, 500)}` : ""));
    }
    return res.json();
}
/**
 * Recursively flatten section nodes from a structure tree.
 */
function collectSections(node, map) {
    if (node && typeof node === "object") {
        if (node.type === "section" && node.identifier) {
            map.set(String(node.identifier), node);
        }
        if (Array.isArray(node.children)) {
            for (const child of node.children) {
                collectSections(child, map);
            }
        }
    }
}
/**
 * Build a lookup of section identifier -> node from a structure payload.
 */
function buildSectionMap(structure) {
    const map = new Map();
    collectSections(structure, map);
    return map;
}
/**
 * Parse a YYYY-MM-DD-ish string to a Date; returns undefined on failure.
 */
function toDate(value) {
    if (!value)
        return undefined;
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? undefined : d;
}
/**
 * Check if a target date falls within [start, end] (inclusive).
 */
function isWithinRange(target, start, end) {
    const t = toDate(target);
    const s = toDate(start);
    const e = toDate(end);
    if (!t)
        return false;
    if (s && t < s)
        return false;
    if (e && t > e)
        return false;
    return true;
}
/**
 * Check if two date ranges overlap (inclusive). Missing bounds are treated as open.
 */
function rangesOverlap(filterStart, filterEnd, itemStart, itemEnd) {
    const fs = toDate(filterStart);
    const fe = toDate(filterEnd);
    const is = toDate(itemStart);
    const ie = toDate(itemEnd);
    // Open range defaults
    const effectiveItemStart = is ?? new Date(-8640000000000000);
    const effectiveItemEnd = ie ?? new Date(8640000000000000);
    if (fs && effectiveItemEnd < fs)
        return false;
    if (fe && effectiveItemStart > fe)
        return false;
    return true;
}
/**
 * Fetch structure JSON for a given title/date/optional part.
 */
async function fetchStructureJson(date, title, part) {
    const path = `/api/versioner/v1/structure/${encodeURIComponent(date)}/title-${encodeURIComponent(String(title))}.json`;
    const url = new URL(path, ECFR_BASE);
    if (part)
        url.searchParams.set("part", part);
    return fetchJson(url.toString());
}
/**
 * Fetch title metadata from titles.json for a specific title number.
 */
async function fetchTitleMeta(title) {
    const url = new URL("/api/versioner/v1/titles.json", ECFR_BASE);
    const data = await fetchJson(url.toString());
    const meta = Array.isArray(data?.titles) &&
        data.titles.find((t) => String(t?.number) === String(title));
    return meta ?? null;
}
/**
 * Compare two structure payloads and produce change summaries.
 */
async function diffTitleStructures(title, start_date, end_date, part, change_types) {
    const [startStructure, endStructure] = await Promise.all([
        fetchStructureJson(start_date, title, part),
        fetchStructureJson(end_date, title, part),
    ]);
    const startMap = buildSectionMap(startStructure);
    const endMap = buildSectionMap(endStructure);
    const changes = [];
    for (const [id, node] of endMap.entries()) {
        if (!startMap.has(id)) {
            changes.push({
                type: "added",
                section: id,
                citation: `${title} CFR ${id}`,
                part: part ?? node?.hierarchy?.part ?? null,
                change_date: end_date,
                heading: node?.label_description ?? node?.label ?? null,
            });
        }
    }
    for (const [id, node] of startMap.entries()) {
        if (!endMap.has(id)) {
            changes.push({
                type: "removed",
                section: id,
                citation: `${title} CFR ${id}`,
                part: part ?? null,
                change_date: end_date,
                heading: node?.label_description ?? node?.label ?? null,
            });
        }
    }
    for (const [id, node] of endMap.entries()) {
        const previous = startMap.get(id);
        if (previous) {
            const differs = node?.label_description !== previous.label_description ||
                node?.reserved !== previous.reserved ||
                node?.received_on !== previous.received_on ||
                node?.size !== previous.size;
            if (differs) {
                changes.push({
                    type: "modified",
                    section: id,
                    citation: `${title} CFR ${id}`,
                    part: part ?? null,
                    change_date: end_date,
                    description: "Section metadata changed between snapshots.",
                    start_metadata: {
                        received_on: previous.received_on ?? null,
                        reserved: previous.reserved ?? null,
                        size: previous.size ?? null,
                    },
                    end_metadata: {
                        received_on: node.received_on ?? null,
                        reserved: node.reserved ?? null,
                        size: node.size ?? null,
                    },
                });
            }
        }
    }
    const filteredChanges = change_types
        ? changes.filter((c) => change_types.includes(c.type))
        : changes;
    const summary = {
        total_changes: filteredChanges.length,
        sections_added: filteredChanges.filter((c) => c.type === "added").length,
        sections_removed: filteredChanges.filter((c) => c.type === "removed").length,
        sections_modified: filteredChanges.filter((c) => c.type === "modified").length,
    };
    return { summary, changes: filteredChanges };
}
async function main() {
    const server = new McpServer({
        name: "ecfr-mcp",
        version: "0.2.0",
    });
    // Cast to any to avoid deep generic type instantiation with Zod + MCP
    const anyServer = server;
    // ---------------------------------------------------------------------------
    // TOOL: ecfr_search_results
    // Full-text search of eCFR using /api/search/v1/results.json
    // ---------------------------------------------------------------------------
    anyServer.tool("ecfr_search_results", {
        query: z
            .string()
            .min(1)
            .describe("Search string, e.g. '21 CFR 1306.04', 'legitimate medical purpose prescription', or 'inventory requirements schedule II'."),
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
    }, async (args) => {
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
        }
        catch (err) {
            return errorText(`Error calling eCFR search results API: ${err?.message || String(err)}`);
        }
    });
    // ---------------------------------------------------------------------------
    // TOOL: ecfr_search_summary
    // Aggregated summary of search results via /api/search/v1/summary.json
    // ---------------------------------------------------------------------------
    anyServer.tool("ecfr_search_summary", {
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
    }, async (args) => {
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
        }
        catch (err) {
            return errorText(`Error calling eCFR search summary API: ${err?.message || String(err)}`);
        }
    });
    // ---------------------------------------------------------------------------
    // TOOL: ecfr_list_titles
    // List CFR titles from /api/versioner/v1/titles.json
    // ---------------------------------------------------------------------------
    anyServer.tool("ecfr_list_titles", {}, async () => {
        try {
            const url = new URL("/api/versioner/v1/titles.json", ECFR_BASE);
            const data = await fetchJson(url.toString());
            return jsonText({
                endpoint: "/api/versioner/v1/titles.json",
                data,
            });
        }
        catch (err) {
            return errorText(`Error calling eCFR titles endpoint: ${err?.message || String(err)}`);
        }
    });
    // ---------------------------------------------------------------------------
    // TOOL: ecfr_list_agencies
    // List agencies from /api/admin/v1/agencies.json
    // ---------------------------------------------------------------------------
    anyServer.tool("ecfr_list_agencies", {}, async () => {
        try {
            const url = new URL("/api/admin/v1/agencies.json", ECFR_BASE);
            const data = await fetchJson(url.toString());
            return jsonText({
                endpoint: "/api/admin/v1/agencies.json",
                data,
            });
        }
        catch (err) {
            return errorText(`Error calling eCFR agencies endpoint: ${err?.message || String(err)}`);
        }
    });
    // ---------------------------------------------------------------------------
    // TOOL: ecfr_get_title_xml
    // Get full XML for a title at a given date; can be filtered by part/section
    // ---------------------------------------------------------------------------
    anyServer.tool("ecfr_get_title_xml", {
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
    }, async (args) => {
        const { date, title, part, section } = args;
        try {
            const path = `/api/versioner/v1/full/${encodeURIComponent(date)}/title-${encodeURIComponent(String(title))}.xml`;
            const url = new URL(path, ECFR_BASE);
            if (part)
                url.searchParams.set("part", part);
            if (section)
                url.searchParams.set("section", section);
            const res = await fetch(url.toString());
            if (!res.ok) {
                const body = await res.text().catch(() => "");
                throw new Error(`HTTP ${res.status} ${res.statusText} from ${url.toString()}` +
                    (body ? ` — body: ${body.slice(0, 500)}` : ""));
            }
            const xml = await res.text();
            return {
                content: [
                    {
                        type: "text",
                        text: xml,
                    },
                ],
            };
        }
        catch (err) {
            return errorText(`Error fetching eCFR XML: ${err?.message || String(err)}`);
        }
    });
    // ---------------------------------------------------------------------------
    // TOOL: ecfr_get_corrections
    // Fetch correction notices, optionally filtered
    // ---------------------------------------------------------------------------
    anyServer.tool("ecfr_get_corrections", {
        title: z
            .number()
            .int()
            .min(1)
            .max(50)
            .optional()
            .describe("Optional CFR title number to filter."),
        date: z
            .string()
            .optional()
            .describe("Optional date to filter error_occured/error_corrected (YYYY-MM-DD)."),
        error_corrected_date: z
            .string()
            .optional()
            .describe("Optional error_corrected date filter (YYYY-MM-DD)."),
    }, async (args) => {
        const { title, date, error_corrected_date } = args;
        try {
            const url = new URL("/api/admin/v1/corrections.json", ECFR_BASE);
            const data = await fetchJson(url.toString());
            const corrections = Array.isArray(data?.ecfr_corrections)
                ? data.ecfr_corrections
                : [];
            const filtered = corrections.filter((c) => {
                if (title && String(c?.title) !== String(title))
                    return false;
                const corrDate = c?.error_corrected;
                const occDate = c?.error_occurred;
                if (error_corrected_date && corrDate !== error_corrected_date)
                    return false;
                if (date && corrDate !== date && occDate !== date)
                    return false;
                return true;
            });
            return jsonText({
                endpoint: "/api/admin/v1/corrections.json",
                params: { title: title ?? null, date: date ?? null, error_corrected_date: error_corrected_date ?? null },
                meta: { total: corrections.length, filtered: filtered.length },
                corrections: filtered,
            });
        }
        catch (err) {
            return errorText(`Error fetching eCFR corrections: ${err?.message || String(err)}`);
        }
    });
    // ---------------------------------------------------------------------------
    // TOOL: ecfr_get_part_xml
    // Fetch XML for a specific part (smaller payload than full title)
    // ---------------------------------------------------------------------------
    anyServer.tool("ecfr_get_part_xml", {
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
        part: z.string().min(1).describe("CFR part number, e.g. '1306'."),
    }, async (args) => {
        const { date, title, part } = args;
        try {
            const path = `/api/versioner/v1/full/${encodeURIComponent(date)}/title-${encodeURIComponent(String(title))}.xml`;
            const url = new URL(path, ECFR_BASE);
            url.searchParams.set("part", part);
            const res = await fetch(url.toString());
            if (!res.ok) {
                const body = await res.text().catch(() => "");
                throw new Error(`HTTP ${res.status} ${res.statusText} from ${url.toString()}` +
                    (body ? ` — body: ${body.slice(0, 500)}` : ""));
            }
            const xml = await res.text();
            return {
                content: [
                    {
                        type: "text",
                        text: xml,
                    },
                ],
            };
        }
        catch (err) {
            return errorText(`Error fetching eCFR part XML: ${err?.message || String(err)}`);
        }
    });
    // ---------------------------------------------------------------------------
    // TOOL: ecfr_get_title_versions
    // List version history (issue dates) for a given title
    // ---------------------------------------------------------------------------
    anyServer.tool("ecfr_get_title_versions", {
        title: z
            .number()
            .int()
            .min(1)
            .max(50)
            .describe("CFR title number, e.g. 21."),
        issue_date_gte: z
            .string()
            .optional()
            .describe("Filter to versions on/after this issue date (YYYY-MM-DD)."),
        issue_date_lte: z
            .string()
            .optional()
            .describe("Filter to versions on/before this issue date (YYYY-MM-DD)."),
        after_date: z.string().optional().describe("Deprecated alias for issue_date_gte."),
        before_date: z.string().optional().describe("Deprecated alias for issue_date_lte."),
        part: z.string().optional().describe("Optional part filter."),
        section: z.string().optional().describe("Optional section filter."),
    }, async (args) => {
        const { title, issue_date_gte, issue_date_lte, after_date, before_date, part, section } = args;
        try {
            const path = `/api/versioner/v1/versions/title-${encodeURIComponent(String(title))}.json`;
            const url = new URL(path, ECFR_BASE);
            const data = await fetchJson(url.toString());
            const versions = Array.isArray(data?.content_versions)
                ? data.content_versions
                : [];
            const uniqueDates = Array.from(new Set(versions
                .map((v) => v.issue_date || v.date)
                .filter((d) => Boolean(d)))).sort();
            const lower = issue_date_gte ?? after_date;
            const upper = issue_date_lte ?? before_date;
            const filteredDates = uniqueDates.filter((d) => {
                if (lower && d < lower)
                    return false;
                if (upper && d > upper)
                    return false;
                return true;
            });
            return jsonText({
                endpoint: "/api/versioner/v1/versions/title-{title}.json",
                params: {
                    title,
                    issue_date_gte: lower ?? null,
                    issue_date_lte: upper ?? null,
                    part: part ?? null,
                    section: section ?? null,
                },
                data: {
                    title,
                    versions: filteredDates.map((d) => {
                        const sample = versions.find((v) => (v.issue_date || v.date) === d);
                        if (part && sample?.part && String(sample.part) !== String(part))
                            return null;
                        if (section &&
                            sample?.identifier &&
                            String(sample.identifier) !== String(section))
                            return null;
                        return {
                            date: d,
                            issue_date: d,
                            volume: sample?.volume ?? null,
                            part: sample?.part ?? null,
                            section: sample?.identifier ?? null,
                            name: sample?.name ?? null,
                        };
                    }).filter(Boolean),
                },
            });
        }
        catch (err) {
            return errorText(`Error fetching eCFR title versions: ${err?.message || String(err)}`);
        }
    });
    // ---------------------------------------------------------------------------
    // TOOL: ecfr_get_title_structure
    // Retrieve title hierarchy (JSON default) for a specific date
    // ---------------------------------------------------------------------------
    anyServer.tool("ecfr_get_title_structure", {
        title: z
            .number()
            .int()
            .min(1)
            .max(50)
            .describe("CFR title number, e.g. 21."),
        date: z.string().min(1).describe("Point-in-time date in YYYY-MM-DD format."),
        part: z.string().optional().describe("Optional part number, e.g. '1306'."),
        format: z.enum(["json", "xml"]).optional().describe("Return format (json | xml). Defaults to json."),
    }, async (args) => {
        const { title, date, part, format } = args;
        const fmt = format ?? "json";
        const extension = fmt === "xml" ? "xml" : "json";
        try {
            const path = `/api/versioner/v1/structure/${encodeURIComponent(date)}/title-${encodeURIComponent(String(title))}.${extension}`;
            const url = new URL(path, ECFR_BASE);
            if (part)
                url.searchParams.set("part", part);
            if (fmt === "xml") {
                const res = await fetch(url.toString());
                if (!res.ok) {
                    const body = await res.text().catch(() => "");
                    throw new Error(`HTTP ${res.status} ${res.statusText} from ${url.toString()}` +
                        (body ? ` — body: ${body.slice(0, 500)}` : ""));
                }
                const xml = await res.text();
                return {
                    content: [
                        {
                            type: "text",
                            text: xml,
                        },
                    ],
                };
            }
            const data = await fetchJson(url.toString());
            return jsonText({
                endpoint: "/api/versioner/v1/structure/{date}/title-{title}.json",
                params: {
                    title,
                    date,
                    part: part ?? null,
                },
                data,
            });
        }
        catch (err) {
            return errorText(`Error fetching eCFR title structure: ${err?.message || String(err)}`);
        }
    });
    // ---------------------------------------------------------------------------
    // TOOL: ecfr_get_title_ancestry
    // Retrieve full hierarchy for a title at a given date
    // ---------------------------------------------------------------------------
    anyServer.tool("ecfr_get_title_ancestry", {
        title: z
            .number()
            .int()
            .min(1)
            .max(50)
            .describe("CFR title number, e.g. 21."),
        date: z.string().min(1).describe("Point-in-time date in YYYY-MM-DD format."),
    }, async (args) => {
        const { title, date } = args;
        try {
            const data = await fetchStructureJson(date, title);
            return jsonText({
                endpoint: "/api/versioner/v1/structure/{date}/title-{title}.json",
                params: { title, date },
                data,
            });
        }
        catch (err) {
            return errorText(`Error fetching eCFR title ancestry: ${err?.message || String(err)}`);
        }
    });
    // ---------------------------------------------------------------------------
    // TOOL: ecfr_search_with_date_range
    // Search results filtered by date range and optional title
    // ---------------------------------------------------------------------------
    anyServer.tool("ecfr_search_with_date_range", {
        query: z
            .string()
            .min(1)
            .describe("Search string, e.g. '21 CFR 1306.04' or 'telemedicine prescribing'."),
        title: z
            .number()
            .int()
            .min(1)
            .max(50)
            .optional()
            .describe("Optional CFR title number to scope search."),
        start_date: z
            .string()
            .optional()
            .describe("Optional start date (YYYY-MM-DD) to filter results by effective window."),
        end_date: z
            .string()
            .optional()
            .describe("Optional end date (YYYY-MM-DD) to filter results by effective window."),
        results: z
            .number()
            .int()
            .min(1)
            .max(1000)
            .optional()
            .describe("Maximum number of results to return. Defaults to 50."),
        order: z
            .enum(["relevance", "newest", "oldest"])
            .optional()
            .describe("Sort order. Defaults to 'relevance'."),
    }, async (args) => {
        const { query, title, start_date, end_date, results, order } = args;
        try {
            const url = new URL("/api/search/v1/results.json", ECFR_BASE);
            url.searchParams.set("query", query);
            url.searchParams.set("results", String(results ?? 50));
            url.searchParams.set("order", order ?? "relevance");
            const data = await fetchJson(url.toString());
            const filtered = Array.isArray(data?.results)
                ? data.results.filter((entry) => {
                    const matchesTitle = title === undefined ||
                        (entry?.hierarchy?.title && String(entry.hierarchy.title) === String(title));
                    const starts = entry?.starts_on;
                    const ends = entry?.ends_on;
                    const matchesDate = !start_date && !end_date
                        ? true
                        : rangesOverlap(start_date, end_date, starts, ends);
                    return matchesTitle && matchesDate;
                })
                : [];
            return jsonText({
                endpoint: "/api/search/v1/results.json",
                params: {
                    query,
                    title: title ?? null,
                    start_date: start_date ?? null,
                    end_date: end_date ?? null,
                    order: order ?? "relevance",
                    results: results ?? 50,
                },
                data: {
                    meta: data?.meta ?? {},
                    filtered_count: filtered.length,
                    results: filtered,
                },
            });
        }
        catch (err) {
            return errorText(`Error calling eCFR search with date range: ${err?.message || String(err)}`);
        }
    });
    // ---------------------------------------------------------------------------
    // TOOL: ecfr_get_section_content
    // Fetch content for a specific section using structure_index or lookup
    // ---------------------------------------------------------------------------
    anyServer.tool("ecfr_get_section_content", {
        title: z
            .number()
            .int()
            .min(1)
            .max(50)
            .describe("CFR title number, e.g. 21."),
        date: z.string().min(1).describe("Point-in-time date in YYYY-MM-DD format."),
        section: z.string().optional().describe("Section number, e.g. '1306.04'."),
        part: z.string().optional().describe("Part number, e.g. '1306'."),
        structure_index: z
            .number()
            .int()
            .optional()
            .describe("Optional structure_index if already known from search results."),
    }, async (args) => {
        const { title, date, section, part, structure_index } = args;
        try {
            let targetIndex = structure_index;
            let matchedResult;
            if (!targetIndex) {
                if (!section) {
                    return errorText("Provide either structure_index or a section number to locate content.");
                }
                const queries = [
                    `${title} CFR ${section}`,
                    `${section}`,
                    part ? `${part} ${section}` : null,
                ].filter(Boolean);
                for (const q of queries) {
                    const searchUrl = new URL("/api/search/v1/results.json", ECFR_BASE);
                    searchUrl.searchParams.set("query", q);
                    searchUrl.searchParams.set("results", "200");
                    searchUrl.searchParams.set("order", "relevance");
                    const searchData = await fetchJson(searchUrl.toString());
                    const candidates = Array.isArray(searchData?.results)
                        ? searchData.results
                        : [];
                    const filtered = candidates.filter((entry) => {
                        const matchesSection = entry?.hierarchy?.section &&
                            String(entry.hierarchy.section) === String(section);
                        const matchesPart = part
                            ? entry?.hierarchy?.part && String(entry.hierarchy.part) === String(part)
                            : true;
                        const matchesTitle = entry?.hierarchy?.title && String(entry.hierarchy.title) === String(title);
                        return matchesSection && matchesPart && matchesTitle;
                    });
                    if (filtered.length > 0) {
                        matchedResult = filtered[0];
                        targetIndex = matchedResult?.structure_index;
                        if (targetIndex)
                            break;
                    }
                }
            }
            if (!targetIndex) {
                return errorText("Unable to resolve structure_index for requested section.");
            }
            try {
                const path = `/api/versioner/v1/content/${encodeURIComponent(date)}/${encodeURIComponent(String(targetIndex))}`;
                const url = new URL(path, ECFR_BASE);
                const res = await fetch(url.toString());
                if (!res.ok) {
                    const body = await res.text().catch(() => "");
                    throw new Error(`HTTP ${res.status} ${res.statusText} from ${url.toString()}` +
                        (body ? ` — body: ${body.slice(0, 500)}` : ""));
                }
                const contentType = res.headers.get("content-type") || "";
                const bodyText = await res.text();
                let parsed = null;
                if (contentType.includes("application/json")) {
                    try {
                        parsed = JSON.parse(bodyText);
                    }
                    catch {
                        parsed = null;
                    }
                }
                return jsonText({
                    endpoint: "/api/versioner/v1/content/{date}/{structure_index}",
                    params: {
                        title,
                        date,
                        section: section ?? matchedResult?.hierarchy?.section ?? null,
                        part: part ?? matchedResult?.hierarchy?.part ?? null,
                        structure_index: targetIndex,
                    },
                    content: parsed ?? bodyText,
                    heading: matchedResult?.headings?.section ?? null,
                    citation: matchedResult?.hierarchy?.section && matchedResult?.hierarchy?.title
                        ? `${matchedResult.hierarchy.title} CFR ${matchedResult.hierarchy.section}`
                        : null,
                    hierarchy: matchedResult?.hierarchy ?? null,
                });
            }
            catch (err) {
                if (section) {
                    try {
                        const xmlPath = `/api/versioner/v1/full/${encodeURIComponent(date)}/title-${encodeURIComponent(String(title))}.xml`;
                        const xmlUrl = new URL(xmlPath, ECFR_BASE);
                        if (part)
                            xmlUrl.searchParams.set("part", part);
                        xmlUrl.searchParams.set("section", section);
                        const res = await fetch(xmlUrl.toString());
                        if (!res.ok) {
                            const body = await res.text().catch(() => "");
                            throw new Error(`HTTP ${res.status} ${res.statusText} from ${xmlUrl.toString()}` +
                                (body ? ` — body: ${body.slice(0, 500)}` : ""));
                        }
                        const xml = await res.text();
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: xml,
                                },
                            ],
                        };
                    }
                    catch (xmlErr) {
                        return errorText(`Error fetching eCFR section content: ${xmlErr?.message || err?.message || String(err)}`);
                    }
                }
                return errorText(`Error fetching eCFR section content: ${err?.message || String(err)}`);
            }
        }
        catch (err) {
            return errorText(`Error fetching eCFR section content: ${err?.message || String(err)}`);
        }
    });
    // ---------------------------------------------------------------------------
    // TOOL: ecfr_compare_title_dates
    // Compare structures between two dates and report changes
    // ---------------------------------------------------------------------------
    anyServer.tool("ecfr_compare_title_dates", {
        title: z
            .number()
            .int()
            .min(1)
            .max(50)
            .describe("CFR title number, e.g. 21."),
        start_date: z
            .string()
            .min(1)
            .describe("Earlier date in YYYY-MM-DD format."),
        end_date: z
            .string()
            .min(1)
            .describe("Later date in YYYY-MM-DD format."),
        part: z.string().optional().describe("Optional part number to focus comparison."),
        change_types: z
            .array(z.enum(["added", "removed", "modified", "effective", "cross_reference"]))
            .optional()
            .describe("Optional filter for change categories."),
    }, async (args) => {
        const { title, start_date, end_date, part, change_types } = args;
        try {
            const meta = await fetchTitleMeta(title);
            const latestIssue = meta?.latest_issue_date;
            const effectiveEnd = latestIssue && end_date > latestIssue ? latestIssue : end_date;
            const { summary, changes } = await diffTitleStructures(title, start_date, effectiveEnd, part, change_types);
            return jsonText({
                endpoint: "composite: structure comparison",
                params: {
                    title,
                    start_date,
                    end_date: effectiveEnd,
                    part: part ?? null,
                    change_types: change_types ?? null,
                },
                summary,
                changes,
            });
        }
        catch (err) {
            return errorText(`Error comparing eCFR title snapshots: ${err?.message || String(err)}`);
        }
    });
    // ---------------------------------------------------------------------------
    // TOOL: ecfr_get_recent_changes
    // Convenience wrapper around compare_title_dates for trailing window
    // ---------------------------------------------------------------------------
    anyServer.tool("ecfr_get_recent_changes", {
        title: z
            .number()
            .int()
            .min(1)
            .max(50)
            .describe("CFR title number, e.g. 21."),
        days: z
            .number()
            .int()
            .min(1)
            .optional()
            .describe("Number of days to look back. Defaults to 180."),
        part: z.string().optional().describe("Optional part number to filter."),
        end_date: z
            .string()
            .optional()
            .describe("End date in YYYY-MM-DD format. Defaults to today."),
        change_types: z
            .array(z.enum(["added", "removed", "modified", "effective", "cross_reference"]))
            .optional()
            .describe("Optional change type filter."),
    }, async (args) => {
        const { title, days, part, end_date, change_types } = args;
        try {
            const meta = await fetchTitleMeta(title);
            const latestIssue = meta?.latest_issue_date;
            const requestedEnd = end_date ?? new Date().toISOString().slice(0, 10);
            const end = latestIssue && requestedEnd > latestIssue ? latestIssue : requestedEnd;
            const daysBack = days ?? 180;
            const start = new Date(end);
            start.setDate(start.getDate() - daysBack);
            const startStr = start.toISOString().slice(0, 10);
            const { summary, changes } = await diffTitleStructures(title, startStr, end, part, change_types);
            return jsonText({
                endpoint: "composite: recent change window",
                params: {
                    title,
                    start_date: startStr,
                    end_date: end,
                    part: part ?? null,
                    days: daysBack,
                    change_types: change_types ?? null,
                },
                summary,
                changes,
            });
        }
        catch (err) {
            return errorText(`Error fetching recent eCFR changes: ${err?.message || String(err)}`);
        }
    });
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
