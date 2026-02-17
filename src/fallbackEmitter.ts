const { fnv1a32 } = require("./emitter");

type DeclarationMap = Map<string, string>;

type FallbackRule = {
  selector: string;
  declarations: DeclarationMap;
};

type FallbackOptions = {
  includeBanner?: boolean;
  bannerText?: string;
};

type FallbackStats = {
  sourceNondeterministicNodes: number;
  ruleCount: number;
  declarationCount: number;
};

type FallbackResult = {
  css: string;
  rules: FallbackRule[];
  stats: FallbackStats;
};

function normaliseNodes(analysisResult: any): any[] {
  if (!analysisResult) return [];

  const nodes = analysisResult.nodes;
  if (nodes instanceof Map) {
    return Array.from(nodes.values());
  }
  if (Array.isArray(nodes)) {
    return nodes;
  }

  return [];
}

function readRawDeclarationValue(value: any): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (typeof value === "object") {
    if (typeof value.raw === "string") return value.raw;
    if (typeof value.value === "string") return value.value;
  }
  return null;
}

function collectDeclarations(node: any): DeclarationMap {
  const out = new Map<string, string>();

  if (node?.properties instanceof Map) {
    for (const [name, value] of node.properties.entries()) {
      const raw = readRawDeclarationValue(value);
      if (!name || raw === null) continue;
      out.set(String(name), String(raw).trim());
    }
    return out;
  }

  if (node?.declarations && typeof node.declarations === "object") {
    for (const [name, value] of Object.entries(node.declarations)) {
      const raw = readRawDeclarationValue(value);
      if (!name || raw === null) continue;
      out.set(String(name), String(raw).trim());
    }
    return out;
  }

  if (node?.normalizedDeclarations && typeof node.normalizedDeclarations === "object") {
    for (const [name, value] of Object.entries(node.normalizedDeclarations)) {
      const raw = readRawDeclarationValue(value);
      if (!name || raw === null) continue;
      out.set(String(name), String(raw).trim());
    }
  }

  return out;
}

function isNondeterministic(node: any): boolean {
  return String(node?.finalClass || "") === "BIND_NONDETERMINISTIC";
}

function sortRulesForBinaryParity(rules: FallbackRule[]): FallbackRule[] {
  return rules.slice().sort((a, b) => {
    const ha = fnv1a32(a.selector) >>> 0;
    const hb = fnv1a32(b.selector) >>> 0;
    if (ha !== hb) return ha - hb;
    return a.selector.localeCompare(b.selector);
  });
}

export function collectFallbackRules(analysisResult: any): FallbackRule[] {
  const mergedBySelector = new Map<string, DeclarationMap>();

  for (const node of normaliseNodes(analysisResult)) {
    if (!isNondeterministic(node)) continue;

    const selector = String(node?.selector || "").trim();
    if (!selector) continue;

    const existing = mergedBySelector.get(selector) || new Map<string, string>();
    const declarations = collectDeclarations(node);
    for (const [name, value] of declarations.entries()) {
      existing.set(name, value);
    }
    mergedBySelector.set(selector, existing);
  }

  const rules: FallbackRule[] = [];
  for (const [selector, declarations] of mergedBySelector.entries()) {
    rules.push({ selector, declarations });
  }

  return sortRulesForBinaryParity(rules);
}

export function emitFallbackCss(
  analysisResult: any,
  options: FallbackOptions = {}
): FallbackResult {
  const includeBanner = options.includeBanner !== false;
  const banner =
    options.bannerText ||
    "binary-som fallback.css (NONDETERMINISTIC selectors only)";

  const rules = collectFallbackRules(analysisResult);

  const lines: string[] = [];
  if (includeBanner) {
    lines.push(`/* ${banner} */`);
  }

  let declarationCount = 0;
  for (const rule of rules) {
    lines.push(`${rule.selector} {`);
    for (const [name, value] of rule.declarations.entries()) {
      lines.push(`  ${name}: ${value};`);
      declarationCount += 1;
    }
    lines.push("}");
  }

  const css = `${lines.join("\n")}\n`;

  const stats: FallbackStats = {
    sourceNondeterministicNodes: normaliseNodes(analysisResult).filter(isNondeterministic).length,
    ruleCount: rules.length,
    declarationCount,
  };

  return { css, rules, stats };
}
