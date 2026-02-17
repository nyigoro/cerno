// @ts-nocheck
// =============================================================================
// Binary SOM — Component Section Emitter
// COMP-SPEC-001 v0.2  §7
//
// BINARY FORMAT — COMPONENT SECTION
// ===================================
//
// The component section follows the constant pool in the .som binary.
// It is split into two tiers with different runtime access patterns:
//
//  ┌─────────────────────────────────────────────────────────────┐
//  │  FILE HEADER   (16 bytes)                                   │
//  │  POOL SECTION  (variable)                                   │
//  │  STATIC TIER   (bulk, no index needed)                      │
//  │  DYNAMIC INDEX (offset table, DYNAMIC components only)      │
//  │  DYNAMIC TIER  (boundary markers + rule sets + manifests)   │
//  └─────────────────────────────────────────────────────────────┘
//
// ── STATIC TIER ─────────────────────────────────────────────────────────────
//
//  STATIC TIER HEADER (12 bytes):
//    0   4   MAGIC         0x534F4D53 ("SOMS")
//    4   4   component_count  uint32 LE
//    8   4   section_size     uint32 LE — byte length of all records
//
//  RESOLVED STYLE BLOCK (per STATIC component):
//    0   4   selector_hash  uint32 LE — FNV-1a of selector UTF-8
//    4   3   selector_ref   uint24 LE — pool index of selector string
//    7   1   prop_count     uint8  — number of property entries (max 255)
//    8   N   properties[]  (see property entry layout)
//
//  PROPERTY ENTRY:
//    0   3   name_ref     uint24 LE — pool index of property name
//    3   3   value_ref    uint24 LE — pool index of raw value string
//    (6 bytes per property)
//
// ── DYNAMIC INDEX ────────────────────────────────────────────────────────────
//
//  DYNAMIC INDEX HEADER (12 bytes):
//    0   4   MAGIC         0x534F4D44 ("SOMD")
//    4   4   component_count  uint32 LE
//    8   4   index_size       uint32 LE — byte length of index entries
//
//  INDEX ENTRY (11 bytes each):
//    0   4   selector_hash  uint32 LE — FNV-1a of selector UTF-8
//    4   3   selector_ref   uint24 LE — pool index
//    7   4   file_offset    uint32 LE — absolute offset into DYNAMIC TIER
//
// ── DYNAMIC TIER ────────────────────────────────────────────────────────────
//
//  BOUNDARY MARKER RECORD (BIND_DETERMINISTIC boundary node):
//    0   1   record_type    0x01 = BOUNDARY_MARKER
//    1   4   selector_hash  uint32 LE
//    2   3   selector_ref   uint24 LE  [at byte 5]
//    8   1   dep_count      uint8
//    9   1   flags          uint8  (bit 0 = PORTAL_DEP, bit 1 = THEME_DEP)
//   10   2   subgraph_count uint16 LE — number of subgraph member hashes
//   12   N   dep_entries[]  (see dep entry layout)
//   12+N M   subgraph_hashes[] uint32 LE each
//
//  RULE SET RECORD (contaminated non-boundary):
//    0   1   record_type    0x02 = RULE_SET
//    1   4   selector_hash  uint32 LE
//    5   3   selector_ref   uint24 LE
//    8   1   prop_count     uint8
//    9   3   boundary_hash_lo + boundary_hash_hi  (4 bytes: boundary owner hash)
//   13   N   properties[]   same layout as STATIC property entry
//
//  NONDETERMINISTIC RECORD:
//    0   1   record_type    0x03 = NONDETERMINISTIC
//    1   4   selector_hash  uint32 LE
//    5   3   selector_ref   uint24 LE
//    8   1   flags          uint8
//
//  DEP ENTRY (in BOUNDARY_MARKER):
//    0   1   dep_type       uint8 (DepType enum)
//    1   3   prop_name_ref  uint24 LE — pool index
//    4   4   container_hash uint32 LE — FNV-1a of container selector (0 if none)
//    (8 bytes per dep entry)
//
// =============================================================================

'use strict';

const { NULL_REF } = require('./constantPool');

const DEP_TYPE_CODE = Object.freeze({
  PARENT_SIZE: 0x01,
  VIEWPORT: 0x02,
  FONT_METRICS: 0x03,
  ENV: 0x04,
  ENVIRONMENT: 0x04,
  THEME: 0x05,
  CONTAINER_SIZE: 0x06,
  USER_PREF: 0x07,
  INTRINSIC_SIZE: 0x08,
  STRUCTURE: 0x09,
});

// ── Record type constants ──────────────────────────────────────────────────
const RecordType = Object.freeze({
  BOUNDARY_MARKER:   0x01,
  RULE_SET:          0x02,
  NONDETERMINISTIC:  0x03,
});

// ── Section magic numbers ──────────────────────────────────────────────────
const STATIC_MAGIC  = Buffer.from('SOMS');   // 0x534F4D53
const DYNAMIC_MAGIC = Buffer.from('SOMD');   // 0x534F4D44

// ── FNV-1a hash (32-bit) ───────────────────────────────────────────────────
// Standard FNV-1a over UTF-8 bytes of the selector string.
// Stable across compilations as long as selector text is unchanged.
function fnv1a32(str) {
  let hash = 0x811c9dc5;  // FNV offset basis
  const bytes = Buffer.from(str, 'utf8');
  for (const byte of bytes) {
    hash ^= byte;
    // 32-bit FNV prime multiply, keeping within uint32
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;  // ensure unsigned 32-bit
}

// ── Write helpers ──────────────────────────────────────────────────────────
function writeUInt24LE(buf, value, offset) {
  buf.writeUInt8(value & 0xFF, offset);
  buf.writeUInt8((value >> 8) & 0xFF, offset + 1);
  buf.writeUInt8((value >> 16) & 0xFF, offset + 2);
}

function normaliseDepType(depType) {
  if (typeof depType === 'number') return depType;
  return DEP_TYPE_CODE[String(depType || '').toUpperCase()] || 0x00;
}

function asPropertiesMap(node) {
  if (node?.properties instanceof Map) {
    return node.properties;
  }
  const map = new Map();
  if (node?.declarations && typeof node.declarations === 'object') {
    for (const [name, raw] of Object.entries(node.declarations)) {
      map.set(name, { raw });
    }
  }
  if (map.size === 0 && node?.normalizedDeclarations && typeof node.normalizedDeclarations === 'object') {
    for (const [name, raw] of Object.entries(node.normalizedDeclarations)) {
      map.set(name, { raw });
    }
  }
  return map;
}

function normaliseAnalysisNodes(analysisResult) {
  const nodes = analysisResult?.nodes;
  const entries = [];
  const byId = new Map();

  if (nodes instanceof Map) {
    for (const [id, node] of nodes.entries()) {
      const selector = node?.selector ?? id;
      const entry = { id, selector, node: node || {} };
      entries.push(entry);
      byId.set(id, entry);
    }
  } else if (Array.isArray(nodes)) {
    for (const node of nodes) {
      const id = node?.id ?? node?.selector ?? '';
      const selector = node?.selector ?? id;
      const entry = { id, selector, node: node || {} };
      entries.push(entry);
      byId.set(id, entry);
    }
  }

  const manifestsByBoundary = new Map();
  for (const manifest of analysisResult?.manifests || []) {
    manifestsByBoundary.set(manifest.componentId, manifest);
  }

  return entries.map(({ id, selector, node }) => {
    const sourceDeps = Array.isArray(node?.depEntries)
      ? node.depEntries
      : Array.isArray(node?.deps)
        ? node.deps
        : [];
    const depEntries = sourceDeps.map((dep) => ({
      propertyName: dep?.propertyName ?? dep?.property ?? '',
      depType: normaliseDepType(dep?.depType),
      containerId: dep?.containerId ?? null,
    }));

    const isBoundary =
      node?.isBoundary === true ||
      (node?.boundaryId && node?.id && node.boundaryId === node.id);

    const boundaryId = node?.boundaryId ?? null;
    let subgraphIds = Array.isArray(node?.subgraphIds)
      ? [...node.subgraphIds]
      : (manifestsByBoundary.get(id)?.subgraphIds || null);
    if (Array.isArray(subgraphIds)) {
      subgraphIds = subgraphIds.map((memberId) => byId.get(memberId)?.selector || memberId);
    }

    const boundaryRecord = boundaryId ? byId.get(boundaryId) : null;
    const subgraphRoot = node?.subgraphRoot
      ? node.subgraphRoot
      : boundaryRecord
        ? { selector: boundaryRecord.selector }
        : null;

    return {
      selector,
      finalClass: node?.finalClass ?? 'BIND_STATIC',
      isBoundary,
      portalTarget: node?.portalTarget ?? node?.portalTargetRaw ?? null,
      depEntries,
      subgraphIds,
      subgraphRoot,
      contaminates: Array.isArray(node?.contaminates) ? node.contaminates : [],
      properties: asPropertiesMap(node),
      customProps: node?.customProps instanceof Map ? node.customProps : new Map(),
    };
  });
}

// ── Static tier emitter ───────────────────────────────────────────────────
function emitStaticTier(staticNodes, pool) {
  // Collect serialised records first to compute section_size
  const records = [];

  for (const node of staticNodes) {
    const selectorHash = fnv1a32(node.selector);
    const selectorRef  = pool.ref(node.selector);

    const props = [];
    for (const [name, prop] of (node.properties ?? [])) {
      if (name.startsWith('--')) continue;  // skip custom props in static block
      const nameRef  = pool.ref(name);
      const valueRef = pool.ref(prop.raw ?? prop.value ?? '');
      if (nameRef !== NULL_REF) {
        props.push({ nameRef, valueRef });
      }
    }

    // Sort properties by name_ref for deterministic output
    props.sort((a, b) => a.nameRef - b.nameRef);

    // Cap at 255 properties (uint8 prop_count)
    const propSlice = props.slice(0, 255);

    // Record: 4 (hash) + 3 (selector_ref) + 1 (prop_count) + 6*N (properties)
    const recSize = 4 + 3 + 1 + (6 * propSlice.length);
    const rec = Buffer.alloc(recSize);
    let pos = 0;

    rec.writeUInt32LE(selectorHash, pos); pos += 4;
    writeUInt24LE(rec, selectorRef, pos); pos += 3;
    rec.writeUInt8(propSlice.length, pos); pos += 1;

    for (const { nameRef, valueRef } of propSlice) {
      writeUInt24LE(rec, nameRef,  pos); pos += 3;
      writeUInt24LE(rec, valueRef, pos); pos += 3;
    }

    records.push(rec);
  }

  const sectionSize = records.reduce((sum, r) => sum + r.length, 0);

  // Header: 4 (magic) + 4 (count) + 4 (size) = 12 bytes
  const header = Buffer.alloc(12);
  STATIC_MAGIC.copy(header, 0);
  header.writeUInt32LE(records.length, 4);
  header.writeUInt32LE(sectionSize, 8);

  return Buffer.concat([header, ...records]);
}

// ── Dynamic tier emitter ──────────────────────────────────────────────────
function emitDynamicTier(dynamicNodes, pool) {
  // Two passes:
  //   Pass 1 — serialise all records, compute offsets
  //   Pass 2 — build index with resolved offsets, concatenate

  const serialisedRecords = [];
  let currentOffset = 0;
  const indexEntries = [];  // { selectorHash, selectorRef, offset }

  for (const node of dynamicNodes) {
    const selectorHash = fnv1a32(node.selector);
    const selectorRef  = pool.ref(node.selector);
    const rec          = serialiseComponentRecord(node, pool);

    // Only boundary nodes and NONDETERMINISTIC nodes get index entries
    // (Rule set nodes are reached via their boundary's subgraph list)
    if (node.isBoundary || node.finalClass === 'BIND_NONDETERMINISTIC') {
      indexEntries.push({ selectorHash, selectorRef, offset: currentOffset });
    }

    serialisedRecords.push(rec);
    currentOffset += rec.length;
  }

  // Dynamic index
  const indexRecordSize = 11;  // 4 hash + 3 ref + 4 offset
  const indexSize       = indexEntries.length * indexRecordSize;

  const indexHeader = Buffer.alloc(12);
  DYNAMIC_MAGIC.copy(indexHeader, 0);
  indexHeader.writeUInt32LE(indexEntries.length, 4);
  indexHeader.writeUInt32LE(indexSize, 8);

  const indexBuf = Buffer.alloc(indexSize);
  indexEntries.forEach(({ selectorHash, selectorRef, offset }, i) => {
    const base = i * indexRecordSize;
    indexBuf.writeUInt32LE(selectorHash, base);
    writeUInt24LE(indexBuf, selectorRef, base + 4);
    indexBuf.writeUInt32LE(offset, base + 7);
  });

  const tierBuf = Buffer.concat(serialisedRecords);

  return {
    indexSection: Buffer.concat([indexHeader, indexBuf]),
    tierSection:  tierBuf,
    indexEntries,
  };
}

function serialiseComponentRecord(node, pool) {
  const selectorHash = fnv1a32(node.selector);
  const selectorRef  = pool.ref(node.selector);

  // ── NONDETERMINISTIC ──────────────────────────────────────────────────
  if (node.finalClass === 'BIND_NONDETERMINISTIC') {
    const rec = Buffer.alloc(9);
    rec.writeUInt8(RecordType.NONDETERMINISTIC, 0);
    rec.writeUInt32LE(selectorHash, 1);
    writeUInt24LE(rec, selectorRef, 5);
    rec.writeUInt8(0x00, 8);  // flags reserved
    return rec;
  }

  // ── BOUNDARY MARKER (BIND_DETERMINISTIC boundary) ─────────────────────
  if (node.isBoundary) {
    const depEntries    = node.depEntries ?? [];
    const subgraphIds   = node.subgraphIds ?? (node.subgraphRoot === node
      ? [node.selector, ...(node.contaminates ?? []).map(c => c.selector ?? c)]
      : [node.selector]);

    const flags = computeFlags(node);
    const depCount      = Math.min(depEntries.length, 255);
    const subgraphCount = Math.min(subgraphIds.length, 65535);

    // Header: 1 + 4 + 3 + 1 + 1 + 2 = 12 bytes
    // Deps:   8 bytes each
    // Subgraph hashes: 4 bytes each
    const recSize = 12 + (8 * depCount) + (4 * subgraphCount);
    const rec = Buffer.alloc(recSize);
    let pos = 0;

    rec.writeUInt8(RecordType.BOUNDARY_MARKER, pos); pos += 1;
    rec.writeUInt32LE(selectorHash, pos);             pos += 4;
    writeUInt24LE(rec, selectorRef, pos);             pos += 3;
    rec.writeUInt8(depCount, pos);                    pos += 1;
    rec.writeUInt8(flags, pos);                       pos += 1;
    rec.writeUInt16LE(subgraphCount, pos);            pos += 2;

    for (let i = 0; i < depCount; i++) {
      const dep = depEntries[i];
      const propRef       = pool.ref(dep.propertyName);
      const containerHash = dep.containerId ? fnv1a32(dep.containerId) : 0;
      const depType       = normaliseDepType(dep.depType);

      rec.writeUInt8(depType, pos);                    pos += 1;
      writeUInt24LE(rec, propRef, pos);                pos += 3;
      rec.writeUInt32LE(containerHash, pos);           pos += 4;
    }

    for (let i = 0; i < subgraphCount; i++) {
      const hash = fnv1a32(subgraphIds[i]);
      rec.writeUInt32LE(hash, pos); pos += 4;
    }

    return rec;
  }

  // ── RULE SET (contaminated non-boundary DETERMINISTIC) ────────────────
  const boundarySelector = node.subgraphRoot?.selector ?? node.selector;
  const boundaryHash     = fnv1a32(boundarySelector);

  const props = [];
  for (const [name, prop] of (node.properties ?? [])) {
    if (name.startsWith('--')) continue;
    const nameRef  = pool.ref(name);
    const valueRef = pool.ref(prop.raw ?? prop.value ?? '');
    if (nameRef !== NULL_REF) props.push({ nameRef, valueRef });
  }
  props.sort((a, b) => a.nameRef - b.nameRef);
  const propSlice  = props.slice(0, 255);

  // Header: 1 + 4 + 3 + 1 + 4 = 13 bytes
  const recSize = 13 + (6 * propSlice.length);
  const rec     = Buffer.alloc(recSize);
  let pos       = 0;

  rec.writeUInt8(RecordType.RULE_SET, pos);         pos += 1;
  rec.writeUInt32LE(selectorHash, pos);             pos += 4;
  writeUInt24LE(rec, selectorRef, pos);             pos += 3;
  rec.writeUInt8(propSlice.length, pos);            pos += 1;
  rec.writeUInt32LE(boundaryHash, pos);             pos += 4;

  for (const { nameRef, valueRef } of propSlice) {
    writeUInt24LE(rec, nameRef,  pos); pos += 3;
    writeUInt24LE(rec, valueRef, pos); pos += 3;
  }

  return rec;
}

function computeFlags(node) {
  let flags = 0x00;
  if (node.portalTarget)                                      flags |= 0x01; // PORTAL_DEP
  if ((node.depEntries ?? []).some(e => normaliseDepType(e.depType) === 0x05)) flags |= 0x02; // THEME_DEP
  return flags;
}

// ── Top-level emitter ─────────────────────────────────────────────────────
function emitComponentSection(analysisResult, pool) {
  if (!pool.isFinalised) {
    throw new Error('emitComponentSection: pool must be finalised before emission');
  }

  const normalisedNodes = normaliseAnalysisNodes(analysisResult);
  const staticNodes  = [];
  const dynamicNodes = [];

  for (const node of normalisedNodes) {
    if (node.finalClass === 'BIND_STATIC') {
      staticNodes.push(node);
    } else {
      dynamicNodes.push(node);
    }
  }

  // Stable ordering within each tier: by selector hash (deterministic)
  staticNodes.sort((a, b)  => fnv1a32(a.selector) - fnv1a32(b.selector));
  dynamicNodes.sort((a, b) => fnv1a32(a.selector) - fnv1a32(b.selector));

  const staticTier   = emitStaticTier(staticNodes, pool);
  const { indexSection, tierSection, indexEntries } = emitDynamicTier(dynamicNodes, pool);

  return {
    staticTier,
    dynamicIndex: indexSection,
    dynamicTier:  tierSection,
    stats: {
      staticCount:       staticNodes.length,
      dynamicCount:      dynamicNodes.length,
      indexedCount:      indexEntries.length,
      staticTierBytes:   staticTier.length,
      dynamicIndexBytes: indexSection.length,
      dynamicTierBytes:  tierSection.length,
      totalBytes:        staticTier.length + indexSection.length + tierSection.length,
    },
  };
}

// ── Full .som binary assembler ─────────────────────────────────────────────
//  FILE HEADER (16 bytes):
//    0   4   MAGIC     0x42534F4D (".som" → "BSOM")
//    4   1   VERSION   0x01
//    5   3   RESERVED
//    8   4   flags     uint32 LE (reserved, 0)
//   12   4   section_count uint32 LE (always 3: pool, static, dynamic)
//
const FILE_MAGIC   = Buffer.from([0x42, 0x53, 0x4F, 0x4D]); // "BSOM"
const FILE_VERSION = 0x01;

function assembleBinary(poolBuf, staticTierBuf, dynamicIndexBuf, dynamicTierBuf) {
  const fileHeader = Buffer.alloc(16, 0);
  FILE_MAGIC.copy(fileHeader, 0);
  fileHeader.writeUInt8(FILE_VERSION, 4);
  fileHeader.writeUInt32LE(0, 8);   // flags
  fileHeader.writeUInt32LE(3, 12);  // section_count: pool + static + dynamic

  return Buffer.concat([
    fileHeader,
    poolBuf,
    staticTierBuf,
    dynamicIndexBuf,
    dynamicTierBuf,
  ]);
}

module.exports = {
  emitComponentSection,
  assembleBinary,
  fnv1a32,
  RecordType,
  STATIC_MAGIC,
  DYNAMIC_MAGIC,
  FILE_MAGIC,
  FILE_VERSION,
};

