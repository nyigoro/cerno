'use strict';

const { BinarySomPlugin } = require('../dist/src/webpackPlugin');
const { computeDiff, formatDiff, snapshotResult } = require('../dist/src/watcher');
const { analyseCSS } = require('../dist/src/analyser');
const { SOMLoader }  = require('../dist/src/loader');

let passed = 0, failed = 0;
const failures = [];

function assert(label, actual, expected) {
  if (actual === expected) { passed++; return; }
  failed++;
  failures.push({ label, actual, expected });
  console.log(`  ✗ ${label}\n      exp: ${JSON.stringify(expected)}\n      got: ${JSON.stringify(actual)}`);
}
function assertNoThrow(label, fn) {
  try { fn(); passed++; }
  catch (e) {
    failed++;
    failures.push({ label, actual: e.message, expected: 'no throw' });
    console.log(`  ✗ ${label}: ${e.message}`);
  }
}
function section(t) { console.log(`\n${'═'.repeat(55)}\n  ${t}\n${'═'.repeat(55)}`); }

// ── Mock webpack context ─────────────────────────────────────────────────
function makeMockCompilation(modules) {
  const emitted = new Map(), warnings = [], errors = [];
  const comp = {
    modules, emitted, warnings, errors,
    emitAsset(name, src) { emitted.set(name, src); },
    constructor: { PROCESS_ASSETS_STAGE_SUMMARIZE: 1000 },
    hooks: {
      processAssets: {
        _fn: null,
        tapAsync(opts, fn) { this._fn = fn; },
        run() {
          return new Promise((res, rej) =>
            this._fn({}, (err) => err ? rej(err) : res())
          );
        },
      },
    },
  };
  return comp;
}

function makeMockCompiler(compilation) {
  return {
    webpack: {
      WebpackError: Error,
      sources: {
        RawSource: class {
          constructor(v) { this.v = v; }
          source() { return this.v; }
          buffer() { return Buffer.isBuffer(this.v) ? this.v : Buffer.from(this.v); }
        },
      },
      Compilation: { PROCESS_ASSETS_STAGE_SUMMARIZE: 1000 },
    },
    hooks: {
      thisCompilation: { tap(name, fn) { fn(compilation); } },
    },
    getInfrastructureLogger() {
      return { warn: () => {}, error: () => {}, info: () => {} };
    },
  };
}

function makeCSSModule(resource, source) {
  return {
    resource,
    originalSource() { return { source() { return source; } }; },
  };
}

// =============================================================================
section('1. BinarySomPlugin — structure');
// =============================================================================

assertNoThrow('instantiates with defaults', () => new BinarySomPlugin());
assertNoThrow('instantiates with options',  () => new BinarySomPlugin({ failOnNonDeterministic: true }));
const p = new BinarySomPlugin();
assert('has apply method', typeof p.apply, 'function');

// =============================================================================
section('2. BinarySomPlugin — production build');
// =============================================================================

(async () => {
  const cssSource = '.btn { color: #fff; padding: 8px; } .layout { width: 100%; }';
  const compilation = makeMockCompilation([makeCSSModule('/project/src/styles.css', cssSource)]);
  const compiler    = makeMockCompiler(compilation);

  new BinarySomPlugin({ verbose: false }).apply(compiler);

  try {
    await compilation.hooks.processAssets.run();
    assert('styles.som emitted',  compilation.emitted.has('styles.som'),              true);
    assert('fallback.css emitted',compilation.emitted.has('fallback.css'),            true);
    assert('fallback-map.json emitted',compilation.emitted.has('fallback-map.json'),  true);
    assert('summary emitted',     compilation.emitted.has('binary-som-summary.json'), true);
    assert('no errors',           compilation.errors.length,                          0);

    const binary  = compilation.emitted.get('styles.som').buffer();
    assert('binary magic = BSOM', binary.slice(0, 4).toString('ascii'), 'BSOM');

    // Binary is loadable
    const loader = new SOMLoader(binary);
    assert('loader reads binary',     loader.stats !== null,                    true);
    assert('static components exist', loader.stats.staticComponents > 0,       true);
    assert('.btn is STATIC',          loader.getStatic('.btn')?.recordType,     'STATIC');
    assert('.layout is BOUNDARY',     loader.getDynamic('.layout')?.recordType, 'BOUNDARY_MARKER');

    const summary = JSON.parse(compilation.emitted.get('binary-som-summary.json').source());
    const fallbackMap = JSON.parse(compilation.emitted.get('fallback-map.json').source());
    assert('fallback-map is object', !!fallbackMap && typeof fallbackMap === 'object', true);
    assert('summary total > 0',        summary.classification.total > 0,         true);
    assert('summary has generatedAt',  typeof summary.meta.generatedAt,          'string');
    assert('summary has binarySize',   summary.meta.binarySizeBytes > 0,         true);
    assert('summary has fallbackSize', summary.meta.fallbackSizeBytes >= 0,      true);
    assert('summary has fallbackMapEntries', summary.meta.fallbackMapEntries >= 0, true);
    assert('pct sum ≈ 100',
      summary.classification.staticPct +
      summary.classification.deterministicPct +
      summary.classification.nondeterministicPct >= 99, true);
  } catch (e) {
    failed++;
    failures.push({ label: 'build run', actual: e.message, expected: 'no throw' });
    console.log(`  ✗ build threw: ${e.message}`);
  }

  // =============================================================================
  section('3. BinarySomPlugin — failOnNonDeterministic');
  // =============================================================================

  const ndetCSS = '.table tr:nth-child(even) { background: #F8FAFC; }';

  // warn only (default)
  {
    const comp = makeMockCompilation([makeCSSModule('/src/t.css', ndetCSS)]);
    new BinarySomPlugin({ failOnNonDeterministic: false }).apply(makeMockCompiler(comp));
    try {
      await comp.hooks.processAssets.run();
      assert('warn-only: emits binary', comp.emitted.has('styles.som'), true);
      assert('warn-only: emits fallback', comp.emitted.has('fallback.css'), true);
      assert('warn-only: emits fallback-map', comp.emitted.has('fallback-map.json'), true);
      assert('warn-only: no errors',    comp.errors.length,             0);
      assert('warn-only: has warning',  comp.warnings.length > 0,       true);
      assert('warn-only fallback has selector',
        comp.emitted.get('fallback.css').source().includes('.table tr:nth-child(even)'), true);
      const fallbackMap = JSON.parse(comp.emitted.get('fallback-map.json').source());
      assert('warn-only fallback-map has selector',
        Object.values(fallbackMap).includes('.table tr:nth-child(even)'), true);
    } catch (e) {
      failed++;
      failures.push({ label: 'warn-only', actual: e.message, expected: 'no throw' });
      console.log(`  ✗ warn-only: ${e.message}`);
    }
  }

  // fail mode — plugin adds to compilation.errors, does not throw
  {
    const comp = makeMockCompilation([makeCSSModule('/src/t.css', ndetCSS)]);
    new BinarySomPlugin({ failOnNonDeterministic: true }).apply(makeMockCompiler(comp));
    try { await comp.hooks.processAssets.run(); } catch (_) {}
    assert('fail mode: compilation.errors populated', comp.errors.length > 0, true);
    assert('fail mode: no .som emitted on error', comp.emitted.has('styles.som'), false);
    assert('fail mode: no fallback emitted on error', comp.emitted.has('fallback.css'), false);
    assert('fail mode: no fallback-map emitted on error', comp.emitted.has('fallback-map.json'), false);
  }

  // =============================================================================
  section('4. Diff engine — computeDiff');
  // =============================================================================

  const r1 = analyseCSS('.btn { color: red; } .layout { width: 100%; }');
  const r2 = analyseCSS('.btn { color: red; } .layout { width: 100%; } .new { font-size: 14px; }');
  const r3 = analyseCSS('.btn { font-size: 1rem; } .layout { width: 100%; }');
  const r4 = analyseCSS('.layout { width: 100%; }');  // .btn removed

  const s1 = snapshotResult(r1);
  const s2 = snapshotResult(r2);
  const s3 = snapshotResult(r3);
  const s4 = snapshotResult(r4);

  const d12 = computeDiff(s1, s2);
  assert('ADDED .new detected', d12.some(d => d.type === 'ADDED' && d.selector === '.new'), true);
  assert('no spurious changes in d12', d12.filter(d => d.type !== 'ADDED').length, 0);

  const d14 = computeDiff(s1, s4);
  assert('REMOVED .btn detected', d14.some(d => d.type === 'REMOVED' && d.selector === '.btn'), true);

  const d13 = computeDiff(s1, s3);
  const reclass = d13.find(d => d.type === 'RECLASSIFIED' && d.selector === '.btn');
  assert('RECLASSIFIED .btn detected',   !!reclass, true);
  assert('.btn prevClass = STATIC',       reclass?.prevClass, 'BIND_STATIC');
  assert('.btn nextClass = DETERMINISTIC',reclass?.nextClass, 'BIND_DETERMINISTIC');

  // Identical results → no diff
  const rSame = analyseCSS('.btn { color: red; } .layout { width: 100%; }');
  const dSame = computeDiff(s1, snapshotResult(rSame));
  assert('no diffs for identical results', dSame.length, 0);

  // =============================================================================
  section('5. Diff formatter — formatDiff');
  // =============================================================================

  const diffs = [
    { type: 'ADDED',        selector: '.hero',  nextClass: 'BIND_STATIC' },
    { type: 'REMOVED',      selector: '.old',   prevClass: 'BIND_STATIC' },
    { type: 'RECLASSIFIED', selector: '.card',  prevClass: 'BIND_STATIC', nextClass: 'BIND_DETERMINISTIC' },
    { type: 'WARNED',       message:  'MISSING_CONTAINER: .card' },
    { type: 'RESOLVED',     message:  'STRUCTURAL_DYNAMIC: .table' },
  ];

  const out = formatDiff(diffs, '/src/styles.css', false);
  assert('output is string',           typeof out,              'string');
  assert('contains + for ADDED',       out.includes('+'),       true);
  assert('contains - for REMOVED',     out.includes('-'),       true);
  assert('contains ~ for reclassify',  out.includes('~'),       true);
  assert('contains ⚠ for warning',     out.includes('⚠'),       true);
  assert('contains ✓ for resolved',    out.includes('✓'),       true);
  assert('contains selector text',     out.includes('.hero'),   true);
  assert('null returned for no diffs', formatDiff([], '/src/styles.css'), null);

  // =============================================================================
  section('6. Multiple CSS files joined');
  // =============================================================================

  {
    const modules = [
      makeCSSModule('/src/base.css',       ':root { --color: #2563EB; }'),
      makeCSSModule('/src/components.css', '.btn { color: var(--color); padding: 8px; }'),
      makeCSSModule('/src/layout.css',     '.layout { width: 100%; }'),
    ];
    const comp = makeMockCompilation(modules);
    new BinarySomPlugin().apply(makeMockCompiler(comp));
    await comp.hooks.processAssets.run();

    const summary = JSON.parse(comp.emitted.get('binary-som-summary.json').source());
    assert('multi-file: 3 source files',    summary.meta.fileCount,              3);
    assert('multi-file: components found',  summary.classification.total > 0,    true);

    // .btn should be STATIC — token --color resolves to absolute #2563EB
    const binary = comp.emitted.get('styles.som').buffer();
    const loader = new SOMLoader(binary);
    assert('cross-file token: .btn STATIC', loader.getStatic('.btn')?.recordType, 'STATIC');
  }

  // Results
  console.log(`\n${'═'.repeat(55)}\n  Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('\n  FAILURES:');
    failures.forEach(f => {
      console.log(`  ✗ ${f.label}`);
      console.log(`      exp: ${JSON.stringify(f.expected)}`);
      console.log(`      got: ${JSON.stringify(f.actual)}`);
    });
    process.exitCode = 1;
  } else {
    console.log('  ✓ All webpack + watcher tests passed.\n');
  }
})();


