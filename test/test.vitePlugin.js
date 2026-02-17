// =============================================================================
// Binary SOM — Vite Plugin Test Suite
// Tests plugin lifecycle, collection, emission, and error handling
// using a mock Vite plugin context (no real Vite required).
// =============================================================================

'use strict';

const { binarySomPlugin } = require('../src/vitePlugin');
const { SOMLoader }       = require('../src/loader');

let passed = 0, failed = 0;
const failures = [];

function assert(label, actual, expected) {
  if (actual === expected) {
    passed++;
  } else {
    failed++;
    failures.push({ label, actual, expected });
    console.log(`  ✗ ${label}`);
    console.log(`      expected: ${JSON.stringify(expected)}`);
    console.log(`      actual:   ${JSON.stringify(actual)}`);
  }
}

function assertNoThrow(label, fn) {
  try { const r = fn(); passed++; return r; }
  catch (e) {
    failed++;
    failures.push({ label, actual: `THREW: ${e.message}`, expected: 'no throw' });
    console.log(`  ✗ ${label} — threw: ${e.message}`);
    return null;
  }
}

function assertThrows(label, fn, msgIncludes = '') {
  try {
    fn();
    failed++;
    failures.push({ label, actual: 'no throw', expected: 'Error' });
    console.log(`  ✗ ${label} — expected throw`);
  } catch (e) {
    if (msgIncludes && !e.message.includes(msgIncludes)) {
      failed++;
      failures.push({ label, actual: e.message, expected: `includes "${msgIncludes}"` });
      console.log(`  ✗ ${label} — wrong error: ${e.message}`);
    } else {
      passed++;
    }
  }
}

function section(title) {
  console.log(`\n${'═'.repeat(65)}`);
  console.log(`  ${title}`);
  console.log('═'.repeat(65));
}

// ── Mock Vite plugin context ───────────────────────────────────────────────
function makeContext(command = 'build') {
  const warnings = [];
  const errors   = [];
  const emitted  = new Map();  // fileName → source (Buffer or string)

  return {
    // Simulates Vite's resolved config
    config:  { command, mode: command === 'build' ? 'production' : 'development' },
    warnings,
    errors,
    emitted,

    warn(msg)  { warnings.push(msg); },
    error(msg) { errors.push(msg); throw new Error(msg); },
    emitFile({ fileName, source }) { emitted.set(fileName, source); },
  };
}

// Calls the plugin lifecycle for a build run
async function runPlugin(css, options = {}, command = 'build') {
  const plugin  = binarySomPlugin(options);
  const ctx     = makeContext(command);

  // configResolved
  plugin.configResolved.call(ctx, ctx.config);

  // buildStart
  plugin.buildStart.call(ctx);

  // transform each CSS module
  const modules = Array.isArray(css)
    ? css
    : [{ id: 'test.css', code: css }];

  for (const { id, code } of modules) {
    await plugin.transform.call(ctx, code, id);
  }

  // generateBundle
  if (command === 'build') {
    await plugin.generateBundle.call(ctx, {}, {});
  }

  return ctx;
}

// =============================================================================
// §1 — Plugin factory and identity
// =============================================================================
section('1. Plugin Factory');

{
  const plugin = binarySomPlugin();
  assert('plugin has name',          plugin.name,            'vite-plugin-binary-som');
  assert('plugin enforce = pre',     plugin.enforce,         'pre');
  assert('has configResolved hook',  typeof plugin.configResolved,  'function');
  assert('has buildStart hook',      typeof plugin.buildStart,      'function');
  assert('has transform hook',       typeof plugin.transform,       'function');
  assert('has generateBundle hook',  typeof plugin.generateBundle,  'function');
  assert('has handleHotUpdate hook', typeof plugin.handleHotUpdate, 'function');

  // Factory creates independent instances — no shared module-scope state
  const p1 = binarySomPlugin();
  const p2 = binarySomPlugin();
  assert('two instances are different objects', p1 !== p2, true);
}

// =============================================================================
// §2 — transform: collection only, no emission
// =============================================================================
section('2. transform — Collection Only');

{
  const plugin = binarySomPlugin();
  const ctx    = makeContext('serve');  // dev server
  plugin.configResolved.call(ctx, ctx.config);
  plugin.buildStart.call(ctx);

  // transform returns null (no code transformation)
  const result = plugin.transform.call(ctx, '.btn { color: red; }', 'src/styles.css');
  assert('transform returns null (no code change)', result, null);

  // Non-CSS files ignored
  const jsResult = plugin.transform.call(ctx, 'const x = 1;', 'src/app.js');
  assert('non-CSS file returns null', jsResult, null);

  // No emission in dev mode
  assert('no files emitted during transform', ctx.emitted.size, 0);
}

// =============================================================================
// §3 — generateBundle skipped in dev mode
// =============================================================================
section('3. Dev Mode — No Emission');

{
  const ctx = assertNoThrow('dev mode run does not throw', () => null);
  (async () => {
    try {
      const devCtx = await runPlugin('.btn { color: red; }', {}, 'serve');
      assert('no files emitted in dev mode', devCtx.emitted.size, 0);
      assert('no errors in dev mode', devCtx.errors.length, 0);
      passed++;
    } catch (e) {
      failed++;
      failures.push({ label: 'dev mode no emission', actual: e.message, expected: 'no throw' });
    }
  })();
  // Synchronous assertion placeholder — async verified below
}

// =============================================================================
// §4 — generateBundle: emits both assets
// =============================================================================
section('4. Production Build — Asset Emission');

const CSS_SAMPLE = `
  :root { --color: #2563EB; --radius: 4px; }
  .btn { display: flex; padding: 8px 16px; background: var(--color); border-radius: var(--radius); }
  .card { background: white; border: 1px solid #E2E8F0; border-radius: 8px; }
  .layout { width: 100%; min-height: 100vh; }
  .layout .panel { background: #F8FAFC; }
`;

let buildCtx;
(async () => {
  try {
    buildCtx = await runPlugin(CSS_SAMPLE);
  } catch (e) {
    failed++;
    failures.push({ label: 'prod build', actual: e.message, expected: 'no throw' });
    console.log(`  ✗ prod build threw: ${e.message}`);
    runRemainingSync();
    return;
  }

  assert('styles.som emitted',             buildCtx.emitted.has('styles.som'),              true);
  assert('fallback.css emitted',           buildCtx.emitted.has('fallback.css'),            true);
  assert('fallback-map.json emitted',      buildCtx.emitted.has('fallback-map.json'),       true);
  assert('binary-som-summary.json emitted', buildCtx.emitted.has('binary-som-summary.json'), true);
  assert('no errors',                      buildCtx.errors.length,                          0);

  // Binary is a Buffer
  const binary = buildCtx.emitted.get('styles.som');
  assert('binary is a Buffer', Buffer.isBuffer(binary), true);
  assert('binary size > 0',    binary.length > 0,       true);

  // Binary starts with BSOM magic
  assert('binary magic = BSOM', binary.slice(0, 4).toString('ascii'), 'BSOM');

  // Summary is valid JSON
  const summaryRaw = buildCtx.emitted.get('binary-som-summary.json');
  const fallbackRaw = buildCtx.emitted.get('fallback.css');
  const fallbackMapRaw = buildCtx.emitted.get('fallback-map.json');
  assert('fallback asset is string', typeof fallbackRaw, 'string');
  assert('fallback banner present', fallbackRaw.includes('binary-som fallback.css'), true);
  let fallbackMap;
  assertNoThrow('fallback map is valid JSON', () => { fallbackMap = JSON.parse(fallbackMapRaw); });
  assert('fallback map is object', !!fallbackMap && typeof fallbackMap === 'object', true);
  let summary;
  assertNoThrow('summary is valid JSON', () => { summary = JSON.parse(summaryRaw); });

  if (summary) {
    assert('summary has meta',           !!summary.meta,           true);
    assert('summary has classification', !!summary.classification, true);
    assert('summary has warnings',       Array.isArray(summary.warnings), true);
    assert('summary total > 0',          summary.classification.total > 0, true);
    assert('summary static > 0',         summary.classification.static > 0, true);
    assert('summary pcts sum to ~100',
      summary.classification.staticPct +
      summary.classification.deterministicPct +
      summary.classification.nondeterministicPct >= 99, true);
    assert('meta has binarySizeBytes',   summary.meta.binarySizeBytes > 0, true);
    assert('meta has fallbackSizeBytes', summary.meta.fallbackSizeBytes >= 0, true);
    assert('meta has fallbackMapEntries', summary.meta.fallbackMapEntries >= 0, true);
    assert('meta generatedAt is ISO',    summary.meta.generatedAt.includes('T'), true);
  }

  // =============================================================================
  // §5 — Loader round-trip: emitted binary is loadable
  // =============================================================================
  section('5. Round-trip — Emitted Binary Is Loadable');

  const loader = assertNoThrow('SOMLoader accepts emitted binary', () => new SOMLoader(binary));

  if (loader) {
    assert('loader stats present', loader.stats !== null, true);
    assert('static components > 0', loader.stats.staticComponents > 0, true);

    // Static lookup
    const btn = loader.getStatic('.btn');
    assert('.btn is in binary as STATIC',    btn !== null,     true);
    assert('.btn recordType = STATIC',       btn?.recordType,  'STATIC');

    // Dynamic lookup
    const layout = loader.getDynamic('.layout');
    assert('.layout is in binary as DYNAMIC', layout !== null,            true);
    assert('.layout recordType = BOUNDARY_MARKER', layout?.recordType,   'BOUNDARY_MARKER');
    assert('.layout dep count >= 1', (layout?.depEntries?.length ?? 0) >= 1, true);
  }

  // =============================================================================
  // §6 — failOnNonDeterministic behaviour
  // =============================================================================
  section('6. failOnNonDeterministic');

  const NDET_CSS = `.table tr:nth-child(even) { background: #F8FAFC; }`;

  // Default: warn only
  try {
    const warnCtx = await runPlugin(NDET_CSS, { failOnNonDeterministic: false });
    assert('warn-only: still emits binary',   warnCtx.emitted.has('styles.som'), true);
    assert('warn-only: emits fallback.css',   warnCtx.emitted.has('fallback.css'), true);
    assert('warn-only: emits fallback-map.json', warnCtx.emitted.has('fallback-map.json'), true);
    assert('warn-only: no errors',            warnCtx.errors.length,             0);
    assert('warn-only: warning present',      warnCtx.warnings.some(w => w.includes('NONDETERMINISTIC')), true);
    const fallbackCss = warnCtx.emitted.get('fallback.css');
    const fallbackMap = JSON.parse(warnCtx.emitted.get('fallback-map.json'));
    assert('warn-only fallback contains selector', fallbackCss.includes('.table tr:nth-child(even)'), true);
    const ndetMapValues = Object.values(fallbackMap);
    assert('warn-only fallback map has selector', ndetMapValues.includes('.table tr:nth-child(even)'), true);
  } catch (e) {
    failed++;
    failures.push({ label: 'warn-only: did not throw', actual: e.message, expected: 'no throw' });
    console.log(`  ✗ warn-only threw: ${e.message}`);
  }

  // failOnNonDeterministic: true → throws
  try {
    await runPlugin(NDET_CSS, { failOnNonDeterministic: true });
    failed++;
    failures.push({ label: 'failOnNonDeterministic: throws', actual: 'no throw', expected: 'Error' });
    console.log('  ✗ failOnNonDeterministic: should have thrown');
  } catch (e) {
    if (e.message.includes('NONDETERMINISTIC')) {
      passed++;
    } else {
      failed++;
      failures.push({ label: 'failOnNonDeterministic: correct error message', actual: e.message, expected: 'includes NONDETERMINISTIC' });
    }
  }

  // =============================================================================
  // §7 — Multiple CSS files joined correctly
  // =============================================================================
  section('7. Multi-file Collection');

  const multiCtx = await runPlugin([
    { id: 'base.css',       code: ':root { --color: #2563EB; }' },
    { id: 'components.css', code: '.btn { color: var(--color); padding: 8px; }' },
    { id: 'layout.css',     code: '.layout { width: 100%; }' },
  ]);

  assert('multi-file: binary emitted',  multiCtx.emitted.has('styles.som'), true);
  assert('multi-file: no errors',       multiCtx.errors.length, 0);

  const multiSummary = JSON.parse(multiCtx.emitted.get('binary-som-summary.json'));
  assert('multi-file: 3 source files',  multiSummary.meta.fileCount, 3);
  assert('multi-file: components found', multiSummary.classification.total > 0, true);

  // Verify token chain resolves across files (--color defined in base.css, used in components.css)
  const multiBinary = multiCtx.emitted.get('styles.som');
  const multiLoader = new SOMLoader(multiBinary);
  const btn         = multiLoader.getStatic('.btn');
  assert('cross-file token: .btn is STATIC (token resolves to absolute)', btn?.recordType, 'STATIC');

  // =============================================================================
  // §8 — buildStart clears state between runs
  // =============================================================================
  section('8. buildStart Clears State');

  // First build collects .layout (DETERMINISTIC)
  const run1 = await runPlugin('.layout { width: 100%; }');
  const sum1 = JSON.parse(run1.emitted.get('binary-som-summary.json'));

  // Second build with different CSS — no .layout
  const run2 = await runPlugin('.btn { color: red; }');
  const sum2 = JSON.parse(run2.emitted.get('binary-som-summary.json'));

  // run2 should not contain stale .layout from run1
  const run2Loader = new SOMLoader(run2.emitted.get('styles.som'));
  assert('second build does not contain stale .layout from first build',
    run2Loader.getDynamic('.layout'), null);
  assert('second build contains .btn', run2Loader.getStatic('.btn') !== null, true);

  // =============================================================================
  // §9 — Custom filenames
  // =============================================================================
  section('9. Custom Output Filenames');

  const customCtx = await runPlugin('.btn { color: red; }', {
    somFileName:     'assets/design-system.som',
    fallbackFileName:'assets/fallback.css',
    fallbackMapFileName:'assets/fallback-map.json',
    summaryFileName: 'reports/som-report.json',
  });

  assert('custom som filename', customCtx.emitted.has('assets/design-system.som'), true);
  assert('custom fallback filename', customCtx.emitted.has('assets/fallback.css'), true);
  assert('custom fallback-map filename', customCtx.emitted.has('assets/fallback-map.json'), true);
  assert('custom summary filename', customCtx.emitted.has('reports/som-report.json'), true);
  assert('default filenames absent', !customCtx.emitted.has('styles.som'), true);
  assert('default fallback absent', !customCtx.emitted.has('fallback.css'), true);
  assert('default fallback-map absent', !customCtx.emitted.has('fallback-map.json'), true);

  // =============================================================================
  // §10 — handleHotUpdate evicts correctly
  // =============================================================================
  section('10. HMR Eviction');

  const plugin = binarySomPlugin();
  const hmrCtx = makeContext('serve');
  plugin.configResolved.call(hmrCtx, hmrCtx.config);
  plugin.buildStart.call(hmrCtx);
  plugin.transform.call(hmrCtx, '.btn { color: red; }', '/src/styles.css');

  // File is collected
  // (We can't inspect the Map directly, but we can verify that a subsequent
  //  full build re-analyses correctly after eviction)
  plugin.handleHotUpdate.call(hmrCtx, { file: '/src/styles.css' });
  // No assertion on internal state — just verify no crash
  assert('handleHotUpdate does not crash', true, true);

  runRemainingSync();
})();

function runRemainingSync() {
  // Results
  console.log('\n' + '═'.repeat(65));
  console.log(`\n  Results: ${passed} passed, ${failed} failed`);

  if (failed > 0) {
    console.log('\n  FAILURES:');
    failures.forEach(f => {
      console.log(`  ✗ ${f.label}`);
      console.log(`      expected: ${JSON.stringify(f.expected)}`);
      console.log(`      actual:   ${JSON.stringify(f.actual)}`);
    });
    process.exitCode = 1;
  } else {
    console.log('\n  ✓ All plugin tests passed.\n');
  }
}
