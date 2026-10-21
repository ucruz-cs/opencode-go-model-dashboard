# Archived parsers

This directory is **not** part of the application. Nothing here is imported by
`server.mjs` or `lib/`.

## `goLimits-html.mjs`

A verbatim copy of the previous `lib/goLimits.mjs`, which parsed the rendered
OpenCode Go docs page (`https://opencode.ai/v2/docs/console/go/`) by scraping
its HTML tables. It was last known good on 2026-10-20.

It was replaced by the Markdown parser in `lib/goLimits.mjs`, which reads the
MIT-licensed source file directly:

```
https://raw.githubusercontent.com/anomalyco/opencode/dev/services/www/src/docs/content/console/go.mdx
```

The copy is kept only as a reference in case the Markdown source changes shape
or disappears. Its `import { ROOT } from "./env.mjs"` is relative to `lib/`, so
it will not run from this directory as-is; move it back to `lib/` to use it.
