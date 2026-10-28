# OpenCode Go · Model Dashboard

A small, dependency-free dashboard that shows how the models in your **OpenCode Go** subscription perform according to [Artificial Analysis](https://artificialanalysis.ai/).

> **Unofficial project.** Not affiliated with, endorsed by, or supported by Anomaly Innovations, Inc. or Artificial Analysis. "OpenCode" and "OpenCode Go" are trademarks of Anomaly Innovations, Inc.

On start it:

1. parses the OpenCode Go model list, token prices and privacy table from the MIT-licensed Markdown source behind the docs (`services/www/src/docs/content/console/go.mdx` in [anomalyco/opencode](https://github.com/anomalyco/opencode));
2. computes an **effective price** per model using a traffic-weighted Go usage mix (`4.5% input + 94.85% cached input + 0.65% output`, per 1M tokens) and how many effective tokens the monthly Go allowance buys (`monthly $ ÷ effective price`);
3. loads Artificial Analysis benchmark data from its cache, fetching it (paginated) only when no cache exists;
4. joins the two catalogues by model name and serves the result in a web UI.

The model list, prices and privacy data come from that Markdown source; benchmarks come from Artificial Analysis. Both payloads are cached locally (`cache/go.json` and `cache/aa.json`) and re-fetched **only** when you press **Refresh**, or on the first run when no cache exists yet.

Only Artificial Analysis' quality benchmarks are shown: the **Intelligence Index** (v5.0, an equally weighted average of Knowledge Work, Coding, Science and General) and the **Engineering** capability index. Models AA has not scored on the current index version yet show `–` and are left out of the chart. AA's speed/latency measurements are excluded because they are measured on AA's own inference and don't reflect how the models are served through OpenCode Go.

## Requirements

- Node.js 20+ (built on Node 24). No `npm install` needed — uses the built-in `http` module and global `fetch`, with Chart.js loaded from a CDN.

## Setup

1. Get a free API key from the [Artificial Analysis Insights Platform](https://artificialanalysis.ai/login).
2. Copy `.env.example` to `.env` and add the key:

   ```
   AA_API_KEY=your_key_here
   ```

## Run

```bash
node server.mjs
```

Then open <http://localhost:8787>.

## Configuration

Secrets and the HTTP port live in `.env` (gitignored); non-secret dashboard
settings live in `settings.json` (committed).

### `.env`

| Variable     | Default | Purpose                                 |
| ------------ | ------- | --------------------------------------- |
| `AA_API_KEY` | –       | Artificial Analysis API key (required). |
| `PORT`       | `8787`  | HTTP port.                              |

### `settings.json`

| Key                    | Default                                | Purpose                              |
| ---------------------- | -------------------------------------- | ------------------------------------ |
| `GO_DOCS_URL`          | raw `go.mdx` on the `dev` branch¹      | OpenCode Go docs source (Markdown).  |
| `AA_BASE_URL`          | `https://artificialanalysis.ai/api/v2` | Artificial Analysis API base.        |

¹ `https://raw.githubusercontent.com/anomalyco/opencode/dev/services/www/src/docs/content/console/go.mdx` — `dev` is the branch the live docs are built from; the `v2` branch copy lags behind and misses recent models.

Missing keys fall back to the defaults above; an unreadable `settings.json` logs a warning and uses all defaults. The file holds no secrets, so it is safe to commit.

The AA free tier allows 1,000 requests/day, and the full list takes ~4 paginated requests. Both caches (`cache/go.json` and `cache/aa.json`) are reused by startup and every page load; only the **Refresh** button forces a new fetch, and a first run with no cache fetches once to populate the file. The AA cache is versioned (`AA_CACHE_VERSION` in `lib/aaModels.mjs`); a cache written for a different benchmark-suite version is refreshed once on startup.

## Pricing

The docs page publishes per-model token prices (Input, Output, Cached Read) and a monthly allowance in $. The dashboard shows:

- **Effective $/1M tok** — `0.045 × input + 0.9485 × cached_read + 0.0065 × output` (the traffic-weighted Go usage mix described below).
- **Tokens / mo** — `monthly_allowance ÷ effective price` (millions of effective tokens).

### Where the 4.5 / 94.85 / 0.65 % mix comes from

Earlier versions used the "typical Go usage" profiles published on the Go docs page. Those are assumptions used to produce OpenCode's estimated request counts, and they imply a **98.84% cache hit rate** (98.5% is the cached share of all tokens, not the hit rate). Measured traffic is lower.

This mix instead comes from [OpenCode Data](https://opencode.ai/data), which publishes a per-model `cachedInputPercent` over the last two months. I take all 29 models currently in the Go lineup, including the free ones, and map them to their OpenCode Data model pages:

- `LongCat 2.5 Preview Free` → `LongCat-2.5-Preview`
- `Beam Free` → `beam`
- `MiniMax M3.1 Flash Free` → `MiniMax-M3.1-Flash`
- `Gemini 4 Argon Contributor` → `gemini-4-argon-contributor`

The cache hit rate is `cached input / (cached + uncached input)`. Across those 29 models:

| Metric | Value |
| --- | ---: |
| Unweighted mean | 94.15% |
| SD (sample) | 3.43 pp |
| Token-weighted mean | **95.46%** |
| Token-weighted SD | 1.49 pp |

I use the **token-weighted** mean because the global mix is applied across token volume, and usage is dominated by a few models. An equal-weight average would over-represent low-volume models such as Grok 4.7 (84.5%) and Kimi K3 (88.4%).

The output share is measured as `total tokens − (cached + uncached input)` on the OpenCode Data tables, which include output and reasoning tokens. That gives about **0.65%** output+reasoning (the Go subset of the 7-day table gives ~0.66%). Converting the measured cache hit rate and output share to shares of all tokens:

```
cached         = 0.9546 × (1 − 0.0065) = 94.84%
uncached input = 0.0454 × (1 − 0.0065) = 4.51%
output         =                         0.65%
```

Rounded, that is **4.5% input / 94.85% cached input / 0.65% output**. The constant lives in `lib/goLimits.mjs`; update it if OpenCode Data changes materially.

Caveat: these cache rates cover all OpenCode traffic for those model IDs, not Go-subscription-only traffic, because no public Go-only breakdown exists. The model set, however, is exactly the current Go lineup.

This replaces Artificial Analysis' 7/2/1 (70% cached / 20% input / 10% output) mix, which assumes far more uncached input than coding-agent traffic actually uses.

The current (possibly limited-time-bonused) monthly figure is used, taken from the bold value in the docs table (e.g. Gemini 4 Argon Contributor's `$30 → $60` 2× bonus is shown as **$60**).

Tiered rows (context-size or peak/off-peak) are kept as separate price variants. The **Price tiers** filter selects the **Lowest** tier (default), **All tiers**, or **Highest** tier by effective price; single-tier models are unaffected. With **All tiers**, each variant is an independent table row and chart point, the model count stays per base model, the best-models cards are computed across the shown variants, and dashed range bars in the chart connect variants of the same model. The unmatched panel follows the same filter, and the table panel shows how many variants are being displayed.

## Matching OpenCode Go models to Artificial Analysis

Names differ between the two catalogues (for example `deepseek-v4.1-flash` vs. the AA slug `deepseek-v4-1-flash`, or AA's `(High)`/`(Max)` effort variants). The matcher normalises both sides and prefers the base (non-variant) entry. If a model is not matched, add it to `overrides.json`:

```json
{
  "space-bunny": "space-bunny",
  "some-go-id": { "slug": "aa-slug", "note": "why" }
}
```

Unmatched models appear in the "No benchmark data found" panel.

## Data sources, attribution & licensing

This is an unofficial project and is not affiliated with Anomaly Innovations, Inc. ("OpenCode") or Artificial Analysis.

- **Model list, prices and privacy** are parsed from the MIT-licensed [`go.mdx`](https://github.com/anomalyco/opencode/blob/dev/services/www/src/docs/content/console/go.mdx) source in the `anomalyco/opencode` repository (`Copyright (c) 2025 opencode`, MIT). The rendered page is <https://opencode.ai/v2/docs/console/go/>. No OpenCode data is committed to this repository; each user's copy is cached locally in `cache/go.json`.
- **Benchmarks** are provided by [Artificial Analysis](https://artificialanalysis.ai/) and displayed under their free API terms, which require attribution and permit **internal use only — no redistribution**. You must supply your own `AA_API_KEY`. Benchmark data is cached locally in `cache/aa.json` and is not committed to this repository. If you deploy this dashboard publicly, or redistribute the data in any form, you need a license from Artificial Analysis that grants those rights.
- **Code** in this repository is MIT licensed; see [LICENSE](LICENSE). The licences of the data above are separate and do not extend to it.
 