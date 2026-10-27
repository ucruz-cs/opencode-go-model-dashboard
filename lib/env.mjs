import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Repository root (the folder that contains server.mjs). */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Non-secret dashboard settings. */
const SETTINGS_FILE = path.join(ROOT, "settings.json");

function parseDotEnv(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/**
 * Non-secret dashboard settings live in settings.json, next to server.mjs.
 * These are the fallbacks used when the file or a key is missing.
 */
const DEFAULT_SETTINGS = Object.freeze({
  GO_DOCS_URL:
    "https://raw.githubusercontent.com/anomalyco/opencode/dev/services/www/src/docs/content/console/go.mdx",
  AA_BASE_URL: "https://artificialanalysis.ai/api/v2",
});

function loadSettings() {
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.warn(`  ! Could not read settings.json (${err.message}); using defaults.`);
    }
    raw = {};
  }

  const url = (value) =>
    typeof value === "string" && value.trim() ? value.trim() : null;

  return {
    GO_DOCS_URL: url(raw.GO_DOCS_URL) ?? DEFAULT_SETTINGS.GO_DOCS_URL,
    AA_BASE_URL: url(raw.AA_BASE_URL) ?? DEFAULT_SETTINGS.AA_BASE_URL,
  };
}

/**
 * Resolve configuration from process.env first, then a local .env file, plus
 * the non-secret settings in settings.json.
 */
export function loadConfig() {
  const envFile = path.join(ROOT, ".env");
  const fromFile = fs.existsSync(envFile)
    ? parseDotEnv(fs.readFileSync(envFile, "utf8"))
    : {};
  const get = (key, fallback) => process.env[key] ?? fromFile[key] ?? fallback;

  return {
    AA_API_KEY: get("AA_API_KEY", ""),
    PORT: Number(get("PORT", "8787")),
    ...loadSettings(),
  };
}
