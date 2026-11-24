# Data sources, caching and matching

[← Back to the README](../README.md)

Where each column comes from, how the data is refreshed, and why a model might not appear.

## What the dashboard reads

Three sources, all fetched by the local server:

1. **OpenCode Go models endpoint** (`GO_MODELS_URL`, `https://opencode.ai/inference/go/v1/models`) — model IDs, names, types, token prices, per-plan monthly allowances (`go`, `go-plus`, `go-teams`), training and ZDR flags, and the `cost` object that drives tiers and promotions.
2. **`go.mdx` documentation source** (`GO_DOCS_URL`, raw Markdown from the `dev` branch of `anomalyco/opencode`) — the exact data-retention days from the "Privacy" table, plus its footnotes. `dev` is the branch the live docs are built from; the `v2` branch copy lags behind and misses recent models. This fetch is best-effort: if it fails, retention falls back to labels derived from the endpoint's ZDR/training flags.
3. **Artificial Analysis** (`AA_BASE_URL`, `/language/models/free`, paginated) — Intelligence and Engineering indexes plus the other capability evaluations, used by name to join against the Go models.

Artificial Analysis speed and latency measurements are deliberately excluded: they are measured on AA's own inference and would not describe how the models are served through OpenCode Go.

## Refresh and caching

The dashboard is built once at startup and then frozen in memory. Nothing is re-fetched until you press **Refresh** (or call `POST /api/refresh`):

- `cache/go.json` — parsed Go models and retention, tagged with `CACHE_VERSION` (currently `1.8` in `lib/goLimits.mjs`). Reused on every start; fetched live on Refresh, when the file is missing or empty, or when the version does not match.
- `cache/aa.json` — the full AA catalogue, tagged with `AA_CACHE_VERSION` (currently `2` in `lib/aaModels.mjs`). Same policy, plus one extra rule: a cached payload written for a different benchmark-suite version is refreshed once on startup. An empty catalogue is treated as no cache so a failed fetch is retried instead of being served forever.

Both version checks compare for equality; bump the constant whenever the cached payload shape or the parser's meaning changes. Neither file is committed or redistributed — see the licensing section of the README.

The Artificial Analysis free tier allows **100 requests per fixed 24-hour window**, shared by every key on the same user or organisation, and the full model list takes about **four** paginated requests. A refresh that fails leaves the previous cache in place and surfaces a warning in the page banner.

## Chat models only

The Go endpoint also lists decision and embedding models. Artificial Analysis' language benchmarks do not cover them, so they are dropped before matching and counted in `skippedByType` rather than shown as unmatched. `counts.go` is therefore the chat-only model count.

## Matching Go models to Artificial Analysis

Names differ between the catalogues — `qwen3.8-flash` against AA's `qwen3-8-flash-next`, or AA's `(High)` / `(Max)` effort variants — so both sides are reduced to a comparable key:

- both names keep letters and digits only, lowercased;
- AA slugs drop 4+ digit date stamps (`0813`, `20250902`) and effort words (`high`, `max`, `medium`, `thinking`, …) and are ranked by how much was stripped;
- Go names drop `free`, `preview` and `contributor` suffixes.

When several AA entries collapse to the same key, the matcher prefers the plain slug, then the higher reasoning effort, then the shorter slug.

Rare mismatches can be pinned in [`overrides.json`](../overrides.json), keyed by the **Go model id**. Values may be a slug or an object with a note:

```json
{
  "space-bunny": "space-bunny",
  "some-go-id": { "slug": "aa-slug", "note": "why" }
}
```

Keys starting with `_` are ignored, so the file can carry a comment. Overrides win over automatic matching, and a model that matches nothing appears in the "No benchmark data found" panel — it still shows pricing and retention.

## HTTP surface

The server exposes three JSON endpoints besides the static page, which is enough to script against the same data the UI uses:

| Endpoint | Purpose |
| --- | --- |
| `GET /api/dashboard` | The current in-memory build; builds first if nothing is loaded yet. |
| `POST /api/refresh` | Forces a Go + AA fetch and returns the new build. Concurrent calls are coalesced. |
| `GET /api/health` | `{ "ok": true }`. |

Everything else is served from `public/`.
