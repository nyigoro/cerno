// @ts-nocheck
// =============================================================================
// webpack-plugin-binary-som
// COMP-SPEC-001 v0.2  §10
//
// Compatible with: webpack 5, Rspack (webpack-compatible API)
//
// PLUGIN LIFECYCLE
// ────────────────
// compiler.hooks.thisCompilation  → attach to compilation
// compilation.hooks.processAssets → global analysis + emit (PROCESS_ASSETS_STAGE_SUMMARIZE)
//
// The plugin collects CSS modules from the compilation's module graph
// (no per-module transform hook needed — webpack gives us all modules
// at processAssets time). This is cleaner than Vite's transform approach
// because webpack's module graph is available as a complete object.
//
// EMITTED ASSETS
// ──────────────
// styles.som               — binary component database
// fallback.css             — NONDETERMINISTIC selector fallback rules
// fallback-map.json        — NONDETERMINISTIC hash → selector map
// binary-som-summary.json  — build report
// =============================================================================

'use strict';

const { analyseCSS }                           = require('./analyser');
const { emitFallbackCss }                      = require('./fallbackEmitter');
const { buildPoolFromAnalysis }                = require('./constantPool');
const { emitComponentSection, assembleBinary, fnv1a32 } = require('./emitter');

const PLUGIN_NAME = 'BinarySomPlugin';

// CSS module test — matches .css, .scss, .sass, .less, .styl
const CSS_MODULE_RE = /\.(css|scss|sass|less|styl)(\?.*)?$/;

class BinarySomPlugin {
  constructor(options = {}) {
    this.options = Object.assign({
      failOnNonDeterministic: false,
      somFileName:            'styles.som',
      fallbackFileName:       'fallback.css',
      fallbackMapFileName:    'fallback-map.json',
      summaryFileName:        'binary-som-summary.json',
      include:                null,
      exclude:                null,
      tokensFile:             null,
      verbose:                false,
    }, options);
  }

  apply(compiler) {
    const { options } = this;

    // Load global tokens once at plugin init
    const globalTokens = loadTokens(options.tokensFile, msg => {
      // Use console.warn at init time (compiler.getInfrastructureLogger not always available)
      if (options.verbose) console.warn(`[binary-som] ${msg}`);
    });

    compiler.hooks.thisCompilation.tap(PLUGIN_NAME, (compilation) => {

      // webpack 5 / Rspack: processAssets at SUMMARIZE stage
      // This runs after all modules are built and assets are assembled —
      // the correct point for cross-module analysis.
      const stage = compilation.constructor.PROCESS_ASSETS_STAGE_SUMMARIZE
        ?? (compiler.webpack?.Compilation?.PROCESS_ASSETS_STAGE_SUMMARIZE)
        ?? 1000;  // fallback constant if neither is available

      compilation.hooks.processAssets.tapAsync(
        { name: PLUGIN_NAME, stage },
        async (assets, callback) => {
          try {
            await this._processAssets(compilation, compiler, globalTokens, assets);
            callback();
          } catch (err) {
            callback(err);
          }
        }
      );
    });
  }

  async _processAssets(compilation, compiler, globalTokens, assets) {
    const { options } = this;
    const logger = compiler.getInfrastructureLogger
      ? compiler.getInfrastructureLogger(PLUGIN_NAME)
      : { warn: console.warn, error: console.error, info: console.log };

    // ── Step 1: Collect CSS modules from the compilation ──────────────────
    const cssModules = collectCSSModules(compilation, options);

    if (cssModules.length === 0) {
      logger.warn('No CSS modules found in compilation — nothing to emit.');
      return;
    }

    if (options.verbose) {
      logger.info(`Collected ${cssModules.length} CSS module(s)`);
    }

    // ── Step 2: Join into a single source (sorted for determinism) ────────
    const sorted = cssModules.sort((a, b) => a.id.localeCompare(b.id));
    const combined = sorted
      .map(m => `/* __SOURCE__: ${m.shortName} */\n${m.source}`)
      .join('\n\n');

    // ── Step 3: Global analysis ───────────────────────────────────────────
    let result;
    try {
      result = analyseCSS(combined, {
        filename:     sorted.map(m => m.shortName).join(', '),
        globalTokens,
      });
    } catch (err) {
      compilation.errors.push(
        new (compiler.webpack?.WebpackError ?? Error)(`[binary-som] Analysis failed: ${err.message}`)
      );
      return;
    }

    // ── Step 4: NONDETERMINISTIC warnings / errors ────────────────────────
    const nodes = normaliseNodes(result);
    const ndetNodes = nodes
      .filter(n => n.finalClass === 'BIND_NONDETERMINISTIC');

    if (ndetNodes.length > 0) {
      const selectors = ndetNodes.map(n => `  ${n.selector}`).join('\n');
      const msg = `[binary-som] ${ndetNodes.length} NONDETERMINISTIC component(s):\n${selectors}\n` +
        `  These use structural pseudo-selectors and cannot be statically classified.`;

      if (options.failOnNonDeterministic) {
        compilation.errors.push(
          new (compiler.webpack?.WebpackError ?? Error)(msg)
        );
        return;
      } else {
        compilation.warnings.push(
          new (compiler.webpack?.WebpackError ?? Error)(msg)
        );
      }
    }

    // ── Step 5: Emit binary ───────────────────────────────────────────────
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
    } catch (err) {
      compilation.errors.push(
        new (compiler.webpack?.WebpackError ?? Error)(`[binary-som] Emission failed: ${err.message}`)
      );
      return;
    }

    // webpack/Rspack asset emission: source must be a RawSource-like object
    // Use webpack's sources if available, otherwise a minimal shim.
    const RawSource = compiler.webpack?.sources?.RawSource
      ?? tryRequire('webpack-sources')?.RawSource
      ?? MinimalRawSource;

    compilation.emitAsset(
      options.fallbackFileName,
      new RawSource(fallback.css, false),
    );

    const fallbackMap = buildFallbackMap(ndetNodes);
    compilation.emitAsset(
      options.fallbackMapFileName,
      new RawSource(JSON.stringify(fallbackMap, null, 2), false),
    );

    compilation.emitAsset(
      options.somFileName,
      new RawSource(binary, false),  // false = not dev-only
    );

    // ── Step 6: Summary JSON ──────────────────────────────────────────────
    const summary = buildSummary(result, binary, sorted, fallback, fallbackMap);

    compilation.emitAsset(
      options.summaryFileName,
      new RawSource(JSON.stringify(summary, null, 2), false),
    );

    // ── Step 7: Console report ────────────────────────────────────────────
    printBuildReport(summary, options.verbose);
  }
}

// ── CSS module collector ───────────────────────────────────────────────────
// Walks webpack's module graph and extracts CSS source from CSS modules.
// Works with both webpack 5 NormalModule and Rspack's module representation.
function collectCSSModules(compilation, options) {
  const results = [];
  const seen    = new Set();

  for (const mod of compilation.modules) {
    const resource = mod.resource ?? mod.userRequest ?? '';
    if (!CSS_MODULE_RE.test(resource)) continue;
    if (seen.has(resource)) continue;

    if (options.exclude && matchPattern(options.exclude, resource)) continue;
    if (options.include && !matchPattern(options.include, resource)) continue;

    // Get source: try originalSource(), then source(), then _source
    let source = null;
    try {
      source = mod.originalSource?.()?.source()
        ?? mod.source?.()
        ?? mod._source?.source?.()
        ?? null;
    } catch (_) { /* module not fully built */ }

    if (typeof source !== 'string' || source.trim().length === 0) continue;

    seen.add(resource);
    results.push({
      id:        resource,
      shortName: resource.replace(process.cwd(), '').replace(/^[/\\]/, ''),
      source,
    });
  }

  return results;
}

// ── Helpers ────────────────────────────────────────────────────────────────
function matchPattern(pattern, str) {
  if (Array.isArray(pattern))    return pattern.some(p => matchPattern(p, str));
  if (typeof pattern === 'function') return pattern(str);
  if (pattern instanceof RegExp) return pattern.test(str);
  const re = new RegExp(pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*'));
  return re.test(str);
}

function loadTokens(tokensFile, warn) {
  if (!tokensFile) return {};
  try {
    const fs  = require('fs');
    const raw = fs.readFileSync(tokensFile, 'utf-8');
    const parsed = JSON.parse(raw);
    const out = {};
    for (const [k, v] of Object.entries(parsed)) {
      out[k.startsWith('--') ? k : `--${k}`] = String(v);
    }
    return out;
  } catch (e) {
    warn(`Could not load tokens file ${tokensFile}: ${e.message}`);
    return {};
  }
}

function tryRequire(id) {
  try { return require(id); } catch (_) { return null; }
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

// Minimal RawSource shim for environments without webpack-sources
class MinimalRawSource {
  constructor(value) { this._value = value; }
  source()  { return this._value; }
  buffer()  { return Buffer.isBuffer(this._value) ? this._value : Buffer.from(this._value); }
  size()    { return this.buffer().length; }
  map()     { return null; }
  sourceAndMap() { return { source: this._value, map: null }; }
}

function buildSummary(result, binary, sortedModules, fallback, fallbackMap = {}) {
  const nodes   = normaliseNodes(result);
  const total   = nodes.length;
  const statics = nodes.filter(n => n.finalClass === 'BIND_STATIC');
  const dets    = nodes.filter(n => n.finalClass === 'BIND_DETERMINISTIC');
  const ndets   = nodes.filter(n => n.finalClass === 'BIND_NONDETERMINISTIC');
  const bounds  = nodes.filter(n => n.isBoundary || (n.boundaryId && n.boundaryId === n.id));
  const pct     = (n) => total > 0 ? Math.round(n / total * 100) : 0;

  const depTypes = {};
  for (const node of nodes) {
    const deps = Array.isArray(node.depEntries) ? node.depEntries : (Array.isArray(node.deps) ? node.deps : []);
    for (const dep of deps) {
      const depTypeName = dep.depTypeName ?? dep.depType ?? 'UNKNOWN';
      depTypes[depTypeName] = (depTypes[depTypeName] ?? 0) + 1;
    }
  }

  return {
    meta: {
      generatedAt:     new Date().toISOString(),
      sourceFiles:     sortedModules.map(m => m.shortName),
      fileCount:       sortedModules.length,
      binarySizeBytes: binary.length,
      fallbackSizeBytes: Buffer.byteLength(fallback?.css ?? '', 'utf8'),
      fallbackRules: fallback?.stats?.ruleCount ?? 0,
      fallbackMapEntries: Object.keys(fallbackMap).length,
    },
    classification: {
      total,
      static: statics.length, staticPct: pct(statics.length),
      deterministic: dets.length, deterministicPct: pct(dets.length),
      nondeterministic: ndets.length, nondeterministicPct: pct(ndets.length),
      boundaries: bounds.length,
    },
    warnings: normaliseWarnings(result),
    nondeterministicSelectors: ndets.map(n => ({
      selector: n.selector, sourceFile: n.sourceFile, sourceLine: n.sourceLine,
    })),
    depTypeDistribution: depTypes,
  };
}

function normaliseNodes(result) {
  if (result?.nodes instanceof Map) return Array.from(result.nodes.values());
  if (Array.isArray(result?.nodes)) return result.nodes;
  return [];
}

function normaliseWarnings(result) {
  const warnings = Array.isArray(result?.warnings) ? result.warnings : [];
  return warnings.map((warning) => {
    if (warning && typeof warning === 'object') {
      return {
        type: warning.type ?? 'WARNING',
        nodeId: warning.nodeId ?? null,
        message: warning.msg ?? warning.message ?? '',
      };
    }
    return { type: 'WARNING', nodeId: null, message: String(warning) };
  });
}

function printBuildReport(summary, verbose) {
  const { classification: c, meta } = summary;
  const T = process.stdout.isTTY;
  const G = T ? '\x1b[32m' : '', B = T ? '\x1b[34m' : '';
  const R = T ? '\x1b[31m' : '', D = T ? '\x1b[2m'  : '', X = T ? '\x1b[0m' : '';

  console.log(`\n${B}[binary-som]${X} Build complete`);
  console.log(`  ${G}STATIC          ${X}${c.static}/${c.total} (${c.staticPct}%)`);
  console.log(`  ${B}DETERMINISTIC   ${X}${c.deterministic}/${c.total} (${c.deterministicPct}%)`);
  console.log(`  ${c.nondeterministic > 0 ? R : D}NONDETERMINISTIC${X}${c.nondeterministic > 0 ? R : D} ${c.nondeterministic}/${c.total} (${c.nondeterministicPct}%)${X}`);
  console.log(`  Boundaries:      ${c.boundaries}`);
  console.log(`  Binary:          ${meta.binarySizeBytes} bytes → ${meta.fileCount} source file(s)\n`);
}

module.exports = { BinarySomPlugin };


