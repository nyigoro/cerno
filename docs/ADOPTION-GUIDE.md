# Binary SOM Analyser — Adoption Guide

## What this tool does

The Binary SOM analyser reads your CSS and classifies every component into one of three tiers:

- **BIND_STATIC** — all values are absolute. No recalculation ever needed at runtime.
- **BIND_DETERMINISTIC** — values depend on measurable inputs (viewport size, font metrics, parent dimensions). Recalculation is bounded and predictable.
- **BIND_NONDETERMINISTIC** — values depend on DOM structure (`:nth-child`, `:has`, `:last-child`, etc.). Recalculation requires full cascade traversal.

The output is a report of your codebase's current classification state, a `.som` binary for runtime use, a `fallback.css` file for NONDETERMINISTIC selectors, and a JSON summary for CI integration.

---

## Hybrid Contract (Binary + Fallback CSS)

Binary SOM is intentionally hybrid:

- `styles.som` handles `BIND_STATIC` + `BIND_DETERMINISTIC`
- `fallback.css` handles `BIND_NONDETERMINISTIC` (`:nth-child`, `:last-child`, `:has()`, etc.)
- `fallback-map.json` maps NONDETERMINISTIC hashes to selectors for diagnostics

Why this exists:

- Structural selectors depend on live DOM structure, which cannot be encoded as a stable O(1) selector-hash lookup.
- Instead of forcing rewrites, Binary SOM routes those rules to standard CSS so behavior stays correct.

Runtime behavior:

1. STATIC/RULE_SET records apply inline from binary.
2. BOUNDARY records mount observers and invalidate deterministically.
3. NONDETERMINISTIC records trigger one-time lazy load of `fallback.css`.

This means adoption is safe for existing codebases: unchanged CSS still works, and only optimizable selectors move to binary.

---

## Live Demo (Binary Style Resolution)

To see the SOM runtime resolving styles from a binary buffer in the browser:

1. Install dependencies: `npm install`
2. Build the demo assets: `npm run demo:build` (emits `styles.som` + `fallback.css`)
3. Launch the demo server: `npm run demo:serve`
4. Open: `http://localhost:3000`

Open the browser console to inspect the loader stats and O(1) selector/hash lookups.

---

## Runtime API (`SOMRuntime`)

`SOMRuntime` is the standard browser handshake between `.som` and the DOM:

- Uses `[data-som]` attributes for selector mapping
- Applies `STATIC`/`RULE_SET` properties inline
- Lazy-loads `fallback.css` on first `NONDETERMINISTIC` hit
- Supports manual preloading with `preloadFallback()`
- Includes a subscription manager that batches boundary invalidation with `requestAnimationFrame`

```js
import { SOMLoaderBrowser } from '../dist/browser/browserLoader.js';
import { SOMRuntime } from '../dist/browser/runtime.js';

const loader = await SOMLoaderBrowser.load('/dist/styles.som');
const runtime = new SOMRuntime(loader, {
  attr: 'data-som',
  fallbackUrl: '/dist/fallback.css',
});

await runtime.applyAll(document);   // scans [data-som]
// optional warmup:
await runtime.preloadFallback();
```

Example markup:

```html
<div data-som="card-primary"></div>
```

Default resolver maps `card-primary` to `.card-primary`.

---

## Step 1 — Install

```bash
npm install --save-dev binary-som
```

No other dependencies required. The analyser, emitter, and loader are all self-contained.

---

## Step 2 — Run on your stylesheet

```bash
npx som-analyze src/styles.css
```

Or on multiple files:

```bash
npx som-analyze src/**/*.css
```

Example output:

```
  BINARY SOM — STATIC ANALYSIS REPORT
────────────────────────────────────────────────────────────────
Component             Classification         Boundary  Emit Type
────────────────────────────────────────────────────────────────
.btn                  BIND_STATIC            —         ResolvedStyleBlock
.card                 BIND_STATIC            —         ResolvedStyleBlock
.layout               BIND_DETERMINISTIC     ✓         DynamicBoundaryMarker
.layout .panel        BIND_DETERMINISTIC     —         RuleSet
.table tr:nth-child   BIND_NONDETERMINISTIC  —         (warn)
────────────────────────────────────────────────────────────────

Classification Summary
  BIND_STATIC           3/5 (60%)  ██████████████████░░░░░░░░░░░░
  BIND_DETERMINISTIC    1/5 (20%)  ██████░░░░░░░░░░░░░░░░░░░░░░░░
  BIND_NONDETERMINISTIC 1/5 (20%)  ██████░░░░░░░░░░░░░░░░░░░░░░░░
```

Exit codes: `0` = clean, `1` = NONDETERMINISTIC components found, `2` = error.

---

## Step 3 — Read the output

### BIND_STATIC
These components use only absolute values (`px`, `#hex`, named colours, fixed keywords). They are fully resolved at build time. No runtime work required.

```css
/* BIND_STATIC — all absolute */
.btn {
  display: flex;
  padding: 8px 16px;
  background-color: #2563EB;
  border-radius: 4px;
}
```

### BIND_DETERMINISTIC
These components depend on runtime inputs, but those inputs are enumerable and bounded. The analyser records exactly what each component depends on:

```
.layout   BIND_DETERMINISTIC  deps: PARENT_SIZE(width), VIEWPORT(min-height)
```

This means `.layout` needs recalculation when the parent's width changes or the viewport size changes — and only then.

```css
/* BIND_DETERMINISTIC — depends on parent width and viewport height */
.layout {
  width: 100%;        /* PARENT_SIZE */
  min-height: 100vh;  /* VIEWPORT */
}
```

### BIND_NONDETERMINISTIC
These components use structural pseudo-selectors. The DOM position of an element affects its appearance, which means recalculation requires knowledge of the full sibling context.

```css
/* BIND_NONDETERMINISTIC — depends on DOM position */
.table tr:nth-child(even) {
  background: #F8FAFC;
}
```

The analyser warns about these because they cannot be compiled to a static or deterministic representation. See Step 4 for how to fix them.

### Contamination
A DETERMINISTIC component propagates its classification to its CSS descendants:

```
.layout               BIND_DETERMINISTIC  [boundary]
.layout .panel        BIND_DETERMINISTIC  ← .layout
.layout .panel .title BIND_DETERMINISTIC  ← .layout
```

`.panel` and `.title` have only absolute values of their own, but because their parent `.layout` is dynamic, their rendered output depends on `.layout`'s resolved values. The boundary marker captures the full subgraph — everything that needs to be re-evaluated together.

---

## Step 4 — Fix NONDETERMINISTIC warnings

Every NONDETERMINISTIC warning is a refactor opportunity. The goal is to move position-dependent styling into data attributes or class names that your application sets explicitly.

### Pattern: zebra striping

**Before (NONDETERMINISTIC):**
```css
.table tr:nth-child(even) {
  background: #F8FAFC;
}
```

**After (STATIC):**
```css
.table tr[data-even] {
  background: #F8FAFC;
}
```

```js
// In your component
rows.forEach((row, i) => {
  row.dataset.even = (i % 2 === 0) ? '' : undefined;
});
```

The visual result is identical. The difference is that the styling decision is now explicit in the data rather than inferred from DOM position.

### Pattern: last-child border removal

**Before (NONDETERMINISTIC):**
```css
.list li:last-child {
  border-bottom: none;
}
```

**After (STATIC):**
```css
.list li[data-last] {
  border-bottom: none;
}
```

### Pattern: `:has()` parent styling

**Before (NONDETERMINISTIC):**
```css
.card:has(.badge) {
  padding-top: 24px;
}
```

**After (STATIC):**
```css
.card[data-has-badge] {
  padding-top: 24px;
}
```

### When you cannot refactor

If a NONDETERMINISTIC component is in a third-party library or cannot be changed, use `--ignore-nondeterministic` to suppress warnings for specific selectors:

```bash
npx som-analyze src/styles.css --ignore-nondeterministic ".vendor-table tr:nth-child"
```

This does not change the classification — the component is still marked NONDETERMINISTIC in the output. It only suppresses the warning so it does not fail CI.

---

## Step 5 — CI integration

### Basic: fail on NONDETERMINISTIC

Add to your CI pipeline:

```yaml
# .github/workflows/ci.yml
- name: CSS classification check
  run: npx som-analyze src/**/*.css
  # Exits 1 if any NONDETERMINISTIC components found
```

The exit code `1` fails the CI job. Exit code `0` means all components are STATIC or DETERMINISTIC.

### Tracking: diff the summary JSON

Emit the summary on every build and diff it between PRs:

```yaml
- name: Analyse CSS
  run: npx som-analyze src/**/*.css --json --out binary-som-summary.json

- name: Upload summary
  uses: actions/upload-artifact@v4
  with:
    name: binary-som-summary
    path: binary-som-summary.json
```

In a PR check, compare against the base branch summary to catch regressions:

```bash
# In PR pipeline — compare against main
npx som-analyze src/**/*.css --json --out pr-summary.json
diff main-summary.json pr-summary.json
```

A diff in `nondeterministic` count going up means the PR introduced structural selectors.

### Tracking: count thresholds

Fail only when the NONDETERMINISTIC count exceeds a threshold (useful when adopting incrementally):

```bash
# Allow up to 5 NONDETERMINISTIC components during migration
COUNT=$(npx som-analyze src/**/*.css --json | jq '.stats.nondeterministic')
if [ "$COUNT" -gt 5 ]; then
  echo "Too many NONDETERMINISTIC components: $COUNT (max 5)"
  exit 1
fi
```

---

## Vite integration

```bash
npm install --save-dev binary-som
```

```js
// vite.config.js
import { binarySomPlugin } from 'binary-som/vite';

export default {
  plugins: [
    binarySomPlugin({
      failOnNonDeterministic: false,  // warn only (default)
      verbose: true,                  // show report in build output
    })
  ]
}
```

The plugin emits four files to your build output:
- `dist/styles.som` — binary component database
- `dist/fallback.css` — NONDETERMINISTIC fallback stylesheet (lazy-load in runtime)
- `dist/fallback-map.json` — NONDETERMINISTIC hash → selector map (diagnostics)
- `dist/binary-som-summary.json` — build report

---

## webpack integration

```js
// webpack.config.js
const { BinarySomPlugin } = require('binary-som/webpack');

module.exports = {
  plugins: [
    new BinarySomPlugin({
      failOnNonDeterministic: false,  // warn only (default)
    })
  ]
};
```

Compatible with webpack 5 and Rspack.
Output assets mirror Vite: `styles.som`, `fallback.css`, `fallback-map.json`, and `binary-som-summary.json`.

---

## Watch mode

Run the analyser in watch mode to see classification changes as you edit:

```bash
npx som-analyze --watch src/styles.css
```

Output on each change shows only what changed:

```
[14:32:07] src/components.css changed
  ~ .card-grid      STATIC → DETERMINISTIC  (reclassified)
  + .hero__subtitle STATIC
  ⚠ MISSING_CONTAINER: .card-grid uses cqw but has no container-type ancestor
```

- `+` new component detected
- `-` component removed
- `~` classification changed (green = improved, red = degraded)
- `⚠` new warning
- `✓` warning resolved

---

## Token files

If your design system uses a central token file, pass it to the analyser so token chains resolve correctly:

```bash
npx som-analyze src/**/*.css --tokens tokens.json
```

```json
{
  "--color-primary": "#2563EB",
  "--spacing-base": "16px",
  "--font-size-fluid": "clamp(1rem, 3vw, 2rem)"
}
```

Tokens with absolute values (`#2563EB`, `16px`) allow components that reference them to classify as STATIC. Tokens with runtime values (`clamp(1rem, 3vw, 2rem)`) cause referencing components to classify as DETERMINISTIC with the appropriate dependency type.

---

## Understanding dependency types

When a component is DETERMINISTIC, the analyser records what it depends on:

| Dep type | Triggered by | Example |
|----------|-------------|---------|
| `PARENT_SIZE` | `%` lengths | `width: 50%` |
| `VIEWPORT` | `vw`, `vh`, `vmin`, `vmax` | `height: 100vh` |
| `FONT_METRICS` | `rem`, `em`, `ch` | `padding: 1rem` |
| `CONTAINER_SIZE` | `cqw`, `cqh`, `cqi`, `cqb` | `font-size: 2cqw` |
| `ENV` | `env()` | `padding-top: env(safe-area-inset-top)` |
| `USER_PREF` | `@media (prefers-*)`, `forced-colors`, `inverted-colors` | `@media (prefers-color-scheme: dark)` |

These dependency types are recorded in the boundary manifest and in the summary JSON. They tell a runtime exactly what to observe in order to know when to re-evaluate a component.

---

## Frequently asked questions

**Q: My entire stylesheet is DETERMINISTIC because one top-level layout uses `width: 100%`. Is that expected?**

Yes. Contamination propagates from parent to child in the CSS selector graph. A layout component with `width: 100%` is DETERMINISTIC, and all components that are CSS descendants of it inherit that classification. This is correct — their rendered output does depend on the layout's resolved width.

To limit contamination spread, consider whether the parent component genuinely needs a relative width, or whether a fixed pixel value would work for your use case.

**Q: I have a NONDETERMINISTIC component in a CSS framework I can't modify. What do I do?**

Use `--ignore-nondeterministic` to suppress the warning without changing the classification. If you're using the Vite or webpack plugin, pass `ignoreSelectors: ['.framework-selector']` in the plugin options.

**Q: The binary is large. Why?**

The pool section contains the full CSS property vocabulary (~60 entries, ~500 bytes) regardless of which properties your codebase uses. This ensures stable pool indices across incremental builds. At scale this cost is amortised across hundreds of components — a 500-byte fixed cost on a 10KB binary is negligible.

**Q: Can I use the `.som` binary without the full pipeline?**

Yes. The binary format is documented in `COMP-SPEC-001`. The loader (`binary-som/loader`) reads `.som` files with no dependency on the analyser or emitter:

```js
const { loadSOM } = require('binary-som/loader');
const loader = loadSOM('./dist/styles.som');
const btn = loader.getStatic('.btn');
// btn.properties → Map<propertyName, rawValue>
```

**Q: What's the difference between a boundary and a rule set?**

A boundary is the root of a dynamic subgraph — the highest component in the selector hierarchy that has a runtime dependency. Everything below it in the graph is governed by that boundary's manifest.

A rule set is a contaminated non-boundary node. It has no runtime dependencies of its own but is governed by its boundary's manifest because its rendered output is affected by the boundary's resolved values.

The boundary's manifest tells the runtime what to observe and what subgraph members to invalidate when those observations change.
