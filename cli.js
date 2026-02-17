"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { analyseCSS } = require("./dist/src/analyser");
const { renderReport, toJSON } = require("./dist/src/reporter");
const { buildPoolFromAnalysis } = require("./src/constantPool");
const { emitComponentSection, assembleBinary } = require("./src/emitter");
const { SOMWatcher } = require("./src/watcher");

function usage() {
  return [
    "Usage:",
    "  node cli.js <css-file-or-glob> [more files...] [--manifests] [--json] [--out <file>] [--som-out <file>] [--watch]",
    "",
    "Examples:",
    "  node cli.js test/sample.css --manifests",
    "  node cli.js src/**/*.css --json --out outputs/report.json",
    "  node cli.js test/sample.css --som-out outputs/sample.som",
    "  node cli.js src/**/*.css --watch",
  ].join("\n");
}

function normalizePathForMatch(p) {
  return p.replace(/\\/g, "/");
}

function globToRegex(glob) {
  const normalized = normalizePathForMatch(glob);
  const escaped = normalized.replace(/([.+^=!:${}()|[\]/\\])/g, "\\$1");
  const regexBody = escaped
    .replace(/\\\*\\\*/g, ".*")
    .replace(/\\\*/g, "[^/]*")
    .replace(/\\\?/g, ".");
  return new RegExp(`^${regexBody}$`);
}

function walkFiles(rootDir) {
  const out = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (error) {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        out.push(full);
      }
    }
  }
  return out;
}

function expandInputPattern(input) {
  const absoluteInput = path.resolve(input);
  if (!/[*?]/.test(input)) {
    if (fs.existsSync(absoluteInput) && fs.statSync(absoluteInput).isFile()) {
      return [absoluteInput];
    }
    return [];
  }

  const firstWildcard = normalizePathForMatch(input).search(/[*?]/);
  const preWildcard = firstWildcard >= 0 ? input.slice(0, firstWildcard) : input;
  const baseDir = preWildcard
    ? path.resolve(preWildcard.replace(/[\\/][^\\/]*$/, ""))
    : process.cwd();
  const safeBase = fs.existsSync(baseDir) ? baseDir : process.cwd();
  const matcher = globToRegex(path.resolve(input).replace(/\\/g, "/"));
  const files = walkFiles(safeBase)
    .map((f) => path.resolve(f))
    .filter((f) => matcher.test(normalizePathForMatch(f)));
  return files;
}

function ensureDirForFile(filePath) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
}

function parseArgs(argv) {
  const files = [];
  let manifests = false;
  let json = false;
  let out = null;
  let somOut = null;
  let watch = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--manifests") {
      manifests = true;
      continue;
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--out") {
      out = argv[i + 1] || null;
      i += 1;
      continue;
    }
    if (arg === "--som-out") {
      somOut = argv[i + 1] || null;
      i += 1;
      continue;
    }
    if (arg === "--watch") {
      watch = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      return { help: true };
    }
    files.push(arg);
  }

  return { help: false, files, manifests, json, out, somOut, watch };
}

function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.help || parsed.files.length === 0) {
    console.log(usage());
    process.exitCode = parsed.help ? 0 : 2;
    return;
  }

  const expanded = new Set();
  for (const input of parsed.files) {
    const matches = expandInputPattern(input);
    for (const file of matches) {
      if (file.toLowerCase().endsWith(".css")) {
        expanded.add(file);
      }
    }
  }

  const files = [...expanded].sort();
  if (files.length === 0) {
    console.error("No CSS files matched the provided inputs.");
    process.exitCode = 2;
    return;
  }

  if (parsed.watch) {
    if (parsed.somOut || parsed.json || parsed.out || parsed.manifests) {
      console.error("--watch is diff-only and cannot be combined with --som-out, --json, --out, or --manifests.");
      process.exitCode = 2;
      return;
    }

    const watcher = new SOMWatcher(files, { verbose: true });
    watcher.start();
    process.on("SIGINT", () => {
      watcher.stop();
      process.exit(0);
    });
    process.on("SIGTERM", () => {
      watcher.stop();
      process.exit(0);
    });
    return;
  }

  const analyses = [];
  let hadError = false;
  for (const file of files) {
    try {
      const source = fs.readFileSync(file, "utf8");
      analyses.push(analyseCSS(source, { sourceName: file }));
    } catch (error) {
      hadError = true;
      console.error(`Failed to analyse ${file}: ${error.message}`);
    }
  }

  if (hadError) {
    process.exitCode = 2;
    return;
  }

  if (parsed.somOut) {
    if (analyses.length !== 1) {
      console.error("--som-out currently supports exactly one input CSS file.");
      process.exitCode = 2;
      return;
    }
    try {
      const analysis = analyses[0];
      const pool = buildPoolFromAnalysis(analysis);
      const emit = emitComponentSection(analysis, pool);
      const binary = assembleBinary(
        pool.serialise(),
        emit.staticTier,
        emit.dynamicIndex,
        emit.dynamicTier
      );
      const somPath = path.resolve(parsed.somOut);
      ensureDirForFile(somPath);
      fs.writeFileSync(somPath, binary);
    } catch (error) {
      console.error(`Failed to emit .som binary: ${error.message}`);
      process.exitCode = 2;
      return;
    }
  }

  const hasNondeterministic = analyses.some(
    (analysis) => analysis.summary.nondeterministic > 0
  );

  let output = "";
  if (parsed.json) {
    output =
      analyses.length === 1
        ? toJSON(analyses[0])
        : JSON.stringify({ files: analyses }, null, 2);
  } else {
    output = analyses
      .map((analysis) => renderReport(analysis, { manifests: parsed.manifests }))
      .join("\n\n");
  }

  if (parsed.out) {
    const absoluteOut = path.resolve(parsed.out);
    ensureDirForFile(absoluteOut);
    fs.writeFileSync(absoluteOut, output, "utf8");
  } else {
    console.log(output);
  }

  process.exitCode = hasNondeterministic ? 1 : 0;
}

if (require.main === module) {
  main();
}

module.exports = {
  main,
};

