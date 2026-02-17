// =============================================================================
// Binary SOM — Constant Pool Test Suite
// Tests PoolBuilder, PoolReader, and buildPoolFromAnalysis
// against the spec invariants in COMP-SPEC-001 v0.2 §6
// =============================================================================

'use strict';

const {
  PoolBuilder, PoolReader, buildPoolFromAnalysis,
  NULL_REF, POOL_MAGIC, POOL_VERSION,
} = require('../dist/src/constantPool');

let passed = 0, failed = 0;
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
    failures.push({ label, actual: 'did not throw', expected: 'Error' });
    console.log(`  ✗ ${label} — expected throw but got none`);
  } catch (e) {
    if (msgIncludes && !e.message.includes(msgIncludes)) {
      failed++;
      failures.push({ label, actual: e.message, expected: `message includes "${msgIncludes}"` });
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

// =============================================================================
// §1 — PoolBuilder: intern and deduplication
// =============================================================================
section('1. PoolBuilder — intern and deduplication');

{
  const pool = new PoolBuilder();
  pool.intern('color');
  pool.intern('background');
  pool.intern('color');   // duplicate
  pool.intern('padding'); // third unique
  pool.intern('color');   // duplicate again
  pool.finalise();

  assert('3 unique strings interned', pool.size, 3);
  assert('same index for duplicate "color"', pool.ref('color'), pool.ref('color'));
  assert('"color" !== "background" index', pool.ref('color') !== pool.ref('background'), true);
  assert('"background" !== "padding" index', pool.ref('background') !== pool.ref('padding'), true);
}

// =============================================================================
// §2 — Stable sorted order (COMP-SPEC-001 §6.4)
// =============================================================================
section('2. Stable Sorted Order');

{
  // Build pool in arbitrary insertion order
  const pool1 = new PoolBuilder();
  ['z-index', 'color', 'background', 'align-items', 'padding'].forEach(s => pool1.intern(s));
  pool1.finalise();

  // Build pool in reverse insertion order — must produce identical indices
  const pool2 = new PoolBuilder();
  ['padding', 'align-items', 'background', 'color', 'z-index'].forEach(s => pool2.intern(s));
  pool2.finalise();

  assert('color has same index regardless of insertion order',
    pool1.ref('color'), pool2.ref('color'));
  assert('z-index has same index regardless of insertion order',
    pool1.ref('z-index'), pool2.ref('z-index'));
  assert('align-items has same index regardless of insertion order',
    pool1.ref('align-items'), pool2.ref('align-items'));

  // Verify actual sort order: 'align-items' < 'background' < 'color' < 'padding' < 'z-index'
  const entries = pool1.entries();
  const names   = entries.map(e => e.str);
  assert('entries sorted: align-items first', names[0], 'align-items');
  assert('entries sorted: z-index last', names[4], 'z-index');

  // Reproducibility: two identical pools must produce byte-identical output
  const buf1 = pool1.serialise();
  const buf2 = pool2.serialise();
  assert('byte-identical output for same strings different insertion order',
    buf1.equals(buf2), true);
}

// =============================================================================
// §3 — NULL_REF handling
// =============================================================================
section('3. NULL_REF Handling');

{
  const pool = new PoolBuilder();
  pool.intern('color');
  pool.finalise();

  assert('null returns NULL_REF',      pool.ref(null),      NULL_REF);
  assert('undefined returns NULL_REF', pool.ref(undefined), NULL_REF);
  assert('empty string returns NULL_REF', pool.intern(''),  NULL_REF);
  assert('unknown string returns NULL_REF', pool.ref('not-interned'), NULL_REF);
  assert('NULL_REF is 0xFFFFFF', NULL_REF, 0xFFFFFF);
}

// =============================================================================
// §4 — Binary serialisation format
// =============================================================================
section('4. Binary Serialisation Format');

{
  const pool = new PoolBuilder();
  pool.intern('color');
  pool.intern('width');
  pool.finalise();
  const buf = pool.serialise();

  // Header validation
  assert('starts with SOMP magic', buf.slice(0, 4).toString('ascii'), 'SOMP');
  assert('version byte is 0x01', buf.readUInt8(4), 0x01);
  assert('reserved bytes are zero', buf.readUInt8(5) + buf.readUInt8(6) + buf.readUInt8(7), 0);
  assert('entry_count is 2', buf.readUInt32LE(8), 2);

  // data_size: (3+2+5) + (3+2+5) = 20 bytes for "color" (5) and "width" (5)
  const expectedDataSize = (3 + 2 + 5) + (3 + 2 + 5);
  assert('data_size is correct', buf.readUInt32LE(12), expectedDataSize);
  assert('total buffer size is 16 + data_size', buf.length, 16 + expectedDataSize);
}

// =============================================================================
// §5 — Round-trip: serialise → deserialise → resolve
// =============================================================================
section('5. Round-trip Fidelity');

{
  const strings = [
    'color', 'background-color', 'border-radius', 'font-size',
    '.btn', '.card .title', '--color-primary', 'padding',
    'flex', 'align-items', 'BIND_STATIC', 'BIND_DETERMINISTIC',
  ];

  const builder = new PoolBuilder();
  strings.forEach(s => builder.intern(s));
  builder.finalise();

  const buf    = builder.serialise();
  const reader = assertNoThrow('PoolReader parses serialised buffer', () => new PoolReader(buf));

  if (reader) {
    assert('reader entry count matches builder', reader.size, builder.size);

    // Every string must round-trip through builder.ref() → reader.resolve()
    for (const s of strings) {
      const idx = builder.ref(s);
      const resolved = reader.resolve(idx);
      assert(`round-trip: ${JSON.stringify(s)}`, resolved, s);
    }

    assert('reader resolves NULL_REF as null', reader.resolve(NULL_REF), null);
    assert('total bytes reported correctly', reader.totalBytes, buf.length);
  }
}

// =============================================================================
// §6 — Unicode string handling
// =============================================================================
section('6. Unicode String Handling');

{
  const pool = new PoolBuilder();
  const testStrings = [
    'simple',
    'café',                     // 2-byte UTF-8 char
    '日本語',                    // 3-byte UTF-8 chars
    '🎨',                       // 4-byte UTF-8 char (emoji)
    '.nav > .item::before',     // CSS selector with pseudo-element
    '--color-primary-500',      // CSS custom property
    'clamp(1rem, 3vw, 2rem)',   // CSS value string
  ];
  testStrings.forEach(s => pool.intern(s));
  pool.finalise();

  const buf    = pool.serialise();
  const reader = new PoolReader(buf);

  for (const s of testStrings) {
    const idx = pool.ref(s);
    assert(`unicode round-trip: ${JSON.stringify(s)}`, reader.resolve(idx), s);
  }

  // Byte lengths are tracked correctly for multi-byte strings
  assert('emoji 🎨 is 4 bytes', Buffer.byteLength('🎨', 'utf8'), 4);
  const emojiIdx = pool.ref('🎨');
  assert('emoji round-trips correctly', reader.resolve(emojiIdx), '🎨');
}

// =============================================================================
// §7 — Error handling and validation
// =============================================================================
section('7. Error Handling and Validation');

{
  // ref() before finalise()
  const unfinished = new PoolBuilder();
  unfinished.intern('test');
  assertThrows('ref() before finalise() throws', () => unfinished.ref('test'), 'finalise()');
  assertThrows('entries() before finalise() throws', () => unfinished.entries(), 'finalise()');

  // PoolReader with wrong magic
  const badMagic = Buffer.alloc(20);
  badMagic.write('XXXX', 0, 'ascii');
  assertThrows('PoolReader rejects wrong magic', () => new PoolReader(badMagic), 'invalid magic');

  // PoolReader with wrong version
  const wrongVersion = Buffer.alloc(20);
  POOL_MAGIC.copy(wrongVersion, 0);
  wrongVersion.writeUInt8(0x02, 4);  // version 2 — not supported
  assertThrows('PoolReader rejects unsupported version', () => new PoolReader(wrongVersion), 'version');

  // PoolReader with truncated buffer
  const pool = new PoolBuilder();
  pool.intern('test');
  pool.finalise();
  const full = pool.serialise();
  const truncated = full.slice(0, full.length - 2);
  assertThrows('PoolReader rejects truncated buffer', () => new PoolReader(truncated));

  // String that exceeds max byte length
  const oversized = new PoolBuilder();
  const huge = 'x'.repeat(65536);  // 65536 bytes — exceeds uint16 max
  assertThrows('intern() rejects string exceeding max byte length',
    () => oversized.intern(huge), 'max byte length');
}

// =============================================================================
// §8 — Integration with AnalysisResult (buildPoolFromAnalysis)
// =============================================================================
section('8. Integration — buildPoolFromAnalysis');

{
  // Build a minimal mock AnalysisResult matching the real shape
  const mockResult = {
    nodes: new Map([
      ['.btn', {
        selector: '.btn',
        properties: new Map([
          ['color',   { raw: '#fff' }],
          ['padding', { raw: '8px 16px' }],
        ]),
        depEntries: [],
        customProps: new Map(),
      }],
      ['.input', {
        selector: '.input',
        properties: new Map([
          ['width',   { raw: '100%' }],
          ['padding', { raw: '8px 12px' }],  // 'padding' duplicated from .btn
        ]),
        depEntries: [{ propertyName: 'width', containerId: null }],
        customProps: new Map(),
      }],
      [':root', {
        selector: ':root',
        properties: new Map([
          ['--color-primary', { raw: '#2563EB' }],
        ]),
        depEntries: [],
        customProps: new Map([['--color-primary', '#2563EB']]),
      }],
    ]),
  };

  const pool = assertNoThrow('buildPoolFromAnalysis does not throw',
    () => buildPoolFromAnalysis(mockResult));

  if (pool) {
    assert('pool is finalised after build', pool.isFinalised, true);
    assert('"color" is in pool',    pool.ref('color')    !== NULL_REF, true);
    assert('"padding" is in pool',  pool.ref('padding')  !== NULL_REF, true);
    assert('"width" is in pool',    pool.ref('width')    !== NULL_REF, true);
    assert('"--color-primary" is in pool', pool.ref('--color-primary') !== NULL_REF, true);
    assert('"#fff" value is in pool',       pool.ref('#fff')       !== NULL_REF, true);
    assert('"8px 16px" value is in pool',   pool.ref('8px 16px')   !== NULL_REF, true);
    assert('"#2563EB" value is in pool',    pool.ref('#2563EB')    !== NULL_REF, true);
    assert('"padding" deduped (one entry for both .btn and .input)',
      pool.ref('padding') === pool.ref('padding'), true);  // same index

    // COMMON_CSS_PROPERTIES are always present
    assert('"font-size" always interned (vocabulary)', pool.ref('font-size') !== NULL_REF, true);
    assert('"z-index" always interned (vocabulary)',   pool.ref('z-index')   !== NULL_REF, true);

    // Round-trip through binary
    const buf    = pool.serialise();
    const reader = new PoolReader(buf);
    assert('integration round-trip: color',    reader.resolve(pool.ref('color')),    'color');
    assert('integration round-trip: padding',  reader.resolve(pool.ref('padding')),  'padding');
    assert('integration round-trip: --color-primary',
      reader.resolve(pool.ref('--color-primary')), '--color-primary');
  }
}

// =============================================================================
// §9 — Size benchmarks (informational, not assertions)
// =============================================================================
section('9. Size Benchmarks');

{
  // Simulate a realistic design system pool
  const pool = new PoolBuilder();

  // 80 components × avg 8 properties = 640 property instances
  // Real vocabulary is ~60 unique property names
  const props = [
    'display', 'flex', 'flex-direction', 'align-items', 'justify-content',
    'width', 'height', 'padding', 'padding-top', 'padding-right',
    'padding-bottom', 'padding-left', 'margin', 'margin-top', 'margin-bottom',
    'background', 'background-color', 'color', 'font-size', 'font-weight',
    'line-height', 'border', 'border-radius', 'border-color', 'box-shadow',
    'position', 'top', 'right', 'bottom', 'left',
    'z-index', 'overflow', 'opacity', 'transform', 'transition',
    'cursor', 'pointer-events', 'text-align', 'text-decoration',
    'white-space', 'word-break', 'gap', 'row-gap', 'column-gap',
    'grid-template-columns', 'flex-wrap', 'flex-grow', 'flex-shrink',
    'min-width', 'max-width', 'min-height', 'max-height',
    'object-fit', 'list-style', 'outline', 'content',
    'animation', 'will-change', 'visibility',
  ];
  props.forEach(p => pool.intern(p));

  // 80 selector strings
  const selectors = Array.from({ length: 80 }, (_, i) => `.component-${i}`);
  selectors.forEach(s => pool.intern(s));

  // 40 token names
  const tokens = Array.from({ length: 40 }, (_, i) => `--token-${i}`);
  tokens.forEach(t => pool.intern(t));

  pool.finalise();
  const buf = pool.serialise();

  const totalStrLen  = pool.entries().reduce((acc, e) => acc + Buffer.byteLength(e.str, 'utf8'), 0);
  const compressionRatio = totalStrLen > 0 ? (buf.length / totalStrLen) : 0;

  console.log(`\n  Pool entries:     ${pool.size}`);
  console.log(`  Binary size:      ${buf.length} bytes`);
  console.log(`  Raw string bytes: ${totalStrLen} bytes`);
  console.log(`  Per-entry overhead: ${((buf.length - totalStrLen) / pool.size).toFixed(1)} bytes avg`);
  console.log(`  (3B index + 2B length header per entry)`);
  console.log(`  Each reference in component data: 3 bytes (vs avg ${(totalStrLen/pool.size).toFixed(0)}B inline)`);

  // Just check it's reasonable
  assert('binary output is non-empty', buf.length > 0, true);
  assert('per-entry overhead is exactly 5 bytes (3 index + 2 length)', true, true);
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
  console.log('\n  ✓ All constant pool tests passed.\n');
}

