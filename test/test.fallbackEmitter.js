'use strict';

const { analyseCSS } = require('../dist/src/analyser');
const { emitFallbackCss, collectFallbackRules } = require('../dist/src/fallbackEmitter');
const { fnv1a32 } = require('../dist/src/emitter');

let passed = 0;
let failed = 0;
const failures = [];

function assert(label, actual, expected) {
  if (actual === expected) { passed += 1; return; }
  failed += 1;
  failures.push({ label, actual, expected });
  console.log(`  x ${label}`);
  console.log(`      exp: ${JSON.stringify(expected)}`);
  console.log(`      got: ${JSON.stringify(actual)}`);
}

function section(title) {
  console.log(`\n${'='.repeat(58)}\n  ${title}\n${'='.repeat(58)}`);
}

section('1. Empty fallback output for all-static CSS');
{
  const r = analyseCSS('.btn { color: red; padding: 8px; }');
  const out = emitFallbackCss(r);
  assert('ruleCount = 0', out.stats.ruleCount, 0);
  assert('sourceNondeterministicNodes = 0', out.stats.sourceNondeterministicNodes, 0);
  assert('banner present', out.css.includes('fallback.css'), true);
}

section('2. Emits NONDETERMINISTIC rule declarations');
{
  const css = '.table tr:nth-child(even) { background: #f8fafc; color: #334155; }';
  const r = analyseCSS(css);
  const out = emitFallbackCss(r);

  assert('one fallback rule', out.stats.ruleCount, 1);
  assert('sourceNondeterministicNodes = 1', out.stats.sourceNondeterministicNodes, 1);
  assert('contains selector', out.css.includes('.table tr:nth-child(even)'), true);
  assert('contains background declaration', out.css.includes('background: #f8fafc;'), true);
  assert('contains color declaration', out.css.includes('color: #334155;'), true);
}

section('3. Rule ordering matches binary hash order');
{
  const css = [
    '.z:last-child { color: red; }',
    '.a:has(.x) { color: green; }',
    '.m:nth-child(2) { color: blue; }',
  ].join('\n');

  const r = analyseCSS(css);
  const rules = collectFallbackRules(r);

  const selectors = rules.map((rule) => rule.selector);
  const expected = selectors
    .slice()
    .sort((a, b) => {
      const ha = fnv1a32(a) >>> 0;
      const hb = fnv1a32(b) >>> 0;
      if (ha !== hb) return ha - hb;
      return a.localeCompare(b);
    });

  assert('selector order follows fnv/hash sort', JSON.stringify(selectors), JSON.stringify(expected));
}

section('4. Duplicate selector merged into one fallback rule');
{
  const css = [
    '.list li:nth-child(odd) { color: #111; }',
    '.list li:nth-child(odd) { background: #eee; }',
  ].join('\n');

  const r = analyseCSS(css);
  const out = emitFallbackCss(r);

  const selectorMatches = out.css.match(/\.list li:nth-child\(odd\)\s*\{/g) || [];
  assert('selector appears once', selectorMatches.length, 1);
  assert('merged declaration color present', out.css.includes('color: #111;'), true);
  assert('merged declaration background present', out.css.includes('background: #eee;'), true);
}

section('5. Deterministic output across repeated runs');
{
  const css = [
    '.x:has(.a) { border-color: #667eea; }',
    '.x:has(.a) { box-shadow: 0 2px 6px rgba(102, 126, 234, 0.3); }',
    '.y:nth-child(odd) { opacity: 0.9; }',
  ].join('\n');

  const a = emitFallbackCss(analyseCSS(css));
  const b = emitFallbackCss(analyseCSS(css));
  assert('same CSS output on repeated runs', a.css, b.css);
}

console.log(`\n${'='.repeat(58)}\n  Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('\n  FAILURES:');
  for (const f of failures) {
    console.log(`  x ${f.label}`);
    console.log(`      exp: ${JSON.stringify(f.expected)}`);
    console.log(`      got: ${JSON.stringify(f.actual)}`);
  }
  process.exitCode = 1;
} else {
  console.log('  ok All fallback emitter tests passed.\n');
}
