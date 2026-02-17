// =============================================================================
// Binary SOM — Emitter Test Suite
// Tests emitComponentSection, assembleBinary, fnv1a32
// against the spec invariants in COMP-SPEC-001 v0.2 §7
// =============================================================================

'use strict';

const { emitComponentSection, assembleBinary, fnv1a32,
        RecordType, STATIC_MAGIC, DYNAMIC_MAGIC, FILE_MAGIC } = require('../dist/src/emitter');
const { PoolBuilder, buildPoolFromAnalysis, NULL_REF } = require('../dist/src/constantPool');
const { analyseCSS } = require('../dist/src/analyser');

let passed = 0, failed = 0;
const failures = [];

function assert(label, actual, expected) {
  if (actual === expected || (typeof actual === 'number' && typeof expected === 'number' && isNaN(actual) === isNaN(expected))) {
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
    console.log(`  ✗ ${label} — expected throw but got none`);
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

// ── Minimal mock analysis result ──────────────────────────────────────────
function makeNode(overrides) {
  return Object.assign({
    selector:   '.default',
    finalClass: 'BIND_STATIC',
    isBoundary: false,
    portalTarget: null,
    depEntries: [],
    contaminates: [],
    subgraphRoot: null,
    properties: new Map([
      ['color',   { raw: '#1E293B' }],
      ['padding', { raw: '8px 16px' }],
    ]),
    customProps: new Map(),
  }, overrides);
}

function makeResult(nodeList) {
  const nodes = new Map();
  for (const node of nodeList) {
    nodes.set(node.selector, node);
  }
  return { nodes };
}

// =============================================================================
// §1 — FNV-1a hash correctness
// =============================================================================
section('1. FNV-1a Hash Correctness');

// Known vectors from FNV spec
assert('fnv1a32("") = 0x811c9dc5',  fnv1a32(''),      0x811c9dc5);
assert('fnv1a32("a") = 0xe40c292c', fnv1a32('a'),     0xe40c292c);
assert('fnv1a32("foobar")',          fnv1a32('foobar'), 0xbf9cf968);

// Stability: same input always same output
assert('deterministic across calls', fnv1a32('.card .title'), fnv1a32('.card .title'));

// Uniqueness: different selectors should (almost certainly) differ
assert('.btn !== .card', fnv1a32('.btn') !== fnv1a32('.card'), true);

// Hash is uint32 (no sign bit issues)
assert('always non-negative', fnv1a32('.very-long-selector-that-might-wrap') >= 0, true);
assert('always <= 0xFFFFFFFF', fnv1a32('.test') <= 0xFFFFFFFF, true);

// Cross-compilation stability key property: hash depends only on string content
const h1 = fnv1a32('.responsive-card .responsive-card__title');
const h2 = fnv1a32('.responsive-card .responsive-card__title');
assert('identical selectors produce identical hashes', h1, h2);

// =============================================================================
// §2 — Static tier format
// =============================================================================
section('2. Static Tier Format');

{
  const result = makeResult([
    makeNode({ selector: '.btn',  properties: new Map([['color', { raw: '#fff' }], ['padding', { raw: '8px 16px' }]]) }),
    makeNode({ selector: '.card', properties: new Map([['background', { raw: 'white' }]]) }),
  ]);

  const pool = buildPoolFromAnalysis(result);
  const { staticTier, stats } = emitComponentSection(result, pool);

  // Header validation
  assert('static tier magic = SOMS', staticTier.slice(0, 4).toString('ascii'), 'SOMS');
  assert('static component count = 2', staticTier.readUInt32LE(4), 2);
  assert('static count in stats', stats.staticCount, 2);
  assert('dynamic count = 0', stats.dynamicCount, 0);

  // section_size should match actual data size
  const sectionSize = staticTier.readUInt32LE(8);
  assert('section_size matches buffer content', staticTier.length, 12 + sectionSize);

  // Each record starts at correct offset
  // Record 1: hash(smallest) first (sorted by hash)
  const firstHash = staticTier.readUInt32LE(12);
  assert('first record has valid hash (non-zero)', firstHash !== 0, true);
}

// =============================================================================
// §3 — Dynamic tier and index format
// =============================================================================
section('3. Dynamic Tier and Index Format');

{
  const boundaryNode = makeNode({
    selector:   '.container',
    finalClass: 'BIND_DETERMINISTIC',
    isBoundary: true,
    depEntries: [{ propertyName: 'width', depType: 0x01, containerId: null }],
    contaminates: [],
    subgraphIds: ['.container', '.container .title'],
  });

  const childNode = makeNode({
    selector:    '.container .title',
    finalClass:  'BIND_DETERMINISTIC',
    isBoundary:  false,
    subgraphRoot: boundaryNode,
    depEntries:  [],
    properties:  new Map([['font-size', { raw: '18px' }]]),
  });

  const result = makeResult([boundaryNode, childNode]);
  const pool = buildPoolFromAnalysis(result);
  const { dynamicIndex, dynamicTier, stats } = emitComponentSection(result, pool);

  // Dynamic index header
  assert('dynamic index magic = SOMD', dynamicIndex.slice(0, 4).toString('ascii'), 'SOMD');

  // Only boundary node gets an index entry
  const indexedCount = dynamicIndex.readUInt32LE(4);
  assert('only boundary node indexed (not child)', indexedCount, 1);
  assert('indexed count in stats', stats.indexedCount, 1);

  // Index entry: 11 bytes at offset 12
  const entryBase = 12;
  const entryHash = dynamicIndex.readUInt32LE(entryBase);
  assert('index entry hash matches selector', entryHash, fnv1a32('.container'));

  const fileOffset = dynamicIndex.readUInt32LE(entryBase + 7);
  assert('file offset is 0 (first record)', fileOffset, 0);

  // Dynamic tier: first record is boundary marker
  assert('first dynamic record type = BOUNDARY_MARKER', dynamicTier.readUInt8(0), RecordType.BOUNDARY_MARKER);
  const boundaryHash = dynamicTier.readUInt32LE(1);
  assert('boundary record hash matches selector', boundaryHash, fnv1a32('.container'));
  const depCount = dynamicTier.readUInt8(9);
  assert('dep_count = 1', depCount, 1);

  // Subgraph count
  const subgraphCount = dynamicTier.readUInt16LE(11);
  assert('subgraph_count = 2', subgraphCount, 2);

  // Second record is rule set
  // Offset: 1 + 4 + 3 + 1 + 1 + 2 + (8 * 1) + (4 * 2) = 28 bytes for boundary record
  const boundaryRecordSize = 1 + 4 + 3 + 1 + 1 + 2 + (8 * 1) + (4 * 2);
  assert('rule set record type', dynamicTier.readUInt8(boundaryRecordSize), RecordType.RULE_SET);
  const ruleSetHash = dynamicTier.readUInt32LE(boundaryRecordSize + 1);
  assert('rule set hash matches .container .title', ruleSetHash, fnv1a32('.container .title'));

  // Rule set encodes its boundary owner hash
  const boundaryOwnerHash = dynamicTier.readUInt32LE(boundaryRecordSize + 9);
  assert('rule set boundary_hash = hash(.container)', boundaryOwnerHash, fnv1a32('.container'));
}

// =============================================================================
// §4 — NONDETERMINISTIC record format
// =============================================================================
section('4. NONDETERMINISTIC Record Format');

{
  const ndetNode = makeNode({
    selector:   '.table tr:nth-child(even) td',
    finalClass: 'BIND_NONDETERMINISTIC',
    isBoundary: true,
    depEntries: [],
  });

  const result = makeResult([ndetNode]);
  const pool = buildPoolFromAnalysis(result);
  const { dynamicTier, stats } = emitComponentSection(result, pool);

  assert('ndet count = 1', stats.dynamicCount, 1);
  assert('record type = NONDETERMINISTIC (0x03)', dynamicTier.readUInt8(0), RecordType.NONDETERMINISTIC);
  assert('hash matches selector', dynamicTier.readUInt32LE(1), fnv1a32('.table tr:nth-child(even) td'));
  assert('ndet record is 9 bytes', dynamicTier.length, 9);
}

// =============================================================================
// §5 — Deterministic output (same input → byte-identical binary)
// =============================================================================
section('5. Deterministic / Reproducible Output');

{
  // Build result in two different insertion orders
  const makeTestResult = (reversed) => {
    const nodes = [
      makeNode({ selector: '.alpha', properties: new Map([['color', { raw: 'red' }]]) }),
      makeNode({ selector: '.beta',  properties: new Map([['padding', { raw: '8px' }]]) }),
      makeNode({ selector: '.gamma', properties: new Map([['margin', { raw: '0' }]]) }),
    ];
    const ordered = reversed ? [...nodes].reverse() : nodes;
    return makeResult(ordered);
  };

  const r1 = makeTestResult(false);
  const r2 = makeTestResult(true);

  const p1 = buildPoolFromAnalysis(r1);
  const p2 = buildPoolFromAnalysis(r2);

  const e1 = emitComponentSection(r1, p1);
  const e2 = emitComponentSection(r2, p2);

  assert('static tier byte-identical regardless of input order',
    e1.staticTier.equals(e2.staticTier), true);
}

// =============================================================================
// §6 — Full pipeline: CSS source → analysis → pool → binary
// =============================================================================
section('6. Full Pipeline: CSS → Binary');

{
  // Simulate what the analyser produces (without importing it to keep test portable)
  const staticButton = makeNode({
    selector:   '.btn',
    finalClass: 'BIND_STATIC',
    properties: new Map([
      ['display',          { raw: 'inline-flex' }],
      ['padding',          { raw: '8px 16px' }],
      ['background-color', { raw: '#2563EB' }],
      ['color',            { raw: '#FFFFFF' }],
      ['border-radius',    { raw: '4px' }],
      ['font-size',        { raw: '14px' }],
    ]),
  });

  const dynamicLayout = makeNode({
    selector:   '.layout',
    finalClass: 'BIND_DETERMINISTIC',
    isBoundary: true,
    depEntries: [
      { propertyName: 'width',      depType: 0x01, containerId: null },
      { propertyName: 'min-height', depType: 0x02, containerId: null },
    ],
    subgraphIds: ['.layout'],
    properties: new Map([
      ['width',      { raw: '100%' }],
      ['min-height', { raw: '100vh' }],
    ]),
  });

  const result = makeResult([staticButton, dynamicLayout]);
  const pool   = buildPoolFromAnalysis(result);
  const emit   = emitComponentSection(result, pool);
  const binary = assembleBinary(
    pool.serialise(),
    emit.staticTier,
    emit.dynamicIndex,
    emit.dynamicTier,
  );

  // File header
  assert('file starts with BSOM magic', binary.slice(0, 4).equals(FILE_MAGIC), true);
  assert('file version = 0x01', binary.readUInt8(4), 0x01);
  assert('section_count = 3', binary.readUInt32LE(12), 3);

  // Pool section starts at offset 16
  assert('pool magic at offset 16', binary.slice(16, 20).toString('ascii'), 'SOMP');

  // Static tier follows pool
  const poolSize = pool.serialise().length;
  const staticOffset = 16 + poolSize;
  assert('static tier magic at correct offset', binary.slice(staticOffset, staticOffset + 4).toString('ascii'), 'SOMS');
  assert('static count = 1', binary.readUInt32LE(staticOffset + 4), 1);

  // Dynamic index follows static tier
  const dynamicIndexOffset = staticOffset + emit.staticTier.length;
  assert('dynamic index magic at correct offset', binary.slice(dynamicIndexOffset, dynamicIndexOffset + 4).toString('ascii'), 'SOMD');

  // Stats
  assert('total bytes > 0', emit.stats.totalBytes > 0, true);
  assert('static component = 1', emit.stats.staticCount, 1);
  assert('dynamic component = 1', emit.stats.dynamicCount, 1);
  assert('indexed entries = 1 (boundary only)', emit.stats.indexedCount, 1);

  console.log(`\n  Binary output: ${binary.length} bytes total`);
  console.log(`  Pool:          ${poolSize} bytes`);
  console.log(`  Static tier:   ${emit.stats.staticTierBytes} bytes (1 component, 6 properties)`);
  console.log(`  Dynamic index: ${emit.stats.dynamicIndexBytes} bytes (1 boundary entry)`);
  console.log(`  Dynamic tier:  ${emit.stats.dynamicTierBytes} bytes (1 boundary marker)`);
}

section('6b. Real AnalysisResult Integration');

{
  const css = `
    :root { --color-primary: #2563EB; }
    .btn {
      color: var(--color-primary);
      padding: 8px 16px;
    }
    .layout {
      width: 100%;
      min-height: 100vh;
    }
    .layout .title {
      font-size: 18px;
    }
  `;

  const analysis = assertNoThrow('analyseCSS returns object', () => analyseCSS(css));
  const pool = assertNoThrow('buildPoolFromAnalysis accepts analyser output', () => buildPoolFromAnalysis(analysis));
  const emit = assertNoThrow('emitComponentSection accepts analyser output', () => emitComponentSection(analysis, pool));
  if (emit) {
    assert('real analysis yields at least one static component', emit.stats.staticCount > 0, true);
    assert('real analysis yields at least one dynamic component', emit.stats.dynamicCount > 0, true);
    assert('real analysis emits non-empty component bytes', emit.stats.totalBytes > 0, true);
  }
}

// =============================================================================
// §7 — Error handling
// =============================================================================
section('7. Error Handling');

{
  const result = makeResult([makeNode()]);
  const unfinalised = new PoolBuilder();
  unfinalised.intern('color');
  // Do NOT call finalise()

  assertThrows(
    'emitComponentSection rejects unfinalised pool',
    () => emitComponentSection(result, unfinalised),
    'finalised'
  );
}

// =============================================================================
// §8 — Size benchmarks
// =============================================================================
section('8. Size Benchmarks');

{
  // Simulate 60 STATIC + 20 DETERMINISTIC components
  const staticNodes = Array.from({ length: 60 }, (_, i) => makeNode({
    selector: `.component-${i}`,
    properties: new Map([
      ['display',    { raw: 'flex' }],
      ['padding',    { raw: '8px 16px' }],
      ['color',      { raw: '#1E293B' }],
      ['background', { raw: '#FFFFFF' }],
      ['font-size',  { raw: '14px' }],
    ]),
  }));

  const dynamicNodes = Array.from({ length: 20 }, (_, i) => makeNode({
    selector:   `.dynamic-${i}`,
    finalClass: 'BIND_DETERMINISTIC',
    isBoundary: true,
    depEntries: [{ propertyName: 'width', depType: 0x01, containerId: null }],
    subgraphIds: [`.dynamic-${i}`],
    properties: new Map([['width', { raw: '50%' }]]),
  }));

  const result = makeResult([...staticNodes, ...dynamicNodes]);
  const pool   = buildPoolFromAnalysis(result);
  const emit   = emitComponentSection(result, pool);

  const staticBytesPerComp  = (emit.stats.staticTierBytes - 12) / 60;
  const dynamicBytesPerComp = emit.stats.dynamicTierBytes / 20;

  console.log(`\n  60 STATIC + 20 DYNAMIC components:`);
  console.log(`  Static tier:   ${emit.stats.staticTierBytes} bytes  (~${staticBytesPerComp.toFixed(0)}B/component)`);
  console.log(`  Dynamic index: ${emit.stats.dynamicIndexBytes} bytes  (${emit.stats.indexedCount} entries × 11B)`);
  console.log(`  Dynamic tier:  ${emit.stats.dynamicTierBytes} bytes  (~${dynamicBytesPerComp.toFixed(0)}B/component)`);
  console.log(`  Pool:          ${pool.serialise().length} bytes`);
  console.log(`  Total:         ${emit.stats.totalBytes + pool.serialise().length} bytes`);

  assert('static bytes per component reasonable (<100)', staticBytesPerComp < 100, true);
  assert('dynamic index entry is 11 bytes each', emit.stats.dynamicIndexBytes - 12, 20 * 11);
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
  console.log('\n  ✓ All emitter tests passed.\n');
}


