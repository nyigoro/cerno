import { SOMLoaderBrowser } from "./browserLoader.js";
import { SubscriptionManager } from "./subscriptionManager.js";

export type RuntimeSelectorResolver = (value: string, element?: Element | null) => string;

export interface RuntimeRecordStatic {
  type: "STATIC" | "RULE_SET";
  hash: number;
  selector: string;
  properties: Map<string, string>;
}

export interface RuntimeRecordBoundary {
  type: "BOUNDARY";
  hash: number;
  selector: string;
  depEntries: Array<{ depType: number; propertyName: string; containerHash?: number | null }>;
  subgraphHashes: number[];
  properties?: Map<string, string>;
}

export interface RuntimeRecordNondeterministic {
  type: "NONDETERMINISTIC";
  hash: number;
  selector: string;
}

export type RuntimeRecord = RuntimeRecordStatic | RuntimeRecordBoundary | RuntimeRecordNondeterministic;

export interface RuntimeLoader {
  get(selectorOrHash: string | number): RuntimeRecord | null;
}

export interface SOMRuntimeOptions {
  attr?: string;
  fallbackUrl?: string;
  selectorResolver?: RuntimeSelectorResolver;
  dev?: boolean;
  onWarn?: (msg: string) => void;
  onInvalidate?: (hash: number, record: RuntimeRecordBoundary) => void;
  observeMutations?: boolean;
  requestAnimationFrame?: (cb: FrameRequestCallback) => number;
  cancelAnimationFrame?: (id: number) => void;
}

export class SOMRuntime {
  readonly loader: RuntimeLoader;
  readonly attr: string;
  readonly fallbackUrl: string;
  readonly selectorResolver: RuntimeSelectorResolver;
  readonly dev: boolean;

  private onWarn: (msg: string) => void;
  private fallbackLoadedFlag = false;
  private fallbackPromise: Promise<void> | null = null;
  private mountedHashByElement = new WeakMap<HTMLElement, number>();
  private tokenCache: Record<string, string> = Object.create(null);
  private domObserver: MutationObserver | null = null;
  private observeMutations: boolean;
  private onInvalidate: ((hash: number, record: RuntimeRecordBoundary) => void) | null;

  readonly subscriptionManager: SubscriptionManager;

  constructor(loader: RuntimeLoader, options: SOMRuntimeOptions = {}) {
    if (!loader || typeof loader.get !== "function") {
      throw new TypeError("SOMRuntime: loader with get() is required");
    }

    this.loader = loader;
    this.attr = options.attr || "data-som";
    this.fallbackUrl = options.fallbackUrl || "fallback.css";
    this.selectorResolver = options.selectorResolver || ((value: string) => {
      const v = String(value || "").trim();
      if (!v) return "";
      if (v.startsWith(".") || v.startsWith("#") || v.startsWith("[")) return v;
      return `.${v}`;
    });
    this.dev = !!options.dev;
    this.onWarn = options.onWarn || ((msg: string) => {
      if (this.dev && typeof console !== "undefined") {
        console.warn(msg);
      }
    });
    this.onInvalidate = typeof options.onInvalidate === "function"
      ? options.onInvalidate
      : null;
    this.observeMutations = !!options.observeMutations;

    this.subscriptionManager = new SubscriptionManager(this, {
      requestAnimationFrame: options.requestAnimationFrame,
      cancelAnimationFrame: options.cancelAnimationFrame,
    });
  }

  static async fromUrl(url: string, options: SOMRuntimeOptions = {}): Promise<SOMRuntime> {
    const loader = await SOMLoaderBrowser.load(url);
    return new SOMRuntime(loader, options);
  }

  get fallbackLoaded(): boolean {
    return this.fallbackLoadedFlag;
  }

  async preloadFallback(): Promise<void> {
    if (this.fallbackLoadedFlag) return;
    if (this.fallbackPromise) return this.fallbackPromise;

    if (typeof document === "undefined") {
      throw new Error("SOMRuntime.preloadFallback: document is unavailable");
    }

    this.fallbackPromise = new Promise<void>((resolve, reject) => {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = this.fallbackUrl;
      link.onload = () => {
        this.fallbackLoadedFlag = true;
        resolve();
      };
      link.onerror = () => {
        reject(new Error(`SOMRuntime: failed to load fallback stylesheet ${this.fallbackUrl}`));
      };
      document.head.appendChild(link);
    });

    return this.fallbackPromise;
  }

  updateTokens(newTokenMap: Record<string, string> = {}): void {
    Object.assign(this.tokenCache, newTokenMap);
  }

  invalidateBoundary(hash: number): void {
    const h = hash >>> 0;
    const boundary = this.loader.get(h);
    if (!boundary || boundary.type !== "BOUNDARY") return;

    const boundaryElements = this.subscriptionManager.getElements(h);
    const boundaryProps = this.resolveProperties(boundary);
    if (boundaryElements && boundaryProps) {
      this.applyPropertiesToSet(boundaryElements, boundaryProps);
    }

    for (const memberHash of boundary.subgraphHashes || []) {
      const memberElements = this.subscriptionManager.getElements(memberHash >>> 0);
      if (!memberElements || memberElements.size === 0) continue;

      const member = this.loader.get(memberHash >>> 0);
      if (!member) continue;

      if (member.type === "NONDETERMINISTIC") {
        if (!this.fallbackLoadedFlag) {
          this.preloadFallback().catch((err) => this.onWarn(err.message));
        }
        continue;
      }

      const resolved = this.resolveProperties(member);
      if (resolved) {
        this.applyPropertiesToSet(memberElements, resolved);
      }
    }

    if (this.onInvalidate) {
      this.onInvalidate(h, boundary);
    }
  }

  async applyStyles(selector: string, element: HTMLElement): Promise<void> {
    const record = this.loader.get(selector);
    if (!record) {
      this.onWarn(`[binary-som runtime] hash miss for "${selector}"`);
      return;
    }

    this.mountedHashByElement.set(element, record.hash >>> 0);
    this.subscriptionManager.registerElement(record.hash >>> 0, element);

    if (record.type === "STATIC" || record.type === "RULE_SET") {
      this.applyProperties(element, record.properties);
      return;
    }

    if (record.type === "BOUNDARY") {
      this.subscriptionManager.mount(record.hash >>> 0, element, record);
      this.invalidateBoundary(record.hash >>> 0);
      return;
    }

    if (!this.fallbackLoadedFlag) {
      await this.preloadFallback();
    }
  }

  async applyElement(element: HTMLElement): Promise<void> {
    if (!element || typeof element.getAttribute !== "function") return;
    const raw = element.getAttribute(this.attr);
    if (!raw) return;
    const selector = this.selectorResolver(raw, element);
    if (!selector) return;
    await this.applyStyles(selector, element);
  }

  async applyAll(root: ParentNode | Document = (typeof document !== "undefined" ? document : (null as any))): Promise<void> {
    if (!root || typeof (root as any).querySelectorAll !== "function") return;

    const elements = (root as any).querySelectorAll(`[${this.attr}]`) as Iterable<HTMLElement>;
    for (const element of elements) {
      await this.applyElement(element);
    }

    this.startMutationObserver(root as any);
  }

  unmountElement(element: HTMLElement): void {
    const hash = this.mountedHashByElement.get(element);
    if (hash === undefined) return;
    this.subscriptionManager.unmount(hash, element);
    this.mountedHashByElement.delete(element);
  }

  destroy(): void {
    if (this.domObserver) {
      this.domObserver.disconnect();
      this.domObserver = null;
    }
    this.subscriptionManager.destroy();
    this.mountedHashByElement = new WeakMap();
  }

  private resolveProperties(record: RuntimeRecordBoundary | RuntimeRecordStatic): Map<string, string> | null {
    if (record && (record as any).properties && typeof (record as any).properties[Symbol.iterator] === "function") {
      return (record as any).properties;
    }
    return null;
  }

  private applyProperties(element: HTMLElement, properties: Map<string, string>): void {
    for (const [name, value] of properties) {
      element.style.setProperty(name, value);
    }
  }

  private applyPropertiesToSet(elements: Set<HTMLElement>, properties: Map<string, string>): void {
    for (const element of elements) {
      this.applyProperties(element, properties);
    }
  }

  private startMutationObserver(root: ParentNode | Document): void {
    if (!this.observeMutations) return;
    if (this.domObserver) return;
    if (typeof MutationObserver === "undefined") return;

    const observerRoot = (root as any).nodeType === 1
      ? (root as Element)
      : (typeof document !== "undefined" ? document.documentElement : null);
    if (!observerRoot) return;

    this.domObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        const removed = mutation.removedNodes || [];
        for (let i = 0; i < removed.length; i += 1) {
          this.unmountTree(removed[i] as any);
        }
      }
    });

    this.domObserver.observe(observerRoot, { childList: true, subtree: true });
  }

  private unmountTree(node: any): void {
    if (!node || node.nodeType !== 1) return;
    this.unmountElement(node as HTMLElement);

    if (typeof node.querySelectorAll === "function") {
      const children = node.querySelectorAll(`[${this.attr}]`) as Iterable<HTMLElement>;
      for (const child of children) {
        this.unmountElement(child);
      }
    }
  }
}
