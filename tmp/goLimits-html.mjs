/**
 * OpenCode Go pricing, parsed from the "Usage limits" tables on the docs page
 * (https://opencode.ai/v2/docs/console/go/, identical to /docs/go/).
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

const PANEL_ATTRS = {
  go: 'data-plan-panel="go"',
  plus: 'data-plan-panel="go-plus"',
};

const GO_CACHE_FILE = path.join(ROOT, "cache", "go.json");

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

function decodeEntities(s) {
  const map = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", times: "×" };
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") {
      const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return map[e.toLowerCase()] ?? m;
  });
}

function cleanText(html) {
  return decodeEntities(String(html).replace(/<[^>]*>/g, " "))
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

/** Monthly-limit cell: current value lives in <strong>; <del> holds the old one. */
function parseMonthly(cellHtml) {
  const strong = cellHtml.match(/<strong>([\s\S]*?)<\/strong>/i);
  const text = cleanText(strong ? strong[1] : cellHtml);
  const unlimited = /unlimited/i.test(text);
  const bonusMatch = cellHtml.match(/(\d+)\s*(?:x|×)/i);
  return {
    value: unlimited ? null : toMoney(text),
    unlimited,
    limitedTime: /limited\s*time/i.test(cellHtml),
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

/**
 * Parse the "Privacy" section table:
 *
 *   <h2 id="privacy">Privacy</h2>
 *   <table><thead>…<th>Model</th><th>Model training</th><th>Data retention</th>…
 *
 * A retention of "0 days" (including the "0 days*" variant) means zero data
 * retention. Returns a Map keyed by normalizeKey(model name).
 */
function parsePrivacy(html) {
  const sectionStart = html.search(/id=["']privacy["']/i);
  if (sectionStart === -1) return new Map();

  const tableStart = html.indexOf("<table", sectionStart);
  const tableEnd = tableStart === -1 ? -1 : html.indexOf("</table>", tableStart);
  if (tableStart === -1 || tableEnd === -1) return new Map();
  const table = html.slice(tableStart, tableEnd);

  const heads = [...table.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/gi)].map((m) =>
    cleanText(m[1]).toLowerCase(),
  );
  const iModel = heads.indexOf("model");
  const iTraining = heads.indexOf("model training");
  const iRetention = heads.indexOf("data retention");

  // The footnote list after the table carries caveats. The "*" marker belongs
  // to DeepSeek, whose note is the one mentioning the monthly ZDR renewal.
  const nextHeading = html.indexOf("<h2", tableEnd);
  const footnoteHtml = html.slice(tableEnd, nextHeading === -1 ? undefined : nextHeading);
  const footnotes = [...footnoteHtml.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)].map((m) =>
    cleanText(m[1]),
  );
  const zdrNote =
    footnotes.find((t) => /renewed monthly/i.test(t)) ??
    footnotes.find((t) => /^deepseek[:\s]/i.test(t)) ??
    null;

  const out = new Map();
  for (const tr of table.matchAll(/<tr>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...tr[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) =>
      cleanText(m[1]),
    );
    if (cells.length < 3) continue;

    const name = cells[iModel >= 0 ? iModel : 0];
    const training = cells[iTraining >= 0 ? iTraining : 1];
    const retention = cells[iRetention >= 0 ? iRetention : 2];

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

/** Slice the first <table>…</table> inside a plan panel. */
function panelTable(html, attr) {
  const panel = html.indexOf(attr);
  if (panel === -1) return null;
  const start = html.indexOf("<table", panel);
  if (start === -1) return null;
  const end = html.indexOf("</table>", start);
  if (end === -1) return null;
  return html.slice(start, end);
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

/** Parse one plan panel into a Map of base name -> { tiers: [{ tier, kind, pricing }] }. */
function parsePanel(html, attr) {
  const table = panelTable(html, attr);
  if (!table) return null;

  const rows = [];
  for (const tr of table.matchAll(/<tr>([\s\S]*?)<\/tr>/g)) {
    const tds = [...tr[1].matchAll(/<td>([\s\S]*?)<\/td>/g)].map((m) => m[1]);
    if (tds.length < 6) continue; // header row uses <th>

    rows.push({
      name: cleanText(tds[0]),
      input: toMoney(cleanText(tds[1])),
      output: toMoney(cleanText(tds[2])),
      cachedRead: toMoney(cleanText(tds[3])),
      cachedWrite: toMoney(cleanText(tds[4])),
      monthly: parseMonthly(tds[5]),
    });
  }
  if (rows.length === 0) return null;

  // Keep every tier as its own pricing entry. Context-window and peak/off-peak
  // rows are distinguished by their qualifier, not collapsed.
  const byBase = new Map();
  for (const row of rows) {
    const { base, tier } = splitTier(row.name);
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
  return byBase;
}

/**
 * Parse both subscription plans from the Go docs page. Each model carries every
 * pricing tier; each tier has the Go plan price and the Go Plus price. Everything
 * else (benchmarks, privacy) is shared between plans.
 */
export function parseGoDocs(html) {
  const go = parsePanel(html, PANEL_ATTRS.go);
  if (!go) return { models: [], error: "Go plan panel not found" };

  const plus = parsePanel(html, PANEL_ATTRS.plus);
  const privacy = parsePrivacy(html);

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
    if (!Array.isArray(parsed?.models) || parsed.models.length === 0) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Persist the parsed Go docs payload so restarts do not re-fetch the page. */
export function writeGoCache(models, meta = {}) {
  fs.mkdirSync(path.dirname(GO_CACHE_FILE), { recursive: true });
  const payload = {
    fetchedAt: meta.fetchedAt ?? new Date().toISOString(),
    source: meta.source ?? null,
    models,
  };
  fs.writeFileSync(GO_CACHE_FILE, JSON.stringify(payload, null, 1), "utf8");
  return payload;
}

export async function fetchGoDocs(url) {
  const res = await fetch(url, { headers: { accept: "text/html" } });
  if (!res.ok) throw new Error(`OpenCode Go docs request failed: HTTP ${res.status}`);
  const html = await res.text();
  return parseGoDocs(html);
}
