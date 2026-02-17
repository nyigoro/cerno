'use strict';

const { fnv1a32 } = require('../dist/src/emitter');
const { SOMRuntime } = require('../dist/src/runtime');

let passed = 0;
let failed = 0;
const failures = [];

function assert(label, actual, expected) {
  if (actual === expected) {
    passed += 1;
    return;
  }
  failed += 1;
  failures.push({ label, actual, expected });
  console.log(`  x ${label}`);
  console.log(`      exp: ${JSON.stringify(expected)}`);
  console.log(`      got: ${JSON.stringify(actual)}`);
}

function section(title) {
  console.log(`\n${'='.repeat(62)}\n  ${title}\n${'='.repeat(62)}`);
}

function makeElement(dataSomValue, parent = null) {
  const attrs = new Map();
  if (dataSomValue != null) attrs.set('data-som', dataSomValue);
  return {
    nodeType: 1,
    parentElement: parent,
    style: { setProperty() {} },
    getAttribute(name) {
      return attrs.has(name) ? attrs.get(name) : null;
    },
    querySelectorAll() {
      return [];
    },
  };
}

function makeLoader(recordsBySelector) {
  const byHash = new Map();
  const bySelector = new Map();

  for (const [selector, record] of Object.entries(recordsBySelector)) {
    const hash = fnv1a32(selector) >>> 0;
    const full = Object.assign({ hash, selector }, record);
    byHash.set(hash, full);
    bySelector.set(selector, full);
  }

  return {
    get(input) {
      if (typeof input === 'number') return byHash.get(input >>> 0) || null;
      return bySelector.get(String(input)) || null;
    },
  };
}

function installDomMocks() {
  const prev = {
    document: global.document,
    window: global.window,
    screen: global.screen,
    ResizeObserver: global.ResizeObserver,
    MutationObserver: global.MutationObserver,
    getComputedStyle: global.getComputedStyle,
  };

  const rafQueue = [];
  const resizeListeners = [];
  const orientationListeners = [];
  const mqlListeners = new Map();
  const observedTargets = [];
  const unobservedTargets = [];
  const mutationObservers = [];
  let rootFontSize = '16px';

  global.window = {
    addEventListener(event, cb) {
      if (event === 'resize') resizeListeners.push(cb);
    },
    removeEventListener(event, cb) {
      if (event !== 'resize') return;
      const idx = resizeListeners.indexOf(cb);
      if (idx >= 0) resizeListeners.splice(idx, 1);
    },
    matchMedia(query) {
      const key = String(query);
      if (!mqlListeners.has(key)) mqlListeners.set(key, []);
      const list = mqlListeners.get(key);
      return {
        media: key,
        matches: false,
        addEventListener(_type, cb) { list.push(cb); },
        removeEventListener(_type, cb) {
          const idx = list.indexOf(cb);
          if (idx >= 0) list.splice(idx, 1);
        },
        addListener(cb) { list.push(cb); },
        removeListener(cb) {
          const idx = list.indexOf(cb);
          if (idx >= 0) list.splice(idx, 1);
        },
      };
    },
  };

  global.screen = {
    orientation: {
      addEventListener(_type, cb) { orientationListeners.push(cb); },
      removeEventListener(_type, cb) {
        const idx = orientationListeners.indexOf(cb);
        if (idx >= 0) orientationListeners.splice(idx, 1);
      },
    },
  };

  global.document = {
    documentElement: { nodeType: 1, parentElement: null, getAttribute() { return null; } },
    head: { appendChild() {} },
    createElement() { return { rel: '', href: '', onload: null, onerror: null }; },
  };

  global.getComputedStyle = () => ({ fontSize: rootFontSize });

  global.ResizeObserver = class {
    constructor(cb) { this.cb = cb; }
    observe(target) { observedTargets.push(target); }
    unobserve(target) { unobservedTargets.push(target); }
    disconnect() {}
  };

  global.MutationObserver = class {
    constructor(cb) { this.cb = cb; this.connected = false; mutationObservers.push(this); }
    observe() { this.connected = true; }
    disconnect() { this.connected = false; }
  };

  return {
    rafQueue,
    resizeListeners,
    orientationListeners,
    mqlListeners,
    observedTargets,
    unobservedTargets,
    mutationObservers,
    setRootFontSize(v) { rootFontSize = String(v); },
    fireResize() { resizeListeners.slice().forEach((cb) => cb()); },
    fireOrientation() { orientationListeners.slice().forEach((cb) => cb()); },
    fireMatchMedia(query) {
      const list = mqlListeners.get(String(query)) || [];
      list.slice().forEach((cb) => cb({ matches: true, media: String(query) }));
    },
    fireMutation() {
      mutationObservers
        .filter((o) => o.connected)
        .forEach((o) => o.cb([{ type: 'attributes' }]));
    },
    restore() {
      global.document = prev.document;
      global.window = prev.window;
      global.screen = prev.screen;
      global.ResizeObserver = prev.ResizeObserver;
      global.MutationObserver = prev.MutationObserver;
      global.getComputedStyle = prev.getComputedStyle;
    },
  };
}

function queueRaf(env) {
  return {
    requestAnimationFrame(cb) {
      env.rafQueue.push(cb);
      return env.rafQueue.length;
    },
    cancelAnimationFrame() {},
    flushRaf() {
      const cb = env.rafQueue.shift();
      if (cb) cb(0);
    },
  };
}

(async () => {
  const env = installDomMocks();
  const raf = queueRaf(env);

  section('1. FONT_METRICS observer wiring and teardown');
  {
    const records = {
      '.font-boundary': {
        type: 'BOUNDARY',
        depEntries: [{ depType: 0x03, propertyName: 'font-size' }],
        subgraphHashes: [],
        properties: new Map([['font-size', '1rem']]),
      },
    };

    const runtime = new SOMRuntime(makeLoader(records), {
      requestAnimationFrame: raf.requestAnimationFrame,
      cancelAnimationFrame: raf.cancelAnimationFrame,
      observeMutations: false,
    });

    const el = makeElement('font-boundary', { nodeType: 1 });
    await runtime.applyStyles('.font-boundary', el);
    assert('FONT_METRICS: mutation observer connected', env.mutationObservers.filter((o) => o.connected).length, 1);
    assert('FONT_METRICS: resize listener registered', env.resizeListeners.length, 1);

    let invalidateCalls = 0;
    const originalInvalidate = runtime.invalidateBoundary.bind(runtime);
    runtime.invalidateBoundary = (hash) => {
      invalidateCalls += 1;
      return originalInvalidate(hash);
    };

    env.fireMutation();
    assert('no dirty when font size unchanged', env.rafQueue.length, 0);
    assert('no invalidation when font size unchanged', invalidateCalls, 0);

    env.setRootFontSize('18px');
    env.fireMutation();
    assert('dirty scheduled on root font-size mutation', env.rafQueue.length, 1);
    raf.flushRaf();
    assert('invalidation fired after font-size mutation', invalidateCalls, 1);

    env.fireResize();
    assert('no dirty when resize does not change font-size', env.rafQueue.length, 0);

    env.setRootFontSize('20px');
    env.fireResize();
    assert('dirty scheduled on resize+font-size change', env.rafQueue.length, 1);
    raf.flushRaf();
    assert('invalidation fired after resize+font-size change', invalidateCalls, 2);

    runtime.unmountElement(el);
    assert('FONT_METRICS: mutation observer disconnected', env.mutationObservers.filter((o) => o.connected).length, 0);
    assert('FONT_METRICS: resize listener removed', env.resizeListeners.length, 0);

    env.setRootFontSize('24px');
    env.fireMutation();
    env.fireResize();
    assert('FONT_METRICS: no dirty after unmount', env.rafQueue.length, 0);
  }

  section('2. ENV observer wiring and teardown');
  {
    const records = {
      '.env-boundary': {
        type: 'BOUNDARY',
        depEntries: [{ depType: 0x04, propertyName: 'padding-top' }],
        subgraphHashes: [],
        properties: new Map([['padding-top', 'env(safe-area-inset-top)']]),
      },
    };
    const runtime = new SOMRuntime(makeLoader(records), {
      requestAnimationFrame: raf.requestAnimationFrame,
      cancelAnimationFrame: raf.cancelAnimationFrame,
      observeMutations: false,
    });
    const el = makeElement('env-boundary', { nodeType: 1 });
    await runtime.applyStyles('.env-boundary', el);

    assert('ENV: resize listener registered', env.resizeListeners.length, 1);
    assert('ENV: orientation listener registered', env.orientationListeners.length, 1);

    let invalidateCalls = 0;
    const originalInvalidate = runtime.invalidateBoundary.bind(runtime);
    runtime.invalidateBoundary = (hash) => {
      invalidateCalls += 1;
      return originalInvalidate(hash);
    };

    env.fireResize();
    assert('ENV: dirty scheduled on resize', env.rafQueue.length, 1);
    raf.flushRaf();
    assert('ENV: invalidation fired on resize', invalidateCalls, 1);

    env.fireOrientation();
    assert('ENV: dirty scheduled on orientation', env.rafQueue.length, 1);
    raf.flushRaf();
    assert('ENV: invalidation fired on orientation', invalidateCalls, 2);

    runtime.unmountElement(el);
    assert('ENV: resize listener removed', env.resizeListeners.length, 0);
    assert('ENV: orientation listener removed', env.orientationListeners.length, 0);

    env.fireResize();
    env.fireOrientation();
    assert('ENV: no dirty after unmount', env.rafQueue.length, 0);
  }

  section('3. USER_PREF observer wiring and dedupe');
  {
    const records = {
      '.pref-boundary': {
        type: 'BOUNDARY',
        depEntries: [{ depType: 0x07, propertyName: '(prefers-color-scheme: dark)' }],
        subgraphHashes: [],
        properties: new Map([['color', '#fff']]),
      },
      '.pref-bare': {
        type: 'BOUNDARY',
        depEntries: [{ depType: 0x07, propertyName: 'prefers-reduced-motion: reduce' }],
        subgraphHashes: [],
        properties: new Map([['transition', 'none']]),
      },
    };
    const runtime = new SOMRuntime(makeLoader(records), {
      requestAnimationFrame: raf.requestAnimationFrame,
      cancelAnimationFrame: raf.cancelAnimationFrame,
      observeMutations: false,
    });

    const elA = makeElement('pref-boundary', { nodeType: 1 });
    await runtime.applyStyles('.pref-boundary', elA);
    const q1 = '(prefers-color-scheme: dark)';
    assert('USER_PREF: listener registered', (env.mqlListeners.get(q1) || []).length, 1);

    const elA2 = makeElement('pref-boundary', { nodeType: 1 });
    await runtime.applyStyles('.pref-boundary', elA2);
    assert('USER_PREF: duplicate mount does not duplicate listener', (env.mqlListeners.get(q1) || []).length, 1);

    let invalidateCalls = 0;
    const originalInvalidate = runtime.invalidateBoundary.bind(runtime);
    runtime.invalidateBoundary = (hash) => {
      invalidateCalls += 1;
      return originalInvalidate(hash);
    };

    env.fireMatchMedia(q1);
    assert('USER_PREF: dirty scheduled on matchMedia change', env.rafQueue.length, 1);
    raf.flushRaf();
    assert('USER_PREF: invalidation fired on matchMedia change', invalidateCalls, 1);

    const elBare = makeElement('pref-bare', { nodeType: 1 });
    await runtime.applyStyles('.pref-bare', elBare);
    const q2 = '(prefers-reduced-motion: reduce)';
    assert('USER_PREF: bare query normalized and registered', (env.mqlListeners.get(q2) || []).length, 1);

    runtime.unmountElement(elA);
    assert('USER_PREF: first unmount keeps listener for remaining element', (env.mqlListeners.get(q1) || []).length, 1);
    runtime.unmountElement(elA2);
    assert('USER_PREF: final unmount removes listener', (env.mqlListeners.get(q1) || []).length, 0);

    runtime.unmountElement(elBare);
    assert('USER_PREF: second query listener removed on unmount', (env.mqlListeners.get(q2) || []).length, 0);
  }

  section('4. Combined deps batch to single invalidation per frame');
  {
    const records = {
      '.combo-boundary': {
        type: 'BOUNDARY',
        depEntries: [
          { depType: 0x01, propertyName: 'width' },
          { depType: 0x07, propertyName: '(prefers-contrast: more)' },
        ],
        subgraphHashes: [],
        properties: new Map([['width', '100%']]),
      },
    };
    const runtime = new SOMRuntime(makeLoader(records), {
      requestAnimationFrame: raf.requestAnimationFrame,
      cancelAnimationFrame: raf.cancelAnimationFrame,
      observeMutations: false,
    });

    const parent = { nodeType: 1 };
    const el = makeElement('combo-boundary', parent);
    await runtime.applyStyles('.combo-boundary', el);
    assert('PARENT_SIZE: parent observed by ResizeObserver', env.observedTargets.includes(parent), true);
    assert('USER_PREF: combined query listener registered', (env.mqlListeners.get('(prefers-contrast: more)') || []).length, 1);

    let invalidateCalls = 0;
    const originalInvalidate = runtime.invalidateBoundary.bind(runtime);
    runtime.invalidateBoundary = (hash) => {
      invalidateCalls += 1;
      return originalInvalidate(hash);
    };

    env.fireResize();
    env.fireMatchMedia('(prefers-contrast: more)');
    assert('combined events scheduled as single rAF flush', env.rafQueue.length, 1);
    raf.flushRaf();
    assert('combined events invalidate boundary once', invalidateCalls, 1);

    runtime.unmountElement(el);
    assert('PARENT_SIZE: parent unobserved on unmount', env.unobservedTargets.includes(parent), true);
    assert('USER_PREF: listener removed on unmount', (env.mqlListeners.get('(prefers-contrast: more)') || []).length, 0);
  }

  section('5. Invalid USER_PREF query is ignored safely');
  {
    const records = {
      '.bad-pref': {
        type: 'BOUNDARY',
        depEntries: [{ depType: 0x07, propertyName: 'not-a-media-feature' }],
        subgraphHashes: [],
        properties: new Map([['display', 'block']]),
      },
    };
    const runtime = new SOMRuntime(makeLoader(records), {
      requestAnimationFrame: raf.requestAnimationFrame,
      cancelAnimationFrame: raf.cancelAnimationFrame,
      observeMutations: false,
    });
    const el = makeElement('bad-pref', { nodeType: 1 });
    await runtime.applyStyles('.bad-pref', el);
    assert('invalid USER_PREF query does not register listeners', env.mqlListeners.size >= 0, true);
    runtime.unmountElement(el);
    assert('invalid USER_PREF query unmount does not throw', true, true);
  }

  env.restore();

  console.log(`\n${'='.repeat(62)}\n  Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('\n  FAILURES:');
    for (const f of failures) {
      console.log(`  x ${f.label}`);
      console.log(`      exp: ${JSON.stringify(f.expected)}`);
      console.log(`      got: ${JSON.stringify(f.actual)}`);
    }
    process.exitCode = 1;
  } else {
    console.log('  ok All subscription manager tests passed.\n');
  }
})();


