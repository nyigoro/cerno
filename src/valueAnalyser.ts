import {
  BindingClass,
  DepType,
  INTRINSIC_KEYWORDS,
  RUNTIME_UNIT_DEP_TYPES,
  DepEntry,
  getPropertyBitMask,
  type BindingClassValue,
  type DepTypeValue,
} from "./types";

type WarningType =
  | "STRUCTURAL_DYNAMIC"
  | "MISSING_CONTAINER"
  | "UNKNOWN_PARENT"
  | "PORTAL_MISSING"
  | "UNRESOLVED_TOKEN"
  | "UNDEFINED_TOKEN"
  | "MIXED_OPERANDS"
  | "DEP_WARNING";

interface WarningObject {
  type: WarningType;
  nodeId: string;
  msg: string;
  tokenName?: string;
  referencedToken?: string;
  propertyName?: string;
}

interface DetectDep {
  property: string;
  depType: DepTypeValue;
  expression: string;
}

interface DetectResult {
  deps: DetectDep[];
  warnings: WarningObject[];
}

interface ResolveTokenChainResult {
  state: "circular" | "unknown" | "runtime-dependent" | "absolute";
  depTypes: Set<DepTypeValue>;
  warnings: WarningObject[];
}

interface AnalyseValueSignals {
  portalTarget: string | null;
  containerBoundary: boolean;
}

interface AnalyseValueResult {
  normalizedValue: string;
  deps: DepEntry[];
  classification: BindingClassValue;
  signals: AnalyseValueSignals;
  warnings: WarningObject[];
}

const NAMED_COLORS = Object.freeze({
  red: "#FF0000FF",
  blue: "#0000FFFF",
  green: "#008000FF",
  black: "#000000FF",
  white: "#FFFFFFFF",
  transparent: "#00000000",
});

const OPAQUE_COLOR_FUNCTIONS = new Set([
  "rgb",
  "rgba",
  "hsl",
  "hsla",
  "hwb",
  "lab",
  "lch",
  "oklch",
  "oklab",
  "color",
  "color-mix",
  "light-dark",
]);

function makeWarning(
  type: WarningType | null,
  msg: string,
  extra: Partial<WarningObject> = {}
): WarningObject {
  return {
    type: type || "DEP_WARNING",
    nodeId: extra.nodeId || "",
    msg: String(msg || ""),
    tokenName: extra.tokenName || undefined,
    referencedToken: extra.referencedToken || undefined,
    propertyName: extra.propertyName || undefined,
  };
}

function normalizeWarningObject(
  warning: WarningObject | string,
  context: Partial<WarningObject> = {}
): WarningObject {
  if (warning && typeof warning === "object") {
    return {
      type: warning.type || "DEP_WARNING",
      nodeId: warning.nodeId || context.nodeId || "",
      msg: String(warning.msg || ""),
      tokenName: warning.tokenName || undefined,
      referencedToken: warning.referencedToken || undefined,
      propertyName: warning.propertyName || context.propertyName || undefined,
    };
  }
  return makeWarning("DEP_WARNING", String(warning || ""), {
    nodeId: context.nodeId,
    propertyName: context.propertyName,
  });
}

function warningKey(warning: WarningObject): string {
  return [
    warning.type || "",
    warning.nodeId || "",
    warning.msg || "",
    warning.tokenName || "",
    warning.referencedToken || "",
    warning.propertyName || "",
  ].join("|");
}

export function normalizeHexColor(value: string): string | null {
  const v = value.trim();
  if (!v.startsWith("#")) {
    return null;
  }
  const hex = v.slice(1);
  if (/^[0-9a-f]{3}$/i.test(hex)) {
    return (
      "#" +
      hex
        .split("")
        .map((c) => c + c)
        .join("")
        .toUpperCase() +
      "FF"
    );
  }
  if (/^[0-9a-f]{4}$/i.test(hex)) {
    return (
      "#" +
      hex
        .split("")
        .map((c) => c + c)
        .join("")
        .toUpperCase()
    );
  }
  if (/^[0-9a-f]{6}$/i.test(hex)) {
    return "#" + hex.toUpperCase() + "FF";
  }
  if (/^[0-9a-f]{8}$/i.test(hex)) {
    return "#" + hex.toUpperCase();
  }
  return null;
}

export function normalizeSimpleValue(raw: unknown): string {
  const trimmed = String(raw || "").trim();
  const lower = trimmed.toLowerCase();
  const hex = normalizeHexColor(trimmed);
  if (hex) {
    return hex;
  }
  if (NAMED_COLORS[lower as keyof typeof NAMED_COLORS]) {
    return NAMED_COLORS[lower as keyof typeof NAMED_COLORS];
  }
  return trimmed.replace(/\s+/g, " ");
}

function parseFunctionNameCandidates(lowerValue: string): string[] {
  const names: string[] = [];
  const re = /([a-z-]+)\s*\(/g;
  let match = re.exec(lowerValue);
  while (match) {
    names.push(match[1]);
    match = re.exec(lowerValue);
  }
  return names;
}

export function extractVarReferences(value: unknown): string[] {
  const refs: string[] = [];
  const re = /var\(\s*(--[\w-]+)/gi;
  let match = re.exec(String(value || ""));
  while (match) {
    refs.push(match[1]);
    match = re.exec(String(value || ""));
  }
  return refs;
}

function parseSingleVar(
  value: unknown
): { tokenName: string; fallback: string | null } | null {
  const match = String(value || "")
    .trim()
    .match(/^var\(\s*(--[\w-]+)\s*(?:,\s*([\s\S]+))?\)$/i);
  if (!match) {
    return null;
  }
  return {
    tokenName: match[1],
    fallback: match[2] ? match[2].trim() : null,
  };
}

function collectRuntimeDepTypes(
  property: string,
  value: string
): { depTypes: Set<DepTypeValue>; warnings: WarningObject[] } {
  const result = detectRuntimeDependencies(property, value, {
    includeThemeDeps: false,
  });
  const depTypes = new Set<DepTypeValue>();
  for (const dep of result.deps) {
    if (dep.depType !== DepType.THEME) {
      depTypes.add(dep.depType);
    }
  }
  return {
    depTypes,
    warnings: result.warnings,
  };
}

export function resolveTokenChain(
  tokenName: string,
  tokenDefs: Record<string, unknown>,
  visited = new Set<string>()
): ResolveTokenChainResult {
  if (visited.has(tokenName)) {
    return {
      state: "circular",
      depTypes: new Set<DepTypeValue>(),
      warnings: [
        makeWarning(
          "DEP_WARNING",
          `token cycle detected while resolving ${tokenName}`,
          { tokenName }
        ),
      ],
    };
  }

  visited.add(tokenName);
  const hasToken =
    !!tokenDefs && Object.prototype.hasOwnProperty.call(tokenDefs, tokenName);
  const rawValue = hasToken ? tokenDefs[tokenName] : null;

  if (!hasToken || rawValue === undefined || rawValue === null) {
    return {
      state: "unknown",
      depTypes: new Set<DepTypeValue>(),
      warnings: [
        makeWarning(
          "UNDEFINED_TOKEN",
          `token ${tokenName} is not defined in token table`,
          { tokenName }
        ),
      ],
    };
  }

  const trimmed = String(rawValue).trim();
  const maybeVar = parseSingleVar(trimmed);
  if (maybeVar) {
    const hasTarget =
      !!tokenDefs &&
      Object.prototype.hasOwnProperty.call(tokenDefs, maybeVar.tokenName);
    if (hasTarget) {
      return resolveTokenChain(maybeVar.tokenName, tokenDefs, visited);
    }
    if (maybeVar.fallback) {
      const fallback = collectRuntimeDepTypes(tokenName, maybeVar.fallback);
      return {
        state: fallback.depTypes.size > 0 ? "runtime-dependent" : "absolute",
        depTypes: fallback.depTypes,
        warnings: [
          makeWarning(
            "UNRESOLVED_TOKEN",
            `token ${tokenName} references missing token ${maybeVar.tokenName}; fallback used`,
            { tokenName, referencedToken: maybeVar.tokenName }
          ),
          ...fallback.warnings,
        ],
      };
    }
    return {
      state: "unknown",
      depTypes: new Set<DepTypeValue>(),
      warnings: [
        makeWarning(
          "UNRESOLVED_TOKEN",
          `token ${tokenName} references missing token ${maybeVar.tokenName}`,
          { tokenName, referencedToken: maybeVar.tokenName }
        ),
      ],
    };
  }

  const leaf = collectRuntimeDepTypes(tokenName, trimmed);
  return {
    state: leaf.depTypes.size > 0 ? "runtime-dependent" : "absolute",
    depTypes: leaf.depTypes,
    warnings: leaf.warnings,
  };
}

function detectRuntimeDependencies(
  property: unknown,
  value: unknown,
  options: { includeThemeDeps?: boolean } = {}
): DetectResult {
  const includeThemeDeps = options.includeThemeDeps !== false;
  const deps: DetectDep[] = [];
  const prop = String(property || "").trim().toLowerCase();
  const raw = String(value || "");
  const lower = raw.toLowerCase();
  const warnings: WarningObject[] = [];
  const functionName = lower.match(/^\s*([\w-]+)\s*\(/)?.[1] || null;

  if (includeThemeDeps && /\bvar\s*\(/i.test(raw)) {
    deps.push({
      property: prop,
      depType: DepType.THEME,
      expression: raw.trim(),
    });
  }

  if (functionName && OPAQUE_COLOR_FUNCTIONS.has(functionName)) {
    return {
      deps,
      warnings,
    };
  }

  if (/\benv\s*\(/i.test(lower)) {
    deps.push({
      property: prop,
      depType: DepType.ENV,
      expression: raw.trim(),
    });
  }

  for (const keyword of INTRINSIC_KEYWORDS) {
    const re = new RegExp(`\\b${keyword}\\b`, "i");
    if (re.test(lower)) {
      deps.push({
        property: prop,
        depType: DepType.INTRINSIC_SIZE,
        expression: raw.trim(),
      });
      break;
    }
  }

  const unitRe = /(-?(?:\d+|\d*\.\d+))\s*(%|[a-z]+)/gi;
  let unitMatch = unitRe.exec(raw);
  while (unitMatch) {
    const unit = unitMatch[2].toLowerCase();
    const depType = RUNTIME_UNIT_DEP_TYPES[unit];
    if (depType) {
      deps.push({
        property: prop,
        depType,
        expression: raw.trim(),
      });
    }
    unitMatch = unitRe.exec(raw);
  }

  const functions = parseFunctionNameCandidates(lower);
  const hasRuntimeMath = functions.some(
    (fn) => fn === "calc" || fn === "min" || fn === "max" || fn === "clamp"
  );
  if (hasRuntimeMath) {
    const hasAbsoluteOperand = /(-?(?:\d+|\d*\.\d+)\s*px)\b/i.test(raw);
    const hasRuntimeOperand = deps.some(
      (d) => d.depType !== DepType.THEME && d.depType !== DepType.ENVIRONMENT
    );
    if (hasAbsoluteOperand && hasRuntimeOperand) {
      warnings.push(
        makeWarning(
          "MIXED_OPERANDS",
          `mixed absolute/runtime operands detected for ${prop}; runtime operand dominates`,
          { propertyName: prop }
        )
      );
    }
  }

  const deduped: DetectDep[] = [];
  const seen = new Set<string>();
  for (const dep of deps) {
    const key = `${dep.property}|${dep.depType}|${dep.expression}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(dep);
    }
  }

  return {
    deps: deduped,
    warnings,
  };
}

export function analyseValue(
  componentId: string,
  property: unknown,
  value: unknown,
  options: { tokenDefinitions?: Record<string, unknown> } = {}
): AnalyseValueResult {
  const prop = String(property || "").trim();
  const propLower = prop.toLowerCase();
  const rawValue = String(value || "").trim();
  const tokenDefinitions = options.tokenDefinitions || {};
  const normalizedValue = normalizeSimpleValue(rawValue);
  const signals: AnalyseValueSignals = {
    portalTarget: null,
    containerBoundary: false,
  };

  if (
    prop === "PORTAL_ID" ||
    propLower === "portal_id" ||
    propLower === "portal-id"
  ) {
    signals.portalTarget = rawValue.replace(/^["']|["']$/g, "").trim();
  }

  if (propLower === "container-type") {
    const lower = rawValue.toLowerCase();
    if (/\b(inline-size|size)\b/.test(lower)) {
      signals.containerBoundary = true;
    }
  }

  if (
    propLower.startsWith("-webkit-") ||
    propLower.startsWith("-moz-") ||
    propLower.startsWith("-ms-")
  ) {
    return {
      normalizedValue,
      deps: [],
      classification: BindingClass.STATIC,
      signals,
      warnings: [],
    };
  }

  const detection = detectRuntimeDependencies(propLower, rawValue, {
    includeThemeDeps: true,
  });
  let forceRuntime = false;

  const varRefs = extractVarReferences(rawValue);
  for (const tokenName of varRefs) {
    const chain = resolveTokenChain(tokenName, tokenDefinitions, new Set());
    for (const warning of chain.warnings) {
      detection.warnings.push(
        normalizeWarningObject(warning, {
          nodeId: componentId,
          propertyName: propLower,
        })
      );
    }

    if (chain.state === "circular") {
      forceRuntime = false;
      detection.warnings.push(
        makeWarning(
          "DEP_WARNING",
          `token cycle at ${tokenName}; treating ${propLower} as static fallback`,
          { nodeId: componentId, tokenName, propertyName: propLower }
        )
      );
      continue;
    }

    if (chain.state === "runtime-dependent") {
      for (const depType of chain.depTypes) {
        detection.deps.push({
          property: propLower,
          depType,
          expression: `var(${tokenName})`,
        });
      }
    }
  }

  const finalDeps: DetectDep[] = [];
  const depKeys = new Set<string>();
  for (const dep of detection.deps) {
    const key = `${dep.property}|${dep.depType}|${dep.expression || ""}`;
    if (depKeys.has(key)) continue;
    depKeys.add(key);
    finalDeps.push(dep);
  }

  const depEntries = finalDeps.map(
    (d) =>
      new DepEntry({
        componentId,
        property: d.property,
        depType: d.depType,
        invalidationMask:
          d.depType === DepType.STRUCTURE
            ? 0x80000000 >>> 0
            : getPropertyBitMask(d.property),
        expression: d.expression,
        containerId: null,
      })
  );

  const uniqueWarnings: WarningObject[] = [];
  const warningKeys = new Set<string>();
  for (const warning of detection.warnings) {
    const normalized = normalizeWarningObject(warning, {
      nodeId: componentId,
      propertyName: propLower,
    });
    const key = warningKey(normalized);
    if (warningKeys.has(key)) continue;
    warningKeys.add(key);
    uniqueWarnings.push(normalized);
  }
  const hasRuntimeDep =
    depEntries.some((entry) => entry.depType !== DepType.THEME) || forceRuntime;

  return {
    normalizedValue,
    deps: depEntries,
    classification: hasRuntimeDep
      ? BindingClass.DETERMINISTIC
      : BindingClass.STATIC,
    signals,
    warnings: uniqueWarnings,
  };
}

