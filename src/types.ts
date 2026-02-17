export const BindingClass = Object.freeze({
  STATIC: "BIND_STATIC",
  DETERMINISTIC: "BIND_DETERMINISTIC",
  NONDETERMINISTIC: "BIND_NONDETERMINISTIC",
} as const);

export type BindingClassValue =
  (typeof BindingClass)[keyof typeof BindingClass];

export const BindingRank: Record<BindingClassValue, number> = Object.freeze({
  [BindingClass.STATIC]: 0,
  [BindingClass.DETERMINISTIC]: 1,
  [BindingClass.NONDETERMINISTIC]: 2,
});

export const DepType = Object.freeze({
  PARENT_SIZE: "PARENT_SIZE",
  VIEWPORT: "VIEWPORT",
  FONT_METRICS: "FONT_METRICS",
  ENV: "ENV",
  ENVIRONMENT: "ENV",
  CONTAINER_SIZE: "CONTAINER_SIZE",
  USER_PREF: "USER_PREF",
  INTRINSIC_SIZE: "INTRINSIC_SIZE",
  STRUCTURE: "STRUCTURE",
  THEME: "THEME",
} as const);

export type DepTypeValue = (typeof DepType)[keyof typeof DepType];

export const RUNTIME_UNIT_DEP_TYPES: Record<string, DepTypeValue> =
  Object.freeze({
    "%": DepType.PARENT_SIZE,
    vw: DepType.VIEWPORT,
    vh: DepType.VIEWPORT,
    vi: DepType.VIEWPORT,
    vb: DepType.VIEWPORT,
    vmin: DepType.VIEWPORT,
    vmax: DepType.VIEWPORT,
    svw: DepType.VIEWPORT,
    svh: DepType.VIEWPORT,
    svi: DepType.VIEWPORT,
    svb: DepType.VIEWPORT,
    lvw: DepType.VIEWPORT,
    lvh: DepType.VIEWPORT,
    lvi: DepType.VIEWPORT,
    lvb: DepType.VIEWPORT,
    dvw: DepType.VIEWPORT,
    dvh: DepType.VIEWPORT,
    dvi: DepType.VIEWPORT,
    dvb: DepType.VIEWPORT,
    em: DepType.FONT_METRICS,
    rem: DepType.FONT_METRICS,
    ex: DepType.FONT_METRICS,
    rex: DepType.FONT_METRICS,
    ch: DepType.FONT_METRICS,
    rch: DepType.FONT_METRICS,
    cap: DepType.FONT_METRICS,
    rcap: DepType.FONT_METRICS,
    ic: DepType.FONT_METRICS,
    ric: DepType.FONT_METRICS,
    lh: DepType.FONT_METRICS,
    rlh: DepType.FONT_METRICS,
    cqw: DepType.CONTAINER_SIZE,
    cqh: DepType.CONTAINER_SIZE,
    cqi: DepType.CONTAINER_SIZE,
    cqb: DepType.CONTAINER_SIZE,
    cqmin: DepType.CONTAINER_SIZE,
    cqmax: DepType.CONTAINER_SIZE,
  });

export const INTRINSIC_KEYWORDS = new Set([
  "min-content",
  "max-content",
  "fit-content",
  "stretch",
]);

export const STRUCTURAL_PSEUDO_RE =
  /:(nth-child|nth-last-child|nth-of-type|nth-last-of-type|first-child|last-child|only-child|has|empty)\b/i;

export const PROPERTY_BIT_INDEX = Object.freeze({
  width: 0,
  height: 1,
  "font-size": 2,
  "line-height": 3,
  color: 4,
  "background-color": 5,
  background: 6,
  padding: 7,
  margin: 8,
  display: 9,
  "border-radius": 10,
  "font-weight": 11,
  "max-width": 12,
  "min-width": 13,
  "max-height": 14,
  "min-height": 15,
  "grid-template-columns": 16,
  "grid-template-rows": 17,
  top: 18,
  right: 19,
  bottom: 20,
  left: 21,
  opacity: 22,
  transform: 23,
  gap: 24,
  "column-gap": 25,
  "row-gap": 26,
  "container-type": 27,
} as const);

export const STRUCTURE_INVALIDATION_MASK = 0x80000000 >>> 0;

function hashString(input: string): number {
  let hash = 2166136261 >>> 0;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash >>> 0;
}

export function getPropertyBitMask(propertyName: unknown): number {
  const key = String(propertyName || "").toLowerCase();
  const known = PROPERTY_BIT_INDEX[key as keyof typeof PROPERTY_BIT_INDEX];
  if (known !== undefined) {
    return (1 << known) >>> 0;
  }
  const idx = hashString(key) % 31;
  return (1 << idx) >>> 0;
}

export function maxBinding(
  a: BindingClassValue,
  b: BindingClassValue
): BindingClassValue {
  return BindingRank[a] >= BindingRank[b] ? a : b;
}

export function isDynamicBinding(binding: BindingClassValue): boolean {
  return binding !== BindingClass.STATIC;
}

export function selectorHasStructuralPseudo(selector: string): boolean {
  return STRUCTURAL_PSEUDO_RE.test(selector);
}

export interface ComponentNodeInit {
  id: string;
  selector: string;
  sourceOrder: number;
}

export class ComponentNode {
  id: string;
  selector: string;
  sourceOrder: number;
  declarations: Record<string, string>;
  normalizedDeclarations: Record<string, string>;
  treeParentId: string | null;
  treeChildren: Set<string>;
  portalTargetRaw: string | null;
  portalTargetId: string | null;
  effectiveParentId: string | null;
  isContainerBoundary: boolean;
  localClass: BindingClassValue;
  finalClass: BindingClassValue;
  contaminationSource: string | null;
  deps: DepEntry[];
  warnings: unknown[];
  emitType: string;
  boundaryId: string | null;

  constructor({ id, selector, sourceOrder }: ComponentNodeInit) {
    this.id = id;
    this.selector = selector;
    this.sourceOrder = sourceOrder;
    this.declarations = {};
    this.normalizedDeclarations = {};
    this.treeParentId = null;
    this.treeChildren = new Set();
    this.portalTargetRaw = null;
    this.portalTargetId = null;
    this.effectiveParentId = null;
    this.isContainerBoundary = false;
    this.localClass = BindingClass.STATIC;
    this.finalClass = BindingClass.STATIC;
    this.contaminationSource = null;
    this.deps = [];
    this.warnings = [];
    this.emitType = "ResolvedStyleBlock";
    this.boundaryId = null;
  }
}

export interface DepEntryInit {
  componentId: string;
  property: string;
  depType: DepTypeValue;
  invalidationMask: number;
  expression?: string | null;
  containerId?: string | null;
}

export class DepEntry {
  componentId: string;
  property: string;
  depType: DepTypeValue;
  invalidationMask: number;
  expression: string | null;
  containerId: string | null;

  constructor({
    componentId,
    property,
    depType,
    invalidationMask,
    expression = null,
    containerId = null,
  }: DepEntryInit) {
    this.componentId = componentId;
    this.property = property;
    this.depType = depType;
    this.invalidationMask = invalidationMask >>> 0;
    this.expression = expression;
    this.containerId = containerId;
  }
}
