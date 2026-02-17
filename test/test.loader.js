// =============================================================================
// Binary SOM — Loader Test Suite
// Tests SOMLoader round-trip fidelity and runtime lookup behaviour
// =============================================================================

'use strict';

const { SOMLoader, loadSOM } = require('../src/loader');
const { PoolBuilder, buildPoolFromAnalysis } = require('../src/constantPool');
const { emitComponentSection, assembleBinary, fnv1a32 } = require('../src/emitter');
const fs = require('fs');

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

// ── Build a reference binary for all tests ────────────────────────────────
function makeNode(overrides) {
  return Object.assign({
    selector: '.x', finalClass: 'BIND_STATIC', isBoundary: false,
    portalTarget: null, depEntries: [], contaminates: [], subgraphRoot: null,
    properties: new Map(), customProps: new Map(),
  }, overrides);
}

function buildBinary(nodes) {
  const result = { nodes: new Map(nodes.map(n => [n.selector, n])) };
  const pool   = buildPoolFromAnalysis(result);
  const emit   = emitComponentSection(result, pool);
  const binary = assembleBinary(pool.serialise(), emit.staticTier, emit.dynamicIndex, emit.dynamicTier);
  return { binary, pool, emit, result };
}

// ── Reference dataset used across multiple test sections ─────────────────
const staticBtn = makeNode({
  selector:   '.btn',
  finalClass: 'BIND_STATIC',
  properties: new Map([
    ['color',            { raw: '#FFFFFF' }],
    ['background-color', { raw: '#2563EB' }],
    ['padding',          { raw: '8px 16px' }],
    ['font-size',        { raw: '14px' }],
    ['border-radius',    { raw: '4px' }],
  ]),
});

const staticCard = makeNode({
  selector:   '.card',
  finalClass: 'BIND_STATIC',
  properties: new Map([
    ['background', { raw: '#FFFFFF' }],
    ['border',     { raw: '1px solid #E2E8F0' }],
    ['padding',    { raw: '20px 24px' }],
  ]),
});

const boundaryLayout = makeNode({
  selector:   '.layout',
  finalClass: 'BIND_DETERMINISTIC',
  isBoundary: true,
  depEntries: [
    { propertyName: 'width',      depType: 0x01, containerId: null },
    { propertyName: 'min-height', depType: 0x02, containerId: null },
  ],
  subgraphIds: ['.layout', '.layout .panel'],
  properties: new Map([['width', { raw: '100%' }], ['min-height', { raw: '100vh' }]]),
});

const ruleSetPanel = (() => {
  const n = makeNode({
    selector:    '.layout .panel',
    finalClass:  'BIND_DETERMINISTIC',
    isBoundary:  false,
    depEntries:  [],
    properties:  new Map([['background', { raw: '#F8FAFC' }]]),
  });
  n.subgraphRoot = boundaryLayout;
  return n;
})();

const ndetRow = makeNode({
  selector:   '.table tr:nth-child(even)',
  finalClass: 'BIND_NONDETERMINISTIC',
  isBoundary: true,
  depEntries: [],
  subgraphIds: ['.table tr:nth-child(even)'],
});

const allNodes = [staticBtn, staticCard, boundaryLayout, ruleSetPanel, ndetRow];

// =============================================================================
// §1 — Load and validate file structure
// =============================================================================
section('1. Load and File Structure Validation');

{
  const { binary } = buildBinary(allNodes);

  const loader = assertNoThrow('SOMLoader loads valid binary', () => new SOMLoader(binary));

  if (loader) {
    assert('stats present', loader.stats !== null, true);
    assert('pool entries > 0', loader.poolSize > 0, true);
    assert('static component count = 2', loader.stats.staticComponents, 2);
    assert('indexed dynamic count = 2', loader.stats.indexedDynamic, 2); // boundary + ndet
  }
}

// =============================================================================
// §2 — Static component lookup
// =============================================================================
section('2. Static Component Lookup');

{
  const { binary } = buildBinary(allNodes);
  const loader = new SOMLoader(binary);

  // Lookup by selector string
  const btn = loader.getStatic('.btn');
  assert('getStatic(".btn") not null', btn !== null, true);
  assert('.btn recordType = STATIC', btn?.recordType, 'STATIC');
  assert('.btn selector resolved', btn?.selector, '.btn');

  // Properties round-trip
  assert('.btn color = #FFFFFF',            btn?.properties.get('color'),            '#FFFFFF');
  assert('.btn background-color = #2563EB', btn?.properties.get('background-color'), '#2563EB');
  assert('.btn padding = 8px 16px',         btn?.properties.get('padding'),          '8px 16px');
  assert('.btn font-size = 14px',           btn?.properties.get('font-size'),        '14px');
  assert('.btn border-radius = 4px',        btn?.properties.get('border-radius'),    '4px');

  // Lookup by pre-computed hash (O(1) runtime path)
  const hash = fnv1a32('.btn');
  const btnByHash = loader.getStatic(hash);
  assert('getStatic(hash) same result as getStatic(string)',
    btnByHash?.selector, btn?.selector);

  // Card lookup
  const card = loader.getStatic('.card');
  assert('.card not null',          card !== null, true);
  assert('.card background = #FFFFFF', card?.properties.get('background'), '#FFFFFF');

  // Unknown selector returns null
  assert('unknown static selector returns null', loader.getStatic('.nonexistent'), null);

  // Dynamic component not found in static map
  assert('dynamic component not in static map', loader.getStatic('.layout'), null);
}

// =============================================================================
// §3 — Dynamic component lookup (boundary, rule set, nondeterministic)
// =============================================================================
section('3. Dynamic Component Lookup');

{
  const { binary } = buildBinary(allNodes);
  const loader = new SOMLoader(binary);

  // Boundary manifest
  const layout = loader.getDynamic('.layout');
  assert('.layout not null',             layout !== null, true);
  assert('.layout recordType',           layout?.recordType, 'BOUNDARY_MARKER');
  assert('.layout dep count = 2',        layout?.depEntries.length, 2);

  const widthDep = layout?.depEntries.find(d => d.propertyName === 'width');
  assert('.layout width dep type = 0x01 (PARENT_SIZE)', widthDep?.depType, 0x01);

  const heightDep = layout?.depEntries.find(d => d.propertyName === 'min-height');
  assert('.layout min-height dep type = 0x02 (VIEWPORT)', heightDep?.depType, 0x02);

  assert('.layout subgraph count = 2', layout?.subgraphHashes.length, 2);
  assert('.layout subgraph[0] = hash(.layout)',
    layout?.subgraphHashes[0], fnv1a32('.layout'));
  assert('.layout subgraph[1] = hash(.layout .panel)',
    layout?.subgraphHashes[1], fnv1a32('.layout .panel'));

  // Rule set lookup via its own hash
  // NOTE: rule set records are stored in dynamic tier but NOT in the index
  // (only boundaries are indexed). They're reached via subgraph traversal.
  // getDynamic('.layout .panel') may return null if not indexed — that's correct.
  // Access is via boundary's subgraph list.
  const panelViaIndex = loader.getDynamic('.layout .panel');
  // Either null (correct — not indexed) or a RuleSetRecord (if your impl indexes all dynamic)
  // We assert it's either null OR a rule set, not anything else
  assert('.layout .panel is either null or RULE_SET',
    panelViaIndex === null || panelViaIndex?.recordType === 'RULE_SET', true);

  // Nondeterministic record
  const ndet = loader.getDynamic('.table tr:nth-child(even)');
  assert('ndet not null',               ndet !== null, true);
  assert('ndet recordType',             ndet?.recordType, 'NONDETERMINISTIC');
  assert('ndet selector resolved',      ndet?.selector, '.table tr:nth-child(even)');

  // Hash-based lookup for dynamic
  const layoutByHash = loader.getDynamic(fnv1a32('.layout'));
  assert('getDynamic(hash) matches getDynamic(string)',
    layoutByHash?.selector, layout?.selector);

  // Unknown returns null
  assert('unknown dynamic selector returns null', loader.getDynamic('.nonexistent'), null);
  assert('static component not in dynamic index', loader.getDynamic('.btn'), null);
}

// =============================================================================
// §4 — Lazy loading behaviour
// =============================================================================
section('4. Lazy Dynamic Record Parsing');

{
  const { binary } = buildBinary(allNodes);
  const loader = new SOMLoader(binary);

  // First access parses the record
  const first  = loader.getDynamic('.layout');
  // Second access returns cached instance
  const second = loader.getDynamic('.layout');

  assert('same object returned on second access (cached)', first === second, true);
  assert('layout not null after second access', second !== null, true);
}

// =============================================================================
// §5 — Error handling
// =============================================================================
section('5. Error Handling');

{
  // Buffer too short
  assertThrows('rejects empty buffer',   () => new SOMLoader(Buffer.alloc(0)),  'too short');
  assertThrows('rejects 15-byte buffer', () => new SOMLoader(Buffer.alloc(15)), 'too short');

  // Wrong magic
  const wrongMagic = Buffer.alloc(64, 0);
  wrongMagic.write('XXXX', 0, 'ascii');
  assertThrows('rejects wrong file magic', () => new SOMLoader(wrongMagic), 'magic');

  // Wrong version
  const wrongVersion = Buffer.alloc(64, 0);
  Buffer.from([0x42, 0x53, 0x4F, 0x4D]).copy(wrongVersion, 0); // BSOM
  wrongVersion.writeUInt8(0x02, 4); // version 2
  assertThrows('rejects unsupported version', () => new SOMLoader(wrongVersion), 'version');

  // Truncated static tier
  const { binary } = buildBinary([staticBtn]);
  const truncated = binary.slice(0, binary.length - 5);
  assertThrows('rejects truncated binary', () => new SOMLoader(truncated));
}

// =============================================================================
// §6 — Full pipeline round-trip: CSS-like input → binary → loader
// =============================================================================
section('6. Full Round-trip Pipeline');

{
  // Build a representative set covering all record types
  const nodes = [
    // STATIC components
    makeNode({ selector: '.badge',  properties: new Map([['display', { raw: 'inline-flex' }], ['padding', { raw: '2px 8px' }], ['border-radius', { raw: '9999px' }]]) }),
    makeNode({ selector: '.avatar', properties: new Map([['width', { raw: '40px' }], ['height', { raw: '40px' }], ['border-radius', { raw: '9999px' }]]) }),
    // DETERMINISTIC boundary
    (() => {
      const n = makeNode({
        selector:   '.hero__title',
        finalClass: 'BIND_DETERMINISTIC',
        isBoundary: true,
        depEntries: [{ propertyName: 'font-size', depType: 0x02, containerId: null }],
        subgraphIds: ['.hero__title'],
        properties: new Map([['font-size', { raw: 'clamp(28px, 5vw, 64px)' }]]),
      });
      return n;
    })(),
    // NONDETERMINISTIC
    makeNode({
      selector: '.data-table tr:nth-child(even) td',
      finalClass: 'BIND_NONDETERMINISTIC',
      isBoundary: true,
      depEntries: [],
      subgraphIds: ['.data-table tr:nth-child(even) td'],
    }),
  ];

  const { binary, emit } = buildBinary(nodes);
  const loader = new SOMLoader(binary);

  // Static lookups
  assert('badge loaded',  loader.getStatic('.badge')?.recordType,  'STATIC');
  assert('avatar loaded', loader.getStatic('.avatar')?.recordType, 'STATIC');
  assert('badge display = inline-flex', loader.getStatic('.badge')?.properties.get('display'), 'inline-flex');
  assert('avatar width = 40px',         loader.getStatic('.avatar')?.properties.get('width'),  '40px');

  // Dynamic lookup
  const heroTitle = loader.getDynamic('.hero__title');
  assert('hero__title loaded',        heroTitle?.recordType, 'BOUNDARY_MARKER');
  assert('hero__title dep count',     heroTitle?.depEntries.length, 1);
  assert('hero__title dep type = VIEWPORT (0x02)', heroTitle?.depEntries[0]?.depType, 0x02);
  assert('hero__title dep prop',      heroTitle?.depEntries[0]?.propertyName, 'font-size');

  // Nondeterministic
  const ndet = loader.getDynamic('.data-table tr:nth-child(even) td');
  assert('ndet loaded', ndet?.recordType, 'NONDETERMINISTIC');

  // Stats
  assert('load stats present', loader.stats !== null, true);
  assert('static count = 2',   loader.stats.staticComponents, 2);
}

// =============================================================================
// §7 — Load benchmark (informational)
// =============================================================================
section('7. Load Benchmark');

{
  // 100 static + 40 dynamic components
  const nodes = [
    ...Array.from({ length: 100 }, (_, i) => makeNode({
      selector:   `.static-${i}`,
      properties: new Map([
        ['color',         { raw: '#1E293B' }],
        ['background',    { raw: '#FFFFFF' }],
        ['padding',       { raw: '8px 16px' }],
        ['font-size',     { raw: '14px' }],
        ['border-radius', { raw: '4px' }],
      ]),
    })),
    ...Array.from({ length: 40 }, (_, i) => makeNode({
      selector:   `.dynamic-${i}`,
      finalClass: 'BIND_DETERMINISTIC',
      isBoundary: true,
      depEntries: [{ propertyName: 'width', depType: 0x01, containerId: null }],
      subgraphIds: [`dynamic-${i}`],
      properties: new Map([['width', { raw: '50%' }]]),
    })),
  ];

  const { binary } = buildBinary(nodes);

  // Time 100 load + lookup cycles
  const ITERATIONS = 100;
  const t0 = Date.now();
  let loader;
  for (let i = 0; i < ITERATIONS; i++) {
    loader = new SOMLoader(binary);
    loader.getStatic('.static-0');
    loader.getDynamic('.dynamic-0');
  }
  const elapsed = Date.now() - t0;

  console.log(`\n  Binary size:       ${binary.length} bytes (140 components)`);
  console.log(`  Load time:         ${loader.stats.loadTimeMs}ms (single load)`);
  console.log(`  100x load+lookup:  ${elapsed}ms total, ${(elapsed/ITERATIONS).toFixed(2)}ms avg`);
  console.log(`  getStatic():       O(1) Map lookup by FNV-1a hash`);
  console.log(`  getDynamic():      O(1) index lookup + lazy record parse`);

  assert('single load < 10ms', loader.stats.loadTimeMs < 10, true);
  assert('binary > 0 bytes', binary.length > 0, true);
}

// =============================================================================
// Results
// =============================================================================
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
  console.log('\n  ✓ All loader tests passed.\n');
}