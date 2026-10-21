import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./env.mjs";

const CACHE_FILE = path.join(ROOT, "cache", "aa.json");

export function readAaCache() {
  try {
    const parsed = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
    if (Array.isArray(parsed?.models)) return parsed;
    return null;
  } catch {
    return null;
  }
}

export function writeAaCache(models, meta = {}) {
  fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
  const payload = {
    fetchedAt: new Date().toISOString(),
    tier: meta.tier ?? null,
    models,
  };
  fs.writeFileSync(CACHE_FILE, JSON.stringify(payload, null, 1), "utf8");
  return payload;
}

/**
 * Fetch every page of the (free) language models list.
 * The free endpoint ignores page_size and paginates with `page`.
 */
export async function fetchAaModels(baseUrl, apiKey) {
  if (!apiKey) throw new Error("Missing AA_API_KEY");

  const collected = [];
  let page = 1;
  let totalPages = 1;
  let tier = null;

  do {
    const url = `${baseUrl}/language/models/free?page=${page}`;
    const res = await fetch(url, {
      headers: { "x-api-key": apiKey, accept: "application/json" },
    });

    if (res.status === 401) throw new Error("AA API key missing or invalid (HTTP 401)");
    if (res.status === 403) throw new Error("AA subscription does not cover this endpoint (HTTP 403)");
    if (res.status === 429) throw new Error("AA daily rate limit reached (HTTP 429)");
    if (!res.ok) throw new Error(`AA API error HTTP ${res.status} on page ${page}`);

    const json = await res.json();
    tier = json.tier ?? tier;
    collected.push(...(json.data ?? []));
    totalPages = json.pagination?.total_pages ?? 1;
    page += 1;
    if (page > 100) break; // safety valve
  } while (page <= totalPages);

  return { models: collected, tier };
}
