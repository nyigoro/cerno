"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { analyseCSS } = require("../dist/src/analyser");
const { emitFallbackCss } = require("../dist/src/fallbackEmitter");
const { buildPoolFromAnalysis } = require("../dist/src/constantPool");
const { emitComponentSection, assembleBinary, fnv1a32 } = require("../dist/src/emitter");
const { SOMLoader } = require("../dist/src/loader");

const root = __dirname;
const cssPath = path.join(root, "styles.css");
const outPath = path.join(root, "styles.som");
const fallbackPath = path.join(root, "fallback.css");
const fallbackMapPath = path.join(root, "fallback-map.json");

const css = fs.readFileSync(cssPath, "utf8");
const analysis = analyseCSS(css, { sourceName: "demo/styles.css" });
const fallback = emitFallbackCss(analysis);
const pool = buildPoolFromAnalysis(analysis);
const emit = emitComponentSection(analysis, pool);
const binary = assembleBinary(pool.serialise(), emit.staticTier, emit.dynamicIndex, emit.dynamicTier);
fs.writeFileSync(outPath, binary);
fs.writeFileSync(fallbackPath, fallback.css, "utf8");

const nondeterministicNodes = analysis.nodes
  .filter((node) => node.finalClass === "BIND_NONDETERMINISTIC")
  .sort((a, b) => (fnv1a32(a.selector) >>> 0) - (fnv1a32(b.selector) >>> 0));

const fallbackMap = {};
for (const node of nondeterministicNodes) {
  const hashHex = `0x${(fnv1a32(node.selector) >>> 0).toString(16)}`;
  fallbackMap[hashHex] = node.selector;
}
fs.writeFileSync(fallbackMapPath, `${JSON.stringify(fallbackMap, null, 2)}\n`, "utf8");

const loader = new SOMLoader(binary);

const selectors = [
  ".demo-card",
  ".demo-title",
  ".demo-subtitle",
  ".demo-badge",
  ".demo-btn",
  ".demo-stats",
  ".demo-stat",
  ".demo-stat-value",
  ".demo-stat-label",
  ".demo-section-title",
  ".demo-grid-two",
  ".demo-field",
  ".demo-label",
  ".demo-input",
  ".demo-help",
  ".demo-pill-row",
  ".demo-pill",
  ".demo-pill-success",
  ".demo-pill-warn",
  ".demo-pill-danger",
  ".demo-callout",
  ".demo-callout-title",
  ".demo-callout-text",
  ".demo-kpi-grid",
  ".demo-kpi",
  ".demo-kpi-value",
  ".demo-kpi-label",
  ".demo-progress",
  ".demo-progress-bar",
  ".demo-list",
  ".demo-list-item",
  ".demo-resize-wrapper",
  ".demo-resize-container",
  ".demo-resize-title",
  ".demo-resize-readout",
  ".demo-resize-label",
  ".demo-resize-badge",
  ".demo-pref-container",
  ".demo-pref-label",
  ".demo-pref-value",
];

console.log("Wrote:", outPath);
console.log("Wrote:", fallbackPath);
console.log("Wrote:", fallbackMapPath);
console.log("[demo:build] styles.som:", `${binary.length} bytes`);
console.log(
  "[demo:build] fallback.css:",
  `${Buffer.byteLength(fallback.css, "utf8")} bytes`,
  `(${fallback.stats.ruleCount} rule(s))`
);
console.log("[demo:build] components:", analysis.summary.total);
console.log("[demo:build]   STATIC:", analysis.summary.static);
console.log("[demo:build]   DETERMINISTIC:", analysis.summary.deterministic);
console.log(
  "[demo:build]   NONDETERMINISTIC:",
  `${analysis.summary.nondeterministic} -> fallback.css`
);
if (nondeterministicNodes.length > 0) {
  for (const node of nondeterministicNodes) {
    console.log("[demo:build]     ↩", node.selector);
  }
}
console.log("Stats:", loader.stats);
console.log("\nHash constants:");
for (const selector of selectors) {
  const hash = fnv1a32(selector);
  const key = `H_${selector.replace(/^\./, "").replace(/-/g, "_").toUpperCase()}`;
  console.log(`const ${key} = 0x${hash.toString(16)};`);
}


