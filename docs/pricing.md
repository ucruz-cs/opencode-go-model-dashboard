# Pricing: effective $/1M tokens and tokens per month

[← Back to the README](../README.md)

Per-token prices are easy to compare only when two models are used the same way. The dashboard therefore reduces every model to two numbers that are directly comparable across the Go lineup:

- **Effective $/1M tok** — what 1M tokens cost under a measured mix of input, cached input and output tokens.
- **Tokens / mo** — how many of those effective tokens the selected plan's monthly allowance buys.

Both numbers use the same mix for every model, so the plan filter changes the second number only.

## The formulas

```
effective = 0.045 × input + 0.9485 × cached_read + 0.0065 × output
tokens/mo = monthly allowance ($) ÷ effective          (in millions of tokens)
```

Token prices come from the live Go models endpoint; the allowance comes from the same response (`go.monthly_usage`, one value per plan). Per-token prices are identical across **Go**, **Go Plus** and **Go Teams** — only the monthly allowance differs, and Go Teams figures are per member.

The constants live in `BLEND` in [`lib/goLimits.mjs`](../lib/goLimits.mjs). Update them only if the measured traffic mix changes materially.

Free models have zero prices and no allowance: they are reported as unlimited (`∞`) rather than as a division by zero.

## Where the 4.5 / 94.85 / 0.65 % mix comes from

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

The **token-weighted** mean is used because the global mix is applied across token volume, and usage is dominated by a few models. An equal-weight average would over-represent low-volume models such as Grok 4.7 (84.5%) and Kimi K3 (88.4%).

The output share is measured as `total tokens − (cached + uncached input)` on the OpenCode Data tables, which include output and reasoning tokens. That gives about **0.65%** output+reasoning (the Go subset of the 7-day table gives ~0.66%). Converting the measured cache hit rate and output share to shares of all tokens:

```
cached         = 0.9546 × (1 − 0.0065) = 94.84%
uncached input = 0.0454 × (1 − 0.0065) = 4.51%
output         =                         0.65%
```

Rounded, that is **4.5% input / 94.85% cached input / 0.65% output**.

Caveat: these cache rates cover all OpenCode traffic for those model IDs, not Go-subscription-only traffic, because no public Go-only breakdown exists. The model set, however, is exactly the current Go lineup.

This replaces Artificial Analysis' 7/2/1 (70% cached / 20% input / 10% output) mix, which assumes far more uncached input than coding-agent traffic actually uses.

## Promotions

The endpoint can schedule a price change with a date-scoped multiplier. When a future entry raises the price by a factor, the current price is a limited-time discount. The dashboard shows the current price and marks it with a `bonus` badge whose tooltip reads, for example, `50% off until 30 Nov 2026` (the day before the multiplier takes effect). Expired promotions disappear on their own.

The allowance used is the one currently published by the endpoint, so a limited-time bonus is already included — for example Gemini 4 Argon Contributor's `$30 → $60` 2× bonus is shown as **$60**.

Date-scoped multipliers are never rendered as peak/off-peak rates: they describe a scheduled change, not a rate you can hit today.

## Price tiers

Some models charge differently by context size, and some have peak/off-peak rates. Those become separate tiers:

- **Context tiers** come from input/output overrides with a `context.gt` threshold and are labelled `≤ 100K tokens` / `> 100K tokens` and so on.
- **Time tiers** come from `utc_days` / `utc_hours` multipliers and are labelled `Off-Peak` (base price) and `Peak` (multiplied price).

Every tier carries its own effective price and tokens-per-month figure. The table's default row for a model is its cheapest tier; the **Price tiers** filter selects lowest, all, or highest. See [ui.md](ui.md) for how variants are rendered.

## Caveats

- The mix is a single global constant, so per-model cache behaviour (a model with unusually poor caching is flattered) is not modelled.
- Allowances are the plan's dollar credit, not a hard token cap; actual cost still depends on what you send.
- Prices are read from the live endpoint at refresh time and can change between refreshes.
