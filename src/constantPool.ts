// @ts-nocheck
// =============================================================================
// Binary SOM — Constant Pool Emitter
// COMP-SPEC-001 v0.2  §6 (new section)
//
// BINARY FORMAT — STRING CONSTANT POOL
// =====================================
//
// The constant pool is a self-contained binary section that precedes all
// component data. It maps integer indices to UTF-8 string values, enabling
// any repeated string (selector, property name, token name, keyword) to be
// referenced by a 3-byte index rather than emitted inline.
//
// POOL SECTION LAYOUT
// ───────────────────
//  Offset  Size   Field
//  0       4      MAGIC         0x534F4D50 ("SOMP" — SOM Pool)
//  4       1      VERSION       0x01
//  5       3      RESERVED      0x000000
//  8       4      entry_count   uint32 LE — number of entries
//  12      4      data_size     uint32 LE — byte length of all entries combined
//  16      N      entries[]     (see entry layout below)
//
// ENTRY LAYOUT
// ────────────
//  Offset  Size   Field
//  0       3      index         uint24 LE — 0-based pool index (max 16,777,215 entries)
//  3       2      byte_length   uint16 LE — UTF-8 byte length of string (max 65,535 bytes)
//  5       N      utf8_bytes    raw UTF-8, no null terminator
//
// Entries are emitted in STABLE SORTED ORDER:
//   - Lexicographic by UTF-8 byte value
//   - Deterministic across compilations of semantically identical source
//   - Required for reproducible builds and binary diffing (COMP-SPEC-001 §6.4)
//
// INDEX REFERENCES in component data use 3-byte uint24 LE values.
// Index 0xFFFFFF (16,777,215) is RESERVED as NULL_REF (no pool entry).
//
// LIMITS
//   Max pool entries:  16,777,215  (uint24 max minus NULL_REF)
//   Max string length: 65,535 bytes (uint16 max)
//   Max pool size:     ~4 GB (uint32 data_size)
//
// READING THE POOL
//   1. Validate MAGIC and VERSION
//   2. Read entry_count and data_size
//   3. Read entry_count entries sequentially
//   4. Build index → string lookup array (O(entry_count))
//   5. All subsequent index references resolve in O(1)
//
// =============================================================================

'use strict';

const POOL_MAGIC   = Buffer.from('SOMP');   // 0x534F4D50
const POOL_VERSION = 0x01;
const NULL_REF     = 0xFFFFFF;
const MAX_ENTRIES  = NULL_REF;              // 0xFFFFFE usable entries
const MAX_STR_BYTES = 65535;

// ── PoolBuilder ───────────────────────────────────────────────────────────────
// Collects strings during the analysis pass, assigns stable indices,
// serialises to binary.

class PoolBuilder {
  constructor() {
    // Map from string → tentative insertion order index
    // Indices are reassigned on finalise() to stable sorted order.
    this._strings  = new Map();   // string → finalIndex (set after finalise)
    this._inserted = [];          // insertion-order record for dedup check
    this._finalised = false;
  }

  // ── Intern a string, return its final pool index.
  // Call finalise() before using the returned indices in binary output.
  intern(str) {
    if (str === null || str === undefined) return NULL_REF;
    const s = String(str);
    if (s.length === 0) return NULL_REF;

    const byteLen = Buffer.byteLength(s, 'utf8');
    if (byteLen > MAX_STR_BYTES) {
      throw new Error(
        `PoolBuilder: string exceeds max byte length (${byteLen} > ${MAX_STR_BYTES}): ` +
        `"${s.slice(0, 40)}…"`
      );
    }

    if (!this._strings.has(s)) {
      if (this._strings.size >= MAX_ENTRIES) {
        throw new Error(`PoolBuilder: pool capacity exceeded (max ${MAX_ENTRIES} entries)`);
      }
      this._strings.set(s, -1);  // index assigned on finalise()
      this._inserted.push(s);
    }
    return this._strings.get(s);  // -1 until finalised — callers must finalise first
  }

  // ── Assign stable sorted indices. Must be called before serialise() or ref().
  // Idempotent — safe to call multiple times.
  finalise() {
    if (this._finalised) return this;

    // Sort lexicographically by UTF-8 byte representation (deterministic order)
    const sorted = [...this._strings.keys()].sort((a, b) => {
      const ba = Buffer.from(a, 'utf8');
      const bb = Buffer.from(b, 'utf8');
      const len = Math.min(ba.length, bb.length);
      for (let i = 0; i < len; i++) {
        if (ba[i] !== bb[i]) return ba[i] - bb[i];
      }
      return ba.length - bb.length;
    });

    sorted.forEach((s, idx) => this._strings.set(s, idx));
    this._finalised = true;
    return this;
  }

  // ── Resolve a previously interned string to its final index.
  // Must call finalise() first.
  ref(str) {
    if (!this._finalised) throw new Error('PoolBuilder.ref(): call finalise() first');
    if (str === null || str === undefined || str === '') return NULL_REF;
    const idx = this._strings.get(String(str));
    return idx !== undefined ? idx : NULL_REF;
  }

  get size() { return this._strings.size; }
  get isFinalised() { return this._finalised; }

  // ── Enumerate all entries in stable sorted order (post-finalise)
  entries() {
    if (!this._finalised) throw new Error('PoolBuilder.entries(): call finalise() first');
    return [...this._strings.entries()]
      .sort((a, b) => a[1] - b[1])
      .map(([str, idx]) => ({ idx, str }));
  }

  // ── Serialise to binary Buffer
  serialise() {
    if (!this._finalised) this.finalise();

    const entries = this.entries();

    // Compute data_size: sum of (3 + 2 + byteLen) per entry
    let dataSize = 0;
    const encodedEntries = entries.map(({ idx, str }) => {
      const buf = Buffer.from(str, 'utf8');
      dataSize += 3 + 2 + buf.length;
      return { idx, str, buf };
    });

    // Allocate: 16 bytes header + dataSize bytes entries
    const total = 16 + dataSize;
    const out   = Buffer.alloc(total, 0);
    let pos     = 0;

    // Header
    POOL_MAGIC.copy(out, pos);          pos += 4;  // MAGIC
    out.writeUInt8(POOL_VERSION, pos);  pos += 1;  // VERSION
    pos += 3;                                       // RESERVED
    out.writeUInt32LE(entries.length, pos); pos += 4; // entry_count
    out.writeUInt32LE(dataSize, pos);   pos += 4;  // data_size

    // Entries
    for (const { idx, buf } of encodedEntries) {
      // 3-byte uint24 LE index
      out.writeUInt8(idx & 0xFF, pos);
      out.writeUInt8((idx >> 8) & 0xFF, pos + 1);
      out.writeUInt8((idx >> 16) & 0xFF, pos + 2);
      pos += 3;
      // 2-byte uint16 LE byte length
      out.writeUInt16LE(buf.length, pos); pos += 2;
      // UTF-8 bytes
      buf.copy(out, pos); pos += buf.length;
    }

    if (pos !== total) {
      throw new Error(`PoolBuilder: serialisation size mismatch (wrote ${pos}, expected ${total})`);
    }

    return out;
  }

  // ── Human-readable dump for debugging and spec validation
  dump() {
    if (!this._finalised) this.finalise();
    const lines = [`ConstantPool (${this.size} entries):`];
    for (const { idx, str } of this.entries()) {
      const byteLen = Buffer.byteLength(str, 'utf8');
      lines.push(`  [${String(idx).padStart(6)}]  ${String(byteLen).padStart(5)}B  ${JSON.stringify(str)}`);
    }
    return lines.join('\n');
  }
}

// ── PoolReader ────────────────────────────────────────────────────────────────
// Deserialises a pool section from binary. Validates magic, version, bounds.

class PoolReader {
  constructor(buf, offset = 0) {
    this._buf   = buf;
    this._table = [];   // index → string
    this._parse(offset);
  }

  _parse(offset) {
    const buf = this._buf;

    // Validate magic
    if (buf.length < offset + 16) {
      throw new Error('PoolReader: buffer too short for pool header');
    }
    const magic = buf.slice(offset, offset + 4);
    if (!magic.equals(POOL_MAGIC)) {
      throw new Error(
        `PoolReader: invalid magic 0x${magic.toString('hex').toUpperCase()} ` +
        `(expected 0x${POOL_MAGIC.toString('hex').toUpperCase()})`
      );
    }

    const version = buf.readUInt8(offset + 4);
    if (version !== POOL_VERSION) {
      throw new Error(`PoolReader: unsupported pool version ${version} (expected ${POOL_VERSION})`);
    }

    const entryCount = buf.readUInt32LE(offset + 8);
    const dataSize   = buf.readUInt32LE(offset + 12);

    if (buf.length < offset + 16 + dataSize) {
      throw new Error(
        `PoolReader: buffer truncated (need ${offset + 16 + dataSize} bytes, have ${buf.length})`
      );
    }

    // Pre-allocate lookup table
    this._table = new Array(entryCount);

    let pos = offset + 16;
    for (let i = 0; i < entryCount; i++) {
      if (pos + 5 > buf.length) throw new Error(`PoolReader: truncated entry at index ${i}`);

      // Read 3-byte uint24 LE index
      const idx = buf.readUInt8(pos) | (buf.readUInt8(pos + 1) << 8) | (buf.readUInt8(pos + 2) << 16);
      pos += 3;

      // Read 2-byte uint16 LE byte length
      const byteLen = buf.readUInt16LE(pos); pos += 2;

      if (pos + byteLen > buf.length) {
        throw new Error(`PoolReader: string data truncated at index ${idx}`);
      }
      if (idx >= entryCount) {
        throw new Error(`PoolReader: index ${idx} out of range (entry_count=${entryCount})`);
      }

      const str = buf.toString('utf8', pos, pos + byteLen);
      this._table[idx] = str;
      pos += byteLen;
    }

    // Verify all indices were filled
    for (let i = 0; i < entryCount; i++) {
      if (this._table[i] === undefined) {
        throw new Error(`PoolReader: missing entry for index ${i}`);
      }
    }

    this._entryCount = entryCount;
    this._dataSize   = dataSize;
    this._totalBytes = 16 + dataSize;
  }

  // Resolve an index to its string. NULL_REF returns null.
  resolve(idx) {
    if (idx === NULL_REF) return null;
    if (idx < 0 || idx >= this._table.length) {
      throw new Error(`PoolReader: index ${idx} out of range`);
    }
    return this._table[idx];
  }

  get size()       { return this._entryCount; }
  get totalBytes() { return this._totalBytes; }
  get table()      { return [...this._table]; }  // defensive copy
}

// ── AnalysisPoolExtractor ─────────────────────────────────────────────────────
// Walks an AnalysisResult and interns all poolable strings.
// Returns a finalised PoolBuilder ready for serialisation.

function buildPoolFromAnalysis(analysisResult) {
  const pool = new PoolBuilder();

  function internValueLike(value) {
    if (value === null || value === undefined) return;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      pool.intern(String(value));
      return;
    }
    // Map-style property records commonly use { raw } or { value }.
    if (typeof value === 'object') {
      if (typeof value.raw === 'string') pool.intern(value.raw);
      if (typeof value.value === 'string') pool.intern(value.value);
    }
  }

  const nodeEntries = [];
  const nodes = analysisResult?.nodes;

  if (nodes instanceof Map) {
    for (const [id, node] of nodes.entries()) {
      nodeEntries.push([id, node]);
    }
  } else if (Array.isArray(nodes)) {
    for (const node of nodes) {
      const id = node?.id ?? node?.selector ?? '';
      nodeEntries.push([id, node || {}]);
    }
  }

  for (const [id, node] of nodeEntries) {
    // Selector / component ID
    pool.intern(node?.selector ?? id);

    // Property names from Map-style nodes
    if (node?.properties instanceof Map) {
      for (const [propName, propValue] of node.properties.entries()) {
        pool.intern(propName);
        internValueLike(propValue);
      }
    }

    // Property names from object-style nodes
    if (node?.declarations && typeof node.declarations === 'object') {
      for (const [propName, propValue] of Object.entries(node.declarations)) {
        pool.intern(propName);
        internValueLike(propValue);
      }
    }
    if (node?.normalizedDeclarations && typeof node.normalizedDeclarations === 'object') {
      for (const [propName, propValue] of Object.entries(node.normalizedDeclarations)) {
        pool.intern(propName);
        internValueLike(propValue);
      }
    }

    // Dep entry property names (may overlap with above — deduped automatically)
    const depList = Array.isArray(node?.depEntries)
      ? node.depEntries
      : Array.isArray(node?.deps)
        ? node.deps
        : [];

    for (const dep of depList) {
      pool.intern(dep?.propertyName ?? dep?.property);
      if (dep?.containerId) pool.intern(dep.containerId);
    }

    // Token names from Map-style customProps
    if (node?.customProps instanceof Map) {
      for (const [propName, propValue] of node.customProps.entries()) {
        pool.intern(propName);
        internValueLike(propValue);
      }
    }
  }

  // Token names from object-style analyser output
  if (analysisResult?.tokens && typeof analysisResult.tokens === 'object') {
    for (const [tokenName, tokenValue] of Object.entries(analysisResult.tokens)) {
      pool.intern(tokenName);
      internValueLike(tokenValue);
    }
  }

  // CSS property name vocabulary (always intern the full set for stable indices)
  // These are the properties the runtime needs to reference by name.
  COMMON_CSS_PROPERTIES.forEach(p => pool.intern(p));

  pool.finalise();
  return pool;
}

// Standard CSS property vocabulary — interning these ensures stable indices
// across compilations even when individual components don't use all of them.
const COMMON_CSS_PROPERTIES = [
  'align-content', 'align-items', 'align-self',
  'animation', 'animation-duration', 'animation-name',
  'background', 'background-color', 'background-image',
  'background-position', 'background-repeat', 'background-size',
  'border', 'border-bottom', 'border-color', 'border-left',
  'border-radius', 'border-right', 'border-top', 'border-width',
  'bottom', 'box-shadow', 'box-sizing',
  'color', 'column-gap', 'container', 'container-type', 'content',
  'cursor', 'display',
  'flex', 'flex-direction', 'flex-grow', 'flex-shrink', 'flex-wrap',
  'font-family', 'font-size', 'font-style', 'font-weight',
  'gap', 'grid', 'grid-column', 'grid-row', 'grid-template-columns',
  'height', 'inset', 'justify-content', 'justify-items', 'justify-self',
  'left', 'letter-spacing', 'line-height',
  'margin', 'margin-bottom', 'margin-left', 'margin-right', 'margin-top',
  'max-height', 'max-width', 'min-height', 'min-width',
  'object-fit', 'object-position', 'opacity', 'outline', 'overflow',
  'padding', 'padding-bottom', 'padding-left', 'padding-right', 'padding-top',
  'pointer-events', 'position',
  'right', 'row-gap',
  'text-align', 'text-decoration', 'text-overflow', 'text-transform',
  'top', 'transform', 'transition',
  'vertical-align', 'visibility',
  'white-space', 'width', 'will-change', 'word-break', 'z-index',
];

// ── Module exports ────────────────────────────────────────────────────────────
module.exports = {
  PoolBuilder,
  PoolReader,
  buildPoolFromAnalysis,
  NULL_REF,
  POOL_MAGIC,
  POOL_VERSION,
  COMMON_CSS_PROPERTIES,
};

