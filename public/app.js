let dashboard = null;
let sortKey = "intelligence";
let sortDir = "desc";
let plan = "go"; // "go" | "plus"
let privacyFilter = "all"; // "all" | "notraining" | "zdr"
let tierFilter = "cheap"; // "cheap" | "both" | "expensive"
let logX = true; // usage (tokens/mo) axis scale
const charts = {};
let currentVariants = [];

/** Pricing for the selected subscription plan (falls back to Go if Plus is missing). */
function activePricing(model) {
  if (model.isVariant) return model.pricing;
  return plan === "plus" ? (model.pricingPlus ?? model.pricing) : model.pricing;
}

/** Pricing for one tier under the selected subscription plan. */
function planPricing(tier) {
  return plan === "plus" ? (tier.pricingPlus ?? tier.pricing) : tier.pricing;
}

/** Blended price used to order tiers; unpriced tiers sort last. */
function tierBlend(pricing) {
  if (!pricing) return Infinity;
  if (pricing.unlimited) return 0;
  return pricing.blended ?? Infinity;
}

/** Every tier for a model, with a synthetic single tier for legacy/unpriced entries. */
function modelTiers(model) {
  if (model.tiers?.length) return model.tiers;
  return [
    {
      tier: null,
      kind: null,
      pricing: model.pricing,
      pricingPlus: model.pricingPlus,
    },
  ];
}

/**
 * Expand a base model into the variant rows required by the current tier filter.
 * "both" keeps every tier; otherwise only the lowest/highest blended price.
 */
function tierVariants(model) {
  const allTiers = modelTiers(model).map((tier, index) => ({
    ...tier,
    index,
    active: planPricing(tier),
  }));

  const blends = allTiers.map((t) => tierBlend(t.active));
  const min = Math.min(...blends);
  const max = Math.max(...blends);

  let selected = allTiers;
  if (tierFilter !== "both" && allTiers.length > 1) {
    const pick = (a, b) =>
      tierFilter === "expensive"
        ? tierBlend(b.active) > tierBlend(a.active)
          ? b
          : a
        : tierBlend(b.active) < tierBlend(a.active)
          ? b
          : a;
    selected = [allTiers.reduce(pick)];
  }

  return selected.map((tier) => ({
    ...model,
    isVariant: true,
    baseId: model.id,
    variantId: `${model.id}--${tier.index}`,
    tier: tier.tier,
    tierKind: tier.kind,
    tierIndex: tier.index,
    pricing: tier.active,
    pricingPlus: undefined,
    isCheapestTier: tierBlend(tier.active) === min,
    isMostExpensiveTier: tierBlend(tier.active) === max,
    multipleTiers: allTiers.length > 1,
  }));
}

/** Display label for a variant, including its tier qualifier when present. */
function variantLabel(model) {
  return model.tier ? `${model.name} (${model.tier})` : model.name;
}

const fmt = {
  num: (v, d = 1) => (v == null ? "–" : v.toFixed(d)),
};

function fmtBlended(pricing) {
  if (!pricing || pricing.blended == null) return "–";
  const v = pricing.blended;
  if (v === 0) return "$0";
  return `$${v < 1 ? v.toFixed(3) : v.toFixed(2)}`;
}

/** Unlimited models have no finite tokens/month figure. */
function isUnlimitedPricing(pricing) {
  return (
    Boolean(pricing?.unlimited) ||
    (pricing?.blended === 0 && pricing?.monthlyTokens == null)
  );
}

/** Round up to the next 1/2/5 × 10^n so the unlimited cap lands on a clean value. */
function niceCeil(value) {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const exponent = Math.floor(Math.log10(value));
  const base = 10 ** exponent;
  const fraction = value / base;
  const step = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10;
  return step * base;
}

function fmtTokensValue(v) {
  if (v == null) return "–";
  if (v >= 1000) {
    const b = v / 1000;
    const digits = b < 10 ? 2 : b < 100 ? 1 : 0;
    return `${b.toLocaleString(undefined, { maximumFractionDigits: digits })}B`;
  }
  const digits = v < 10 ? 1 : 0;
  return `${v.toLocaleString(undefined, { maximumFractionDigits: digits })}M`;
}

function fmtTokens(pricing) {
  if (!pricing) return "–";
  if (pricing.unlimited) return "∞";
  return fmtTokensValue(pricing.monthlyTokens);
}

function el(id) {
  return document.getElementById(id);
}

async function loadData(force = false) {
  const btn = el("refresh");
  btn.disabled = true;
  btn.textContent = force ? "Refreshing…" : "Loading…";
  try {
    const res = await fetch(force ? "/api/refresh" : "/api/dashboard", {
      method: force ? "POST" : "GET",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    dashboard = await res.json();
    render();
  } catch (err) {
    showBanner(`Failed to load data: ${err.message}`, true);
  } finally {
    btn.disabled = false;
    btn.textContent = "Refresh";
  }
}

function showBanner(text, isError = false) {
  const b = el("banner");
  b.textContent = text;
  b.classList.toggle("error", isError);
  b.hidden = false;
}

function render() {
  if (!dashboard) return;

  // Banner / warnings
  const problems = [];
  if (!dashboard.aaConfigured) {
    problems.push(
      "Artificial Analysis API key is not configured. Add AA_API_KEY to .env and restart.",
    );
  }
  for (const w of dashboard.warnings ?? []) problems.push(w);
  if (problems.length) showBanner(problems.join(" "), !dashboard.aaConfigured);
  else el("banner").hidden = true;

  // Updated timestamps (date + time)
  const stamp = (iso) =>
    iso
      ? new Date(iso).toLocaleString(undefined, {
          day: "numeric",
          month: "short",
          year: "numeric",
          hour: "numeric",
          minute: "2-digit",
        })
      : "–";
  const goStamp = stamp(dashboard.goDocsFetchedAt);
  const benchStamp = dashboard.aaFetchedAt
    ? stamp(dashboard.aaFetchedAt) + (dashboard.aaFromCache ? " (cached)" : "")
    : "–";
  el("updated").textContent = `Pricing ${goStamp} · Benchmarks ${benchStamp}`;

  // Stat cards. Everything on the page is scoped to the plan + privacy filters.
  el("models-label").textContent =
    plan === "plus" ? "Models in Go Plus" : "Models in Go";
  const models = filteredModels();
  const variants = models.flatMap(tierVariants);
  currentVariants = variants;
  const unmatched = filteredUnmatched();
  const totalGo = models.length + unmatched.length;
  const matchedGo = models.length;
  el("stat-total").textContent = totalGo;
  el("stat-matched").textContent = matchedGo;
  el("stat-meter").style.width = `${totalGo ? (matchedGo / totalGo) * 100 : 0}%`;

  // Colour palette is built from the full set so colours stay stable when the
  // privacy filter changes; the legend only lists creators that are visible.
  creatorColors = buildCreatorColors(dashboard.models);
  const intelligenceValues = models
    .map((m) => m.metrics.intelligence)
    .filter((v) => v != null);
  maxIntelligence = intelligenceValues.length ? Math.max(...intelligenceValues) : 100;

  const bestValue = [...variants]
    .filter((m) => {
      const p = activePricing(m);
      return p && !p.unlimited && p.monthlyTokens != null;
    })
    .sort((a, b) => activePricing(b).monthlyTokens - activePricing(a).monthlyTokens)[0];
  const smartest = [...models]
    .filter((m) => m.metrics.intelligence != null)
    .sort((a, b) => b.metrics.intelligence - a.metrics.intelligence)[0];

  // Normalised all-rounder score: intelligence and tokens are each scaled to
  // the best value in the current set, then multiplied. Monotonic in both axes,
  // so more intelligence or more tokens never hurts the score.
  const eligible = variants.filter((m) => {
    const p = activePricing(m);
    return m.metrics.intelligence != null && p && !p.unlimited && p.monthlyTokens > 0;
  });
  const maxTokens = eligible.length
    ? Math.max(...eligible.map((m) => activePricing(m).monthlyTokens))
    : 0;
  const allRounder =
    maxTokens > 0 && maxIntelligence > 0
      ? eligible
          .map((m) => ({
            model: m,
            score:
              (m.metrics.intelligence / maxIntelligence) *
              (activePricing(m).monthlyTokens / maxTokens),
          }))
          .sort((a, b) => b.score - a.score)[0]
      : null;

  el("stat-value").textContent = bestValue
    ? `${fmtTokens(activePricing(bestValue))} · ${variantLabel(bestValue)}`
    : "–";
  el("stat-smartest").textContent = smartest
    ? `${fmt.num(smartest.metrics.intelligence)} · ${smartest.name}`
    : "–";
  el("stat-intel-token").textContent = allRounder
    ? `${allRounder.score.toFixed(2)} · ${variantLabel(allRounder.model)}`
    : "–";

  // Only meaningful when tier variants are being shown side by side.
  const variantNote = el("variant-note");
  if (tierFilter === "both" && variants.length > models.length) {
    variantNote.textContent = `${variants.length} price variants across ${models.length} matched models`;
    variantNote.hidden = false;
  } else {
    variantNote.textContent = "";
    variantNote.hidden = true;
  }

  renderTable(variants);
  renderLegend();
  renderCharts(variants);
  renderUnmatched(unmatched);
}

function sortValue(m, key) {
  if (key === "name") {
    return `${m.name.toLowerCase()}\u0000${String(m.tierIndex ?? 0).padStart(2, "0")}`;
  }
  if (key === "creator") return (m.creator ?? "").toLowerCase();
  if (key === "blended") return activePricing(m)?.blended ?? null;
  if (key === "monthlyTokens") {
    const p = activePricing(m);
    if (p?.unlimited) return Infinity;
    return p?.monthlyTokens ?? null;
  }
  if (key === "retention") {
    if (!m.privacy) return null;
    return m.privacy.group === "zdr" ? 3 : m.privacy.group === "retained" ? 2 : 1;
  }
  return m.metrics[key];
}

/** Whether a model passes the current privacy filter. */
function passesPrivacy(privacy) {
  if (privacyFilter === "all") return true;
  if (!privacy) return false;
  if (privacyFilter === "zdr") return privacy.group === "zdr";
  // "notraining": everything except models whose prompts may be used for training.
  return privacy.group !== "contributor";
}

function filteredModels() {
  return dashboard.models.filter((m) => passesPrivacy(m.privacy));
}

function filteredUnmatched() {
  return (dashboard.unmatched ?? []).filter((m) => passesPrivacy(m.privacy));
}

function visibleRows(rows) {
  const dir = sortDir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const av = sortValue(a, sortKey);
    const bv = sortValue(b, sortKey);
    const aEmpty = av == null || av === "";
    const bEmpty = bv == null || bv === "";
    if (aEmpty && bEmpty) return 0;
    if (aEmpty) return 1; // nulls last
    if (bEmpty) return -1;
    return av < bv ? -dir : av > bv ? dir : 0;
  });
}

function renderTable(rows = currentVariants) {
  const tbody = el("table").querySelector("tbody");
  tbody.innerHTML = "";

  for (const m of visibleRows(rows)) {
    const tr = document.createElement("tr");
    const p = activePricing(m);
    tr.innerHTML = `
      <td>
        <div class="model-name">${escapeHtml(m.name)}${
          m.tier
            ? `<span class="badge tier">${escapeHtml(m.tier)}</span>`
            : ""
        }${
          m.variant ? `<span class="badge">${escapeHtml(m.variant)}</span>` : ""
        }${
          m.viaOverride
            ? `<span class="badge warn" title="${escapeHtml(
                m.note ?? "manual mapping",
              )}">mapped</span>`
            : ""
        }${
          p?.limitedTime
            ? `<span class="badge warn" title="Limited-time bonus">${
                p.bonus ? `${p.bonus}× ` : ""
              }limited</span>`
            : ""
        }</div>
        <div class="model-id">${escapeHtml(m.id)}</div>
      </td>
      <td><span class="dot" style="background:${colorFor(
        m.creator,
      )}"></span>${escapeHtml(m.creator ?? "–")}</td>
      <td class="num">${scoreCell(m.metrics.intelligence)}</td>
      <td class="num">${fmt.num(m.metrics.coding)}</td>
      <td class="num">${fmt.num(m.metrics.agentic)}</td>
      <td class="num">${fmtBlended(p)}</td>
      <td class="num">${fmtTokens(p)}</td>
      <td>${zdrCell(m.privacy)}</td>
      <td><a href="${m.url}" target="_blank" rel="noopener">AA ↗</a></td>
    `;
    tbody.appendChild(tr);
  }
}

let maxIntelligence = null;

function scoreCell(value) {
  if (value == null) return "–";
  const max = maxIntelligence ?? 100;
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  return `<div class="bar-wrap"><span>${value.toFixed(1)}</span>
    <span class="bar-track"><span class="bar" style="width:${pct}%"></span></span></div>`;
}

/**
 * Privacy badge. Three groups:
 *  - zdr:         0-day retention, not used for training
 *  - retained:    retained (e.g. 30 days), not used for training
 *  - contributor: prompts may be used for training
 */
function zdrCell(privacy) {
  if (!privacy) return '<span class="muted">–</span>';
  const detail = `${privacy.training} · ${privacy.retention}${
    privacy.note ? ` — ${privacy.note}` : ""
  }`;

  let cls = "zdr-unknown";
  let label = privacy.retention ?? "–";
  if (privacy.group === "zdr") {
    cls = "zdr-zdr";
    label = "ZDR";
  } else if (privacy.group === "contributor") {
    cls = "zdr-contributor";
    label = "Contrib";
  } else if (privacy.group === "retained") {
    cls = "zdr-retained";
    label = String(privacy.retention).replace(/\s*days?/i, "d");
  }

  return `<span class="zdr ${cls}" title="${escapeHtml(detail)}">${escapeHtml(label)}</span>`;
}

function renderCharts(rows) {
  if (typeof Chart === "undefined") return;

  const pricingOf = (m) => activePricing(m);

  const points = rows.filter((m) => {
    const pricing = pricingOf(m);
    return (
      m.metrics.intelligence != null &&
      pricing != null &&
      (isUnlimitedPricing(pricing) || pricing.monthlyTokens > 0)
    );
  });

  const finiteTokens = points
    .map(pricingOf)
    .filter((p) => !isUnlimitedPricing(p) && Number.isFinite(p.monthlyTokens))
    .map((p) => p.monthlyTokens);
  const hasUnlimited = points.some((m) => isUnlimitedPricing(pricingOf(m)));
  const unlimitedX = hasUnlimited
    ? niceCeil(Math.max(...finiteTokens, 1) * 1.15)
    : null;

  const usageOf = (m) => {
    const pricing = pricingOf(m);
    return isUnlimitedPricing(pricing) ? unlimitedX : pricing.monthlyTokens;
  };

  const groups = new Map();
  for (const m of points) {
    if (!groups.has(m.baseId)) groups.set(m.baseId, []);
    groups.get(m.baseId).push(m);
  }

  const connectors =
    tierFilter === "both"
      ? [...groups.values()]
          .filter((g) => g.length > 1)
          .map((g) => ({
            color: colorFor(g[0].creator),
            points: g.map((m) => ({
              x: usageOf(m),
              y: m.metrics.intelligence,
            })),
          }))
      : [];

  const sub = el("chart-sub");
  if (sub) {
    const unlimitedNote = hasUnlimited
      ? " Unlimited models are pinned at the right edge (∞)."
      : "";
    sub.textContent =
      tierFilter === "both"
        ? `Each dot is a price tier — dashed lines connect tiers of the same model; hollow markers are the highest-priced tier. Up and to the right is better (smarter and more usage).${unlimitedNote}`
        : `Showing the ${
            tierFilter === "expensive" ? "highest-priced" : "lowest-priced"
          } tier of each model. Up and to the right is better (smarter and more usage).${unlimitedNote}`;
  }

  buildScatter("chart-usage", points, {
    xGetter: usageOf,
    yGetter: (m) => m.metrics.intelligence,
    xLabel: "Tokens / mo",
    yLabel: "Intelligence Index",
    logX,
    fmtX: (value) =>
      hasUnlimited && value >= unlimitedX * 0.999 ? "∞" : fmtTokensValue(value),
    fmtY: (value) => value,
    connectors,
    showTiers: tierFilter === "both",
  });
}

const tierConnectorPlugin = {
  id: "tierConnectors",
  beforeDatasetsDraw(chart) {
    const groups = chart.options.plugins.tierConnectors?.groups ?? [];
    if (!groups.length) return;

    const { ctx, scales } = chart;
    ctx.save();
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 1.5;
    ctx.globalAlpha = 0.35;

    for (const group of groups) {
      const pts = group.points
        .map((p) => ({
          x: scales.x.getPixelForValue(p.x),
          y: scales.y.getPixelForValue(p.y),
        }))
        .sort((a, b) => a.x - b.x);
      if (pts.length < 2) continue;

      const first = pts[0];
      const last = pts[pts.length - 1];
      ctx.strokeStyle = group.color;

      ctx.beginPath();
      ctx.moveTo(first.x, first.y);
      ctx.lineTo(last.x, last.y);
      ctx.stroke();

      // Small caps so the connector reads as a range bar, not a trend line.
      ctx.beginPath();
      ctx.moveTo(first.x, first.y - 4);
      ctx.lineTo(first.x, first.y + 4);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(last.x, last.y - 4);
      ctx.lineTo(last.x, last.y + 4);
      ctx.stroke();
    }

    ctx.restore();
  },
};

function buildScatter(canvasId, rows, opts = {}) {
  const { xGetter, yGetter, xLabel, yLabel } = opts;

  const points = rows
    .map((m) => {
      const pricing = activePricing(m);
      return {
        x: xGetter(m),
        y: yGetter(m),
        label: m.name,
        creator: m.creator ?? "?",
        tier: m.tier,
        tokens: pricing?.monthlyTokens ?? null,
        unlimited: isUnlimitedPricing(pricing),
        hollow: Boolean(
          opts.showTiers &&
            m.multipleTiers &&
            m.isMostExpensiveTier &&
            !m.isCheapestTier,
        ),
      };
    })
    .filter((p) => p.x != null && p.y != null && (!opts.logX || p.x > 0));

  const byCreator = new Map();
  for (const p of points) {
    if (!byCreator.has(p.creator)) byCreator.set(p.creator, []);
    byCreator.get(p.creator).push(p);
  }

  const datasets = [...byCreator.entries()].map(([creator, pts]) => {
    const color = colorFor(creator);
    return {
      label: creator,
      data: pts,
      backgroundColor: pts.map((p) => (p.hollow ? "#ffffff" : color)),
      borderColor: color,
      borderWidth: pts.map((p) => (p.hollow ? 2 : 0)),
      pointRadius: 5,
      pointHoverRadius: 7,
    };
  });

  if (charts[canvasId]) charts[canvasId].destroy();
  charts[canvasId] = new Chart(el(canvasId), {
    type: "scatter",
    data: { datasets },
    plugins: [tierConnectorPlugin],
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          display: true,
          position: "bottom",
          labels: {
            boxWidth: 9,
            boxHeight: 9,
            usePointStyle: true,
            padding: 10,
            font: { size: 11 },
          },
        },
        tierConnectors: { groups: opts.connectors ?? [] },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              const point = ctx.raw;
              const tier = point.tier ? ` [${point.tier}]` : "";
              const usage = point.unlimited
                ? "Unlimited usage"
                : point.tokens != null
                  ? `${fmtTokensValue(point.tokens).replace(/([MB])$/, "$1 tok")}/mo`
                  : null;
              const intelligence = opts.fmtY ? opts.fmtY(point.y) : round(point.y);
              return `${point.label}${tier}: Intelligence ${intelligence}${
                usage ? ` · ${usage}` : ""
              }`;
            },
          },
        },
      },
      scales: {
        x: {
          title: { display: true, text: xLabel },
          grid: { color: "#eef0f3" },
          ticks: {
            callback: (value) => (opts.fmtX ? opts.fmtX(value) : value),
            maxRotation: 0,
            autoSkip: true,
            maxTicksLimit: 8,
            padding: 6,
          },
          ...(opts.logX
            ? { type: "logarithmic", grace: "8%" }
            : { beginAtZero: true }),
        },
        y: {
          title: { display: true, text: yLabel },
          grid: { color: "#eef0f3" },
          ticks: {
            callback: (value) => (opts.fmtY ? opts.fmtY(value) : value),
          },
          ...(opts.logY ? { type: "logarithmic" } : {}),
        },
      },
    },
  });
}

function round(v) {
  return typeof v === "number" ? Math.round(v * 100) / 100 : v;
}

/**
 * Stable, distinct colour per model creator.
 *
 * Built for *even hue coverage* rather than raw maximum-separation: the wheel
 * is sampled roughly every 30 degrees, lightness alternates between neighbours,
 * and three neutral greys plus a yellow and an olive are included. The closest
 * pair is ~9.1 apart in OKLab (the two neighbouring warms, orange/gold), and
 * there are no unintentionally muddy near-neighbours — the previous list had
 * e.g. "#2f6feb" vs "#2563eb" at only 3.1.
 *
 * Keep pairs well separated if you edit this, especially within one hue family.
 */
const CREATOR_PALETTE = [
  "#E14754", // red
  "#F58B4B", // orange
  "#ECAA0B", // yellow / gold
  "#989900", // olive
  "#2C9302", // green
  "#14532D", // deep green
  "#31BE98", // teal
  "#0891B2", // cyan
  "#236ADE", // blue
  "#9476FE", // violet
  "#AE42C5", // magenta
  "#F46EB4", // pink
  "#94A3B8", // light grey
  "#64748B", // mid grey
  "#334155", // dark slate
  "#8B5E3C", // brown
];

/**
 * Probe offset used to resolve palette collisions. Coprime with the palette
 * length, so probing visits every slot, and far enough from +1 that a clash
 * resolves to a very different colour instead of a neighbouring hue.
 */
const PROBE_STRIDE = 7;

const NEUTRAL_COLOR = "#9aa4b2";

let creatorColors = new Map();

function hashString(s) {
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

/**
 * Deterministic, collision-free colour per creator. Starts from a hash of the
 * name and probes with a coprime stride for a free slot, so colours stay stable
 * per creator while never clashing (as long as there are fewer creators than
 * palette entries).
 */
function buildCreatorColors(models) {
  const creators = [...new Set(models.map((m) => m.creator).filter(Boolean))].sort();
  const map = new Map();
  const used = new Set();
  for (const creator of creators) {
    let idx = hashString(creator) % CREATOR_PALETTE.length;
    let tries = 0;
    while (used.has(idx) && tries < CREATOR_PALETTE.length) {
      idx = (idx + PROBE_STRIDE) % CREATOR_PALETTE.length;
      tries += 1;
    }
    used.add(idx);
    map.set(creator, CREATOR_PALETTE[idx]);
  }
  return map;
}

function colorFor(creator) {
  if (!creator) return NEUTRAL_COLOR;
  return creatorColors.get(creator) ?? NEUTRAL_COLOR;
}

/** Colour key for the Creator column dots and the scatter chart. */
function renderLegend() {
  const container = el("creator-legend");
  if (!container) return;
  const creators = [
    ...new Set(filteredModels().map((m) => m.creator).filter(Boolean)),
  ].sort((a, b) => a.localeCompare(b));
  container.innerHTML = creators
    .map(
      (creator) =>
        `<span class="legend-item"><span class="swatch" style="background:${colorFor(
          creator,
        )}"></span>${escapeHtml(creator)}</span>`,
    )
    .join("");
}

function renderUnmatched(unmatched) {
  const panel = el("unmatched-panel");
  const list = el("unmatched-list");
  const items = unmatched.flatMap(tierVariants);
  panel.hidden = items.length === 0;
  list.innerHTML = items
    .map((u) => {
      const p = activePricing(u);
      const price = fmtBlended(p);
      const tokens = fmtTokens(p);
      const extra =
        price !== "–" || tokens !== "–"
          ? ` <span class="muted">· ${price}/1M · ${tokens}/mo</span>`
          : "";
      const tier = u.tier
        ? ` <span class="muted">(${escapeHtml(u.tier)})</span>`
        : "";
      return `<li title="${escapeHtml(u.id)}">${escapeHtml(u.name)}${tier}${extra}</li>`;
    })
    .join("");
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]),
  );
}

function wireControls() {
  el("refresh").addEventListener("click", () => loadData(true));

  for (const info of document.querySelectorAll(".info")) {
    // Prevent clicks on an info icon inside a sortable <th> from sorting.
    info.addEventListener("click", (e) => e.stopPropagation());
  }

  for (const btn of document.querySelectorAll("#plan-filter .segmented-btn")) {
    btn.addEventListener("click", () => {
      plan = btn.dataset.plan;
      for (const other of document.querySelectorAll("#plan-filter .segmented-btn")) {
        other.classList.toggle("active", other === btn);
      }
      render();
    });
  }

  for (const btn of document.querySelectorAll("#privacy-filter .segmented-btn")) {
    btn.addEventListener("click", () => {
      privacyFilter = btn.dataset.filter;
      for (const other of document.querySelectorAll("#privacy-filter .segmented-btn")) {
        other.classList.toggle("active", other === btn);
      }
      render();
    });
  }

  for (const btn of document.querySelectorAll("#tier-filter .segmented-btn")) {
    btn.addEventListener("click", () => {
      tierFilter = btn.dataset.tier;
      for (const other of document.querySelectorAll("#tier-filter .segmented-btn")) {
        other.classList.toggle("active", other === btn);
      }
      render();
    });
  }

  for (const btn of document.querySelectorAll("#chart-scale .segmented-btn")) {
    btn.addEventListener("click", () => {
      logX = btn.dataset.scale === "log";
      for (const other of document.querySelectorAll("#chart-scale .segmented-btn")) {
        other.classList.toggle("active", other === btn);
      }
      render();
    });
  }

  for (const th of document.querySelectorAll("th.sortable")) {
    th.addEventListener("click", () => {
      const key = th.dataset.key;
      if (sortKey === key) sortDir = sortDir === "asc" ? "desc" : "asc";
      else {
        sortKey = key;
        sortDir = key === "name" || key === "creator" ? "asc" : "desc";
      }
      for (const other of document.querySelectorAll("th.sortable")) {
        delete other.dataset.dir;
      }
      th.dataset.dir = sortDir;
      renderTable();
    });
  }
}

wireControls();
loadData(false);
