/**
 * OpenCode Go model list, pricing and privacy data.
 *
 * Sources:
 *  - https://opencode.ai/inference/go/v1/models: current model IDs, names,
 *    token prices, Go / Go Plus / Go Teams monthly allowances, training/ZDR
 *    flags and capability metadata. This is the live Go API used by the
 *    Console and the documented models endpoint.
 *  - services/site/src/docs/content/console/go.mdx in anomalyco/opencode:
 *    exact data-retention days and the notes under the retention table.
 *
 * The dashboard is local-only: it reads the endpoint once per explicit
 * Refresh and never commits fetched data to the repository.
 *
 * We derive a blended price using a traffic-weighted usage mix measured from
 * OpenCode Data for the current Go model lineup (95.46% cache hit rate,
 * ~0.65% output+reasoning), rounded to 4.5% input / 94.85% cached / 0.65%
 * output below, and the number of blended tokens each plan's allowance buys.
 * The same global mix is applied to every model so models stay comparable.
 */

import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./env.mjs";

const GO_CACHE_FILE = path.join(ROOT, "cache", "go.json");

/** Bump when the cached payload shape or parser semantics change. */
const CACHE_VERSION = 7;

/**
 * Global token mix measured from OpenCode Go model traffic.
 *
 * The cache hit rate (cached input / cached+uncached input) is 95.46% when
 * token-weighted across the current Go lineup; output+reasoning is ~0.65% of
 * total tokens. Converting those to shares of all tokens gives 94.84% cached /
 * 4.51% uncached input / 0.65% output, rounded below.
 */
const BLEND = { cached: 0.9485, input: 0.045, output: 0.0065 };

const INFINITY = Number.POSITIVE_INFINITY;

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

const round = (n, d = 6) => Math.round(n * 10 ** d) / 10 ** d;

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

/** Parse a Markdown table starting at `start`. */
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

/** 100000 -> "100K", 512000 -> "512K", 1000000 -> "1M". */
function formatContext(size) {
  if (!Number.isFinite(size) || size <= 0) return String(size);
  if (size >= 1_000_000) {
    const millions = size / 1_000_000;
    return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`;
  }
  if (size >= 1_000) {
    const thousands = size / 1_000;
    return `${Number.isInteger(thousands) ? thousands : thousands.toFixed(1)}K`;
  }
  return String(size);
}

/** Cache-write price can be a number or a TTL-keyed object; blending doesn't use it. */
function cacheWritePrice(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value && typeof value === "object") {
    const numeric = Object.values(value).find((v) => typeof v === "number");
    return typeof numeric === "number" ? numeric : null;
  }
  return null;
}

function costRow(input, output, cache) {
  const inputPrice = input?.price ?? 0;
  const cachedRead = cache?.read ?? inputPrice;
  return {
    input: inputPrice,
    output: output?.price ?? 0,
    cachedRead,
    cachedWrite: cacheWritePrice(cache?.write),
  };
}

function scaleRow(row, factor) {
  return {
    input: row.input * factor,
    output: row.output * factor,
    cachedRead: row.cachedRead * factor,
    cachedWrite:
      typeof row.cachedWrite === "number" ? row.cachedWrite * factor : row.cachedWrite,
  };
}

/** Build context and time-based price tiers from the endpoint's cost object. */
export function buildCostTiers(model) {
  const text = model?.cost?.text ?? {};
  const base = costRow(text.input, text.output, text.input?.cache);
  const inputOverrides = Array.isArray(text.input?.overrides) ? text.input.overrides : [];
  const outputOverrides = Array.isArray(text.output?.overrides) ? text.output.overrides : [];

  const sizes = [
    ...new Set(
      [...inputOverrides, ...outputOverrides]
        .map((entry) => entry?.when?.context?.gt)
        .filter((size) => Number.isFinite(size)),
    ),
  ].sort((a, b) => a - b);

  let tiers;
  if (!sizes.length) {
    tiers = [{ tier: null, kind: null, row: base }];
  } else {
    const smallest = sizes[0];
    tiers = [{ tier: `≤ ${formatContext(smallest)} tokens`, kind: "context", row: base }];
    for (const size of sizes) {
      const inputOverride = inputOverrides.find(
        (entry) => entry?.when?.context?.gt === size,
      );
      const outputOverride = outputOverrides.find(
        (entry) => entry?.when?.context?.gt === size,
      );
      tiers.push({
        tier: `> ${formatContext(size)} tokens`,
        kind: "context",
        row: {
          input: inputOverride?.price ?? base.input,
          output: outputOverride?.price ?? base.output,
          cachedRead: inputOverride?.cache?.read ?? base.cachedRead,
          cachedWrite: cacheWritePrice(inputOverride?.cache?.write) ?? base.cachedWrite,
        },
      });
    }
  }

  const timeMultipliers = (model?.cost?.multipliers ?? []).filter(
    (entry) =>
      Number.isFinite(entry?.factor) &&
      Boolean(entry?.when?.utc_days || entry?.when?.utc_hours),
  );

  if (timeMultipliers.length) {
    tiers = tiers.map((tier) => ({
      ...tier,
      tier: tier.tier ? `Off-Peak · ${tier.tier}` : "Off-Peak",
      kind: "time",
    }));
    for (const multiplier of timeMultipliers) {
      tiers.push({
        tier: "Peak",
        kind: "time",
        row: scaleRow(base, multiplier.factor),
      });
    }
  }

  return tiers;
}

/** Build the blended/tokens metrics for one pricing row and plan allowance. */
function buildPricing(row, allowance, tier) {
  const input = row.input ?? 0;
  const cachedRead = row.cachedRead ?? input;
  const output = row.output ?? 0;
  const blended = round(
    BLEND.cached * cachedRead + BLEND.input * input + BLEND.output * output,
  );

  const unlimited = allowance == null || !Number.isFinite(allowance);
  const monthlyUsd = unlimited ? null : allowance;
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
    limitedTime: false,
    bonus: null,
    tier,
  };
}

/** Cheapest tier by blended price (nulls/unpriced last). */
function cheapestTier(tiers) {
  return tiers.reduce((best, candidate) => {
    if (!best) return candidate;
    const a = best.pricing?.blended ?? INFINITY;
    const b = candidate.pricing?.blended ?? INFINITY;
    return b < a ? candidate : best;
  }, null);
}

/**
 * Parse the "Privacy" section table:
 *
 *   | Model | Data retention |
 *
 * Training and ZDR flags come from the models endpoint. Returns a Map keyed by
 * normalizeKey(model name) with retention text and the associated note.
 */
export function parsePrivacy(mdx) {
  const lines = String(mdx ?? "").split(/\r?\n/);
  const heading = lines.findIndex((line) => /^##\s+privacy\s*$/i.test(line.trim()));
  if (heading === -1) return new Map();

  const table = findTable(lines, heading + 1);
  if (!table) return new Map();

  const iModel = columnIndex(table.headers, ["model"], 0);
  const iRetention = columnIndex(
    table.headers,
    ["data retention", "retention"],
    table.headers.length - 1,
  );

  const footnotes = [];
  for (let i = table.end; i < lines.length; i += 1) {
    if (/^##\s/.test(lines[i])) break;
    const match = lines[i].match(/^\s*[-*]\s+(.*)$/);
    if (match) footnotes.push(cleanCell(match[1]));
  }
  const zdrNote =
    footnotes.find((text) => /renewed monthly/i.test(text)) ??
    footnotes.find((text) => /^deepseek[:\s]/i.test(text)) ??
    null;

  const out = new Map();
  for (const cells of table.rows) {
    if (cells.length <= Math.max(iModel, iRetention)) continue;

    const name = cleanCell(cells[iModel]);
    if (!name || /^model$/i.test(name)) continue;

    const retention = cleanCell(cells[iRetention]);
    out.set(normalizeKey(name), {
      retention,
      note: retention.includes("*") ? zdrNote : null,
    });
  }
  return out;
}

/** Find retention for a model, tolerating checkpoint suffixes such as "1017". */
function lookupPrivacy(privacy, name) {
  const direct = privacy.get(normalizeKey(name));
  if (direct) return direct;
  const withoutCheckpoint = String(name ?? "").replace(/\s+\d{4,}\s*$/, "");
  return privacy.get(normalizeKey(withoutCheckpoint)) ?? null;
}

function buildPrivacy(model, privacy) {
  const source = lookupPrivacy(privacy, model.name);
  const training = Boolean(model.go?.training);
  const zdr = Boolean(model.go?.zdr);
  const retention =
    source?.retention ?? (zdr ? "0 days" : training ? "Not ZDR" : "Retained");

  return {
    training: training ? "Yes" : "Not used",
    retention,
    zdr,
    group: training ? "contributor" : zdr ? "zdr" : "retained",
    note: source?.note ?? null,
  };
}

/**
 * Build dashboard models from the live models endpoint and the retention table.
 *
 * @param {object} endpoint  parsed /inference/go/v1/models response
 * @param {string} privacyMdx contents of go.mdx (optional; retention only)
 */
export function parseGoData(endpoint, privacyMdx = "") {
  const sourceModels = Array.isArray(endpoint?.data) ? endpoint.data : null;
  if (!sourceModels) throw new Error("Go models response has no data array");

  const privacy = parsePrivacy(privacyMdx);
  const models = [];

  for (const source of sourceModels) {
    if (!source?.id || !source?.name) continue;

    const monthly = source.go?.monthly_usage ?? {};
    const allowance = monthly.go ?? null;
    const plusAllowance = monthly["go-plus"] ?? null;
    const teamsAllowance = monthly["go-teams"] ?? null;

    const costTiers = buildCostTiers(source);
    const tiers = costTiers.map((costTier) => {
      const plans = {
        go: buildPricing(costTier.row, allowance, costTier.tier),
        plus: buildPricing(costTier.row, plusAllowance, costTier.tier),
        teams: buildPricing(costTier.row, teamsAllowance, costTier.tier),
      };
      return {
        tier: costTier.tier,
        kind: costTier.kind,
        pricing: plans.go,
        plans,
      };
    });

    const cheapest = cheapestTier(tiers) ?? tiers[0] ?? null;
    const plans = cheapest?.plans ?? {};

    models.push({
      id: source.id,
      type: source.type ?? "chat",
      canonicalId: source.canonical_id ?? null,
      base: source.name,
      name: source.name,
      tier: cheapest?.tier ?? null,
      displayName: source.name,
      pricing: plans.go ?? null,
      plans,
      tiers,
      privacy: buildPrivacy(source, privacy),
    });
  }

  return { models, privacy };
}

/** Read the last successfully parsed Go payload from disk. */
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

/** Persist the parsed Go payload so restarts do not re-fetch the sources. */
export function writeGoCache(models, meta = {}) {
  fs.mkdirSync(path.dirname(GO_CACHE_FILE), { recursive: true });
  const payload = {
    version: CACHE_VERSION,
    fetchedAt: meta.fetchedAt ?? new Date().toISOString(),
    source: meta.source ?? null,
    docs: meta.docs ?? null,
    models,
  };
  fs.writeFileSync(GO_CACHE_FILE, JSON.stringify(payload, null, 1), "utf8");
  return payload;
}

async function fetchText(url, label) {
  const res = await fetch(url, {
    headers: {
      accept: "text/plain, application/json, */*;q=0.1",
      "user-agent":
        "opencode-go-model-dashboard/1.0 (+https://github.com/ucruz-cs/opencode-go-model-dashboard)",
    },
  });
  if (!res.ok) throw new Error(`${label} request failed: HTTP ${res.status}`);
  return res.text();
}

/**
 * Fetch the live Go models endpoint and the docs retention table. The docs
 * fetch is optional: without it the models still build with ZDR / retained
 * labels derived from the endpoint.
 */
export async function fetchGoData({ modelsUrl, docsUrl }) {
  const [modelsText, docs] = await Promise.all([
    fetchText(modelsUrl, "OpenCode Go models"),
    docsUrl
      ? fetchText(docsUrl, "OpenCode Go docs")
          .then((text) => ({ text }))
          .catch((error) => ({ error }))
      : Promise.resolve({ text: "" }),
  ]);

  const parsed = parseGoData(JSON.parse(modelsText), docs.text ?? "");
  if (docs.error) {
    return {
      ...parsed,
      warning: `OpenCode Go docs: ${docs.error.message}`,
    };
  }
  return parsed;
}
