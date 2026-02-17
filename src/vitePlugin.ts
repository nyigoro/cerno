// @ts-nocheck
// =============================================================================
// vite-plugin-binary-som
// COMP-SPEC-001 v0.2  §9
//
// PLUGIN LIFECYCLE
// ────────────────
// buildStart      → clear cssModules map (every build, including watch rebuilds)
// transform       → collect + parse CSS per module (dev + prod)
// generateBundle  → global analysis + emit (prod only)
// handleHotUpdate → evict changed file from cache (dev HMR)
//
// DEV MODE:  transform collects, nothing is emitted.
//            Vite handles CSS normally. No .som files in dev.
// PROD MODE: transform collects, generateBundle analyses the full
//            combined stylesheet, emits styles.som + fallback.css +
//            fallback-map.json + binary-som-summary.json.
//
// EMITTED ASSETS
// ──────────────
// styles.som               — binary component database
// fallback.css             — NONDETERMINISTIC selector fallback rules
// fallback-map.json        — NONDETERMINISTIC hash → selector map
// binary-som-summary.json  — build report (for CI diffing and dashboards)
// =============================================================================

'use strict';

const path = require('path');
const { analyseCSS }                           = require('./analyser');
const { emitFallbackCss }                      = require('./fallbackEmitter');
const { buildPoolFromAnalysis }                = require('./constantPool');
const { emitComponentSection, assembleBinary, fnv1a32 } = require('./emitter');

// CSS file extensions handled by this plugin
const CSS_RE = /\.(css|scss|sass|less|styl)(\?.*)?$/;

// ── Plugin factory ─────────────────────────────────────────────────────────
function binarySomPlugin(options = {}) {
  const {
    // Never break builds by default — warn only
    failOnNonDeterministic = false,

    // Output filenames
    somFileName     = 'styles.som',
    fallbackFileName = 'fallback.css',
    fallbackMapFileName = 'fallback-map.json',
    summaryFileName = 'binary-som-summary.json',

    // Include/exclude glob patterns (matched against module id)
    include = null,   // null = all CSS files
    exclude = null,   // null = none excluded

    // Tokens file path (JSON, keys are --token-name or token-name)
    tokensFile = null,

    // Verbose console output
    verbose = false,
  } = options;

  // ── Per-instance state ─────────────────────────────────────────────────
  // Initialised inside the factory, not at module scope.
  // Cleared at buildStart() to prevent stale state across watch-mode rebuilds.
  let cssModules = new Map();   // id → { id, raw, shortName }
  let isProduction = false;
  let globalTokens = {};

  // ── Helpers ────────────────────────────────────────────────────────────
  function shouldProcess(id) {
    if (!CSS_RE.test(id)) return false;
    if (exclude && matchGlob(exclude, id)) return false;
    if (include && !matchGlob(include, id)) return false;
    return true;
  }

  // Minimal glob: supports '*' wildcard and direct substring match
  function matchGlob(pattern, str) {
    if (Array.isArray(pattern)) return pattern.some(p => matchGlob(p, str));
    if (typeof pattern === 'function') return pattern(str);
    if (pattern instanceof RegExp) return pattern.test(str);
    // Simple glob: convert * to regex
    const re = new RegExp(pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*'));
    return re.test(str);
  }

  function shortName(id) {
    // Strip query params and make relative for display
    return id.replace(/\?.*$/, '').replace(process.cwd(), '').replace(/^\//, '');
  }

  function log(...args) {
    if (verbose) console.log('[binary-som]', ...args);
  }

  // ── Plugin object ──────────────────────────────────────────────────────
  return {
    name: 'vite-plugin-binary-som',
    enforce: 'pre',

    // ── Config hook: capture build mode ──────────────────────────────────
    configResolved(config) {
      isProduction = config.command === 'build';
      log(`mode: ${config.mode}, command: ${config.command}`);
    },

    // ── buildStart: clean slate for every build ───────────────────────────
    // This covers: initial build, watch-mode rebuilds, and `vite build`.
    // DO NOT rely on handleHotUpdate alone for cache invalidation.
    buildStart() {
      cssModules = new Map();

      // Load global tokens if specified
      if (tokensFile) {
        try {
          const fs = require('fs');
          const raw = fs.readFileSync(tokensFile, 'utf-8');
          const parsed = JSON.parse(raw);
          globalTokens = {};
          for (const [k, v] of Object.entries(parsed)) {
            const key = k.startsWith('--') ? k : `--${k}`;
            globalTokens[key] = String(v);
          }
          log(`Loaded ${Object.keys(globalTokens).length} tokens from ${tokensFile}`);
        } catch (e) {
          this.warn(`[binary-som] Could not load tokens file: ${tokensFile} — ${e.message}`);
        }
      }
    },

    // ── transform: collect CSS per module ─────────────────────────────────
    // Runs for every CSS module Vite processes, dev and prod.
    // Does NOT run analysis — only collects raw CSS for later.
    // Returns null to let Vite handle the CSS normally (no transform).
    transform(code, id) {
      if (!shouldProcess(id)) return null;

      const cleanId = id.replace(/\?.*$/, '');
      cssModules.set(cleanId, {
        id:        cleanId,
        raw:       code,
        shortName: shortName(cleanId),
      });

      log(`collected ${shortName(cleanId)} (${code.length} chars)`);

      // Always return null — let Vite handle CSS normally.
      // We only collect; we don't transform the CSS.
      return null;
    },

    // ── generateBundle: global analysis + emission ────────────────────────
    // Only runs during `vite build` (production).
    // Skipped entirely in dev server mode.
    async generateBundle(outputOptions, bundle) {
      if (!isProduction) return;

      const moduleCount = cssModules.size;
      if (moduleCount === 0) {
        this.warn('[binary-som] No CSS modules collected — nothing to emit.');
        return;
      }

      log(`analysing ${moduleCount} CSS modules...`);

      // ── Step 1: Join all collected CSS into a single source ──────────────
      // Preserve source attribution via comments for debuggability.
      // Sort by id for deterministic output across runs.
      const sortedModules = Array.from(cssModules.values())
        .sort((a, b) => a.id.localeCompare(b.id));

      const combined = sortedModules
        .map(m => `/* __SOURCE__: ${m.shortName} */\n${m.raw}`)
        .join('\n\n');

      // ── Step 2: Run global analysis ───────────────────────────────────────
      let result;
      try {
        result = analyseCSS(combined, {
          filename:     sortedModules.map(m => m.shortName).join(', '),
          globalTokens,
        });
      } catch (e) {
        this.error(`[binary-som] Analysis failed: ${e.message}`);
        return;
      }

      // ── Step 3: Report NONDETERMINISTIC components ────────────────────────
      const ndetNodes = Array.from(result.nodes.values())
        .filter(n => n.finalClass === 'BIND_NONDETERMINISTIC');

      if (ndetNodes.length > 0) {
        const selectors = ndetNodes.map(n => `  ${n.selector} (${n.sourceFile}:${n.sourceLine})`).join('\n');
        const msg = `[binary-som] ${ndetNodes.length} NONDETERMINISTIC component(s) found:\n${selectors}\n` +
          `  These use structural pseudo-selectors (:nth-child, :has, etc.) and cannot be\n` +
          `  statically classified. Set failOnNonDeterministic: true to block builds.`;

        if (failOnNonDeterministic) {
          this.error(msg);
          return;
        } else {
          this.warn(msg);
        }
      }

      // ── Step 4: Emit binary ───────────────────────────────────────────────
      let binary;
      let fallback;
      try {
        fallback = emitFallbackCss(result);
        const pool = buildPoolFromAnalysis(result);
        const emit = emitComponentSection(result, pool);
        binary     = assembleBinary(
          pool.serialise(),
          emit.staticTier,
          emit.dynamicIndex,
          emit.dynamicTier,
        );
      } catch (e) {
        this.error(`[binary-som] Emission failed: ${e.message}`);
        return;
      }

      this.emitFile({
        type:     'asset',
        fileName: fallbackFileName,
        source:   fallback.css,
      });

      const fallbackMap = buildFallbackMap(ndetNodes);
      this.emitFile({
        type:     'asset',
        fileName: fallbackMapFileName,
        source:   JSON.stringify(fallbackMap, null, 2),
      });

      this.emitFile({
        type:     'asset',
        fileName: somFileName,
        source:   binary,
      });

      // ── Step 5: Emit summary JSON ─────────────────────────────────────────
      const summary = buildSummary(result, binary, sortedModules, fallback, fallbackMap);

      this.emitFile({
        type:     'asset',
        fileName: summaryFileName,
        source:   JSON.stringify(summary, null, 2),
      });

      // ── Step 6: Console report ────────────────────────────────────────────
      printBuildReport(summary, verbose);
    },

    // ── handleHotUpdate: evict changed files ──────────────────────────────
    // Dev-only. Removes the changed file from the cache so the next
    // full build (triggered by generateBundle on next `vite build`) will
    // re-analyse it. Does NOT trigger re-analysis in dev mode.
    handleHotUpdate(ctx) {
      const cleanId = ctx.file.replace(/\?.*$/, '');
      if (cssModules.has(cleanId)) {
        cssModules.delete(cleanId);
        log(`HMR: evicted ${shortName(cleanId)}`);
      }
    },
  };
}

// ── Summary builder ────────────────────────────────────────────────────────
function buildSummary(result, binary, sortedModules, fallback, fallbackMap = {}) {
  const nodes    = Array.from(result.nodes.values());
  const total    = nodes.length;

  const staticNodes  = nodes.filter(n => n.finalClass === 'BIND_STATIC');
  const detNodes     = nodes.filter(n => n.finalClass === 'BIND_DETERMINISTIC');
  const ndetNodes    = nodes.filter(n => n.finalClass === 'BIND_NONDETERMINISTIC');
  const boundaries   = nodes.filter(n => n.isBoundary);

  // Top contamination sources (boundaries with the most contaminated descendants)
  const topContaminators = boundaries
    .map(n => ({ selector: n.selector, contaminates: n.contaminates?.length ?? 0 }))
    .sort((a, b) => b.contaminates - a.contaminates)
    .slice(0, 10);

  // Dep type distribution
  const depTypes = {};
  for (const node of nodes) {
    for (const dep of node.depEntries ?? []) {
      depTypes[dep.depTypeName] = (depTypes[dep.depTypeName] ?? 0) + 1;
    }
  }

  return {
    meta: {
      generatedAt:   new Date().toISOString(),
      sourceFiles:   sortedModules.map(m => m.shortName),
      fileCount:     sortedModules.length,
      binarySizeBytes: binary.length,
      fallbackSizeBytes: Buffer.byteLength(fallback?.css ?? '', 'utf8'),
      fallbackRules: fallback?.stats?.ruleCount ?? 0,
      fallbackMapEntries: Object.keys(fallbackMap).length,
    },
    classification: {
      total,
      static:           staticNodes.length,
      staticPct:        pct(staticNodes.length, total),
      deterministic:    detNodes.length,
      deterministicPct: pct(detNodes.length, total),
      nondeterministic:    ndetNodes.length,
      nondeterministicPct: pct(ndetNodes.length, total),
      boundaries:       boundaries.length,
    },
    warnings: result.warnings.map(w => ({
      type:    w.type,
      nodeId:  w.nodeId,
      message: w.msg,
    })),
    nondeterministicSelectors: ndetNodes.map(n => ({
      selector:   n.selector,
      sourceFile: n.sourceFile,
      sourceLine: n.sourceLine,
    })),
    topContaminators,
    depTypeDistribution: depTypes,
    binaryLayout: {
      totalBytes:        binary.length,
      // Sections not directly accessible here — reported from emit stats
    },
  };
}

function pct(n, total) {
  return total > 0 ? Math.round(n / total * 100) : 0;
}

function buildFallbackMap(ndetNodes) {
  const out = {};
  const sorted = [...(ndetNodes || [])].sort((a, b) =>
    (fnv1a32(a.selector) >>> 0) - (fnv1a32(b.selector) >>> 0)
  );
  for (const node of sorted) {
    const hash = `0x${(fnv1a32(node.selector) >>> 0).toString(16)}`;
    out[hash] = node.selector;
  }
  return out;
}

// ── Console report ──────────────────────────────────────────────────────────
function printBuildReport(summary, verbose) {
  const { classification: c, meta } = summary;
  const NO_COLOR = !process.stdout.isTTY;
  const G = NO_COLOR ? '' : '\x1b[32m';
  const B = NO_COLOR ? '' : '\x1b[34m';
  const R = NO_COLOR ? '' : '\x1b[31m';
  const Y = NO_COLOR ? '' : '\x1b[33m';
  const D = NO_COLOR ? '' : '\x1b[2m';
  const X = NO_COLOR ? '' : '\x1b[0m';

  console.log(`\n${B}[binary-som]${X} Build complete`);
  console.log(`  ${G}STATIC          ${X}${c.static}/${c.total} (${c.staticPct}%)`);
  console.log(`  ${B}DETERMINISTIC   ${X}${c.deterministic}/${c.total} (${c.deterministicPct}%)`);
  console.log(`  ${c.nondeterministic > 0 ? R : D}NONDETERMINISTIC${X}${c.nondeterministic > 0 ? R : D} ${c.nondeterministic}/${c.total} (${c.nondeterministicPct}%)${X}`);
  console.log(`  Boundaries:      ${c.boundaries}`);
  console.log(`  Binary:          ${meta.binarySizeBytes} bytes → ${meta.sourceFiles.length} source file(s)`);

  if (summary.warnings.length > 0 && verbose) {
    console.log(`  ${Y}Warnings: ${summary.warnings.length}${X}`);
    summary.warnings.forEach(w => console.log(`    ${Y}·${X} [${w.type}] ${w.nodeId}`));
  }

  console.log('');
}

module.exports = { binarySomPlugin };


