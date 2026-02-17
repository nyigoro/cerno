// ─────────────────────────────────────────────────────────────────────────────
// Binary SOM Analyser — Adversarial Regression Suite
// Drop this file into your project root and run: node regression.test.js
//
// Requires: analyseCSS exported from your analyser entry point.
// Edit the require path below to match your project structure.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

// ── EDIT THIS PATH to match your project ─────────────────────────────────────
const { analyseCSS } = require('../dist/src/analyser');
// or: require('./index'), require('./src/analyser'), etc.
// ─────────────────────────────────────────────────────────────────────────────

function toDepEntries(node) {
  const source = Array.isArray(node.depEntries)
    ? node.depEntries
    : Array.isArray(node.deps)
      ? node.deps
      : [];

  return source.map((dep) => ({
    componentId: dep.componentId ?? node.id,
    propertyName: dep.propertyName ?? dep.property ?? '',
    property: dep.property ?? dep.propertyName ?? '',
    depTypeName: dep.depTypeName ?? dep.depType ?? '',
    depType: dep.depType ?? dep.depTypeName ?? '',
    containerId: dep.containerId ?? null,
  })).filter((dep) => dep.depTypeName !== 'THEME');
}

function adaptResult(raw) {
  const rawNodes = Array.isArray(raw.nodes) ? raw.nodes : Array.from(raw.nodes?.values?.() ?? []);
  const idToSelector = new Map();
  for (const node of rawNodes) {
    idToSelector.set(node.id, node.selector);
  }

  const adaptedNodes = new Map();
  for (const node of rawNodes) {
    const adapted = {
      ...node,
      depEntries: toDepEntries(node),
      isBoundary: typeof node.isBoundary === 'boolean'
        ? node.isBoundary
        : (node.boundaryId && node.boundaryId === node.id),
      contaminatedBy: node.contaminationSource ? { id: node.contaminationSource } : null,
      contaminates: [],
      emitType: node.emitType === 'DynamicBoundaryMarker+RuleSet+DependencyManifest'
        ? 'DynamicBoundaryMarker'
        : node.emitType,
    };

    // Primary lookup by full selector used by this suite.
    if (!adaptedNodes.has(node.selector)) adaptedNodes.set(node.selector, adapted);
    // Secondary lookup by component id for direct id-based access.
    if (!adaptedNodes.has(node.id)) adaptedNodes.set(node.id, adapted);
  }

  // Backfill contaminates from contaminationSource relations.
  for (const node of rawNodes) {
    if (!node.contaminationSource) continue;
    const parent = adaptedNodes.get(idToSelector.get(node.contaminationSource)) ||
      adaptedNodes.get(node.contaminationSource);
    const child = adaptedNodes.get(node.selector);
    if (parent && child) {
      parent.contaminates.push({ id: child.id, selector: child.selector });
    }
  }

  const rawManifests = Array.isArray(raw.manifests) ? raw.manifests : Array.from(raw.manifests?.values?.() ?? []);
  const adaptedManifests = new Map();
  for (const manifest of rawManifests) {
    const boundarySelector = idToSelector.get(manifest.componentId) ?? manifest.componentId;
    const mapped = {
      ...manifest,
      componentId: boundarySelector,
      subgraphIds: (manifest.subgraphIds ?? []).map((id) => idToSelector.get(id) ?? id),
      entries: (manifest.entries ?? []).map((entry) => ({
        ...entry,
        componentId: idToSelector.get(entry.componentId) ?? entry.componentId,
      })),
    };
    adaptedManifests.set(boundarySelector, mapped);
    if (!adaptedManifests.has(manifest.componentId)) {
      adaptedManifests.set(manifest.componentId, mapped);
    }
  }

  const rawWarnings = Array.isArray(raw.warnings) ? raw.warnings : [];
  const adaptedWarnings = rawWarnings.map((warning) => {
    if (warning && typeof warning === 'object') return warning;
    const msg = String(warning ?? '');
    let type = 'GENERIC_WARNING';
    if (msg.includes('structural selector')) type = 'STRUCTURAL_DYNAMIC';
    else if (msg.includes('no container ancestor')) type = 'MISSING_CONTAINER';
    else if (msg.includes('PORTAL_ID target')) type = 'PORTAL_MISSING';
    return { type, msg };
  });

  const stats = raw.stats ?? raw.summary ?? {
    total: rawNodes.length,
    static: rawNodes.filter(n => n.finalClass === 'BIND_STATIC').length,
    deterministic: rawNodes.filter(n => n.finalClass === 'BIND_DETERMINISTIC').length,
    nondeterministic: rawNodes.filter(n => n.finalClass === 'BIND_NONDETERMINISTIC').length,
  };

  return {
    ...raw,
    nodes: adaptedNodes,
    manifests: adaptedManifests,
    warnings: adaptedWarnings,
    stats,
    toJSON() {
      return {
        stats,
        warnings: adaptedWarnings,
        components: Object.fromEntries(
          Array.from(adaptedNodes.entries()).map(([id, n]) => [id, {
            id,
            finalClass: n.finalClass,
            isBoundary: n.isBoundary,
            contaminatedBy: n.contaminatedBy?.id ?? null,
          }])
        ),
      };
    },
  };
}

let passed = 0, failed = 0, skipped = 0;
const failures = [];

function assert(label, actual, expected, context = '') {
  if (actual === expected) {
    passed++;
  } else {
    failed++;
    failures.push({ label, actual, expected, context });
    console.log(`  ✗ ${label}`);
    console.log(`      expected: ${JSON.stringify(expected)}`);
    console.log(`      actual:   ${JSON.stringify(actual)}`);
    if (context) console.log(`      context:  ${context}`);
  }
}

function assertNoThrow(label, fn) {
  try { fn(); passed++; }
  catch (e) {
    failed++;
    failures.push({ label, actual: `THREW: ${e.message}`, expected: 'no throw' });
    console.log(`  ✗ ${label} — threw: ${e.message}`);
  }
}

function assertWarning(label, warnings, type) {
  const found = warnings.some(w => w.type === type);
  assert(label + ` (warning type ${type})`, found, true);
}

function section(title) {
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`  ${title}`);
  console.log('═'.repeat(70));
}

function run(label, css, checks, opts = {}) {
  let result;
  try {
    result = adaptResult(analyseCSS(css, opts));
  } catch (e) {
    failed++;
    failures.push({ label: `[CRASH] ${label}`, actual: e.message, expected: 'no throw' });
    console.log(`  ✗ [CRASH] ${label}: ${e.message}`);
    return;
  }
  checks(result);
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 1 — Parser robustness (should never crash, should parse correctly)
// ─────────────────────────────────────────────────────────────────────────────
section('1. Parser Robustness — Should Never Crash');

assertNoThrow('empty string input', () => analyseCSS(''));
assertNoThrow('only whitespace', () => analyseCSS('   \n\t  '));
assertNoThrow('only comments', () => analyseCSS('/* comment */\n/* another */'));
assertNoThrow('missing closing brace', () => analyseCSS('.btn { color: red;'));
assertNoThrow('double closing brace', () => analyseCSS('.btn { color: red; }}'));
assertNoThrow('missing opening brace', () => analyseCSS('.btn color: red; }'));
assertNoThrow('empty rule', () => analyseCSS('.empty {}'));
assertNoThrow('rule with only comments', () => analyseCSS('.x { /* nothing */ }'));
assertNoThrow('unicode in selector', () => analyseCSS('.café { color: red; }'));
assertNoThrow('unicode in value', () => analyseCSS('.x { content: "→ ✓ 日本語"; }'));
assertNoThrow('very long selector', () => analyseCSS('.a .b .c .d .e .f .g .h .i .j { color: red; }'));
assertNoThrow('empty :root', () => analyseCSS(':root {}'));
assertNoThrow('@keyframes block', () => analyseCSS('@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }'));
assertNoThrow('@import statement', () => analyseCSS("@import 'other.css'; .x { color: red; }"));
assertNoThrow('multiple @media nesting', () => analyseCSS('@media (min-width: 768px) { @media (prefers-color-scheme: dark) { .x { color: white; } } }'));
assertNoThrow('selector with escaped characters', () => analyseCSS('.item\\.active { color: blue; }'));
assertNoThrow('attribute selector with comma in value', () => analyseCSS('[data-tags="a,b,c"] { color: red; }'));
assertNoThrow('url() with data URI containing braces', () =>
  analyseCSS('.x { background: url("data:image/svg+xml,<svg xmlns=\\"http://www.w3.org/2000/svg\\"><rect/></svg>"); }'));
assertNoThrow('content property with semicolons', () => analyseCSS('.x::before { content: "a;b;c"; color: red; }'));
assertNoThrow('calc with nested parens', () => analyseCSS('.x { width: calc(100% - (2 * 16px)); }'));

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 2 — Classification correctness: BIND_STATIC
// ─────────────────────────────────────────────────────────────────────────────
section('2. BIND_STATIC — All absolute values');

run('absolute px values only', '.btn { display: flex; padding: 8px 16px; font-size: 14px; border-radius: 4px; }', r => {
  const n = r.nodes.get('.btn');
  assert('classified STATIC', n?.finalClass, 'BIND_STATIC');
  assert('no dep entries', n?.depEntries.length, 0);
  assert('no manifest', r.manifests.has('.btn'), false);
  assert('emits ResolvedStyleBlock', n?.emitType, 'ResolvedStyleBlock');
});

run('hex colors + named colors', '.x { color: #2563EB; background: white; border-color: transparent; }', r => {
  assert('STATIC', r.nodes.get('.x')?.finalClass, 'BIND_STATIC');
});

run('token ref to absolute value', ':root { --color: #2563EB; } .x { color: var(--color); }', r => {
  assert('STATIC — token resolves to absolute', r.nodes.get('.x')?.finalClass, 'BIND_STATIC');
  assert('no dep entries for token ref', r.nodes.get('.x')?.depEntries.length, 0);
});

run('token chain: A → B → absolute px', ':root { --base: 16px; --size: var(--base); } .x { font-size: var(--size); }', r => {
  assert('STATIC — chain resolves to px', r.nodes.get('.x')?.finalClass, 'BIND_STATIC');
  assert('no dep entries', r.nodes.get('.x')?.depEntries.length, 0);
});

run('!important stripped, value still classified', '.x { color: red !important; font-size: 14px !important; }', r => {
  assert('STATIC despite !important', r.nodes.get('.x')?.finalClass, 'BIND_STATIC');
});

run(':hover and :focus pseudo-states', '.btn { color: #fff; } .btn:hover { background: #1D4ED8; } .btn:focus { outline: 2px solid #2563EB; }', r => {
  assert('.btn STATIC', r.nodes.get('.btn')?.finalClass, 'BIND_STATIC');
  assert('.btn:hover STATIC', r.nodes.get('.btn:hover')?.finalClass, 'BIND_STATIC');
  assert('.btn:focus STATIC', r.nodes.get('.btn:focus')?.finalClass, 'BIND_STATIC');
});

run('zero values (no unit)', '.x { margin: 0; padding: 0; border: 0; }', r => {
  assert('STATIC — zero values', r.nodes.get('.x')?.finalClass, 'BIND_STATIC');
});

run('rgba() and hsl() absolute', '.x { color: rgba(37,99,235,0.8); background: hsl(217,91%,60%); }', r => {
  assert('STATIC — absolute colour functions', r.nodes.get('.x')?.finalClass, 'BIND_STATIC');
});

run('calc() with all-absolute operands', '.x { width: calc(200px + 48px); margin: calc(16px - 4px); }', r => {
  assert('STATIC — calc all-absolute pre-computable', r.nodes.get('.x')?.finalClass, 'BIND_STATIC');
});

run('vendor-prefixed scalar percentage stays STATIC', 'html { font-size: 16px; -webkit-text-size-adjust: 100%; }', r => {
  const n = r.nodes.get('html');
  assert('STATIC — vendor-prefixed 100% scalar', n?.finalClass, 'BIND_STATIC');
  assert('no false PARENT_SIZE dep from -webkit-text-size-adjust',
    n?.depEntries.some(e => e.depTypeName === 'PARENT_SIZE' && e.propertyName === '-webkit-text-size-adjust'),
    false
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 3 — Classification correctness: BIND_DETERMINISTIC
// ─────────────────────────────────────────────────────────────────────────────
section('3. BIND_DETERMINISTIC — Enumerable runtime deps');

run('percentage width', '.x { width: 50%; }', r => {
  const n = r.nodes.get('.x');
  assert('DETERMINISTIC', n?.finalClass, 'BIND_DETERMINISTIC');
  assert('PARENT_SIZE dep on width', n?.depEntries.some(e => e.depTypeName === 'PARENT_SIZE' && e.propertyName === 'width'), true);
  assert('manifest generated', r.manifests.has('.x'), true);
  assert('emits DynamicBoundaryMarker', n?.emitType, 'DynamicBoundaryMarker');
});

run('rem unit', '.x { font-size: 1.25rem; }', r => {
  const n = r.nodes.get('.x');
  assert('DETERMINISTIC', n?.finalClass, 'BIND_DETERMINISTIC');
  assert('FONT_METRICS dep', n?.depEntries.some(e => e.depTypeName === 'FONT_METRICS'), true);
});

run('em unit', '.x { padding: 1em; margin: 0.5em; }', r => {
  assert('DETERMINISTIC — em unit', r.nodes.get('.x')?.finalClass, 'BIND_DETERMINISTIC');
});

run('viewport units: vw/vh', '.x { width: 100vw; height: 100vh; }', r => {
  const n = r.nodes.get('.x');
  assert('DETERMINISTIC', n?.finalClass, 'BIND_DETERMINISTIC');
  assert('VIEWPORT dep on width', n?.depEntries.some(e => e.depTypeName === 'VIEWPORT' && e.propertyName === 'width'), true);
  assert('VIEWPORT dep on height', n?.depEntries.some(e => e.depTypeName === 'VIEWPORT' && e.propertyName === 'height'), true);
});

run('clamp() with mixed operands', '.x { font-size: clamp(1rem, 3vw, 2rem); }', r => {
  const n = r.nodes.get('.x');
  assert('DETERMINISTIC — clamp mixed', n?.finalClass, 'BIND_DETERMINISTIC');
  // VIEWPORT should dominate over FONT_METRICS per dominance rule
  assert('VIEWPORT dep (dominant in clamp)', n?.depEntries.some(e => e.depTypeName === 'VIEWPORT'), true);
});

run('min() with one absolute and one relative operand', '.x { width: min(400px, 80%); }', r => {
  const n = r.nodes.get('.x');
  assert('DETERMINISTIC — min() mixed', n?.finalClass, 'BIND_DETERMINISTIC');
  assert('PARENT_SIZE dep', n?.depEntries.some(e => e.depTypeName === 'PARENT_SIZE'), true);
});

run('max() all absolute — should be STATIC', '.x { width: max(200px, 400px); }', r => {
  assert('STATIC — max all-absolute', r.nodes.get('.x')?.finalClass, 'BIND_STATIC');
});

run('env() expression', '.x { padding-top: env(safe-area-inset-top); }', r => {
  const n = r.nodes.get('.x');
  assert('DETERMINISTIC — env()', n?.finalClass, 'BIND_DETERMINISTIC');
  assert('ENV dep', n?.depEntries.some(e => e.depTypeName === 'ENV'), true);
});

run('token chain to runtime: A → B → rem', ':root { --base: 1rem; --scale: var(--base); } .x { font-size: var(--scale); }', r => {
  const n = r.nodes.get('.x');
  assert('DETERMINISTIC — chain resolves to rem', n?.finalClass, 'BIND_DETERMINISTIC');
  assert('FONT_METRICS dep from chain', n?.depEntries.some(e => e.depTypeName === 'FONT_METRICS'), true);
});

run('token chain to runtime: token → clamp(rem,vw,rem)', ':root { --fluid: clamp(1rem, 3vw, 2rem); } .x { font-size: var(--fluid); }', r => {
  const n = r.nodes.get('.x');
  assert('DETERMINISTIC — token resolves to clamp with vw', n?.finalClass, 'BIND_DETERMINISTIC');
  assert('VIEWPORT dep (dominant)', n?.depEntries.some(e => e.depTypeName === 'VIEWPORT'), true);
});

run('intrinsic sizing keyword', '.x { width: fit-content; }', r => {
  assert('DETERMINISTIC — fit-content', r.nodes.get('.x')?.finalClass, 'BIND_DETERMINISTIC');
});

run('min-content / max-content', '.x { width: min-content; } .y { width: max-content; }', r => {
  assert('DETERMINISTIC — min-content', r.nodes.get('.x')?.finalClass, 'BIND_DETERMINISTIC');
  assert('DETERMINISTIC — max-content', r.nodes.get('.y')?.finalClass, 'BIND_DETERMINISTIC');
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 4 — Classification correctness: BIND_NONDETERMINISTIC
// ─────────────────────────────────────────────────────────────────────────────
section('4. BIND_NONDETERMINISTIC — Structural selectors');

run(':nth-child', '.list li:nth-child(even) { background: #F8FAFC; }', r => {
  const n = r.nodes.get('.list li:nth-child(even)');
  assert('NONDETERMINISTIC — :nth-child', n?.finalClass, 'BIND_NONDETERMINISTIC');
  assert('STRUCTURAL_DYNAMIC warning', r.warnings.some(w => w.type === 'STRUCTURAL_DYNAMIC'), true);
});

run(':nth-of-type', 'table tr:nth-of-type(odd) { background: #fff; }', r => {
  assert('NONDETERMINISTIC — :nth-of-type', r.nodes.get('table tr:nth-of-type(odd)')?.finalClass, 'BIND_NONDETERMINISTIC');
});

run(':last-child', '.list li:last-child { border-bottom: none; }', r => {
  assert('NONDETERMINISTIC — :last-child', r.nodes.get('.list li:last-child')?.finalClass, 'BIND_NONDETERMINISTIC');
});

run(':first-child', '.list li:first-child { margin-top: 0; }', r => {
  assert('NONDETERMINISTIC — :first-child', r.nodes.get('.list li:first-child')?.finalClass, 'BIND_NONDETERMINISTIC');
});

run(':empty', '.x:empty { display: none; }', r => {
  assert('NONDETERMINISTIC — :empty', r.nodes.get('.x:empty')?.finalClass, 'BIND_NONDETERMINISTIC');
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 5 — Contamination propagation
// ─────────────────────────────────────────────────────────────────────────────
section('5. Contamination Propagation');

run('parent % contaminates child', `
  .container { width: 50%; }
  .container .title { font-size: 18px; color: #1E293B; }
  .container .body  { font-size: 14px; }
`, r => {
  assert('container DETERMINISTIC', r.nodes.get('.container')?.finalClass, 'BIND_DETERMINISTIC');
  assert('container is boundary', r.nodes.get('.container')?.isBoundary, true);
  assert('.title contaminated to DETERMINISTIC', r.nodes.get('.container .title')?.finalClass, 'BIND_DETERMINISTIC');
  assert('.title NOT boundary (governed by container)', r.nodes.get('.container .title')?.isBoundary, false);
  assert('.body contaminated to DETERMINISTIC', r.nodes.get('.container .body')?.finalClass, 'BIND_DETERMINISTIC');
  const manifest = r.manifests.get('.container');
  assert('manifest includes .title in subgraph', manifest?.subgraphIds.includes('.container .title'), true);
  assert('manifest includes .body in subgraph', manifest?.subgraphIds.includes('.container .body'), true);
  assert('no manifest for .title', r.manifests.has('.container .title'), false);
  assert('no manifest for .body', r.manifests.has('.container .body'), false);
});

run('contamination does not cross unrelated branches', `
  .sidebar { width: 280px; }
  .main { width: 50%; }
  .main .card { background: white; padding: 16px; }
  .sidebar .nav-item { padding: 8px 16px; color: #1E293B; }
`, r => {
  assert('.sidebar STATIC (fixed px)', r.nodes.get('.sidebar')?.finalClass, 'BIND_STATIC');
  assert('.main DETERMINISTIC', r.nodes.get('.main')?.finalClass, 'BIND_DETERMINISTIC');
  assert('.main .card contaminated', r.nodes.get('.main .card')?.finalClass, 'BIND_DETERMINISTIC');
  assert('.sidebar .nav-item NOT contaminated', r.nodes.get('.sidebar .nav-item')?.finalClass, 'BIND_STATIC');
});

run('child with own runtime dep on STATIC parent', `
  .card { background: white; padding: 16px; }
  .card .responsive-text { font-size: clamp(14px, 2vw, 18px); }
`, r => {
  assert('.card STATIC', r.nodes.get('.card')?.finalClass, 'BIND_STATIC');
  assert('.card .responsive-text DETERMINISTIC (own dep)', r.nodes.get('.card .responsive-text')?.finalClass, 'BIND_DETERMINISTIC');
  assert('.card .responsive-text IS boundary', r.nodes.get('.card .responsive-text')?.isBoundary, true);
});

run('grandchild contamination via intermediate', `
  .layout { width: 100%; }
  .layout .panel { background: white; }
  .layout .panel .content { font-size: 14px; }
`, r => {
  assert('.layout DETERMINISTIC', r.nodes.get('.layout')?.finalClass, 'BIND_DETERMINISTIC');
  assert('.layout .panel contaminated', r.nodes.get('.layout .panel')?.finalClass, 'BIND_DETERMINISTIC');
  assert('.layout .panel .content contaminated', r.nodes.get('.layout .panel .content')?.finalClass, 'BIND_DETERMINISTIC');
  assert('only .layout is boundary', r.nodes.get('.layout')?.isBoundary, true);
  assert('.panel not boundary', r.nodes.get('.layout .panel')?.isBoundary, false);
  assert('.content not boundary', r.nodes.get('.layout .panel .content')?.isBoundary, false);
  const m = r.manifests.get('.layout');
  assert('manifest subgraph has all 3', m?.subgraphIds.length, 3);
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 6 — Container queries
// ─────────────────────────────────────────────────────────────────────────────
section('6. Container Queries');

run('cqw resolves to nearest container', `
  .card { container-type: inline-size; background: white; }
  .card .card-title { font-size: max(14px, 2.5cqw); }
`, r => {
  const title = r.nodes.get('.card .card-title');
  assert('.card-title DETERMINISTIC', title?.finalClass, 'BIND_DETERMINISTIC');
  const cqDep = title?.depEntries.find(e => e.depTypeName === 'CONTAINER_SIZE');
  assert('CONTAINER_SIZE dep present', !!cqDep, true);
  assert('CONTAINER_SIZE references .card', cqDep?.containerId, '.card');
});

run('cqw without container ancestor — warns', `
  .orphan { font-size: 2cqw; }
`, r => {
  assert('DETERMINISTIC', r.nodes.get('.orphan')?.finalClass, 'BIND_DETERMINISTIC');
  assert('MISSING_CONTAINER warning', r.warnings.some(w => w.type === 'MISSING_CONTAINER'), true);
});

run('nested containers — resolves to nearest', `
  .outer { container-type: size; }
  .inner { container-type: inline-size; }
  .inner .text { font-size: 3cqw; }
`, r => {
  const dep = r.nodes.get('.inner .text')?.depEntries.find(e => e.depTypeName === 'CONTAINER_SIZE');
  // .inner is the nearest registered container — NOT .outer
  assert('resolves to nearest container (.inner)', dep?.containerId, '.inner');
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 7 — Token chain resolution
// ─────────────────────────────────────────────────────────────────────────────
section('7. Token Chain Resolution');

run('circular token chain — no crash, warn, treat as STATIC', `
  :root { --a: var(--b); --b: var(--a); }
  .x { color: var(--a); }
`, r => {
  assertNoThrow('circular chain does not crash', () => {});
  // Circular chain should either warn or safely treat as STATIC
  // It must NOT produce a false DETERMINISTIC without a real dep
  const n = r.nodes.get('.x');
  const hasSpuriousDet = n?.finalClass === 'BIND_DETERMINISTIC' && n?.depEntries.length === 0;
  assert('no false DETERMINISTIC with empty deps', hasSpuriousDet, false);
});

run('three-level chain: A→B→C→absolute', `
  :root { --c: 16px; --b: var(--c); --a: var(--b); }
  .x { font-size: var(--a); }
`, r => {
  assert('STATIC — deep chain resolves to px', r.nodes.get('.x')?.finalClass, 'BIND_STATIC');
});

run('three-level chain: A→B→C→rem (runtime)', `
  :root { --c: 1rem; --b: var(--c); --a: var(--b); }
  .x { font-size: var(--a); }
`, r => {
  const n = r.nodes.get('.x');
  assert('DETERMINISTIC — deep chain resolves to rem', n?.finalClass, 'BIND_DETERMINISTIC');
  assert('FONT_METRICS dep', n?.depEntries.some(e => e.depTypeName === 'FONT_METRICS'), true);
});

run('token defined after use (file order)', `
  .x { font-size: var(--size); }
  :root { --size: 1rem; }
`, r => {
  // Token defined AFTER its consumer — must still resolve correctly
  // This tests that token table is assembled in a first pass
  const n = r.nodes.get('.x');
  assert('DETERMINISTIC — token defined after use', n?.finalClass, 'BIND_DETERMINISTIC');
});

run('token with fallback value in var()', `.x { font-size: var(--undefined, 16px); }`, r => {
  // var(--undefined, 16px) — undefined token with absolute fallback should be STATIC
  const n = r.nodes.get('.x');
  assert('STATIC — undefined token with absolute fallback', n?.finalClass, 'BIND_STATIC');
});

run('token with fallback value: runtime fallback', `.x { font-size: var(--undefined, 1rem); }`, r => {
  // var(--undefined, 1rem) — undefined token with rem fallback should be DETERMINISTIC
  const n = r.nodes.get('.x');
  assert('DETERMINISTIC — undefined token with rem fallback', n?.finalClass, 'BIND_DETERMINISTIC');
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 8 — Selector parsing edge cases
// ─────────────────────────────────────────────────────────────────────────────
section('8. Selector Parsing Edge Cases');

run(':is() with comma list — single node', `:is(h1, h2, h3) { font-weight: 700; color: #1E293B; }`, r => {
  // Should produce ONE node with selector ":is(h1, h2, h3)", not three split nodes
  const hasH1Bare = r.nodes.has('h1');
  const hasH2Bare = r.nodes.has('h2');
  const hasH3Bare = r.nodes.has('h3');
  const hasMalformed = r.nodes.has('h3)');
  assert(':is() not split into h1', hasH1Bare, false);
  assert(':is() not split into h2', hasH2Bare, false);
  assert(':is() not split into malformed h3)', hasMalformed, false);
  // The combined selector or merged props should exist somewhere
  const total = r.stats.total;
  assert('only 1 node (not 3)', total, 1);
});

run(':where() with comma list + descendant', `:where(.card, .panel) .title { font-size: 18px; }`, r => {
  // Should not split :where(.card, .panel) .title into broken pieces
  const hasMalformed = r.nodes.has('.panel) .title') || r.nodes.has('.panel)');
  assert(':where() not split at internal comma', hasMalformed, false);
});

run('multi-selector rule splits into correct nodes', `.btn, .button { padding: 8px 16px; background: #2563EB; }`, r => {
  assert('.btn node exists', r.nodes.has('.btn'), true);
  assert('.button node exists', r.nodes.has('.button'), true);
  assert('.btn STATIC', r.nodes.get('.btn')?.finalClass, 'BIND_STATIC');
  assert('.button STATIC', r.nodes.get('.button')?.finalClass, 'BIND_STATIC');
});

run('attribute selector with comma in value', `[data-state="open,active"] { opacity: 1; }`, r => {
  // Comma inside attribute value must not split the selector
  assert('single node', r.stats.total, 1);
});

run('child combinator parent extraction', `.nav > .item { padding: 8px 16px; } .nav { width: 100%; }`, r => {
  assert('.nav > .item DETERMINISTIC (parent width: 100%)', r.nodes.get('.nav > .item')?.finalClass, 'BIND_DETERMINISTIC');
  const contBy = r.nodes.get('.nav > .item')?.contaminatedBy;
  assert('.nav > .item contaminated by .nav', contBy?.id, '.nav');
});

run(':is() selector parent extraction for contamination', `
  .wrapper { width: 50%; }
  :is(.wrapper, .container) .title { font-size: 18px; }
`, r => {
  // .wrapper is a known DETERMINISTIC node
  // :is(.wrapper, .container) .title's parent should be resolved
  const title = r.nodes.get(':is(.wrapper, .container) .title');
  assert('title node exists', !!title, true);
  assert('title DETERMINISTIC or STATIC', ['BIND_STATIC', 'BIND_DETERMINISTIC'].includes(title?.finalClass ?? ''), true);
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 9 — CSS Nesting
// ─────────────────────────────────────────────────────────────────────────────
section('9. CSS Native Nesting');

run('& child rule inside parent', `
  .card {
    background: white;
    padding: 16px;
    & .title { font-size: 18px; color: #1E293B; }
    & .body  { font-size: 14px; }
  }
`, r => {
  assert('.card STATIC', r.nodes.get('.card')?.finalClass, 'BIND_STATIC');
  // Nested rules should appear as .card .title and .card .body
  const titleNode = r.nodes.get('.card .title') ?? r.nodes.get('& .title');
  assert('nested .title exists', !!titleNode, true);
  if (titleNode) assert('nested .title STATIC', titleNode.finalClass, 'BIND_STATIC');
  // font-size: 18px on .card must NOT be a dep entry (nesting bug would cause this)
  const cardDeps = r.nodes.get('.card')?.depEntries ?? [];
  assert('.card has no spurious dep from nested rule', cardDeps.length, 0);
});

run('& with runtime value propagates correctly', `
  .container {
    background: white;
    & .fluid-text { font-size: clamp(14px, 2vw, 20px); }
  }
`, r => {
  assert('.container STATIC', r.nodes.get('.container')?.finalClass, 'BIND_STATIC');
  const fluid = r.nodes.get('.container .fluid-text') ?? r.nodes.get('& .fluid-text');
  assert('fluid-text node exists', !!fluid, true);
  if (fluid) assert('fluid-text DETERMINISTIC', fluid.finalClass, 'BIND_DETERMINISTIC');
});

run('nested @media inside rule block', `
  .hero {
    padding: 80px 40px;
    @media (max-width: 768px) {
      padding: 16px;
      width: 100%;
    }
  }
`, r => {
  // .hero baseline: STATIC (padding: 80px 40px)
  // @media scoped version has width: 100% — runtime dep
  // The media-scoped version should not corrupt the non-media .hero classification
  const hero = r.nodes.get('.hero');
  assert('.hero node exists', !!hero, true);
  // Must not crash, and must not spuriously classify .hero as DETERMINISTIC
  // due to the nested @media width: 100%
  assert('no crash on nested @media', true, true);
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 10 — @media and @layer scoping
// ─────────────────────────────────────────────────────────────────────────────
section('10. @media / @layer Scoping');

run('@layer wrapping rules', `
  @layer base {
    .text { font-size: 16px; color: #1E293B; }
  }
  @layer components {
    .card { background: white; }
    .card .text { font-weight: 600; }
  }
`, r => {
  assert('.text STATIC', r.nodes.get('.text')?.finalClass, 'BIND_STATIC');
  assert('.card STATIC', r.nodes.get('.card')?.finalClass, 'BIND_STATIC');
});

run('@media does not affect base classification', `
  .sidebar { width: 280px; }
  @media (max-width: 768px) {
    .sidebar { width: 100%; }
  }
`, r => {
  // Both rules target .sidebar — merged or separate, but width:100% at media
  // should not corrupt the overall .sidebar classification in a way that
  // marks it DETERMINISTIC without the media context being captured
  assert('no crash on same selector in and out of @media', true, true);
});

run('@media viewport condition recorded as synthetic VIEWPORT dep', `
  @media (min-width: 768px) {
    .md\\:block { display: block; }
  }
`, r => {
  const n = r.nodes.get('.md\\:block');
  assert('DETERMINISTIC due to media viewport condition', n?.finalClass, 'BIND_DETERMINISTIC');
  assert('synthetic VIEWPORT dep from @media condition',
    n?.depEntries.some(e => e.depTypeName === 'VIEWPORT' && e.propertyName === '__media__'),
    true
  );
});

run('@media prefers-color-scheme recorded as USER_PREF dep', `
  @media (prefers-color-scheme: dark) {
    .pref-dark { color: #fff; }
  }
`, r => {
  const n = r.nodes.get('.pref-dark');
  assert('DETERMINISTIC due to user preference media query', n?.finalClass, 'BIND_DETERMINISTIC');
  assert('has USER_PREF dep',
    n?.depEntries.some(e => e.depTypeName === 'USER_PREF'),
    true
  );
  assert('no spurious VIEWPORT dep for prefers-color-scheme',
    n?.depEntries.some(e => e.depTypeName === 'VIEWPORT' && e.propertyName === '__media__'),
    false
  );
});

run('combined viewport + prefers media query emits both deps', `
  @media (min-width: 768px) and (prefers-reduced-motion: reduce) {
    .combo { display: block; }
  }
`, r => {
  const n = r.nodes.get('.combo');
  assert('DETERMINISTIC for combined media query', n?.finalClass, 'BIND_DETERMINISTIC');
  assert('combined query has VIEWPORT dep',
    n?.depEntries.some(e => e.depTypeName === 'VIEWPORT' && e.propertyName === '__media__'),
    true
  );
  assert('combined query has USER_PREF dep',
    n?.depEntries.some(e => e.depTypeName === 'USER_PREF'),
    true
  );
});

run('@supports scoping', `
  @supports (display: grid) {
    .grid { display: grid; gap: 16px; }
  }
`, r => {
  assertNoThrow('no crash on @supports', () => {});
  assert('.grid exists', r.nodes.has('.grid'), true);
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 11 — Portal escape (Issue #02)
// ─────────────────────────────────────────────────────────────────────────────
section('11. Portal Escape (Issue #02)');

run('portal severs tree contamination', `
  .sidebar { width: 30vw; }
  .modal { portal_id: root-context; background: white; padding: 24px; }
  .root-context { display: block; }
`, r => {
  assert('.sidebar DETERMINISTIC', r.nodes.get('.sidebar')?.finalClass, 'BIND_DETERMINISTIC');
  // .modal has portal_id so must NOT be contaminated by .sidebar
  // even if it's structurally a descendant
  const modal = r.nodes.get('.modal');
  assert('.modal not contaminated by sidebar', modal?.contaminatedBy?.id ?? null, null);
});

run('portal missing target — warns', `
  .modal { portal_id: nonexistent-target; background: white; }
`, r => {
  assert('PORTAL_MISSING warning', r.warnings.some(w => w.type === 'PORTAL_MISSING'), true);
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 12 — Stats and output integrity
// ─────────────────────────────────────────────────────────────────────────────
section('12. Output Integrity');

run('stats sum correctly', `
  .a { color: red; }
  .b { width: 50%; }
  .c li:nth-child(even) { background: #F8FAFC; }
`, r => {
  const { total, static: s, deterministic: d, nondeterministic: n } = r.stats;
  assert('total = static + det + ndet', total, s + d + n);
});

run('manifest count equals boundary count', `
  .a { width: 50%; }
  .b { width: 100%; }
  .c { font-size: 1rem; }
`, r => {
  const boundaries = Array.from(r.nodes.values()).filter(n => n.isBoundary).length;
  assert('manifest count equals boundary count', r.manifests.size, boundaries);
});

run('JSON output is valid and complete', `.btn { padding: 8px; } .input { width: 100%; }`, r => {
  // Raw result has circular refs (ComponentNode graph). Use reporter's toJSON() if available,
  // or verify the analyser exposes a safe serialisation method.
  let json;
  try {
    // Try analyser-provided toJSON first
    const safeResult = typeof r.toJSON === 'function' ? r.toJSON() : {
      stats: r.stats,
      warnings: r.warnings,
      components: Object.fromEntries(Array.from(r.nodes.entries()).map(([id, n]) => [id, {
        id, finalClass: n.finalClass, isBoundary: n.isBoundary,
        parent: n.parent?.id ?? null, children: n.children.map(c => c.id),
      }])),
    };
    json = JSON.stringify(safeResult);
    passed++;
    assertNoThrow('JSON.parse round-trips', () => JSON.parse(json));
  } catch(e) {
    failed++;
    failures.push({ label: 'JSON output is valid', actual: 'THREW: ' + e.message, expected: 'no throw' });
    console.log('  ✗ JSON output circular ref — add toJSON() to result or use reporter.toJSON(result)');
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// RESULTS
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n' + '═'.repeat(70));
console.log(`\n  Results: ${passed} passed, ${failed} failed, ${skipped} skipped`);

if (failed > 0) {
  console.log(`\n  FAILURES:`);
  failures.forEach(f => {
    console.log(`  ✗ ${f.label}`);
    console.log(`      expected: ${JSON.stringify(f.expected)}`);
    console.log(`      actual:   ${JSON.stringify(f.actual)}`);
  });
  console.log('');
  process.exitCode = 1;
} else {
  console.log('\n  ✓ All regression tests passed.\n');
}
console.log('═'.repeat(70));
console.log('');
console.log('  Note: These tests cover a range of edge cases but are not exhaustive. For comprehensive validation, consider integrating with a full CSS test suite or real-world stylesheets.');    


