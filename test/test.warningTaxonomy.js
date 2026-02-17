"use strict";

const { analyseCSS } = require("../dist/src/analyser");

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
  console.log(`\n${"=".repeat(60)}\n  ${title}\n${"=".repeat(60)}`);
}

function getNode(result, selector) {
  if (result?.nodes instanceof Map) {
    return result.nodes.get(selector) || null;
  }
  if (Array.isArray(result?.nodes)) {
    return (
      result.nodes.find((node) => node.selector === selector || node.id === selector) ||
      null
    );
  }
  return null;
}

function getWarnings(result) {
  return Array.isArray(result?.warnings) ? result.warnings : [];
}

section("1. UNRESOLVED_TOKEN - token references undefined peer");
{
  const r = analyseCSS(`
    :root { --gray-a6: var(--slate-a6); }
    .btn { color: var(--gray-a6); }
  `);

  const unresolvedWarns = getWarnings(r).filter(
    (w) => w && typeof w === "object" && w.type === "UNRESOLVED_TOKEN"
  );
  assert("UNRESOLVED_TOKEN warning present", unresolvedWarns.length > 0, true);

  const w = unresolvedWarns[0];
  assert("type is UNRESOLVED_TOKEN", w?.type, "UNRESOLVED_TOKEN");
  assert("tokenName is --gray-a6", w?.tokenName, "--gray-a6");
  assert("referencedToken is --slate-a6", w?.referencedToken, "--slate-a6");
  assert("msg is a string", typeof w?.msg, "string");
  assert(
    "no OTHER/DEP_WARNING for this scenario",
    getWarnings(r).filter(
      (x) => x && typeof x === "object" && (x.type === "OTHER" || x.type === "DEP_WARNING")
    ).length,
    0
  );
}

section("2. UNDEFINED_TOKEN - token used in value but never declared");
{
  const r = analyseCSS(`
    .hero { background: var(--brand-primary); color: white; }
  `);

  const undefWarns = getWarnings(r).filter(
    (w) => w && typeof w === "object" && w.type === "UNDEFINED_TOKEN"
  );
  assert("UNDEFINED_TOKEN warning present", undefWarns.length > 0, true);

  const w = undefWarns[0];
  assert("type is UNDEFINED_TOKEN", w?.type, "UNDEFINED_TOKEN");
  assert("tokenName present", !!w?.tokenName, true);
  assert("msg is a string", typeof w?.msg, "string");
  assert(
    "no OTHER warnings",
    getWarnings(r).filter(
      (x) => x && typeof x === "object" && (x.type === "OTHER" || x.type === "DEP_WARNING")
    ).length,
    0
  );
}

{
  const r = analyseCSS(`
    .card { background: var(--missing-bg); color: var(--missing-text); }
  `);
  const undefWarns = getWarnings(r).filter(
    (w) => w && typeof w === "object" && w.type === "UNDEFINED_TOKEN"
  );
  assert("two UNDEFINED_TOKEN warnings for two missing tokens", undefWarns.length >= 2, true);
  const tokenNames = undefWarns.map((w) => w.tokenName);
  assert("--missing-bg reported", tokenNames.some((n) => n === "--missing-bg"), true);
  assert("--missing-text reported", tokenNames.some((n) => n === "--missing-text"), true);
}

section("3. MIXED_OPERANDS - calc() with absolute and runtime operands");
{
  const r = analyseCSS(`
    .sidebar { width: calc(100% - 48px); }
  `);

  const mixedWarns = getWarnings(r).filter(
    (w) => w && typeof w === "object" && w.type === "MIXED_OPERANDS"
  );
  assert("MIXED_OPERANDS warning present", mixedWarns.length > 0, true);

  const w = mixedWarns[0];
  assert("type is MIXED_OPERANDS", w?.type, "MIXED_OPERANDS");
  assert(
    "propertyName is width",
    w?.propertyName === "width" || String(w?.msg || "").includes("width"),
    true
  );
  assert("msg is a string", typeof w?.msg, "string");
  assert("component is DETERMINISTIC", getNode(r, ".sidebar")?.finalClass, "BIND_DETERMINISTIC");
  assert(
    "no OTHER warnings",
    getWarnings(r).filter(
      (x) => x && typeof x === "object" && (x.type === "OTHER" || x.type === "DEP_WARNING")
    ).length,
    0
  );
}

{
  const r = analyseCSS(`
    .x { width: calc(100% - 10vw); }
  `);
  assert(
    "calc(% - vw): no MIXED_OPERANDS (both runtime)",
    getWarnings(r).filter((w) => w && typeof w === "object" && w.type === "MIXED_OPERANDS").length,
    0
  );
  assert("calc(% - vw): DETERMINISTIC", getNode(r, ".x")?.finalClass, "BIND_DETERMINISTIC");
}

{
  const r = analyseCSS(`
    .x { width: calc(100px + 48px); }
  `);
  assert(
    "calc(px + px): no MIXED_OPERANDS (both absolute)",
    getWarnings(r).filter((w) => w && typeof w === "object" && w.type === "MIXED_OPERANDS").length,
    0
  );
  assert("calc(px + px): STATIC", getNode(r, ".x")?.finalClass, "BIND_STATIC");
}

section("4. Warning objects have correct shape (no legacy string warnings)");
{
  const r = analyseCSS(`
    :root { --a: var(--missing); }
    .x { width: calc(100% - 8px); background: var(--a); }
    .y { color: var(--undefined-token); }
  `);

  let rawStringWarnings = 0;
  let malformedWarnings = 0;

  for (const w of getWarnings(r)) {
    if (typeof w === "string") {
      rawStringWarnings += 1;
      continue;
    }
    if (!w.type || !w.msg) {
      malformedWarnings += 1;
    }
  }

  assert("no raw string warnings", rawStringWarnings, 0);
  assert("no malformed warning objs", malformedWarnings, 0);

  const knownTypes = new Set([
    "STRUCTURAL_DYNAMIC",
    "MISSING_CONTAINER",
    "UNKNOWN_PARENT",
    "PORTAL_MISSING",
    "UNRESOLVED_TOKEN",
    "UNDEFINED_TOKEN",
    "MIXED_OPERANDS",
    "DEP_WARNING",
  ]);
  const unknownTypeWarnings = getWarnings(r).filter(
    (w) => !w || typeof w !== "object" || !knownTypes.has(w.type)
  );
  assert("all warnings have known types", unknownTypeWarnings.length, 0);
}

section("5. Existing warning types still work after taxonomy change");
{
  const r = analyseCSS(`.table tr:nth-child(even) { background: #f0f0f0; }`);
  assert(
    "STRUCTURAL_DYNAMIC still fires",
    getWarnings(r).some((w) => w && typeof w === "object" && w.type === "STRUCTURAL_DYNAMIC"),
    true
  );
}

{
  const r = analyseCSS(`.card { font-size: 2cqw; }`);
  assert(
    "MISSING_CONTAINER still fires",
    getWarnings(r).some((w) => w && typeof w === "object" && w.type === "MISSING_CONTAINER"),
    true
  );
}

section("6. Radix-style multi-file alias pattern");
{
  const r = analyseCSS(`
    :root {
      --gray-1:  var(--slate-1);
      --gray-2:  var(--slate-2);
      --gray-3:  var(--slate-3);
      --gray-a1: var(--slate-a1);
      --gray-a2: var(--slate-a2);
    }
    .rt-Card { background: var(--gray-1); border-color: var(--gray-2); }
  `);

  const unresolvedWarns = getWarnings(r).filter(
    (w) => w && typeof w === "object" && w.type === "UNRESOLVED_TOKEN"
  );
  assert("5 UNRESOLVED_TOKEN warnings (one per alias)", unresolvedWarns.length, 5);

  const names = unresolvedWarns.map((w) => w.tokenName).sort();
  assert("--gray-1 reported", names.includes("--gray-1"), true);
  assert("--gray-a2 reported", names.includes("--gray-a2"), true);

  const refs = unresolvedWarns.map((w) => w.referencedToken);
  assert(
    "all referenced tokens are --slate-*",
    refs.every((ref) => String(ref || "").startsWith("--slate-")),
    true
  );

  const card = getNode(r, ".rt-Card");
  assert(".rt-Card still gets a classification", !!card?.finalClass, true);
}

section("7. Warning deduplication");
{
  const r = analyseCSS(`
    .a { color: var(--ghost); }
    .b { background: var(--ghost); }
    .c { border-color: var(--ghost); }
  `);

  const ghostWarns = getWarnings(r).filter(
    (w) => w && typeof w === "object" && w.type === "UNDEFINED_TOKEN" && w.tokenName === "--ghost"
  );
  assert("at least 1 UNDEFINED_TOKEN for --ghost", ghostWarns.length >= 1, true);
  assert("at most 3 UNDEFINED_TOKEN for --ghost (one per node)", ghostWarns.length <= 3, true);
}

console.log(`\n${"=".repeat(60)}\n  Results: ${passed} passed, ${failed} failed`);

if (failed > 0) {
  console.log("\n  FAILURES:");
  for (const f of failures) {
    console.log(`  x ${f.label}`);
    console.log(`      exp: ${JSON.stringify(f.expected)}`);
    console.log(`      got: ${JSON.stringify(f.actual)}`);
  }
  process.exitCode = 1;
} else {
  console.log("  ✓ All warning taxonomy tests passed.\n");
}


