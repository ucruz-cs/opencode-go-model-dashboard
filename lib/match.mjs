import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./env.mjs";

/**
 * Ranking for Artificial Analysis reasoning-effort variants. Higher wins when
 * two candidates share a normalised core and the same number of stripped tokens.
 */
const VARIANT_RANK = {
  xhigh: 6,
  max: 5,
  high: 4,
  medium: 3,
  reasoning: 2,
  thinking: 2,
  low: 1,
  min: 0,
  nonreasoning: 0,
};

const GO_SUFFIX_TOKENS = new Set(["free", "preview", "contributor"]);

/** Normalise an AA slug into a comparable core key plus variant metadata. */
function analyzeSlug(slug) {
  let s = String(slug ?? "").toLowerCase();
  s = s.replace(/non-?reasoning/g, "nonreasoning");

  const parts = s.split(/[^a-z0-9]+/).filter(Boolean);
  let removed = 0;
  let rank = 0;
  const kept = [];

  for (const part of parts) {
    if (/^\d{4,}$/.test(part)) {
      removed += 1; // date stamp such as 0813 / 20250902
      continue;
    }
    if (part in VARIANT_RANK) {
      removed += 1;
      rank = Math.max(rank, VARIANT_RANK[part]);
      continue;
    }
    kept.push(part);
  }

  return { core: kept.join(""), removed, rank };
}

/** Normalise an OpenCode Go model name into the same core key space. */
function goCore(name) {
  const parts = String(name ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const kept = parts.filter((p) => !GO_SUFFIX_TOKENS.has(p) && !(p in VARIANT_RANK));
  return kept.join("");
}

function baseDisplayName(name) {
  return (
    String(name ?? "")
      .replace(/\s*\([^)]*\)\s*$/, "") // drop the variant, e.g. "(Max)"
      .replace(/\s+\d{4,}$/, "") // drop trailing date stamps, e.g. "0813"
      .trim() || String(name ?? "")
  );
}

function variantLabel(name) {
  const m = String(name ?? "").match(/\(([^)]+)\)\s*$/);
  return m ? m[1] : null;
}

function loadOverrides() {
  const file = path.join(ROOT, "overrides.json");
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    const out = new Map();
    for (const [key, value] of Object.entries(raw)) {
      if (key.startsWith("_")) continue;
      if (typeof value === "string") out.set(key, { slug: value, note: null });
      else if (value && typeof value.slug === "string")
        out.set(key, { slug: value.slug, note: value.note ?? null });
    }
    return out;
  } catch {
    return new Map();
  }
}

function toRecord(goModel, aa, { viaOverride = false, note = null } = {}) {
  const ev = aa.evaluations ?? {};
  const num = (v) => (typeof v === "number" ? v : null);

  return {
    id: goModel.id,
    baseId: goModel.id,
    name: goModel.displayName,
    creator: aa.model_creator?.name ?? null,
    variant: variantLabel(aa.name),
    aaSlug: aa.slug,
    aaName: aa.name,
    releaseDate: aa.release_date ?? null,
    url: `https://artificialanalysis.ai/models/${encodeURIComponent(aa.slug)}`,
    viaOverride,
    note,
    pricing: goModel.pricing ?? null,
    pricingPlus: goModel.pricingPlus ?? null,
    tiers: goModel.tiers ?? [],
    privacy: goModel.privacy ?? null,
    metrics: {
      intelligence: num(ev.artificial_analysis_intelligence_index),
      coding: num(ev.artificial_analysis_coding_index),
      agentic: num(ev.artificial_analysis_agentic_index),
      finance: num(ev.artificial_analysis_finance_and_accounting_index),
      strategy: num(ev.artificial_analysis_strategy_and_ops_index),
      legal: num(ev.artificial_analysis_legal_index),
      healthcare: num(ev.artificial_analysis_healthcare_and_medical_index),
      engineering: num(ev.artificial_analysis_engineering_index),
      economics: num(ev.artificial_analysis_economics_index),
    },
  };
}

/**
 * Join the OpenCode Go docs model list against the Artificial Analysis catalogue.
 *
 * @param {Array} goModels  entries from parseGoDocs(): { id, base, displayName, pricing }
 */
export function buildDashboard(goModels, aaModels, meta = {}) {
  const overrides = loadOverrides();

  // Group AA models by normalised slug core, keeping the best candidate per core.
  const byCore = new Map();
  const bySlug = new Map();
  for (const aa of aaModels) {
    if (!aa?.slug) continue;
    bySlug.set(aa.slug, aa);
    const info = analyzeSlug(aa.slug);
    if (!info.core) continue;
    const candidate = { aa, ...info };
    const existing = byCore.get(info.core);
    if (!existing || betterCandidate(candidate, existing)) {
      byCore.set(info.core, candidate);
    }
  }

  const models = [];
  const unmatched = [];

  for (const goModel of goModels) {
    const override = overrides.get(goModel.id);
    if (override) {
      const aa = bySlug.get(override.slug);
      if (aa) {
        models.push(
          toRecord(goModel, aa, { viaOverride: true, note: override.note }),
        );
        continue;
      }
    }

    const candidate = byCore.get(goCore(goModel.base));
    if (candidate) {
      models.push(toRecord(goModel, candidate.aa));
    } else {
      unmatched.push({
        id: goModel.id,
        baseId: goModel.id,
        name: goModel.displayName,
        pricing: goModel.pricing ?? null,
        pricingPlus: goModel.pricingPlus ?? null,
        tiers: goModel.tiers ?? [],
        privacy: goModel.privacy ?? null,
      });
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    aaFetchedAt: meta.aaFetchedAt ?? null,
    aaFromCache: Boolean(meta.aaFromCache),
    aaTier: meta.aaTier ?? null,
    goDocsFetchedAt: meta.goDocsFetchedAt ?? null,
    goDocsFromCache: Boolean(meta.goDocsFromCache),
    counts: {
      go: goModels.length,
      matched: models.length,
      unmatched: unmatched.length,
      priced: models.filter((m) => m.pricing).length,
    },
    models,
    unmatched,
  };
}

/** Prefer the plain slug, then higher reasoning effort, then the shorter slug. */
function betterCandidate(a, b) {
  if (a.removed !== b.removed) return a.removed < b.removed;
  if (a.rank !== b.rank) return a.rank > b.rank;
  if (a.aa.slug.length !== b.aa.slug.length) return a.aa.slug.length < b.aa.slug.length;
  return a.aa.slug < b.aa.slug;
}
