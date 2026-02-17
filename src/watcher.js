// =============================================================================
// Binary SOM — Watch Mode
// COMP-SPEC-001 v0.2  §11
//
// Watches CSS files and re-analyses on change.
// Outputs ONLY what changed since the last run (diff-only).
//
// DIFF CATEGORIES
// ───────────────
// ADDED         — new component detected
// REMOVED       — component no longer present
// RECLASSIFIED  — classification changed (e.g. STATIC → DETERMINISTIC)
// WARNED        — new warning appeared
// RESOLVED      — warning that was present is now gone
//
// OUTPUT FORMAT (per change event)
// ─────────────────────────────────
// [HH:MM:SS] src/styles.css changed
//   + .new-component           BIND_STATIC
//   ~ .existing-component      BIND_STATIC → BIND_DETERMINISTIC  (reclassified)
//   - .removed-component       (was BIND_STATIC)
//   ⚠ .table tr:nth-child(even)  STRUCTURAL_DYNAMIC warning
// =============================================================================

'use strict';

const fs   = require('fs');
const path = require('path');
const { analyseCSS } = require('../dist/src/analyser');

// ── Diff engine ────────────────────────────────────────────────────────────

function computeDiff(prev, next) {
  // prev / next: Map<selector, { finalClass, warnings: string[] }>
  const diffs = [];

  for (const [sel, node] of next) {
    if (!prev.has(sel)) {
      diffs.push({ type: 'ADDED', selector: sel, nextClass: node.finalClass });
    } else {
      const prevNode = prev.get(sel);
      if (prevNode.finalClass !== node.finalClass) {
        diffs.push({
          type:      'RECLASSIFIED',
          selector:  sel,
          prevClass: prevNode.finalClass,
          nextClass: node.finalClass,
        });
      }
    }
  }

  for (const [sel, node] of prev) {
    if (!next.has(sel)) {
      diffs.push({ type: 'REMOVED', selector: sel, prevClass: node.finalClass });
    }
  }

  // Warning diffs
  const prevWarnKeys = new Set(prev._warnings ?? []);
  const nextWarnKeys = new Set(next._warnings ?? []);

  for (const w of nextWarnKeys) {
    if (!prevWarnKeys.has(w)) diffs.push({ type: 'WARNED', message: w });
  }
  for (const w of prevWarnKeys) {
    if (!nextWarnKeys.has(w)) diffs.push({ type: 'RESOLVED', message: w });
  }

  return diffs;
}

function snapshotResult(result) {
  const snap = new Map();
  const nodes = result?.nodes;

  if (nodes instanceof Map) {
    for (const [id, node] of nodes.entries()) {
      const key = node?.selector ?? id;
      snap.set(key, { finalClass: node?.finalClass });
    }
  } else if (Array.isArray(nodes)) {
    for (const node of nodes) {
      const key = node?.selector ?? node?.id;
      if (!key) continue;
      snap.set(key, { finalClass: node?.finalClass });
    }
  }

  // Attach warnings as a special key on the map itself
  snap._warnings = (result?.warnings ?? []).map((warning) => {
    if (warning && typeof warning === 'object') {
      return `${warning.type ?? 'WARNING'}:${warning.nodeId ?? warning.msg ?? ''}`;
    }
    return String(warning);
  });
  return snap;
}

// ── Diff formatter ─────────────────────────────────────────────────────────

function formatDiff(diffs, changedFile, tty = process.stdout.isTTY) {
  if (diffs.length === 0) return null;  // no output if nothing changed

  const G  = tty ? '\x1b[32m' : '';
  const B  = tty ? '\x1b[34m' : '';
  const R  = tty ? '\x1b[31m' : '';
  const Y  = tty ? '\x1b[33m' : '';
  const D  = tty ? '\x1b[2m'  : '';
  const X  = tty ? '\x1b[0m'  : '';
  const DIM = tty ? '\x1b[2m' : '';

  const classColour = (cls) => {
    if (cls === 'BIND_STATIC')           return G;
    if (cls === 'BIND_DETERMINISTIC')    return B;
    if (cls === 'BIND_NONDETERMINISTIC') return R;
    return '';
  };
  const shortClass = (cls) => cls.replace('BIND_', '');

  const now    = new Date();
  const time   = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')}`;
  const file   = path.relative(process.cwd(), changedFile);

  const lines = [`${DIM}[${time}]${X} ${file} changed`];

  for (const d of diffs) {
    switch (d.type) {
      case 'ADDED':
        lines.push(`  ${G}+${X} ${d.selector.padEnd(50)} ${classColour(d.nextClass)}${shortClass(d.nextClass)}${X}`);
        break;
      case 'REMOVED':
        lines.push(`  ${R}-${X} ${D}${d.selector.padEnd(50)} (was ${shortClass(d.prevClass)})${X}`);
        break;
      case 'RECLASSIFIED': {
        const arrow = `${classColour(d.prevClass)}${shortClass(d.prevClass)}${X} → ${classColour(d.nextClass)}${shortClass(d.nextClass)}${X}`;
        const severity = reclassificationSeverity(d.prevClass, d.nextClass);
        const marker = severity === 'worse' ? `${R}~${X}` : severity === 'better' ? `${G}~${X}` : `${Y}~${X}`;
        lines.push(`  ${marker} ${d.selector.padEnd(50)} ${arrow}`);
        break;
      }
      case 'WARNED':
        lines.push(`  ${Y}⚠${X} ${d.message}`);
        break;
      case 'RESOLVED':
        lines.push(`  ${G}✓${X} ${D}resolved: ${d.message}${X}`);
        break;
    }
  }

  return lines.join('\n');
}

function reclassificationSeverity(prev, next) {
  const rank = { BIND_STATIC: 0, BIND_DETERMINISTIC: 1, BIND_NONDETERMINISTIC: 2 };
  const p = rank[prev] ?? 0, n = rank[next] ?? 0;
  return n > p ? 'worse' : n < p ? 'better' : 'same';
}

// ── Watcher ────────────────────────────────────────────────────────────────

class SOMWatcher {
  constructor(globs, options = {}) {
    this._globs    = Array.isArray(globs) ? globs : [globs];
    this._options  = Object.assign({
      debounceMs:   150,
      globalTokens: {},
      verbose:      false,
      onDiff:       null,   // (diffText, diffs, result) => void
      onError:      null,   // (err, file) => void
    }, options);

    this._watchers   = [];
    this._snapshot   = new Map();  // selector → { finalClass }
    this._debounce   = null;
    this._pendingFiles = new Set();
    this._allCssFiles  = new Set();
  }

  // Start watching. Returns a stop function.
  start() {
    const files = expandGlobs(this._globs);
    files.forEach(f => this._allCssFiles.add(f));

    if (files.length === 0) {
      console.warn('[binary-som watch] No CSS files matched the given patterns.');
      return () => {};
    }

    // Run initial analysis
    this._runAnalysis(files[0]);

    // Watch each file
    for (const file of files) {
      const watcher = fs.watch(file, { persistent: true }, (event) => {
        if (event === 'change' || event === 'rename') {
          this._scheduleReanalysis(file);
        }
      });
      this._watchers.push(watcher);
    }

    if (this._options.verbose) {
      console.log(`[binary-som watch] Watching ${files.length} file(s). Ctrl+C to stop.\n`);
    }

    return () => this.stop();
  }

  stop() {
    this._watchers.forEach(w => w.close());
    this._watchers = [];
    if (this._debounce) { clearTimeout(this._debounce); this._debounce = null; }
  }

  _scheduleReanalysis(file) {
    this._pendingFiles.add(file);
    if (this._debounce) clearTimeout(this._debounce);
    this._debounce = setTimeout(() => {
      const changed = [...this._pendingFiles][0];  // primary changed file for display
      this._pendingFiles.clear();
      this._runAnalysis(changed);
    }, this._options.debounceMs);
  }

  _runAnalysis(changedFile) {
    try {
      // Re-read ALL watched files (not just the changed one)
      // to get complete cross-file contamination context
      const combined = Array.from(this._allCssFiles)
        .sort()
        .filter(f => fs.existsSync(f))
        .map(f => `/* ${path.relative(process.cwd(), f)} */\n${fs.readFileSync(f, 'utf-8')}`)
        .join('\n\n');

      const result   = analyseCSS(combined, { globalTokens: this._options.globalTokens });
      const next     = snapshotResult(result);
      const diffs    = computeDiff(this._snapshot, next);
      this._snapshot = next;

      const diffText = formatDiff(diffs, changedFile);
      if (diffText) {
        process.stdout.write(diffText + '\n');
      } else if (this._options.verbose) {
        const time = new Date().toTimeString().slice(0, 8);
        console.log(`[${time}] ${path.relative(process.cwd(), changedFile)} — no classification changes`);
      }

      if (this._options.onDiff) {
        this._options.onDiff(diffText, diffs, result);
      }
    } catch (err) {
      if (this._options.onError) {
        this._options.onError(err, changedFile);
      } else {
        console.error(`[binary-som watch] Error analysing ${changedFile}: ${err.message}`);
      }
    }
  }
}

// ── Minimal glob expansion (no external deps) ──────────────────────────────
// Supports: exact file path, directory (watches all .css files within),
// and simple *.css glob in a directory.
function expandGlobs(patterns) {
  const files = [];
  for (const pattern of patterns) {
    const cleanPattern = pattern.replace(/\?.*$/, '');
    if (cleanPattern.includes('*')) {
      // Simple dir/*.ext glob
      const dir  = path.dirname(cleanPattern);
      const ext  = path.extname(cleanPattern).replace('*', '');
      const base = path.basename(cleanPattern).replace(/\*.*$/, '');
      if (fs.existsSync(dir)) {
        fs.readdirSync(dir)
          .filter(f => f.startsWith(base) && (ext ? f.endsWith(ext) : true))
          .forEach(f => files.push(path.resolve(dir, f)));
      }
    } else if (fs.existsSync(cleanPattern)) {
      const stat = fs.statSync(cleanPattern);
      if (stat.isDirectory()) {
        // Watch all CSS files in directory (non-recursive for simplicity)
        fs.readdirSync(cleanPattern)
          .filter(f => /\.(css|scss|sass|less|styl)$/.test(f))
          .forEach(f => files.push(path.resolve(cleanPattern, f)));
      } else {
        files.push(path.resolve(cleanPattern));
      }
    }
  }
  return [...new Set(files)];  // deduplicate
}

module.exports = { SOMWatcher, computeDiff, formatDiff, snapshotResult };

