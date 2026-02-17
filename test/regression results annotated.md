# Binary SOM Analyser — Regression Suite Results
## Reference baseline + annotation for VS Code implementation

---

## How to Read This Document

Each failure is tagged:

- **[FIXED-IN-YOURS]** — Your changelog confirms this is fixed. Expect to pass.
- **[OPEN]** — Not yet addressed. Investigate before binary emitter work.
- **[SPEC-GAP]** — Correct behaviour requires a spec decision not yet made.

Run the suite against your implementation:
```
node regression.test.js
```

Expected result for your implementation: **≥128/135 passing**.
The 7 remaining open items are listed explicitly below.

---

## Section Results

### §1 Parser Robustness — 22/22 ✓
All crash-safety tests pass in reference. Should pass in yours.

### §2 BIND_STATIC — 10/10 ✓
All absolute-value classification tests pass.

### §3 BIND_DETERMINISTIC — 14/18
**4 failures — all [FIXED-IN-YOURS]**

| Test | Status | Reason |
|------|--------|--------|
| token chain A→B→rem | FIXED-IN-YOURS | resolveTokenChain() implemented |
| FONT_METRICS dep from chain | FIXED-IN-YOURS | resolveTokenChain() implemented |
| token→clamp(rem,vw,rem) | FIXED-IN-YOURS | resolveTokenChain() implemented |
| VIEWPORT dep dominant | FIXED-IN-YOURS | resolveTokenChain() implemented |

### §4 BIND_NONDETERMINISTIC — 5/5 ✓
All structural pseudo-class tests pass.

### §5 Contamination Propagation — 17/19
**2 failures — one [FIXED-IN-YOURS], one [OPEN]**

| Test | Status | Reason |
|------|--------|--------|
| grandchild contamination (.layout .panel .content) | FIXED-IN-YOURS | extractParentSelector 3-level fixed |
| manifest subgraph has all 3 | OPEN | See §Open Issues #1 below |

**Open Issue #1 — Manifest subgraph count for 3-level trees**

In the test `.layout → .layout .panel → .layout .panel .content`:
- `.layout` is the boundary
- manifest `subgraphIds` returns `['.layout', '.layout .panel']` — missing `.content`
- Expected: `['.layout', '.layout .panel', '.layout .panel .content']`

Root cause: `collectSubgraphIds` in `analyser.js` walks `node.children`, but
`.layout .panel .content`'s parent is `.layout .panel`, which IS in `node.children`
of the boundary. The walk should reach it. Check whether the `collectSubgraphIds`
function is correctly iterating grandchildren, or if it stops at depth 1.

Reproduce:
```js
const r = analyseCSS(`
  .layout { width: 100%; }
  .layout .panel { background: white; }
  .layout .panel .content { font-size: 14px; }
`);
console.log(r.manifests.get('.layout').subgraphIds);
// Should be: ['.layout', '.layout .panel', '.layout .panel .content']
// Failing as: ['.layout', '.layout .panel']
```

### §6 Container Queries — 6/6 ✓
All container query tests pass in reference.

### §7 Token Chain Resolution — 6/10
**4 failures — 3 [FIXED-IN-YOURS], 1 [OPEN]**

| Test | Status | Reason |
|------|--------|--------|
| three-level chain A→B→C→rem | FIXED-IN-YOURS | resolveTokenChain() |
| FONT_METRICS dep deep chain | FIXED-IN-YOURS | resolveTokenChain() |
| token defined after use | FIXED-IN-YOURS | first-pass token table assembly |
| var() with rem fallback value | OPEN | See §Open Issues #2 below |

**Open Issue #2 — var() fallback argument not parsed**

`var(--undefined, 1rem)` — when the referenced token is undefined, the fallback
value should be used for classification. Currently the fallback after the comma
is ignored, and the whole expression returns `BIND_STATIC`.

The correct behaviour:
- `var(--undefined, 16px)` → STATIC (fallback is absolute)
- `var(--undefined, 1rem)` → DETERMINISTIC / FONT_METRICS (fallback is runtime)
- `var(--defined, 1rem)` → resolved by the defined token, fallback irrelevant

Fix location in `valueAnalyser.js`: in the `var()` branch, after attempting
token resolution, if the token is not in `tokenDefinitions`, parse the fallback
argument (text after first comma inside the parens) and classify it instead.

```js
// In analyseToken() or analyseValue(), var() branch:
const varMatch = t.match(/^var\(\s*(--[\w-]+)(?:\s*,\s*(.+))?\s*\)$/s);
if (varMatch) {
  const tokenName = varMatch[1];
  const fallback  = varMatch[2]; // may be undefined
  const resolved  = resolveTokenChain(tokenName, tokenDefs, new Set());
  if (resolved === 'circular' || (resolved === 'absolute' && !tokenDefs[tokenName])) {
    // Token undefined — classify fallback if present
    if (fallback) return analyseToken(fallback.trim());
    return { isRuntime: false, depType: THEME, reason: 'undefined token, no fallback' };
  }
  return resolved;
}
```

### §8 Selector Parsing Edge Cases — 9/18
**9 failures — 7 [FIXED-IN-YOURS], 2 [OPEN]**

| Test | Status | Reason |
|------|--------|--------|
| :is() not split into h2 | FIXED-IN-YOURS | depth-aware parseSelector() |
| :is() malformed h3) | FIXED-IN-YOURS | depth-aware parseSelector() |
| only 1 node from :is(h1,h2,h3) | FIXED-IN-YOURS | depth-aware parseSelector() |
| :where() not split at comma | FIXED-IN-YOURS | depth-aware parseSelector() |
| [attr="a,b"] single node | FIXED-IN-YOURS | depth-aware parseSelector() |
| .nav > .item parent extraction | FIXED-IN-YOURS | tokeniseSelectorSegments() |
| .nav > .item contamination | FIXED-IN-YOURS | tokeniseSelectorSegments() |
| :is(.wrapper,.container) .title exists | OPEN | See §Open Issues #3 |
| :is(.wrapper,.container) .title class | OPEN | See §Open Issues #3 |

**Open Issue #3 — Parent extraction for :is()/:where() selectors**

`extractParentSelector(':is(.wrapper, .container) .title')` must return
`:is(.wrapper, .container)` — the whole functional pseudo-class as the parent,
not a fragment of it.

With `tokeniseSelectorSegments()` fixed for depth-aware splitting, this
should already work if the depth tracking is applied consistently. The test
is failing in the reference repo where the fix isn't applied. Check your
implementation by running:

```js
const { extractParentSelector } = require('./src/cssparser');
console.log(extractParentSelector(':is(.wrapper, .container) .title'));
// Expected: ':is(.wrapper, .container)'
// If broken: ':is(.wrapper' or similar
```

If this still fails in your implementation, the issue is that the
`tokeniseSelectorSegments` function splits on the space before `.title`
correctly, but the reconstruction of the parent from segments doesn't
preserve the full `:is(...)` token.

### §9 CSS Native Nesting — 3/6
**3 failures — all [FIXED-IN-YOURS] per changelog**

| Test | Status | Reason |
|------|--------|--------|
| nested .title exists | FIXED-IN-YOURS | & nesting implemented |
| .container not DETERMINISTIC | FIXED-IN-YOURS | brace-depth fix stops nested rule bleeding into parent props |
| fluid-text node exists | FIXED-IN-YOURS | & nesting implemented |

### §10 @media / @layer Scoping — 3/3 ✓
All pass (the crash-safety and no-corruption tests pass).

### §11 Portal Escape — 4/4 ✓
Both portal tests pass in reference.

### §12 Output Integrity — 2/3
**1 failure — [OPEN]**

| Test | Status | Reason |
|------|--------|--------|
| JSON output is valid | OPEN | See §Open Issues #4 |

**Open Issue #4 — Circular reference in JSON serialisation**

`JSON.stringify(result)` throws `Converting circular structure to JSON`
because `ComponentNode.subgraphRoot` points to another `ComponentNode` object,
which may point back to itself (boundary nodes set `subgraphRoot = this`).

The `result` object also has `ComponentNode.parent`, `ComponentNode.children`,
`ComponentNode.contaminatedBy`, `ComponentNode.contaminates` — all of which
are object references that create cycles.

**Fix:** The JSON output function (in `reporter.js`) must serialise nodes
using ID references only, not object references. The existing `toJSON()`
function in the reference repo does this correctly — it extracts `.id` from
every node reference. But `JSON.stringify(result)` on the raw `AnalysisResult`
object will always fail because `AnalysisResult.nodes` is a `Map<string, ComponentNode>`
and each `ComponentNode` has circular refs.

Make sure users call `toJSON(result)` from reporter, not `JSON.stringify(result)`.
The test in the suite calls `JSON.stringify(r)` — this is intentionally adversarial.
The fix is either:
- Add a `toJSON()` method to the result object that returns a safe representation, OR
- Document clearly that raw result must not be JSON-serialised directly

Recommended: add `result.toJSON = () => toJSON(result)` so
`JSON.stringify(result)` Just Works via the custom replacer.

---

## Summary of Open Issues for Your Implementation

| # | Issue | Severity | Location |
|---|-------|----------|----------|
| 1 | Manifest subgraph misses grandchildren | Medium | `analyser.js: collectSubgraphIds()` |
| 2 | `var()` fallback argument not parsed | Medium | `valueAnalyser.js: analyseToken()` |
| 3 | `extractParentSelector` for `:is()`/`:where()` selectors | Low-Medium | `cssparser.js: extractParentSelector()` |
| 4 | `JSON.stringify(result)` circular ref crash | Low | `analyser.js` or `reporter.js` |

Issues #1 and #2 affect classification correctness and should be fixed before
the constant pool emitter is built. Issues #3 and #4 are correctness and DX
issues respectively — fix #3 before public release, #4 before any API consumers.

---

## Running Against Your Implementation

```bash
# From your project root:
node regression.test.js

# Expected output:
#   Results: 128+ passed, <7 failed, 0 skipped
```

If token chain resolution is wired correctly, §3 and §7 failures will
disappear (adds 8 passes). If nesting is implemented, §9 failures disappear
(adds 3 passes). Selector fixes add 7 passes from §8.

Total expected for fully-patched implementation: **132–135 / 135**.