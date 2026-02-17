/**
 * Binary SOM — Browser Loader (Loader-Only)
 * COMP-SPEC-001 v0.2  §12
 */

const _imul = typeof Math.imul === "function"
  ? Math.imul
  : ((a: number, b: number) => {
      const ah = (a >>> 16) & 0xffff;
      const al = a & 0xffff;
      const bh = (b >>> 16) & 0xffff;
      const bl = b & 0xffff;
      return ((al * bl) + (((ah * bl + al * bh) << 16) >>> 0) | 0);
    });

export function fnv1a32(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    h = _imul(h ^ str.charCodeAt(i), 0x01000193) >>> 0;
  }
  return h >>> 0;
}

const NULL_REF = 0xFFFFFF;
const FILE_MAGIC = 0x4d4f5342; // BSOM
const POOL_MAGIC = 0x504d4f53; // SOMP
const STATIC_MAGIC = 0x534d4f53; // SOMS
const DYNAMIC_MAGIC = 0x444d4f53; // SOMD
const FILE_VERSION = 0x01;
const POOL_VERSION = 0x01;
const RT_BOUNDARY = 0x01;
const RT_RULE_SET = 0x02;
const RT_NONDETERMINISTIC = 0x03;

const dec = typeof TextDecoder !== "undefined" ? new TextDecoder() : null;

function utf8(buf: ArrayBuffer, start: number, end: number): string {
  if (dec) return dec.decode(buf.slice(start, end));

  let s = "";
  const b = new Uint8Array(buf, start, end - start);
  for (let i = 0; i < b.length;) {
    const c = b[i];
    if (c < 0x80) {
      s += String.fromCodePoint(c);
      i += 1;
    } else if (c < 0xe0) {
      s += String.fromCodePoint(((c & 0x1f) << 6) | (b[i + 1] & 0x3f));
      i += 2;
    } else if (c < 0xf0) {
      s += String.fromCodePoint(
        ((c & 0x0f) << 12) |
        ((b[i + 1] & 0x3f) << 6) |
        (b[i + 2] & 0x3f)
      );
      i += 3;
    } else {
      s += String.fromCodePoint(
        ((c & 0x07) << 18) |
        ((b[i + 1] & 0x3f) << 12) |
        ((b[i + 2] & 0x3f) << 6) |
        (b[i + 3] & 0x3f)
      );
      i += 4;
    }
  }
  return s;
}

function u24(view: DataView, offset: number): number {
  return (
    view.getUint8(offset) |
    (view.getUint8(offset + 1) << 8) |
    (view.getUint8(offset + 2) << 16)
  );
}

export class SOMLoaderBrowser {
  private readonly buf: ArrayBuffer;
  private readonly view: DataView;
  private pool: string[] = [];
  private readonly staticMap = new Map<number, any>();
  private readonly dynamicIndex = new Map<number, number>();
  private readonly dynamicCache = new Map<number, any>();
  private dynamicTierStart = 0;
  private _stats: {
    fileSizeBytes: number;
    poolEntries: number;
    staticComponents: number;
    indexedDynamic: number;
  } = {
    fileSizeBytes: 0,
    poolEntries: 0,
    staticComponents: 0,
    indexedDynamic: 0,
  };

  constructor(buffer: ArrayBuffer) {
    if (!(buffer instanceof ArrayBuffer)) {
      throw new TypeError("SOMLoaderBrowser: expected ArrayBuffer");
    }
    this.buf = buffer;
    this.view = new DataView(buffer);
    this.parse();
  }

  static async load(url: string): Promise<SOMLoaderBrowser> {
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`SOMLoaderBrowser.load: HTTP ${res.status} for ${url}`);
    }
    const buffer = await res.arrayBuffer();
    return new SOMLoaderBrowser(buffer);
  }

  get(selectorOrHash: string | number): any | null {
    const hash = typeof selectorOrHash === "number"
      ? (selectorOrHash >>> 0)
      : fnv1a32(selectorOrHash);

    return this.staticMap.get(hash)
      ?? this.getDynamic(hash)
      ?? null;
  }

  get poolSize(): number {
    return this.pool.length;
  }

  get stats() {
    return this._stats;
  }

  private parse(): void {
    const len = this.buf.byteLength;
    if (len < 16) throw new Error("SOMLoaderBrowser: buffer too short");

    if (this.view.getUint32(0, true) !== FILE_MAGIC) {
      throw new Error("SOMLoaderBrowser: invalid magic");
    }
    if (this.view.getUint8(4) !== FILE_VERSION) {
      throw new Error(`SOMLoaderBrowser: unsupported version ${this.view.getUint8(4)}`);
    }
    if (this.view.getUint32(12, true) !== 3) {
      throw new Error(`SOMLoaderBrowser: unexpected section count ${this.view.getUint32(12, true)}`);
    }

    let pos = 16;
    pos = this.parsePool(pos);
    pos = this.parseStatic(pos);
    pos = this.parseDynamicIndex(pos);

    this.dynamicTierStart = pos;
    this._stats = {
      fileSizeBytes: len,
      poolEntries: this.pool.length,
      staticComponents: this.staticMap.size,
      indexedDynamic: this.dynamicIndex.size,
    };
  }

  private parsePool(pos: number): number {
    if (this.view.getUint32(pos, true) !== POOL_MAGIC) {
      throw new Error(`SOMLoaderBrowser: expected SOMP at offset ${pos}`);
    }
    if (this.view.getUint8(pos + 4) !== POOL_VERSION) {
      throw new Error(`SOMLoaderBrowser: unsupported pool version ${this.view.getUint8(pos + 4)}`);
    }

    const count = this.view.getUint32(pos + 8, true);
    const dataSize = this.view.getUint32(pos + 12, true);

    this.pool = new Array(count);
    let p = pos + 16;
    for (let i = 0; i < count; i += 1) {
      const idx = u24(this.view, p);
      const byteLen = this.view.getUint16(p + 3, true);
      p += 5;
      this.pool[idx] = utf8(this.buf, p, p + byteLen);
      p += byteLen;
    }

    return pos + 16 + dataSize;
  }

  private parseStatic(pos: number): number {
    if (this.view.getUint32(pos, true) !== STATIC_MAGIC) {
      throw new Error(`SOMLoaderBrowser: expected SOMS at offset ${pos}`);
    }

    const count = this.view.getUint32(pos + 4, true);
    const sectionSize = this.view.getUint32(pos + 8, true);
    let p = pos + 12;

    for (let i = 0; i < count; i += 1) {
      const hash = this.view.getUint32(p, true);
      const selectorRef = u24(this.view, p + 4);
      const propCount = this.view.getUint8(p + 7);
      p += 8;

      const selector = this.resolve(selectorRef);
      const properties = new Map<string, string>();

      for (let j = 0; j < propCount; j += 1) {
        const nameRef = u24(this.view, p);
        const valueRef = u24(this.view, p + 3);
        p += 6;
        const name = this.resolve(nameRef);
        if (name !== null) {
          properties.set(name, this.resolve(valueRef) ?? "");
        }
      }

      this.staticMap.set(hash, { type: "STATIC", hash, selector, properties });
    }

    return pos + 12 + sectionSize;
  }

  private parseDynamicIndex(pos: number): number {
    if (this.view.getUint32(pos, true) !== DYNAMIC_MAGIC) {
      throw new Error(`SOMLoaderBrowser: expected SOMD at offset ${pos}`);
    }

    const count = this.view.getUint32(pos + 4, true);
    const idxSize = this.view.getUint32(pos + 8, true);
    let p = pos + 12;

    for (let i = 0; i < count; i += 1) {
      const hash = this.view.getUint32(p, true);
      const offset = this.view.getUint32(p + 7, true);
      this.dynamicIndex.set(hash, offset);
      p += 11;
    }

    return pos + 12 + idxSize;
  }

  private getDynamic(hash: number): any | null {
    if (this.dynamicCache.has(hash)) return this.dynamicCache.get(hash);
    const offset = this.dynamicIndex.get(hash);
    if (offset === undefined) return null;
    const record = this.parseDynamicRecord(this.dynamicTierStart + offset);
    this.dynamicCache.set(hash, record);
    return record;
  }

  private parseDynamicRecord(pos: number): any {
    const recType = this.view.getUint8(pos);
    const hash = this.view.getUint32(pos + 1, true);
    const selectorRef = u24(this.view, pos + 5);
    const selector = this.resolve(selectorRef) ?? `<0x${hash.toString(16)}>`;

    if (recType === RT_BOUNDARY) {
      const depCount = this.view.getUint8(pos + 8);
      const flags = this.view.getUint8(pos + 9);
      const subgraphCount = this.view.getUint16(pos + 10, true);
      let p = pos + 12;

      const depEntries: Array<{ depType: number; propertyName: string; containerHash: number | null }> = [];
      for (let i = 0; i < depCount; i += 1) {
        const depType = this.view.getUint8(p);
        const propRef = u24(this.view, p + 1);
        const containerHash = this.view.getUint32(p + 4, true);
        p += 8;
        depEntries.push({
          depType,
          propertyName: this.resolve(propRef) ?? "",
          containerHash: containerHash || null,
        });
      }

      const subgraphHashes = Array.from({ length: subgraphCount }, (_, i) =>
        this.view.getUint32(p + i * 4, true)
      );

      return {
        type: "BOUNDARY",
        hash,
        selector,
        depEntries,
        flags,
        hasPortalDep: (flags & 0x01) !== 0,
        hasThemeDep: (flags & 0x02) !== 0,
        subgraphHashes,
      };
    }

    if (recType === RT_RULE_SET) {
      const propCount = this.view.getUint8(pos + 8);
      const boundaryHash = this.view.getUint32(pos + 9, true);
      let p = pos + 13;
      const properties = new Map<string, string>();

      for (let i = 0; i < propCount; i += 1) {
        const nameRef = u24(this.view, p);
        const valueRef = u24(this.view, p + 3);
        p += 6;
        const name = this.resolve(nameRef);
        if (name !== null) {
          properties.set(name, this.resolve(valueRef) ?? "");
        }
      }

      return { type: "RULE_SET", hash, selector, properties, boundaryHash };
    }

    if (recType === RT_NONDETERMINISTIC) {
      return { type: "NONDETERMINISTIC", hash, selector, flags: this.view.getUint8(pos + 8) };
    }

    throw new Error(`SOMLoaderBrowser: unknown record type 0x${recType.toString(16)} at offset ${pos}`);
  }

  private resolve(idx: number): string | null {
    if (idx === NULL_REF) return null;
    return this.pool[idx] ?? null;
  }
}

// Back-compat alias
export const SOMLoader = SOMLoaderBrowser;