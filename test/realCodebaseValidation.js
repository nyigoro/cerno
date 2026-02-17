"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { performance } = require("node:perf_hooks");

const { analyseCSS } = require("../dist/src/analyser");
const { buildPoolFromAnalysis } = require("../src/constantPool");
const { emitComponentSection, assembleBinary } = require("../src/emitter");
const { SOMLoader } = require("../src/loader");

function readText(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function listCssFilesRecursively(rootDir) {
  const out = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const dir = stack.pop();
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && full.toLowerCase().endsWith(".css")) {
        out.push(full);
      }
    }
  }
  return out.sort();
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) return (sorted[mid - 1] + sorted[mid]) / 2;
  return sorted[mid];
}

function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function round(n) {
  return Math.round(n * 100) / 100;
}

function warningType(msg) {
  if (msg && typeof msg === "object") {
    return msg.type || "OTHER";
  }
  const t = String(msg || "").toLowerCase();
  if (t.includes("structural selector")) return "STRUCTURAL_DYNAMIC";
  if (t.includes("no container ancestor")) return "MISSING_CONTAINER";
  if (t.includes("portal_id target")) return "PORTAL_MISSING";
  if (t.includes("mixed absolute/runtime")) return "MIXED_OPERANDS";
  if (t.includes("token cycle")) return "TOKEN_CYCLE";
  return "OTHER";
}

function summarizeWarnings(warnings) {
  const out = {};
  for (const w of warnings || []) {
    const key = warningType(w);
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

function summarizeDeps(nodes) {
  const out = {};
  for (const node of nodes || []) {
    for (const dep of node.deps || []) {
      const key = String(dep.depType || "UNKNOWN");
      out[key] = (out[key] || 0) + 1;
    }
  }
  return out;
}

function runScenario(scenario) {
  const fileParts = scenario.files.map((f) => ({
    file: f,
    text: readText(f),
  }));

  const source = fileParts
    .map((p) => `/* __SOURCE__: ${path.basename(p.file)} */\n${p.text}`)
    .join("\n\n");

  const lineCount = source.split(/\r?\n/).length;
  const byteCount = Buffer.byteLength(source, "utf8");

  const warmups = scenario.warmups || 2;
  for (let i = 0; i < warmups; i += 1) {
    analyseCSS(source, { sourceName: scenario.id });
  }

  const analysisTimes = [];
  for (let i = 0; i < scenario.analysisIters; i += 1) {
    const t0 = performance.now();
    analyseCSS(source, { sourceName: scenario.id });
    analysisTimes.push(performance.now() - t0);
  }

  const pipelineTimes = [];
  let finalAnalysis = null;
  let finalPool = null;
  let finalEmit = null;
  let finalBinary = null;
  let finalLoader = null;

  for (let i = 0; i < scenario.pipelineIters; i += 1) {
    const t0 = performance.now();
    const analysis = analyseCSS(source, { sourceName: scenario.id });
    const pool = buildPoolFromAnalysis(analysis);
    const emit = emitComponentSection(analysis, pool);
    const binary = assembleBinary(pool.serialise(), emit.staticTier, emit.dynamicIndex, emit.dynamicTier);
    const loader = new SOMLoader(binary);
    pipelineTimes.push(performance.now() - t0);

    if (i === scenario.pipelineIters - 1) {
      finalAnalysis = analysis;
      finalPool = pool;
      finalEmit = emit;
      finalBinary = binary;
      finalLoader = loader;
    }
  }

  const total = finalAnalysis.summary.total;
  const staticCount = finalAnalysis.summary.static;
  const deterministicCount = finalAnalysis.summary.deterministic;
  const nondeterministicCount = finalAnalysis.summary.nondeterministic;
  const warnings = finalAnalysis.warnings || [];

  const nondetSelectors = finalAnalysis.nodes
    .filter((n) => n.finalClass === "BIND_NONDETERMINISTIC")
    .map((n) => n.selector);

  return {
    id: scenario.id,
    label: scenario.label,
    files: scenario.files,
    fileCount: scenario.files.length,
    bytes: byteCount,
    lines: lineCount,
    components: total,
    classification: {
      static: staticCount,
      deterministic: deterministicCount,
      nondeterministic: nondeterministicCount,
      staticPct: total ? round((staticCount / total) * 100) : 0,
      deterministicPct: total ? round((deterministicCount / total) * 100) : 0,
      nondeterministicPct: total ? round((nondeterministicCount / total) * 100) : 0,
    },
    warnings: {
      total: warnings.length,
      byType: summarizeWarnings(warnings),
    },
    deps: summarizeDeps(finalAnalysis.nodes),
    nondeterministicSelectors: nondetSelectors,
    performanceMs: {
      analysis: {
        iters: scenario.analysisIters,
        min: round(Math.min(...analysisTimes)),
        median: round(median(analysisTimes)),
        p95: round(percentile(analysisTimes, 95)),
        max: round(Math.max(...analysisTimes)),
      },
      pipeline: {
        iters: scenario.pipelineIters,
        min: round(Math.min(...pipelineTimes)),
        median: round(median(pipelineTimes)),
        p95: round(percentile(pipelineTimes, 95)),
        max: round(Math.max(...pipelineTimes)),
      },
    },
    binary: {
      totalBytes: finalBinary.length,
      poolEntries: finalPool.size,
      staticTierBytes: finalEmit.stats.staticTierBytes,
      dynamicIndexBytes: finalEmit.stats.dynamicIndexBytes,
      dynamicTierBytes: finalEmit.stats.dynamicTierBytes,
      staticComponents: finalLoader.stats.staticComponents,
      indexedDynamic: finalLoader.stats.indexedDynamic,
    },
  };
}

function toMarkdown(report) {
  const lines = [];
  lines.push("# Real Codebase Validation");
  lines.push("");
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push("");
  lines.push("## Targets");
  lines.push("");
  lines.push("| Target | Components | STATIC | DETERMINISTIC | NONDETERMINISTIC | Warnings | Source Size | Binary Size | Analysis ms (median/p95) |");
  lines.push("|---|---:|---:|---:|---:|---:|---:|---:|---:|");

  for (const s of report.scenarios) {
    lines.push(
      `| ${s.label} | ${s.components} | ${s.classification.static} (${s.classification.staticPct}%) | ` +
      `${s.classification.deterministic} (${s.classification.deterministicPct}%) | ` +
      `${s.classification.nondeterministic} (${s.classification.nondeterministicPct}%) | ` +
      `${s.warnings.total} | ${s.bytes} B | ${s.binary.totalBytes} B | ${s.performanceMs.analysis.median}/${s.performanceMs.analysis.p95} |`
    );
  }

  lines.push("");
  for (const s of report.scenarios) {
    lines.push(`## ${s.label}`);
    lines.push("");
    lines.push(`- Files: ${s.fileCount}`);
    lines.push(`- Components: ${s.components}`);
    lines.push(`- Warnings: ${s.warnings.total}`);
    lines.push(`- Binary: ${s.binary.totalBytes} bytes (pool: ${s.binary.poolEntries} entries)`);
    lines.push(`- Analysis ms: min ${s.performanceMs.analysis.min}, median ${s.performanceMs.analysis.median}, p95 ${s.performanceMs.analysis.p95}, max ${s.performanceMs.analysis.max}`);
    lines.push(`- Pipeline ms: min ${s.performanceMs.pipeline.min}, median ${s.performanceMs.pipeline.median}, p95 ${s.performanceMs.pipeline.p95}, max ${s.performanceMs.pipeline.max}`);
    lines.push("");
    lines.push("Warnings by type:");
    lines.push("");
    lines.push("```json");
    lines.push(JSON.stringify(s.warnings.byType, null, 2));
    lines.push("```");
    lines.push("");
    lines.push("Dependency distribution:");
    lines.push("");
    lines.push("```json");
    lines.push(JSON.stringify(s.deps, null, 2));
    lines.push("```");
    lines.push("");
    if (s.nondeterministicSelectors.length > 0) {
      lines.push("NONDETERMINISTIC selectors:");
      lines.push("");
      for (const sel of s.nondeterministicSelectors.slice(0, 25)) {
        lines.push(`- \`${sel}\``);
      }
      if (s.nondeterministicSelectors.length > 25) {
        lines.push(`- ... (${s.nondeterministicSelectors.length - 25} more)`);
      }
      lines.push("");
    }
  }
  return lines.join("\n");
}

function main() {
  const root = process.cwd();
  const rv = path.join(root, ".tmp", "real-validation");

  const scenarios = [
    {
      id: "radix_styles_compiled",
      label: "Radix UI Themes v3.3.0 (compiled styles.css)",
      files: [path.join(rv, "radix-pkg", "package", "styles.css")],
      analysisIters: 20,
      pipelineIters: 10,
    },
    {
      id: "radix_src_bundle",
      label: "Radix UI Themes v3.3.0 (src/**/*.css combined)",
      files: listCssFilesRecursively(path.join(rv, "radix-pkg", "package", "src")),
      analysisIters: 20,
      pipelineIters: 10,
    },
    {
      id: "tailwind_v4_index",
      label: "Tailwind CSS v4.1.18 (index.css)",
      files: [path.join(rv, "tailwind-pkg", "package", "index.css")],
      analysisIters: 20,
      pipelineIters: 10,
    },
    {
      id: "tailwind_v4_theme_preflight",
      label: "Tailwind CSS v4.1.18 (theme.css + preflight.css)",
      files: [
        path.join(rv, "tailwind-pkg", "package", "theme.css"),
        path.join(rv, "tailwind-pkg", "package", "preflight.css"),
      ],
      analysisIters: 20,
      pipelineIters: 10,
    },
    {
      id: "tailwind_v3_generated_extensive",
      label: "Tailwind CSS v3.4.17 (generated extensive corpus)",
      files: [path.join(rv, "tailwind3-gen", "generated.css")],
      analysisIters: 8,
      pipelineIters: 5,
    },
  ];

  for (const s of scenarios) {
    for (const f of s.files) {
      if (!fs.existsSync(f)) {
        throw new Error(`Missing scenario file: ${f}`);
      }
    }
  }

  const results = [];
  for (const scenario of scenarios) {
    console.log(`Running ${scenario.label} ...`);
    results.push(runScenario(scenario));
  }

  const report = {
    generatedAt: new Date().toISOString(),
    scenarios: results,
  };

  const outDir = path.join(root, "outputs");
  ensureDir(outDir);
  fs.writeFileSync(
    path.join(outDir, "real-codebase-validation-radix-tailwind.json"),
    JSON.stringify(report, null, 2),
    "utf8"
  );
  fs.writeFileSync(
    path.join(outDir, "real-codebase-validation-radix-tailwind.md"),
    toMarkdown(report),
    "utf8"
  );

  console.log("Wrote:");
  console.log("  outputs/real-codebase-validation-radix-tailwind.json");
  console.log("  outputs/real-codebase-validation-radix-tailwind.md");
}

if (require.main === module) {
  main();
}

