function stripComments(source: unknown): string {
  return String(source || "").replace(/\/\*[\s\S]*?\*\//g, "");
}

function normalizeSelector(selector: unknown): string {
  return String(selector || "")
    .trim()
    .replace(/\s+/g, " ");
}

function splitBySemicolon(block: string): string[] {
  const parts: string[] = [];
  let current = "";
  let depthParens = 0;
  let depthBrackets = 0;
  let quote: string | null = null;

  for (let i = 0; i < block.length; i += 1) {
    const ch = block[i];
    const prev = i > 0 ? block[i - 1] : "";

    if ((ch === "'" || ch === '"') && prev !== "\\") {
      if (quote === ch) {
        quote = null;
      } else if (quote === null) {
        quote = ch;
      }
      current += ch;
      continue;
    }

    if (quote) {
      current += ch;
      continue;
    }

    if (ch === "(") depthParens += 1;
    else if (ch === ")" && depthParens > 0) depthParens -= 1;
    else if (ch === "[") depthBrackets += 1;
    else if (ch === "]" && depthBrackets > 0) depthBrackets -= 1;

    if (ch === ";" && depthParens === 0 && depthBrackets === 0) {
      if (current.trim()) {
        parts.push(current.trim());
      }
      current = "";
      continue;
    }

    current += ch;
  }

  if (current.trim()) {
    parts.push(current.trim());
  }

  return parts;
}

export function splitByComma(input: string): string[] {
  const values: string[] = [];
  let current = "";
  let depthParens = 0;
  let depthBrackets = 0;
  let quote: string | null = null;

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    const prev = i > 0 ? input[i - 1] : "";

    if ((ch === "'" || ch === '"') && prev !== "\\") {
      if (quote === ch) quote = null;
      else if (quote === null) quote = ch;
      current += ch;
      continue;
    }

    if (quote) {
      current += ch;
      continue;
    }

    if (ch === "(") depthParens += 1;
    else if (ch === ")" && depthParens > 0) depthParens -= 1;
    else if (ch === "[") depthBrackets += 1;
    else if (ch === "]" && depthBrackets > 0) depthBrackets -= 1;

    if (ch === "," && depthParens === 0 && depthBrackets === 0) {
      if (current.trim()) {
        values.push(current.trim());
      }
      current = "";
      continue;
    }

    current += ch;
  }

  if (current.trim()) {
    values.push(current.trim());
  }

  return values;
}

export interface SelectorSegment {
  type: "simple" | "combinator";
  value: string;
}

export function tokeniseSelectorSegments(selector: unknown): SelectorSegment[] {
  const segments: SelectorSegment[] = [];
  const input = normalizeSelector(selector);
  let current = "";
  let parenDepth = 0;
  let bracketDepth = 0;
  let quote: string | null = null;

  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    const prev = i > 0 ? input[i - 1] : "";

    if ((ch === "'" || ch === '"') && prev !== "\\") {
      if (quote === ch) quote = null;
      else if (quote === null) quote = ch;
      current += ch;
      i += 1;
      continue;
    }

    if (quote) {
      current += ch;
      i += 1;
      continue;
    }

    if (ch === "(") {
      parenDepth += 1;
      current += ch;
      i += 1;
      continue;
    }
    if (ch === ")" && parenDepth > 0) {
      parenDepth -= 1;
      current += ch;
      i += 1;
      continue;
    }
    if (ch === "[") {
      bracketDepth += 1;
      current += ch;
      i += 1;
      continue;
    }
    if (ch === "]" && bracketDepth > 0) {
      bracketDepth -= 1;
      current += ch;
      i += 1;
      continue;
    }

    if (parenDepth === 0 && bracketDepth === 0) {
      if (ch === ">" || ch === "+" || ch === "~") {
        if (current.trim()) {
          segments.push({ type: "simple", value: current.trim() });
        }
        segments.push({ type: "combinator", value: ch });
        current = "";
        i += 1;
        while (i < input.length && input[i] === " ") i += 1;
        continue;
      }

      if (ch === " ") {
        const ahead = input.slice(i).trimStart();
        const nextNonSpace = ahead[0];
        if (
          nextNonSpace &&
          nextNonSpace !== ">" &&
          nextNonSpace !== "+" &&
          nextNonSpace !== "~"
        ) {
          if (current.trim()) {
            segments.push({ type: "simple", value: current.trim() });
          }
          segments.push({ type: "combinator", value: " " });
          current = "";
          while (i < input.length && input[i] === " ") i += 1;
          continue;
        }
      }
    }

    current += ch;
    i += 1;
  }

  if (current.trim()) {
    segments.push({ type: "simple", value: current.trim() });
  }
  return segments;
}

export function extractParentSelector(selector: unknown): string | null {
  const segments = tokeniseSelectorSegments(selector);
  const simpleCount = segments.filter((s) => s.type === "simple").length;
  if (simpleCount <= 1) return null;

  const lastSimpleIdx = segments.map((s) => s.type).lastIndexOf("simple");
  const parentSegments = segments.slice(0, lastSimpleIdx);
  while (
    parentSegments.length &&
    parentSegments[parentSegments.length - 1].type === "combinator"
  ) {
    parentSegments.pop();
  }

  const parent = parentSegments
    .map((s) => s.value)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return parent || null;
}

function parseDeclarations(block: string): Record<string, string> {
  const declarations: Record<string, string> = {};
  const declList = splitBySemicolon(block);
  for (const decl of declList) {
    const parsed = parseDeclaration(decl);
    if (!parsed) continue;
    declarations[parsed.property] = parsed.value;
  }
  return declarations;
}

function parseDeclaration(
  decl: unknown
): { property: string; value: string } | null {
  const text = String(decl || "").trim();
  if (!text) return null;

  let depthParens = 0;
  let depthBrackets = 0;
  let quote: string | null = null;
  let colonIdx = -1;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const prev = i > 0 ? text[i - 1] : "";
    if ((ch === "'" || ch === '"') && prev !== "\\") {
      if (quote === ch) quote = null;
      else if (quote === null) quote = ch;
      continue;
    }

    if (quote) continue;

    if (ch === "(") depthParens += 1;
    else if (ch === ")" && depthParens > 0) depthParens -= 1;
    else if (ch === "[") depthBrackets += 1;
    else if (ch === "]" && depthBrackets > 0) depthBrackets -= 1;

    if (ch === ":" && depthParens === 0 && depthBrackets === 0) {
      colonIdx = i;
      break;
    }
  }

  if (colonIdx === -1) return null;
  const property = text.slice(0, colonIdx).trim();
  const value = text.slice(colonIdx + 1).trim();
  if (!property || !value) return null;
  if (property.startsWith("@")) return null;
  return { property, value };
}

function findTopLevelTerminator(
  text: string,
  startIdx: number
): { index: number; kind: "block" | "statement" } | null {
  let parenDepth = 0;
  let bracketDepth = 0;
  let quote: string | null = null;

  for (let i = startIdx; i < text.length; i += 1) {
    const ch = text[i];
    const prev = i > 0 ? text[i - 1] : "";

    if ((ch === "'" || ch === '"') && prev !== "\\") {
      if (quote === ch) quote = null;
      else if (quote === null) quote = ch;
      continue;
    }
    if (quote) continue;

    if (ch === "(") {
      parenDepth += 1;
      continue;
    }
    if (ch === ")" && parenDepth > 0) {
      parenDepth -= 1;
      continue;
    }
    if (ch === "[") {
      bracketDepth += 1;
      continue;
    }
    if (ch === "]" && bracketDepth > 0) {
      bracketDepth -= 1;
      continue;
    }

    if (parenDepth === 0 && bracketDepth === 0) {
      if (ch === "{") return { index: i, kind: "block" };
      if (ch === ";") return { index: i, kind: "statement" };
    }
  }

  return null;
}

interface SplitBlockItem {
  type: "declaration" | "block";
  text?: string;
  prelude?: string;
  body?: string;
}

function splitTopLevelBlockItems(block: string): SplitBlockItem[] {
  const items: SplitBlockItem[] = [];
  let i = 0;
  while (i < block.length) {
    while (i < block.length && /\s/.test(block[i])) i += 1;
    if (i >= block.length) break;

    const term = findTopLevelTerminator(block, i);
    if (!term) {
      const trailing = block.slice(i).trim();
      if (trailing) {
        items.push({ type: "declaration", text: trailing });
      }
      break;
    }

    const prelude = block.slice(i, term.index).trim();
    if (term.kind === "statement") {
      if (prelude) {
        items.push({ type: "declaration", text: prelude });
      }
      i = term.index + 1;
      continue;
    }

    const blockEnd = findMatchingBrace(block, term.index);
    if (blockEnd === -1) {
      break;
    }
    const body = block.slice(term.index + 1, blockEnd);
    items.push({
      type: "block",
      prelude,
      body,
    });
    i = blockEnd + 1;
  }
  return items;
}

function findMatchingBrace(text: string, openBraceIdx: number): number {
  let braceDepth = 0;
  let parenDepth = 0;
  let bracketDepth = 0;
  let quote: string | null = null;

  for (let i = openBraceIdx; i < text.length; i += 1) {
    const ch = text[i];
    const prev = i > 0 ? text[i - 1] : "";

    if ((ch === "'" || ch === '"') && prev !== "\\") {
      if (quote === ch) quote = null;
      else if (quote === null) quote = ch;
      continue;
    }

    if (quote) continue;

    if (ch === "(") {
      parenDepth += 1;
      continue;
    }
    if (ch === ")" && parenDepth > 0) {
      parenDepth -= 1;
      continue;
    }
    if (ch === "[") {
      bracketDepth += 1;
      continue;
    }
    if (ch === "]" && bracketDepth > 0) {
      bracketDepth -= 1;
      continue;
    }

    if (parenDepth === 0 && bracketDepth === 0) {
      if (ch === "{") braceDepth += 1;
      else if (ch === "}") {
        braceDepth -= 1;
        if (braceDepth === 0) {
          return i;
        }
      }
    }
  }

  return -1;
}

export function expandNestedSelectors(
  parentSelectors: string[],
  nestedSelectorText: string
): string[] {
  const nestedSelectors = splitByComma(nestedSelectorText);
  const expanded: string[] = [];

  for (const parent of parentSelectors) {
    const normalizedParent = normalizeSelector(parent);
    for (const child of nestedSelectors) {
      const normalizedChild = normalizeSelector(child);
      if (!normalizedChild) continue;

      let merged = "";
      if (normalizedChild.includes("&")) {
        merged = normalizeSelector(
          normalizedChild.replace(/&/g, normalizedParent)
        );
      } else if (/^[>+~]/.test(normalizedChild)) {
        merged = normalizeSelector(`${normalizedParent} ${normalizedChild}`);
      } else {
        merged = normalizeSelector(`${normalizedParent} ${normalizedChild}`);
      }

      if (merged) expanded.push(merged);
    }
  }

  return [...new Set(expanded)];
}

export function parseStyleBlock(
  selectorList: string[],
  blockBody: string,
  outRules: Array<{ selector: string; declarations: Record<string, string>; mediaQuery: string | null }>,
  currentMediaQuery: string | null = null
): void {
  const declarations: Record<string, string> = {};
  const items = splitTopLevelBlockItems(blockBody);

  for (const item of items) {
    if (item.type === "declaration") {
      const parsed = parseDeclaration(item.text);
      if (parsed) {
        declarations[parsed.property] = parsed.value;
      }
      continue;
    }

    if (!item.prelude) continue;

    if (item.prelude.startsWith("@")) {
      const at = parseAtRulePrelude(item.prelude);
      let nestedMediaQuery = currentMediaQuery;
      if (at && at.name === "media") {
        nestedMediaQuery = combineMediaQueries(currentMediaQuery, at.condition);
      }
      parseStyleBlock(selectorList, item.body || "", outRules, nestedMediaQuery);
      continue;
    }

    const nestedSelectors = expandNestedSelectors(selectorList, item.prelude);
    if (nestedSelectors.length === 0) continue;
    parseStyleBlock(nestedSelectors, item.body || "", outRules);
  }

  if (Object.keys(declarations).length > 0) {
    for (const selector of selectorList) {
      outRules.push({ selector, declarations, mediaQuery: currentMediaQuery });
    }
  }
}

function parseRulesRecursively(
  text: string,
  outRules: Array<{ selector: string; declarations: Record<string, string>; mediaQuery: string | null }>,
  currentMediaQuery: string | null = null
): void {
  let i = 0;
  while (i < text.length) {
    while (i < text.length && /\s/.test(text[i])) i += 1;
    if (i >= text.length) break;

    const preludeStart = i;
    const terminator = findTopLevelTerminator(text, preludeStart);
    if (!terminator) break;

    const prelude = text.slice(preludeStart, terminator.index).trim();
    if (terminator.kind === "statement") {
      i = terminator.index + 1;
      continue;
    }

    const blockStart = terminator.index;
    const blockEnd = findMatchingBrace(text, blockStart);
    if (blockEnd === -1) {
      break;
    }
    const body = text.slice(blockStart + 1, blockEnd);

    if (prelude.startsWith("@")) {
      const at = parseAtRulePrelude(prelude);
      let nestedMediaQuery = currentMediaQuery;
      if (at && at.name === "media") {
        nestedMediaQuery = combineMediaQueries(currentMediaQuery, at.condition);
      }
      parseRulesRecursively(body, outRules, nestedMediaQuery);
    } else {
      const selectors = splitByComma(prelude);
      parseStyleBlock(selectors, body, outRules, currentMediaQuery);
    }

    i = blockEnd + 1;
  }
}

function parseAtRulePrelude(
  prelude: unknown
): { name: string; condition: string } | null {
  const text = String(prelude || "").trim();
  const match = text.match(/^@([a-z-]+)\s*([\s\S]*)$/i);
  if (!match) return null;
  return {
    name: match[1].toLowerCase(),
    condition: String(match[2] || "").trim(),
  };
}

function combineMediaQueries(
  parentQuery: unknown,
  childQuery: unknown
): string | null {
  const parent = String(parentQuery || "").trim();
  const child = String(childQuery || "").trim();
  if (!parent) return child || null;
  if (!child) return parent || null;
  return `${parent} and ${child}`;
}

export function parseCSS(source: unknown): {
  rules: Array<{ selector: string; declarations: Record<string, string>; mediaQuery: string | null }>;
  rawTokens: Record<string, string>;
} {
  const cleaned = stripComments(source);
  const rules: Array<{
    selector: string;
    declarations: Record<string, string>;
    mediaQuery: string | null;
  }> = [];
  parseRulesRecursively(cleaned, rules);

  const rawTokens: Record<string, string> = {};
  for (const rule of rules) {
    for (const [property, value] of Object.entries(rule.declarations)) {
      if (property.startsWith("--")) {
        rawTokens[property] = value;
      }
    }
  }

  return {
    rules,
    rawTokens,
  };
}

