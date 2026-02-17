"use strict";

const assert = require("node:assert/strict");
const { analyseCSS, findNodeBySelector, findManifest } = require("./dist/src/analyser");
const { BindingClass, DepType } = require("./dist/src/types");
const { parseCSS } = require("./dist/src/cssparser");

let assertionCount = 0;

function eq(actual, expected, message) {
  assert.equal(actual, expected, message);
  assertionCount += 1;
}

function ok(condition, message) {
  assert.ok(condition, message);
  assertionCount += 1;
}

function getNode(analysis, selector) {
  const node = findNodeBySelector(analysis, selector);
  assert.ok(node, `Expected node for selector "${selector}"`);
  return node;
}

function runtimeDeps(node) {
  return node.deps.filter((d) => d.depType !== DepType.THEME);
}

function runCase1() {
  const css = `
    :root { --color-primary: #2563EB; }
    .button {
      display: flex;
      background-color: var(--color-primary);
      color: #FFFFFF;
      padding: 8px 16px;
      border-radius: 4px;
      font-size: 14px;
      font-weight: 600;
    }
  `;
  const analysis = analyseCSS(css, { sourceName: "case1.css" });
  const button = getNode(analysis, ".button");

  eq(analysis.summary.total, 1, "Case 1 should only emit one component node");
  eq(button.localClass, BindingClass.STATIC, "Case 1 local class must be static");
  eq(button.finalClass, BindingClass.STATIC, "Case 1 final class must be static");
  eq(button.emitType, "ResolvedStyleBlock", "Case 1 should emit ResolvedStyleBlock");
  eq(runtimeDeps(button).length, 0, "Case 1 should have no runtime deps");
  eq(analysis.manifests.length, 0, "Case 1 should emit no manifest");
  eq(
    analysis.tokens["--color-primary"].resolved,
    "#2563EBFF",
    "Case 1 token should normalize to 8-digit RGBA"
  );
  eq(
    analysis.tokens["--color-primary"].pointerTo,
    null,
    "Case 1 direct token should not keep a pointer indirection"
  );
}

function runCase2() {
  const css = `
    .label {
      color: #1E293B;
      font-size: 0.875rem;
      line-height: 1.5;
      padding: 4px 8px;
    }
  `;
  const analysis = analyseCSS(css, { sourceName: "case2.css" });
  const label = getNode(analysis, ".label");
  const manifest = findManifest(analysis, label.id);
  const fontDep = runtimeDeps(label).find((d) => d.property === "font-size");

  eq(analysis.summary.total, 1, "Case 2 should only emit one component node");
  eq(
    label.localClass,
    BindingClass.DETERMINISTIC,
    "Case 2 local class must be deterministic"
  );
  eq(
    label.finalClass,
    BindingClass.DETERMINISTIC,
    "Case 2 final class must be deterministic"
  );
  eq(fontDep.depType, DepType.FONT_METRICS, "Case 2 rem should map to FONT_METRICS");
  eq(analysis.manifests.length, 1, "Case 2 should emit one manifest");
  eq(manifest.componentId, label.id, "Case 2 manifest should be rooted at label");
  eq(manifest.depCount, 1, "Case 2 manifest should have one dependency");
  ok(
    manifest.subgraphIds.includes(label.id),
    "Case 2 manifest subgraph should include label"
  );
}

function runCase3() {
  const css = `
    :root { --color-text: #1E293B; }
    .container {
      width: 50%;
      background: #F8FAFC;
      padding: 16px;
    }
    .container .title {
      font-size: 18px;
      color: #1E293B;
    }
    .container .body {
      font-size: 14px;
      color: var(--color-text);
    }
  `;
  const analysis = analyseCSS(css, { sourceName: "case3.css" });
  const container = getNode(analysis, ".container");
  const title = getNode(analysis, ".container .title");
  const body = getNode(analysis, ".container .body");
  const manifest = findManifest(analysis, container.id);

  eq(
    container.localClass,
    BindingClass.DETERMINISTIC,
    "Case 3 container local class must be deterministic"
  );
  eq(title.localClass, BindingClass.STATIC, "Case 3 title local class should be static");
  eq(body.localClass, BindingClass.STATIC, "Case 3 body local class should be static");
  eq(
    title.finalClass,
    BindingClass.DETERMINISTIC,
    "Case 3 title should be contaminated to deterministic"
  );
  eq(
    body.finalClass,
    BindingClass.DETERMINISTIC,
    "Case 3 body should be contaminated to deterministic"
  );
  eq(
    title.contaminationSource,
    container.id,
    "Case 3 title contamination source should be container"
  );
  eq(
    body.contaminationSource,
    container.id,
    "Case 3 body contamination source should be container"
  );
  eq(analysis.manifests.length, 1, "Case 3 should emit one boundary manifest");
  eq(
    manifest.componentId,
    container.id,
    "Case 3 manifest should be rooted at container"
  );
  ok(
    manifest.subgraphIds.includes(container.id) &&
      manifest.subgraphIds.includes(title.id) &&
      manifest.subgraphIds.includes(body.id),
    "Case 3 subgraphIds should include container, title, and body"
  );
  ok(
    manifest.entries.some(
      (e) =>
        e.componentId === container.id &&
        e.property === "width" &&
        e.depType === DepType.PARENT_SIZE
    ),
    "Case 3 manifest should include container width PARENT_SIZE dependency"
  );
}

function runCase4() {
  const css = `
    .root-context {
      background: #FFFFFF;
    }
    .sidebar {
      width: 30vw;
      background: #1B2A4A;
    }
    .sidebar .modal {
      PORTAL_ID: root-context;
      background: #FFFFFF;
      padding: 24px;
      border-radius: 8px;
    }
  `;
  const analysis = analyseCSS(css, { sourceName: "case4.css" });
  const sidebar = getNode(analysis, ".sidebar");
  const modal = getNode(analysis, ".sidebar .modal");
  const sidebarManifest = findManifest(analysis, sidebar.id);

  eq(
    sidebar.localClass,
    BindingClass.DETERMINISTIC,
    "Case 4 sidebar local class must be deterministic"
  );
  eq(
    sidebar.finalClass,
    BindingClass.DETERMINISTIC,
    "Case 4 sidebar final class must be deterministic"
  );
  eq(modal.localClass, BindingClass.STATIC, "Case 4 modal local class should be static");
  eq(
    modal.finalClass,
    BindingClass.STATIC,
    "Case 4 modal must remain static due to PORTAL contamination severance"
  );
  eq(
    modal.contaminationSource,
    null,
    "Case 4 modal should not inherit contamination from sidebar"
  );
  eq(analysis.manifests.length, 1, "Case 4 should emit one manifest");
  eq(
    sidebarManifest.componentId,
    sidebar.id,
    "Case 4 manifest should be rooted at sidebar"
  );
  eq(
    modal.emitType,
    "ResolvedStyleBlock",
    "Case 4 modal should emit as static block"
  );
}

function runCase5() {
  const css = `
    :root {
      --color-base: #2563EB;
      --color-brand: var(--color-base);
      --color-primary: var(--color-brand);
    }
    .cta-button {
      background-color: var(--color-primary);
      color: #FFFFFF;
      padding: 12px 24px;
    }
  `;
  const analysis = analyseCSS(css, { sourceName: "case5.css" });
  const button = getNode(analysis, ".cta-button");

  eq(analysis.summary.total, 1, "Case 5 should only emit one component node");
  eq(button.finalClass, BindingClass.STATIC, "Case 5 cta button must be static");
  eq(analysis.manifests.length, 0, "Case 5 should emit no manifest");
  ok(analysis.tokens["--color-base"], "Case 5 should keep base token");
  eq(
    analysis.tokens["--color-primary"].pointerTo,
    "--color-base",
    "Case 5 primary token should flatten to base pointer"
  );
  eq(
    analysis.tokens["--color-primary"].resolved,
    "#2563EBFF",
    "Case 5 primary token should resolve to base absolute value"
  );
  eq(
    analysis.tokens["--color-brand"].pointerTo,
    "--color-base",
    "Case 5 brand token should also flatten to base pointer"
  );
  eq(runtimeDeps(button).length, 0, "Case 5 button should have no runtime deps");
  eq(
    button.normalizedDeclarations["color"],
    "#FFFFFFFF",
    "Case 5 should normalize 6-digit hex to 8-digit RGBA"
  );
}

function runCase6() {
  const css = `
    .card {
      container-type: inline-size;
      width: 100%;
      padding: 16px;
    }
    .card .card-body {
      font-size: max(14px, 2cqw);
    }
  `;
  const analysis = analyseCSS(css, { sourceName: "case6.css" });
  const card = getNode(analysis, ".card");
  const body = getNode(analysis, ".card .card-body");
  const manifest = findManifest(analysis, card.id);
  const bodyContainerDep = runtimeDeps(body).find(
    (d) => d.depType === DepType.CONTAINER_SIZE
  );

  eq(
    card.localClass,
    BindingClass.DETERMINISTIC,
    "Case 6 card local class must be deterministic"
  );
  eq(
    body.localClass,
    BindingClass.DETERMINISTIC,
    "Case 6 body local class must be deterministic"
  );
  eq(
    card.finalClass,
    BindingClass.DETERMINISTIC,
    "Case 6 card final class must be deterministic"
  );
  eq(
    body.finalClass,
    BindingClass.DETERMINISTIC,
    "Case 6 body final class must be deterministic"
  );
  eq(
    bodyContainerDep.depType,
    DepType.CONTAINER_SIZE,
    "Case 6 body font-size should be CONTAINER_SIZE-dependent"
  );
  eq(
    bodyContainerDep.containerId,
    card.id,
    "Case 6 body CONTAINER_SIZE dep should reference the nearest container"
  );
  eq(analysis.manifests.length, 1, "Case 6 should emit one boundary manifest");
  eq(manifest.componentId, card.id, "Case 6 manifest should be rooted at card");
  ok(
    manifest.subgraphIds.includes(card.id) && manifest.subgraphIds.includes(body.id),
    "Case 6 manifest subgraph should include card and card-body"
  );
  ok(
    manifest.entries.some(
      (e) =>
        e.componentId === card.id &&
        e.property === "width" &&
        e.depType === DepType.PARENT_SIZE
    ),
    "Case 6 manifest should include card width PARENT_SIZE dependency"
  );
  ok(
    manifest.entries.some(
      (e) =>
        e.componentId === body.id &&
        e.property === "font-size" &&
        e.depType === DepType.CONTAINER_SIZE &&
        e.containerId === card.id
    ),
    "Case 6 manifest should include body font-size CONTAINER_SIZE dependency with container ID"
  );
}

function runTokenChainLeafResolution() {
  const staticLeafCss = `
    :root {
      --spacing-m: 16px;
      --card-padding: var(--spacing-m);
    }
    .card {
      padding: var(--card-padding);
    }
  `;
  const dynamicLeafCss = `
    :root {
      --spacing-m: 2rem;
      --card-padding: var(--spacing-m);
    }
    .card {
      padding: var(--card-padding);
    }
  `;

  const staticAnalysis = analyseCSS(staticLeafCss, { sourceName: "token-static.css" });
  const staticCard = getNode(staticAnalysis, ".card");
  eq(
    staticCard.localClass,
    BindingClass.STATIC,
    "Token chain ending in absolute leaf should remain static"
  );
  eq(
    staticCard.finalClass,
    BindingClass.STATIC,
    "Absolute token chain should not force runtime classification"
  );
  eq(
    runtimeDeps(staticCard).length,
    0,
    "Absolute token chain should not emit runtime dependency entries"
  );

  const dynamicAnalysis = analyseCSS(dynamicLeafCss, { sourceName: "token-dynamic.css" });
  const dynamicCard = getNode(dynamicAnalysis, ".card");
  const dep = runtimeDeps(dynamicCard).find((entry) => entry.property === "padding");
  const manifest = findManifest(dynamicAnalysis, dynamicCard.id);
  eq(
    dynamicCard.localClass,
    BindingClass.DETERMINISTIC,
    "Token chain ending in rem leaf should classify as deterministic"
  );
  eq(
    dynamicCard.finalClass,
    BindingClass.DETERMINISTIC,
    "Runtime-dependent token leaf should propagate to final class"
  );
  eq(
    dep.depType,
    DepType.FONT_METRICS,
    "rem token leaf should emit FONT_METRICS dependency"
  );
  eq(
    manifest.depCount,
    1,
    "Runtime token chain should produce one manifest entry for padding"
  );
}

function runParserDepthAwareness() {
  const css = `
    @import url(data:text/css,{.x{color:red}});
    .parent:is(.a, .b) {
      width: 50%;
    }
    .parent:is(.a, .b) > .child {
      color: #fff;
    }
    .standalone {
      color: red;
    }
  `;

  const parsed = parseCSS(css);
  eq(
    parsed.rules.length,
    3,
    "Parser should ignore braces inside url(...) when detecting rule boundaries"
  );

  const analysis = analyseCSS(css, { sourceName: "parser-depth.css" });
  const parent = getNode(analysis, ".parent:is(.a, .b)");
  const child = getNode(analysis, ".parent:is(.a, .b) > .child");
  const standalone = getNode(analysis, ".standalone");

  eq(
    parent.localClass,
    BindingClass.DETERMINISTIC,
    "Parent selector with :is() should classify normally"
  );
  eq(
    child.treeParentId,
    parent.id,
    "Depth-aware parent extraction should link child to :is()-based parent selector"
  );
  eq(
    child.finalClass,
    BindingClass.DETERMINISTIC,
    "Child should be contaminated by dynamic parent after parent extraction fix"
  );
  eq(
    child.contaminationSource,
    parent.id,
    "Contamination source should point to parent extracted through :is() selector"
  );
  eq(
    standalone.finalClass,
    BindingClass.STATIC,
    "Unrelated standalone rule should parse and classify correctly"
  );
}

runCase1();
runCase2();
runCase3();
runCase4();
runCase5();
runCase6();
runTokenChainLeafResolution();
runParserDepthAwareness();

assert.equal(assertionCount, 68, "Expected exactly 68 assertions");
console.log(`All tests passed (${assertionCount}/68 assertions).`);

