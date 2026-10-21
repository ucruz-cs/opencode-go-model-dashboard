/**
 * OpenCode Go model list, pricing and privacy data.
 *
 * Parsed from the MIT-licensed documentation source in the anomalyco/opencode
 * repository, which is what renders https://opencode.ai/v2/docs/console/go/:
 *
 *   services/www/src/docs/content/console/go.mdx
 *
 * The Go panel lists per model: Input, Output, Cached Read, Cached Write
 * (all $ per 1M tokens) and a Monthly limit (in $, or Unlimited).
 *
 * We derive a blended price using a traffic-weighted usage mix measured from
 * OpenCode Data for the current Go model lineup (95.46% cache hit rate,
 * ~0.65% output+reasoning), rounded to 4.5% input / 94.85% cached / 0.65%
 * output below, and the number of blended tokens the monthly allowance buys.
 * The same global mix is applied to every model so models stay comparable.
 */

import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./env.mjs";

const GO_CACHE_FILE = path.join(ROOT, "cache", "go.json");

/** Bump when the cached payload shape or parser semantics change. */
const CACHE_VERSION = 2;

/**
 * Global token mix measured from OpenCode Go model traffic.
 *
 * The cache hit rate (cached input / cached+uncached input) is 95.46% when
 * token-weighted across the 29 models currently in Go; output+reasoning is
 * ~0.65% of total tokens. Converting those to shares of all tokens gives
 * 94.84% cached / 4.51% uncached input / 0.65% output, rounded below.
 */
const BLEND = { cached: 0.9485, input: 0.045, output: 0.0065 };

/** Normalise a model name or id to a comparable key (letters + digits only). */
export function normalizeKey(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/**
 * Strip inline Markdown/HTML decoration from a table cell. Escaped asterisks
 * (used for footnote markers such as "0 days\*") survive as literal "*".
 */
function cleanCell(value) {
  return String(value ?? "")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\\\*/g, "\u0000")
    .replace(/[*_`~]+/g, "")
    .replace(/\u0000/g, "*")
    .replace(/\s+/g, " ")
    .trim();
}

/** "$0.15" -> 0.15, "Free" -> 0, "-" -> null. */
function toMoney(text) {
  const t = String(text ?? "").trim();
  if (!t || t === "-") return null;
  if (/free/i.test(t)) return 0;
  const m = t.match(/\$?\s*([0-9]+(?:\.[0-9]+)?)/);
  return m ? Number(m[1]) : null;
}

/**
 * Monthly-limit cell. Markdown bolds the current value and strikes through the
 * old one: "~~$15~~ **$60**<br /><small>4x · Limited time</small>".
 */
function parseMonthly(cell) {
  const raw = String(cell ?? "");
  const limitedTime = /limited\s*time/i.test(raw);
  const bonusMatch = raw.match(/(\d+)\s*(?:x|×)/i);
  const current = raw.replace(/~~[\s\S]*?~~/g, " ");
  const text = cleanCell(current);
  const unlimited = /unlimited/i.test(text);
  return {
    value: unlimited ? null : toMoney(text),
    unlimited,
    limitedTime,
    bonus: bonusMatch ? Number(bonusMatch[1]) : null,
  };
}

/** "Grok 4.7 (≤ 200K tokens)" -> { base: "Grok 4.7", tier: "≤ 200K tokens" } */
function splitTier(name) {
  const m = String(name).match(/^(.*?)\s*\(([^)]+)\)\s*$/);
  return m ? { base: m[1].trim(), tier: m[2].trim() } : { base: String(name).trim(), tier: null };
}

function slugify(name) {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** True for a Markdown table row (leading indentation is allowed). */
function isTableLine(line) {
  return /^\s*\|/.test(line);
}

/** Split a Markdown table row on unescaped pipes. */
function splitRow(line) {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);

  const cells = [];
  let current = "";
  for (let i = 0; i < s.length; i += 1) {
    const char = s[i];
    if (char === "\\" && s[i + 1] === "|") {
      current += "|";
      i += 1;
      continue;
    }
    if (char === "|") {
      cells.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  cells.push(current);
  return cells.map((cell) => cell.trim());
}

/** Separator row: only dashes, colons, pipes and whitespace, with at least one dash. */
function isSeparator(line) {
  return /^[\s|:-]+$/.test(line) && line.includes("-");
}

/**
 * Parse a Markdown table starting at `start`.
 * @returns {{ headers: string[], rows: string[][], end: number } | null}
 */
function parseTableAt(lines, start) {
  if (!isTableLine(lines[start])) return null;
  if (start + 1 >= lines.length || !isSeparator(lines[start + 1])) return null;

  const headers = splitRow(lines[start]).map((h) => cleanCell(h).toLowerCase());
  const rows = [];
  let i = start + 2;
  while (i < lines.length && isTableLine(lines[i])) {
    const cells = splitRow(lines[i]);
    if (cells.some((cell) => cell !== "")) rows.push(cells);
    i += 1;
  }
  return { headers, rows, end: i };
}

/** Find the first Markdown table at or after `from`. */
function findTable(lines, from = 0) {
  for (let i = from; i < lines.length; i += 1) {
    if (!isTableLine(lines[i])) continue;
    const table = parseTableAt(lines, i);
    if (table) return table;
  }
  return null;
}

/** First matching header index, or the fallback. */
function columnIndex(headers, names, fallback) {
  for (const name of names) {
    const index = headers.indexOf(name);
    if (index !== -1) return index;
  }
  return fallback;
}

/** Slice a <PlanTabs id="…"> block. */
function planTabsBlock(mdx, id) {
  const start = mdx.indexOf(`<PlanTabs id="${id}"`);
  if (start === -1) return null;
  const end = mdx.indexOf("</PlanTabs>", start);
  return end === -1 ? null : mdx.slice(start, end);
}

/** Slice the content of a <div slot="…"> inside a PlanTabs block. */
function slotBlock(block, slot) {
  const open = `<div slot="${slot}">`;
  const start = block.indexOf(open);
  if (start === -1) return null;
  const end = block.indexOf("</div>", start);
  if (end === -1) return null;
  return block.slice(start + open.length, end);
}

/** Classify a tier qualifier: peak/off-peak pricing vs context-window pricing. */
function tierKind(tier) {
  if (!tier) return null;
  return /peak/i.test(tier) ? "time" : "context";
}

/** Build the blended/tokens metrics for one pricing row. */
function buildPricing(row, tier) {
  const input = row.input ?? 0;
  const cachedRead = row.cachedRead ?? input;
  const output = row.output ?? 0;
  const blended = round(
    BLEND.cached * cachedRead + BLEND.input * input + BLEND.output * output,
  );

  const unlimited = row.monthly.unlimited;
  const monthlyUsd = row.monthly.value;
  const monthlyTokens = unlimited || blended <= 0 ? null : monthlyUsd / blended;

  return {
    input: row.input,
    output: row.output,
    cachedRead: row.cachedRead,
    cachedWrite: row.cachedWrite,
    blended,
    monthlyUsd,
    monthlyTokens,
    unlimited,
    limitedTime: row.monthly.limitedTime,
    bonus: row.monthly.bonus,
    tier,
  };
}

/** Cheapest tier by blended price (nulls/unpriced last). */
function cheapestTier(tiers) {
  return tiers.reduce((best, candidate) => {
    if (!best) return candidate;
    const a = best.pricing?.blended ?? Infinity;
    const b = candidate.pricing?.blended ?? Infinity;
    return b < a ? candidate : best;
  }, null);
}

/**
 * Parse one plan panel into a Map of base name -> { tiers: [{ tier, kind, pricing }] }.
 * @param {string} block  the <PlanTabs id="go-pricing"> block
 * @param {"go"|"go-plus"} slot
 */
function parsePanel(block, slot) {
  const section = slotBlock(block, slot);
  if (!section) return null;

  const table = findTable(section.split(/\r?\n/));
  if (!table || table.rows.length === 0) return null;

  const iName = columnIndex(table.headers, ["model"], 0);
  const iInput = columnIndex(table.headers, ["input"], 1);
  const iOutput = columnIndex(table.headers, ["output"], 2);
  const iCachedRead = columnIndex(table.headers, ["cached read"], 3);
  const iCachedWrite = columnIndex(table.headers, ["cached write"], 4);
  const iMonthly = columnIndex(table.headers, ["monthly limit", "monthly"], 5);

  // Keep every tier as its own pricing entry. Context-window and peak/off-peak
  // rows are distinguished by their qualifier, not collapsed.
  const byBase = new Map();
  for (const cells of table.rows) {
    if (cells.length <= Math.max(iName, iInput, iOutput, iCachedRead, iMonthly)) continue;

    const name = cleanCell(cells[iName]);
    if (!name || /^model$/i.test(name)) continue;

    const row = {
      input: toMoney(cleanCell(cells[iInput])),
      output: toMoney(cleanCell(cells[iOutput])),
      cachedRead: toMoney(cleanCell(cells[iCachedRead])),
      cachedWrite: toMoney(cleanCell(cells[iCachedWrite])),
      monthly: parseMonthly(cells[iMonthly]),
    };

    const { base, tier } = splitTier(name);
    if (!byBase.has(base)) byBase.set(base, { tiers: [] });

    const entry = byBase.get(base);
    const key = tier ?? "";
    if (entry.tiers.some((t) => (t.tier ?? "") === key)) continue;

    entry.tiers.push({
      tier: tier ?? null,
      kind: tierKind(tier),
      pricing: buildPricing(row, tier ?? null),
    });
  }

  return byBase.size > 0 ? byBase : null;
}

/**
 * Parse the "Privacy" section table:
 *
 *   ## Privacy
 *
 *   | Model | Model training | Data retention |
 *
 * A retention of "0 days" (including the "0 days*" variant) means zero data
 * retention. Returns a Map keyed by normalizeKey(model name).
 */
function parsePrivacy(mdx) {
  const lines = mdx.split(/\r?\n/);
  const heading = lines.findIndex((line) => /^##\s+privacy\s*$/i.test(line.trim()));
  if (heading === -1) return new Map();

  const table = findTable(lines, heading + 1);
  if (!table) return new Map();

  const iModel = columnIndex(table.headers, ["model"], 0);
  const iTraining = columnIndex(table.headers, ["model training", "training"], 1);
  const iRetention = columnIndex(table.headers, ["data retention", "retention"], 2);

  // The bullet list after the table carries caveats. The "*" marker belongs to
  // DeepSeek, whose note is the one mentioning the monthly ZDR renewal.
  const footnotes = [];
  for (let i = table.end; i < lines.length; i += 1) {
    if (/^##\s/.test(lines[i])) break;
    const m = lines[i].match(/^\s*[-*]\s+(.*)$/);
    if (m) footnotes.push(cleanCell(m[1]));
  }
  const zdrNote =
    footnotes.find((text) => /renewed monthly/i.test(text)) ??
    footnotes.find((text) => /^deepseek[:\s]/i.test(text)) ??
    null;

  const out = new Map();
  for (const cells of table.rows) {
    if (cells.length <= Math.max(iModel, iTraining, iRetention)) continue;

    const name = cleanCell(cells[iModel]);
    if (!name || /^model$/i.test(name)) continue;

    const training = cleanCell(cells[iTraining]);
    const retention = cleanCell(cells[iRetention]);

    const zdr = /^0\s*days/i.test(retention);
    const group = /^yes/i.test(training)
      ? "contributor"
      : zdr
        ? "zdr"
        : retention
          ? "retained"
          : "unknown";

    out.set(normalizeKey(name), {
      training,
      retention,
      zdr,
      group,
      note: retention.includes("*") ? zdrNote : null,
    });
  }
  return out;
}

const round = (n, d = 6) => Math.round(n * 10 ** d) / 10 ** d;

/**
 * Parse the Go docs Markdown source. Each model carries every pricing tier;
 * each tier has the Go plan price and the Go Plus price. Everything else
 * (benchmarks, privacy) is shared between plans.
 *
 * @param {string} mdx  contents of services/www/src/docs/content/console/go.mdx
 */
export function parseGoDocs(mdx) {
  const text = String(mdx ?? "");
  if (/<!doctype html/i.test(text.slice(0, 2000)) || /<table/i.test(text.slice(0, 2000))) {
    return {
      models: [],
      error: "expected the go.mdx Markdown source, not the rendered HTML page",
    };
  }

  const block = planTabsBlock(text, "go-pricing");
  if (!block) return { models: [], error: "go-pricing PlanTabs block not found in go.mdx" };

  const go = parsePanel(block, "go");
  if (!go) return { models: [], error: "Go plan pricing table not found in go.mdx" };

  const plus = parsePanel(block, "go-plus");
  const privacy = parsePrivacy(text);
  if (privacy.size === 0) {
    // Not fatal: benchmarks/pricing still work, but surface it.
    console.warn("  ! OpenCode Go privacy table not found in go.mdx");
  }

  const models = [];
  for (const [base, entry] of go) {
    const plusByTier = new Map(
      (plus?.get(base)?.tiers ?? []).map((t) => [t.tier ?? "", t.pricing]),
    );

    const tiers = entry.tiers.map((t) => ({
      ...t,
      pricingPlus: plusByTier.get(t.tier ?? "") ?? null,
    }));
    const cheapest = cheapestTier(tiers) ?? tiers[0] ?? null;

    models.push({
      id: slugify(base),
      base,
      name: base,
      tier: cheapest?.tier ?? null,
      displayName: base,
      pricing: cheapest?.pricing ?? null,
      pricingPlus: cheapest?.pricingPlus ?? null,
      tiers,
      privacy: privacy.get(normalizeKey(base)) ?? null,
    });
  }

  return { models, privacy };
}

/** Read the last successfully parsed Go docs payload from disk. */
export function readGoCache() {
  try {
    const parsed = JSON.parse(fs.readFileSync(GO_CACHE_FILE, "utf8"));
    if (parsed?.version !== CACHE_VERSION) return null;
    if (!Array.isArray(parsed?.models) || parsed.models.length === 0) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Persist the parsed Go docs payload so restarts do not re-fetch the source. */
export function writeGoCache(models, meta = {}) {
  fs.mkdirSync(path.dirname(GO_CACHE_FILE), { recursive: true });
  const payload = {
    version: CACHE_VERSION,
    fetchedAt: meta.fetchedAt ?? new Date().toISOString(),
    source: meta.source ?? null,
    models,
  };
  fs.writeFileSync(GO_CACHE_FILE, JSON.stringify(payload, null, 1), "utf8");
  return payload;
}

export async function fetchGoDocs(url) {
  const res = await fetch(url, {
    headers: {
      accept: "text/plain, text/markdown;q=0.9, */*;q=0.1",
      "user-agent":
        "opencode-go-model-dashboard/1.0 (+https://github.com/ucruz-cs/opencode-go-model-dashboard)",
    },
  });
  if (!res.ok) throw new Error(`OpenCode Go docs request failed: HTTP ${res.status}`);
  return parseGoDocs(await res.text());
}
