export interface RuntimeLike {
  attr: string;
  selectorResolver: (value: string, element?: Element | null) => string;
  invalidateBoundary: (hash: number) => void;
  updateTokens: (tokenMap: Record<string, string>) => void;
}

export interface BoundaryDepEntry {
  depType: number;
  propertyName: string;
  containerHash?: number | null;
}

export interface BoundaryRecordLike {
  type: "BOUNDARY";
  depEntries: BoundaryDepEntry[];
  subgraphHashes: number[];
}

export interface SubscriptionOptions {
  requestAnimationFrame?: (cb: FrameRequestCallback) => number;
  cancelAnimationFrame?: (id: number) => void;
}

export class SubscriptionManager {
  private runtime: RuntimeLike;

  private elementRegistry = new Map<number, Set<HTMLElement>>();
  private containerToBoundaries = new Map<Element, Set<number>>();
  private boundaryToContainers = new Map<number, Set<Element>>();
  private themeBoundaries = new Set<number>();
  private fontMetricBoundaries = new Set<number>();
  private envBoundaries = new Set<number>();
  private userPrefTeardowns = new Map<number, Array<() => void>>();
  private userPrefQueries = new Map<number, Set<string>>();

  private dirtyBoundaries = new Set<number>();
  private pendingFrame = 0;

  private readonly raf: (cb: FrameRequestCallback) => number;
  private readonly caf: (id: number) => void;

  private resizeObserver: ResizeObserver | { observe: (el: Element) => void; unobserve: (el: Element) => void; disconnect: () => void };
  private themeObserver: MutationObserver | null = null;
  private fontMetricsObserver: MutationObserver | null = null;
  private fontMetricsResizeHandler: (() => void) | null = null;
  private rootFontSize = "";
  private envResizeHandler: (() => void) | null = null;
  private envOrientationHandler: (() => void) | null = null;

  constructor(runtime: RuntimeLike, options: SubscriptionOptions = {}) {
    this.runtime = runtime;

    this.raf = options.requestAnimationFrame
      || (typeof requestAnimationFrame === "function"
        ? requestAnimationFrame.bind(globalThis)
        : ((cb: FrameRequestCallback) => setTimeout(() => cb(performance.now()), 16) as unknown as number));

    this.caf = options.cancelAnimationFrame
      || (typeof cancelAnimationFrame === "function"
        ? cancelAnimationFrame.bind(globalThis)
        : ((id: number) => clearTimeout(id as unknown as any)));

    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(this.handleResize.bind(this));
    } else {
      this.resizeObserver = {
        observe() {},
        unobserve() {},
        disconnect() {},
      };
    }
  }

  getElements(hash: number): Set<HTMLElement> | null {
    return this.elementRegistry.get(hash >>> 0) || null;
  }

  registerElement(hash: number, element: HTMLElement): void {
    const h = hash >>> 0;
    if (!this.elementRegistry.has(h)) {
      this.elementRegistry.set(h, new Set());
    }
    this.elementRegistry.get(h)!.add(element);
  }

  mount(hash: number, element: HTMLElement, record: BoundaryRecordLike): void {
    const h = hash >>> 0;
    this.registerElement(h, element);

    for (const dep of record.depEntries || []) {
      if (dep.depType === 0x01) {
        // PARENT_SIZE: observe both parent and boundary element.
        // Parent observation captures explicit parent resizes; self observation
        // captures width/height propagation on percentage-based boundaries.
        this.observeContainer(element.parentElement, h);
        this.observeContainer(element, h);
      } else if (dep.depType === 0x06) {
        this.observeContainer(this.resolveContainer(element, dep), h);
      } else if (dep.depType === 0x02) {
        if (typeof document !== "undefined" && document.documentElement) {
          this.observeContainer(document.documentElement, h);
        }
      } else if (dep.depType === 0x05) {
        this.subscribeTheme(h);
      } else if (dep.depType === 0x03) {
        this.subscribeFontMetrics(h);
      } else if (dep.depType === 0x04) {
        this.subscribeEnv(h);
      } else if (dep.depType === 0x07) {
        this.subscribeUserPreference(h, dep.propertyName || "");
      }
    }
  }

  unmount(hash: number, element: HTMLElement): void {
    const h = hash >>> 0;
    const set = this.elementRegistry.get(h);
    if (set) {
      set.delete(element);
      if (set.size === 0) {
        this.elementRegistry.delete(h);
      }
    }

    if (this.elementRegistry.has(h)) return;

    this.dirtyBoundaries.delete(h);
    this.themeBoundaries.delete(h);
    this.fontMetricBoundaries.delete(h);
    this.envBoundaries.delete(h);

    const containers = this.boundaryToContainers.get(h);
    if (containers) {
      for (const container of containers) {
        const hashes = this.containerToBoundaries.get(container);
        if (!hashes) continue;
        hashes.delete(h);
        if (hashes.size === 0) {
          this.containerToBoundaries.delete(container);
          this.resizeObserver.unobserve(container);
        }
      }
      this.boundaryToContainers.delete(h);
    }

    // USER_PREF listeners are per-boundary and must be removed when boundary unmounts.
    this.teardownUserPreference(h);

    if (this.fontMetricBoundaries.size === 0) {
      this.teardownFontMetrics();
    }
    if (this.envBoundaries.size === 0) {
      this.teardownEnv();
    }
  }

  markDirty(hash: number): void {
    this.dirtyBoundaries.add(hash >>> 0);
    this.scheduleUpdate();
  }

  flush(): void {
    if (this.dirtyBoundaries.size === 0) return;
    const batch = [...this.dirtyBoundaries];
    this.dirtyBoundaries.clear();
    for (const hash of batch) {
      this.runtime.invalidateBoundary(hash);
    }
  }

  updateTheme(tokenMap: Record<string, string>): void {
    this.runtime.updateTokens(tokenMap || {});
    for (const hash of this.themeBoundaries) {
      this.dirtyBoundaries.add(hash);
    }
    this.flush();
  }

  destroy(): void {
    this.resizeObserver.disconnect();
    this.themeObserver?.disconnect();
    this.themeObserver = null;
    this.teardownFontMetrics();
    this.teardownEnv();

    if (this.pendingFrame) {
      this.caf(this.pendingFrame);
      this.pendingFrame = 0;
    }

    this.elementRegistry.clear();
    this.containerToBoundaries.clear();
    this.boundaryToContainers.clear();
    this.themeBoundaries.clear();
    this.fontMetricBoundaries.clear();
    this.envBoundaries.clear();
    for (const hash of this.userPrefTeardowns.keys()) {
      this.teardownUserPreference(hash);
    }
    this.userPrefTeardowns.clear();
    this.userPrefQueries.clear();
    this.dirtyBoundaries.clear();
  }

  private resolveContainer(element: HTMLElement, dep: BoundaryDepEntry): Element | null {
    if (dep.containerHash) {
      let cursor: Element | null = element.parentElement;
      while (cursor) {
        const raw = cursor instanceof HTMLElement ? cursor.getAttribute(this.runtime.attr) : null;
        if (raw) {
          const selector = this.runtime.selectorResolver(raw, cursor);
          if (selector && this.hash(selector) === (dep.containerHash >>> 0)) {
            return cursor;
          }
        }
        cursor = cursor.parentElement;
      }
    }
    return element.parentElement;
  }

  private observeContainer(container: Element | null, hash: number): void {
    if (!container) return;
    const h = hash >>> 0;

    let hashes = this.containerToBoundaries.get(container);
    if (!hashes) {
      hashes = new Set();
      this.containerToBoundaries.set(container, hashes);
      this.resizeObserver.observe(container);
    }
    hashes.add(h);

    if (!this.boundaryToContainers.has(h)) {
      this.boundaryToContainers.set(h, new Set());
    }
    this.boundaryToContainers.get(h)!.add(container);
  }

  private subscribeTheme(hash: number): void {
    this.themeBoundaries.add(hash >>> 0);

    if (this.themeObserver) return;
    if (typeof MutationObserver === "undefined") return;
    if (typeof document === "undefined" || !document.documentElement) return;

    this.themeObserver = new MutationObserver(() => {
      for (const h of this.themeBoundaries) {
        this.dirtyBoundaries.add(h);
      }
      this.scheduleUpdate();
    });

    this.themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "class"],
    });
  }

  private subscribeFontMetrics(hash: number): void {
    this.fontMetricBoundaries.add(hash >>> 0);
    if (typeof document === "undefined" || !document.documentElement) return;

    if (!this.rootFontSize) {
      this.rootFontSize = this.readRootFontSize();
    }

    if (!this.fontMetricsObserver && typeof MutationObserver !== "undefined") {
      this.fontMetricsObserver = new MutationObserver(() => {
        this.maybeMarkFontMetricDirty();
      });
      this.fontMetricsObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["style", "class"],
      });
    }

    if (!this.fontMetricsResizeHandler && typeof window !== "undefined" && typeof window.addEventListener === "function") {
      this.fontMetricsResizeHandler = () => {
        this.maybeMarkFontMetricDirty();
      };
      window.addEventListener("resize", this.fontMetricsResizeHandler, {
        passive: true,
      });
    }
  }

  private subscribeEnv(hash: number): void {
    this.envBoundaries.add(hash >>> 0);

    if (!this.envResizeHandler && typeof window !== "undefined" && typeof window.addEventListener === "function") {
      this.envResizeHandler = () => {
        this.markDirtyAll(this.envBoundaries);
      };
      window.addEventListener("resize", this.envResizeHandler, {
        passive: true,
      });
    }

    const orientation = this.getScreenOrientation();
    if (!this.envOrientationHandler && orientation && typeof orientation.addEventListener === "function") {
      this.envOrientationHandler = () => {
        this.markDirtyAll(this.envBoundaries);
      };
      orientation.addEventListener("change", this.envOrientationHandler);
    }
  }

  private subscribeUserPreference(hash: number, propertyName: string): void {
    const h = hash >>> 0;
    const query = this.normaliseUserPreferenceQuery(propertyName);
    if (!query) return;
    if (typeof window === "undefined" || typeof (window as any).matchMedia !== "function") return;

    if (!this.userPrefQueries.has(h)) {
      this.userPrefQueries.set(h, new Set());
    }
    const seen = this.userPrefQueries.get(h)!;
    if (seen.has(query)) return;
    seen.add(query);

    const mql = (window as any).matchMedia(query);
    const onChange = () => this.markDirty(h);
    let teardown: () => void;
    if (typeof mql.addEventListener === "function") {
      mql.addEventListener("change", onChange);
      teardown = () => {
        mql.removeEventListener("change", onChange);
      };
    } else if (typeof mql.addListener === "function") {
      mql.addListener(onChange);
      teardown = () => {
        mql.removeListener(onChange);
      };
    } else {
      teardown = () => {};
    }

    if (!this.userPrefTeardowns.has(h)) {
      this.userPrefTeardowns.set(h, []);
    }
    this.userPrefTeardowns.get(h)!.push(teardown);
  }

  private handleResize(entries: ResizeObserverEntry[]): void {
    for (const entry of entries || []) {
      const hashes = this.containerToBoundaries.get(entry.target);
      this.markDirtyAll(hashes);
    }
  }

  private scheduleUpdate(): void {
    if (this.pendingFrame) return;
    this.pendingFrame = this.raf(() => {
      this.pendingFrame = 0;
      this.flush();
    });
  }

  private hash(selector: string): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < selector.length; i += 1) {
      h ^= selector.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
  }

  private markDirtyAll(hashes: Iterable<number> | null | undefined): void {
    if (!hashes) return;
    for (const hash of hashes) {
      this.dirtyBoundaries.add(hash >>> 0);
    }
    this.scheduleUpdate();
  }

  private readRootFontSize(): string {
    if (typeof document === "undefined" || !document.documentElement) return "";
    if (typeof getComputedStyle !== "function") return "";
    return String(getComputedStyle(document.documentElement).fontSize || "");
  }

  private maybeMarkFontMetricDirty(): void {
    const current = this.readRootFontSize();
    if (current && current !== this.rootFontSize) {
      this.rootFontSize = current;
      this.markDirtyAll(this.fontMetricBoundaries);
    }
  }

  private teardownFontMetrics(): void {
    this.fontMetricsObserver?.disconnect();
    this.fontMetricsObserver = null;
    if (this.fontMetricsResizeHandler && typeof window !== "undefined" && typeof window.removeEventListener === "function") {
      window.removeEventListener("resize", this.fontMetricsResizeHandler);
    }
    this.fontMetricsResizeHandler = null;
    this.rootFontSize = "";
  }

  private teardownEnv(): void {
    if (this.envResizeHandler && typeof window !== "undefined" && typeof window.removeEventListener === "function") {
      window.removeEventListener("resize", this.envResizeHandler);
    }
    this.envResizeHandler = null;

    const orientation = this.getScreenOrientation();
    if (this.envOrientationHandler && orientation && typeof orientation.removeEventListener === "function") {
      orientation.removeEventListener("change", this.envOrientationHandler);
    }
    this.envOrientationHandler = null;
  }

  private teardownUserPreference(hash: number): void {
    const h = hash >>> 0;
    const teardowns = this.userPrefTeardowns.get(h) || [];
    for (const teardown of teardowns) {
      teardown();
    }
    this.userPrefTeardowns.delete(h);
    this.userPrefQueries.delete(h);
  }

  private normaliseUserPreferenceQuery(propertyName: string): string | null {
    const raw = String(propertyName || "").trim();
    if (!raw) return null;
    if (raw.startsWith("(")) return raw;
    if (/^(prefers-[a-z-]+|forced-colors|inverted-colors)\b/i.test(raw)) {
      return `(${raw})`;
    }
    if (/:\s*/.test(raw)) {
      return `(${raw})`;
    }
    return null;
  }

  private getScreenOrientation():
    | { addEventListener?: (type: string, cb: () => void) => void; removeEventListener?: (type: string, cb: () => void) => void }
    | null {
    if (typeof screen === "undefined") return null;
    const orientation = (screen as any).orientation;
    return orientation || null;
  }
}
