// =============================================================================
// Binary SOM — Binary Loader
// COMP-SPEC-001 v0.2  §8
//
// Reads a .som binary and exposes:
//   loader.getStatic(selectorOrHash)  → ResolvedProperties | null
//   loader.getDynamic(selectorOrHash) → DynamicRecord | null
//   loader.stats                      → LoadStats
//
// LOAD SEQUENCE
// ─────────────
// 1. Validate file magic + version (offset 0, 16 bytes)
// 2. Parse pool section → string[index] table        O(pool entries)
// 3. Parse static tier → hash → properties Map       O(static count)
// 4. Parse dynamic index → hash → file offset Map    O(indexed count)
// 5. Dynamic tier records loaded lazily on first access
//
// After steps 1–4 the loader is ready. Step 5 defers I/O for unused components.
// =============================================================================

'use strict';

const { PoolReader, NULL_REF } = require('./constantPool');
const { RecordType, STATIC_MAGIC, DYNAMIC_MAGIC, FILE_MAGIC, FILE_VERSION, fnv1a32 } = require('./emitter');

// ── Public record types ────────────────────────────────────────────────────

// Returned by getStatic()
// properties: Map<propertyName, rawValue>  — both strings, from pool
class ResolvedProperties {
  constructor(selectorHash, selector, properties) {
    this.selectorHash = selectorHash;
    this.selector     = selector;
    this.properties   = properties;    // Map<string, string>
    this.recordType   = 'STATIC';
  }
}

// Returned by getDynamic() for boundary nodes
class BoundaryManifest {
  constructor({ selectorHash, selector, depEntries, flags, subgraphHashes }) {
    this.selectorHash  = selectorHash;
    this.selector      = selector;
    this.depEntries    = depEntries;    // Array<{ depType, propertyName, containerHash }>
    this.flags         = flags;
    this.hasPortalDep  = (flags & 0x01) !== 0;
    this.hasThemeDep   = (flags & 0x02) !== 0;
    this.subgraphHashes= subgraphHashes; // Uint32Array — hashes of all subgraph members
    this.recordType    = 'BOUNDARY_MARKER';
  }
}

// Returned by getDynamic() for contaminated non-boundary nodes
class RuleSetRecord {
  constructor({ selectorHash, selector, properties, boundaryHash }) {
    this.selectorHash = selectorHash;
    this.selector     = selector;
    this.properties   = properties;   // Map<string, string>
    this.boundaryHash = boundaryHash;
    this.recordType   = 'RULE_SET';
  }
}

// Returned by getDynamic() for nondeterministic nodes
class NondeterministicRecord {
  constructor({ selectorHash, selector, flags }) {
    this.selectorHash = selectorHash;
    this.selector     = selector;
    this.flags        = flags;
    this.recordType   = 'NONDETERMINISTIC';
  }
}

// ── SOMLoader ─────────────────────────────────────────────────────────────

class SOMLoader {
  constructor(buf) {
    this._buf         = buf;
    this._pool        = null;
    this._staticMap   = new Map();   // hash → ResolvedProperties
    this._dynamicIdx  = new Map();   // hash → absolute file offset into dynamic tier
    this._dynamicCache= new Map();   // hash → parsed record (lazy)
    this._dynTierStart= 0;           // absolute offset where dynamic tier data begins
    this._loadStats   = null;

    this._parse();
  }

  // ── Public API ────────────────────────────────────────────────────────

  // Look up a STATIC component by selector string or pre-computed hash.
  // Returns ResolvedProperties | null.
  getStatic(selectorOrHash) {
    const hash = typeof selectorOrHash === 'number'
      ? selectorOrHash
      : fnv1a32(selectorOrHash);
    return this._staticMap.get(hash) ?? null;
  }

  // Look up a DYNAMIC component (boundary, rule set, or nondeterministic).
  // Returns BoundaryManifest | RuleSetRecord | NondeterministicRecord | null.
  // First access parses the record from the buffer (lazy).
  getDynamic(selectorOrHash) {
    const hash = typeof selectorOrHash === 'number'
      ? selectorOrHash
      : fnv1a32(selectorOrHash);

    if (this._dynamicCache.has(hash)) {
      return this._dynamicCache.get(hash);
    }

    const offset = this._dynamicIdx.get(hash);
    if (offset === undefined) return null;

    const record = this._parseDynamicRecord(this._dynTierStart + offset);
    this._dynamicCache.set(hash, record);
    return record;
  }

  // Resolve a pool index to a string. Returns null for NULL_REF.
  resolveString(idx) {
    return this._pool.resolve(idx);
  }

  get stats() { return this._loadStats; }
  get poolSize() { return this._pool.size; }

  // ── Parsing ───────────────────────────────────────────────────────────

  _parse() {
    const buf  = this._buf;
    const t0   = Date.now();

    // ── File header ────────────────────────────────────────────────────
    if (buf.length < 16) throw new Error('SOMLoader: file too short for header');

    const magic = buf.slice(0, 4);
    if (!magic.equals(FILE_MAGIC)) {
      throw new Error(
        `SOMLoader: invalid file magic 0x${magic.toString('hex').toUpperCase()} ` +
        `(expected BSOM)`
      );
    }

    const version = buf.readUInt8(4);
    if (version !== FILE_VERSION) {
      throw new Error(`SOMLoader: unsupported file version ${version} (expected ${FILE_VERSION})`);
    }

    // section_count at offset 12 — we expect 3 (pool, static, dynamic)
    const sectionCount = buf.readUInt32LE(12);
    if (sectionCount !== 3) {
      throw new Error(`SOMLoader: unexpected section count ${sectionCount} (expected 3)`);
    }

    let pos = 16;

    // ── Pool section ───────────────────────────────────────────────────
    this._pool = new PoolReader(buf, pos);
    pos += this._pool.totalBytes;

    // ── Static tier ───────────────────────────────────────────────────
    if (!buf.slice(pos, pos + 4).equals(STATIC_MAGIC)) {
      throw new Error(`SOMLoader: expected static tier magic SOMS at offset ${pos}`);
    }

    const staticCount   = buf.readUInt32LE(pos + 4);
    const staticSize    = buf.readUInt32LE(pos + 8);
    let   staticPos     = pos + 12;
    const staticEnd     = staticPos + staticSize;

    for (let i = 0; i < staticCount; i++) {
      if (staticPos + 8 > buf.length) {
        throw new Error(`SOMLoader: static tier truncated at component ${i}`);
      }

      const selectorHash = buf.readUInt32LE(staticPos);
      const selectorRef  = this._readUInt24LE(staticPos + 4);
      const propCount    = buf.readUInt8(staticPos + 7);
      staticPos += 8;

      const selector   = this._pool.resolve(selectorRef) ?? `<hash:${selectorHash.toString(16)}>`;
      const properties = new Map();

      for (let j = 0; j < propCount; j++) {
        if (staticPos + 6 > buf.length) {
          throw new Error(`SOMLoader: static property truncated at component ${i}, prop ${j}`);
        }
        const nameRef  = this._readUInt24LE(staticPos);
        const valueRef = this._readUInt24LE(staticPos + 3);
        staticPos += 6;

        const name  = this._pool.resolve(nameRef);
        const value = this._pool.resolve(valueRef);
        if (name !== null) properties.set(name, value ?? '');
      }

      this._staticMap.set(selectorHash, new ResolvedProperties(selectorHash, selector, properties));
    }

    if (staticPos !== staticEnd) {
      throw new Error(`SOMLoader: static tier size mismatch (parsed ${staticPos - (pos+12)}, expected ${staticSize})`);
    }

    pos = staticEnd;

    // ── Dynamic index ─────────────────────────────────────────────────
    if (!buf.slice(pos, pos + 4).equals(DYNAMIC_MAGIC)) {
      throw new Error(`SOMLoader: expected dynamic index magic SOMD at offset ${pos}`);
    }

    const dynIdxCount = buf.readUInt32LE(pos + 4);
    const dynIdxSize  = buf.readUInt32LE(pos + 8);
    let   dynIdxPos   = pos + 12;

    for (let i = 0; i < dynIdxCount; i++) {
      if (dynIdxPos + 11 > buf.length) {
        throw new Error(`SOMLoader: dynamic index truncated at entry ${i}`);
      }

      const hash       = buf.readUInt32LE(dynIdxPos);
      // selectorRef at dynIdxPos + 4 — available if needed for debug
      const fileOffset = buf.readUInt32LE(dynIdxPos + 7);
      this._dynamicIdx.set(hash, fileOffset);
      dynIdxPos += 11;
    }

    this._dynTierStart = pos + 12 + dynIdxSize;

    const t1 = Date.now();
    this._loadStats = {
      fileSizeBytes:    buf.length,
      poolEntries:      this._pool.size,
      staticComponents: staticCount,
      indexedDynamic:   dynIdxCount,
      loadTimeMs:       t1 - t0,
    };
  }

  // ── Lazy dynamic record parsing ────────────────────────────────────────
  _parseDynamicRecord(absoluteOffset) {
    const buf  = this._buf;
    let   pos  = absoluteOffset;

    if (pos >= buf.length) throw new Error(`SOMLoader: dynamic record offset ${absoluteOffset} out of bounds`);

    const recordType   = buf.readUInt8(pos);         pos += 1;
    const selectorHash = buf.readUInt32LE(pos);       pos += 4;
    const selectorRef  = this._readUInt24LE(pos);     pos += 3;
    const selector     = this._pool.resolve(selectorRef) ?? `<hash:${selectorHash.toString(16)}>`;

    switch (recordType) {

      case RecordType.BOUNDARY_MARKER: {
        const depCount      = buf.readUInt8(pos);     pos += 1;
        const flags         = buf.readUInt8(pos);     pos += 1;
        const subgraphCount = buf.readUInt16LE(pos);  pos += 2;

        const depEntries = [];
        for (let i = 0; i < depCount; i++) {
          const depType       = buf.readUInt8(pos);
          const propRef       = this._readUInt24LE(pos + 1);
          const containerHash = buf.readUInt32LE(pos + 4);
          pos += 8;

          depEntries.push({
            depType,
            propertyName:  this._pool.resolve(propRef) ?? '',
            containerHash: containerHash || null,
          });
        }

        const subgraphHashes = new Uint32Array(subgraphCount);
        for (let i = 0; i < subgraphCount; i++) {
          subgraphHashes[i] = buf.readUInt32LE(pos); pos += 4;
        }

        return new BoundaryManifest({ selectorHash, selector, depEntries, flags, subgraphHashes });
      }

      case RecordType.RULE_SET: {
        const propCount    = buf.readUInt8(pos);      pos += 1;
        const boundaryHash = buf.readUInt32LE(pos);   pos += 4;

        const properties = new Map();
        for (let i = 0; i < propCount; i++) {
          const nameRef  = this._readUInt24LE(pos);
          const valueRef = this._readUInt24LE(pos + 3);
          pos += 6;
          const name  = this._pool.resolve(nameRef);
          const value = this._pool.resolve(valueRef);
          if (name !== null) properties.set(name, value ?? '');
        }

        return new RuleSetRecord({ selectorHash, selector, properties, boundaryHash });
      }

      case RecordType.NONDETERMINISTIC: {
        const flags = buf.readUInt8(pos);
        return new NondeterministicRecord({ selectorHash, selector, flags });
      }

      default:
        throw new Error(`SOMLoader: unknown record type 0x${recordType.toString(16)} at offset ${absoluteOffset}`);
    }
  }

  // ── Utility ────────────────────────────────────────────────────────────
  _readUInt24LE(offset) {
    return this._buf.readUInt8(offset) |
          (this._buf.readUInt8(offset + 1) << 8) |
          (this._buf.readUInt8(offset + 2) << 16);
  }
}

// ── Convenience factory ───────────────────────────────────────────────────
function loadSOM(bufOrPath) {
  let buf;
  if (Buffer.isBuffer(bufOrPath)) {
    buf = bufOrPath;
  } else {
    const fs = require('fs');
    buf = fs.readFileSync(bufOrPath);
  }
  return new SOMLoader(buf);
}

module.exports = {
  SOMLoader, loadSOM,
  ResolvedProperties, BoundaryManifest, RuleSetRecord, NondeterministicRecord,
};