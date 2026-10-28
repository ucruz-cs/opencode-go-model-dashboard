import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { loadConfig, ROOT } from "./lib/env.mjs";
import { fetchGoDocs, readGoCache, writeGoCache } from "./lib/goLimits.mjs";
import { AA_CACHE_VERSION, fetchAaModels, readAaCache, writeAaCache } from "./lib/aaModels.mjs";
import { buildDashboard } from "./lib/match.mjs";

const cfg = loadConfig();
const PUBLIC_DIR = path.join(ROOT, "public");

const state = {
  dashboard: null,
  refreshing: null,
};

/** Last successfully parsed OpenCode Go docs payload, restored from disk at startup. */
const cachedGo = readGoCache();
let lastGo = {
  models: cachedGo?.models ?? [],
  fetchedAt: cachedGo?.fetchedAt ?? null,
};

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

async function refresh({ force = false } = {}) {
  const warnings = [];

  // OpenCode Go docs: reuse the on-disk cache at startup. Only an explicit
  // refresh (the Refresh button) fetches a new copy; if no cache exists yet,
  // fetch once to populate it.
  let goModels = lastGo.models;
  let goFetchedAt = lastGo.fetchedAt;
  let goFetchedLive = false;
  if (force || goModels.length === 0) {
    try {
      const parsed = await fetchGoDocs(cfg.GO_DOCS_URL);
      if (parsed.error) {
        warnings.push(`OpenCode Go docs: ${parsed.error}`);
      } else {
        const cache = writeGoCache(parsed.models, { source: cfg.GO_DOCS_URL });
        goModels = parsed.models;
        goFetchedAt = cache.fetchedAt;
        goFetchedLive = true;
        lastGo = { models: goModels, fetchedAt: goFetchedAt };
      }
    } catch (err) {
      warnings.push(`Could not load OpenCode Go docs: ${err.message}`);
    }
  }

  // Artificial Analysis: like the Go docs, the on-disk cache is reused for as
  // long as it lasts. Only an explicit refresh (the Refresh button) fetches a
  // new copy; if no cache exists yet, or it was written by another benchmark
  // suite version, fetch once to populate it.
  const cached = readAaCache();
  const cacheIsCurrent = cached?.version === AA_CACHE_VERSION;
  let aa = cached ?? { models: [], fetchedAt: null, tier: null };
  let fromCache = Boolean(cached);

  if (!cfg.AA_API_KEY) {
    warnings.push(
      "No AA_API_KEY configured. Showing OpenCode Go models without benchmark data.",
    );
  } else if (!force && cacheIsCurrent) {
    fromCache = true;
  } else {
    try {
      const { models, tier } = await fetchAaModels(cfg.AA_BASE_URL, cfg.AA_API_KEY);
      aa = writeAaCache(models, { tier });
      fromCache = false;
    } catch (err) {
      if (cached?.models?.length) {
        fromCache = true;
        warnings.push(
          `Artificial Analysis fetch failed (${err.message}). Using cached data from ${cached.fetchedAt}.`,
        );
        aa = cached;
      } else {
        aa = { models: [], fetchedAt: null, tier: null };
        warnings.push(`Artificial Analysis fetch failed: ${err.message}`);
      }
    }
  }

  const dashboard = buildDashboard(goModels, aa.models ?? [], {
    aaFetchedAt: aa.fetchedAt,
    aaFromCache: fromCache,
    aaTier: aa.tier,
    goDocsFetchedAt: goFetchedAt,
    goDocsFromCache: !goFetchedLive && goModels.length > 0,
  });
  dashboard.warnings = warnings;
  dashboard.aaConfigured = Boolean(cfg.AA_API_KEY);
  state.dashboard = dashboard;
  return dashboard;
}

/** Coalesce concurrent refreshes into one in-flight promise. */
function refreshOnce(options) {
  if (!state.refreshing) {
    state.refreshing = refresh(options).finally(() => {
      state.refreshing = null;
    });
  }
  return state.refreshing;
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(payload);
}

function serveStatic(req, res, pathname) {
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const target = path.resolve(PUBLIC_DIR, rel);

  if (!target.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(target, (err, data) => {
    if (err) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }
    res.writeHead(200, {
      "content-type": MIME[path.extname(target)] ?? "application/octet-stream",
      "cache-control": "no-cache",
    });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  try {
    if (url.pathname === "/api/dashboard") {
      if (!state.dashboard) await refreshOnce({});
      return sendJson(res, 200, state.dashboard);
    }

    if (url.pathname === "/api/refresh" && req.method === "POST") {
      const dashboard = await refreshOnce({ force: true });
      return sendJson(res, 200, dashboard);
    }

    if (url.pathname === "/api/health") {
      return sendJson(res, 200, { ok: true });
    }

    return serveStatic(req, res, url.pathname);
  } catch (err) {
    return sendJson(res, 500, { error: String(err?.message ?? err) });
  }
});

server.listen(cfg.PORT, async () => {
  const url = `http://localhost:${cfg.PORT}`;
  console.log(`OpenCode Go · Artificial Analysis dashboard: ${url}`);
  if (!cfg.AA_API_KEY) {
    console.warn("  ! AA_API_KEY is not set — add it to .env to load benchmark data.");
  }
  try {
    const dash = await refreshOnce({});
    const goState = !dash.counts.go
      ? "unavailable"
      : dash.goDocsFromCache
        ? "from cache"
        : "fetched live";
    console.log(`  Go docs ${goState}`);
    const aaState = !dash.aaConfigured
      ? " (AA data not fetched — no API key)"
      : dash.aaFromCache
        ? " (AA data from cache)"
        : " (AA data fetched live)";
    console.log(
      `  Loaded ${dash.counts.matched}/${dash.counts.go} Go models with benchmark data` +
        aaState,
    );
    console.log(`  Pricing (effective) available for ${dash.counts.priced} models`);
    for (const w of dash.warnings) console.warn(`  ! ${w}`);
  } catch (err) {
    console.error(`  ! Startup refresh failed: ${err.message}`);
  }
});
