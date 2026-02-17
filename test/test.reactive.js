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
  const styles = new Map();
  return {
    nodeType: 1,
    parentElement: parent,
    style: {
      setProperty(name, value) {
        styles.set(name, value);
      },
    },
    getAttribute(name) {
      return attrs.has(name) ? attrs.get(name) : null;
    },
    querySelectorAll() {
      return [];
    },
    _styles: styles,
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

(async () => {
  const prevDocument = global.document;
  const prevResizeObserver = global.ResizeObserver;
  const prevMutationObserver = global.MutationObserver;

  let resizeCallback = null;
  let observedTargets = [];
  let unobservedTargets = [];
  let appendedLinks = [];

  global.ResizeObserver = class {
    constructor(cb) { resizeCallback = cb; }
    observe(target) { observedTargets.push(target); }
    unobserve(target) { unobservedTargets.push(target); }
    disconnect() {}
  };

  global.MutationObserver = class {
    constructor(cb) { this.cb = cb; }
    observe() {}
    disconnect() {}
  };

  global.document = {
    documentElement: { nodeType: 1 },
    head: {
      appendChild(link) {
        appendedLinks.push(link);
        if (typeof link.onload === 'function') link.onload();
      },
    },
    createElement(tag) {
      return { tagName: String(tag || '').toUpperCase(), rel: '', href: '', onload: null, onerror: null };
    },
  };

  section('1. applyAll eagerly mounts boundaries + registers all elements');
  {
    const records = {
      '.layout': {
        type: 'BOUNDARY',
        depEntries: [{ depType: 0x01, propertyName: 'width' }],
        subgraphHashes: [fnv1a32('.layout .panel') >>> 0],
        properties: new Map([['width', '100%']]),
      },
      '.layout .panel': {
        type: 'RULE_SET',
        boundaryHash: fnv1a32('.layout') >>> 0,
        properties: new Map([['color', 'blue']]),
      },
    };

    const loader = makeLoader(records);
    const rafQueue = [];
    const runtime = new SOMRuntime(loader, {
      requestAnimationFrame: (cb) => { rafQueue.push(cb); return rafQueue.length; },
      cancelAnimationFrame: () => {},
      observeMutations: false,
    });

    const parent = { nodeType: 1 };
    const boundaryEl = makeElement('layout', parent);
    const panelEl = makeElement('layout .panel', boundaryEl);
    const root = {
      querySelectorAll(selector) {
        if (selector === '[data-som]') return [boundaryEl, panelEl];
        return [];
      },
    };

    await runtime.applyAll(root);

    const hBoundary = fnv1a32('.layout') >>> 0;
    const hPanel = fnv1a32('.layout .panel') >>> 0;

    assert('registry has boundary element', runtime.subscriptionManager.getElements(hBoundary).has(boundaryEl), true);
    assert('registry has panel element', runtime.subscriptionManager.getElements(hPanel).has(panelEl), true);
    assert('boundary style applied eagerly', boundaryEl._styles.get('width'), '100%');
    assert('panel style applied', panelEl._styles.get('color'), 'blue');
    assert('parent observed for boundary dep', observedTargets.includes(parent), true);
  }

  section('2. resize invalidation is batched by requestAnimationFrame');
  {
    observedTargets = [];
    unobservedTargets = [];

    const records = {
      '.layout': {
        type: 'BOUNDARY',
        depEntries: [{ depType: 0x01, propertyName: 'width' }],
        subgraphHashes: [],
        properties: new Map([['width', '100%']]),
      },
    };

    const loader = makeLoader(records);
    const rafQueue = [];
    const runtime = new SOMRuntime(loader, {
      requestAnimationFrame: (cb) => { rafQueue.push(cb); return rafQueue.length; },
      cancelAnimationFrame: () => {},
      observeMutations: false,
    });

    const parent = { nodeType: 1 };
    const boundaryEl = makeElement('layout', parent);
    await runtime.applyStyles('.layout', boundaryEl);

    let invalidateCalls = 0;
    const originalInvalidate = runtime.invalidateBoundary.bind(runtime);
    runtime.invalidateBoundary = (hash) => {
      invalidateCalls += 1;
      return originalInvalidate(hash);
    };

    resizeCallback([{ target: parent }, { target: parent }]);
    assert('single rAF scheduled for multiple resize entries', rafQueue.length, 1);

    if (rafQueue[0]) rafQueue.shift()(0);
    assert('flush invalidates once for one dirty boundary', invalidateCalls, 1);
  }

  section('3. unmount cleans observer subscriptions');
  {
    observedTargets = [];
    unobservedTargets = [];

    const records = {
      '.layout': {
        type: 'BOUNDARY',
        depEntries: [{ depType: 0x01, propertyName: 'width' }],
        subgraphHashes: [],
        properties: new Map([['width', '100%']]),
      },
    };

    const runtime = new SOMRuntime(makeLoader(records), {
      requestAnimationFrame: (cb) => { cb(0); return 1; },
      cancelAnimationFrame: () => {},
      observeMutations: false,
    });

    const parent = { nodeType: 1 };
    const boundaryEl = makeElement('layout', parent);
    await runtime.applyStyles('.layout', boundaryEl);
    runtime.unmountElement(boundaryEl);

    assert('container unobserved after last boundary element unmount', unobservedTargets.includes(parent), true);
  }

  section('4. NONDETERMINISTIC triggers fallback load + manual theme update dirties');
  {
    appendedLinks = [];

    const records = {
      '.theme-boundary': {
        type: 'BOUNDARY',
        depEntries: [{ depType: 0x05, propertyName: 'color' }],
        subgraphHashes: [],
        properties: new Map([['color', 'var(--accent)']]),
      },
      '.list:has(.active)': {
        type: 'NONDETERMINISTIC',
      },
    };

    const runtime = new SOMRuntime(makeLoader(records), {
      requestAnimationFrame: (cb) => { cb(0); return 1; },
      cancelAnimationFrame: () => {},
      observeMutations: false,
    });

    const themeEl = makeElement('theme-boundary');
    await runtime.applyStyles('.theme-boundary', themeEl);

    let invalidateCalls = 0;
    const originalInvalidate = runtime.invalidateBoundary.bind(runtime);
    runtime.invalidateBoundary = (hash) => {
      invalidateCalls += 1;
      return originalInvalidate(hash);
    };

    runtime.subscriptionManager.updateTheme({ '--accent': '#ff0000' });
    assert('manual theme update invalidates theme boundary', invalidateCalls, 1);

    const ndEl = makeElement('list:has(.active)');
    await runtime.applyStyles('.list:has(.active)', ndEl);
    assert('fallback loaded on NONDETERMINISTIC', runtime.fallbackLoaded, true);
    assert('fallback stylesheet appended once', appendedLinks.length, 1);
  }

  global.document = prevDocument;
  global.ResizeObserver = prevResizeObserver;
  global.MutationObserver = prevMutationObserver;

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
    console.log('  ok All reactive runtime tests passed.\n');
  }
})();
