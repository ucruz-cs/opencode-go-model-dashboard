# Using the dashboard

[← Back to the README](../README.md)

What each control, column and badge means, and how price tiers are rendered.

## Layout

- **Header** — plan, privacy and price-tier filters, the two "Last updated" timestamps, and **Refresh**.
- **Stat cards** — how many Go chat models exist, how many have a score, how many are matched but unscored, and how many could not be matched; plus "best model" cards.
- **Model comparison table** — one row per model, or per tier variant.
- **Intelligence vs. monthly tokens chart** — the same models as points.
- **No benchmark data found** — models that matched nothing in Artificial Analysis.

A banner appears at the top of the page when a fetch fails, when a cache is being reused after an error, or when no API key is configured.

## Columns

| Column | Meaning |
| --- | --- |
| **Model** | Go model name, its id, and any badges (see below). |
| **Creator** | Model creator according to Artificial Analysis; the colour matches the chart and legend. |
| **Intelligence** | AA Intelligence Index, with a bar relative to the best model on the page. |
| **Engineering** | AA Engineering Index: engineering knowledge, science, reasoning, agentic coding and agentic knowledge work. |
| **Effective $/1M tok** | Blended token price under the measured traffic mix. |
| **Tokens / mo** | How many effective tokens the selected plan's allowance buys. |
| **Data retention** | `ZDR` (zero-day retention), a day count such as `30d` (retained but not trained on), or `Contrib` (prompts may be used for training). Hover for the full detail. |
| **Source** | Link to the model's page on Artificial Analysis. |

Any column header can be sorted; empty values sort last. The Intelligence Index is v5.0 — an equally weighted average of Knowledge Work, Coding, Science and General. Models AA has not scored on the current version show `–`, are left out of the chart, and count as "matched, no score yet".

Artificial Analysis speed and latency numbers are intentionally absent: they describe AA's own inference, not OpenCode Go.

## Badges

| Badge | Meaning |
| --- | --- |
| `≤ 100K tokens`, `Peak`, … | Which price tier this row shows. |
| `High`, `Max`, … | The AA effort variant the model was matched to. |
| `mapped` | Matched through `overrides.json`; hover for the reason. |
| `bonus` | A limited-time discount price; hover for `50% off until …`. |

## Filters

**Subscription** (Go / Go Plus / Go Teams) re-prices the table and the chart and changes the tokens-per-month figure. Token prices are identical across plans, so only allowances move. Go Teams allowances are per member.

**Model privacy** and **Price tiers** apply to the whole page — table, cards, chart and the unmatched panel:

- `All models` / `No training` (hides contributors) / `ZDR` (only zero-day retention).
- `Lowest` / `All tiers` / `Highest` by effective price. Models with a single tier are unaffected by this filter.

## Price tiers in the chart and table

Context-size and peak/off-peak rates are separate pricing rows, so a tiered model is not one dot:

- With **Lowest** or **Highest**, each model contributes its cheapest or most expensive tier.
- With **All tiers**, every tier becomes its own table row and chart point. Points belonging to one model are joined by a dashed line, and that model's most expensive tier is drawn as a hollow marker, so a range reads as one model spanning several rates.
- The model count stays a per-base-model count, the panel note reports how many variants are displayed, and the best-model cards are computed from the rows currently shown.

## Chart

Each point plots AA intelligence against the effective tokens per month for the selected plan. The usage axis can be switched between **Log** (default) and **Linear**. Free models with unlimited usage have no position on that axis, so they are pinned just beyond the largest finite value and labelled `∞` instead of being dropped. When the filters leave enough models with both metrics, a shaded quadrant marks the set with above-median intelligence and above-median usage.

Creator colours are deterministic — the same model keeps its colour no matter which filters are active.

## Refresh

The page fetches once and then keeps the result in memory. **Refresh** is the only thing that re-fetches from the two upstream sources, and it updates both "Last updated" lines. Configuration changes (`.env`, `settings.json`) need a server restart; nothing is re-read between refreshes.
