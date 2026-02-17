const { parseCSS, extractParentSelector, tokeniseSelectorSegments } = require("./cssparser");
const { analyseValue, normalizeSimpleValue } = require("./valueAnalyser");
const {
  BindingClass,
  BindingRank,
  DepType,
  ComponentNode,
  DepEntry,
  getPropertyBitMask,
  STRUCTURE_INVALIDATION_MASK,
  isDynamicBinding,
  maxBinding,
  selectorHasStructuralPseudo,
} = require("./types");

function normalizeSelector(selector) {
  return String(selector || "").trim().replace(/\s+/g, " ");
}

function splitSelectorSegments(selector) {
  return tokeniseSelectorSegments(selector)
    .filter((segment) => segment.type === "simple")
    .map((segment) => segment.value);
}

function deriveNodeId(selector, fallbackIndex) {
  const segments = splitSelectorSegments(selector);
  const rightMost = segments.length > 0 ? segments[segments.length - 1] : selector;
  const cleaned = rightMost
    .replace(/::?[a-z-]+(?:\([^)]*\))?/gi, "")
    .trim();
  const tokens = cleaned.match(/([.#][A-Za-z_][\w-]*|[A-Za-z_][\w-]*)/g);
  if (!tokens || tokens.length === 0) {
    return `component_${fallbackIndex}`;
  }
  return tokens[tokens.length - 1];
}

function findTreeParentSelector(selector, knownSelectors) {
  let candidate = extractParentSelector(selector);
  while (candidate) {
    const normalizedCandidate = normalizeSelector(candidate);
    if (knownSelectors.has(normalizedCandidate)) {
      return normalizedCandidate;
    }
    candidate = extractParentSelector(normalizedCandidate);
  }
  return null;
}

function resolvePortalTargetId(rawTarget, nodesById, nodesBySelector, idAliases) {
  if (!rawTarget) return null;
  const direct = rawTarget.trim();
  if (!direct) return null;

  if (nodesById.has(direct)) return direct;
  if (nodesBySelector.has(direct)) return nodesBySelector.get(direct).id;
  if (nodesBySelector.has(`.${direct}`)) return nodesBySelector.get(`.${direct}`).id;
  if (nodesBySelector.has(`#${direct}`)) return nodesBySelector.get(`#${direct}`).id;

  const alias = idAliases.get(direct.toLowerCase());
  if (alias) return alias;
  return null;
}

function mediaQueryNeedsViewportDependency(mediaQuery) {
  const query = String(mediaQuery || "").toLowerCase();
  if (!query) return false;
  return (
    /\b(min|max)?-?(width|height|aspect-ratio)\b/.test(query) ||
    /\bdevice-(width|height)\b/.test(query) ||
    /\borientation\b/.test(query) ||
    /\bresolution\b/.test(query)
  );
}

function mediaQueryNeedsUserPreferenceDependency(mediaQuery) {
  const query = String(mediaQuery || "").toLowerCase();
  if (!query) return false;
  return (
    /\bprefers-[a-z-]+\b/.test(query) ||
    /\bforced-colors\b/.test(query) ||
    /\binverted-colors\b/.test(query)
  );
}

function makeWarning(type: any, msg: any, extra: any = {}) {
  return {
    type: type || "DEP_WARNING",
    nodeId: extra.nodeId || "",
    msg: String(msg || ""),
    tokenName: extra.tokenName || undefined,
    referencedToken: extra.referencedToken || undefined,
    propertyName: extra.propertyName || undefined,
  };
}

function normalizeWarningObject(warning: any, defaults: any = {}) {
  if (warning && typeof warning === "object") {
    return {
      type: warning.type || "DEP_WARNING",
      nodeId: warning.nodeId || defaults.nodeId || "",
      msg: String(warning.msg || warning.message || ""),
      tokenName: warning.tokenName || undefined,
      referencedToken: warning.referencedToken || undefined,
      propertyName: warning.propertyName || defaults.propertyName || undefined,
    };
  }
  return makeWarning("DEP_WARNING", warning, defaults);
}

function unresolvedPairKey(warning) {
  if (!warning || warning.type !== "UNRESOLVED_TOKEN") {
    return null;
  }
  let tokenName = warning.tokenName || null;
  let referencedToken = warning.referencedToken || null;

  if ((!tokenName || !referencedToken) && warning.msg) {
    const match = String(warning.msg).match(
      /token\s+(--[\w-]+)\s+references missing(?: token)?\s+(--[\w-]+)/i
    );
    if (match) {
      tokenName = tokenName || match[1];
      referencedToken = referencedToken || match[2];
    }
  }
  if (!tokenName || !referencedToken) return null;
  return `${tokenName}|${referencedToken}`;
}

function normalizeTokens(rawTokens) {
  const cache = new Map();
  const warnings = [];
  const tokenNames = Object.keys(rawTokens || {});
  const unresolvedSeen = new Set();

  function resolveToken(tokenName, stack) {
    if (cache.has(tokenName)) {
      return cache.get(tokenName);
    }
    if (stack.includes(tokenName)) {
      warnings.push(
        makeWarning(
          "DEP_WARNING",
          `token cycle detected at ${tokenName}; leaving raw value`,
          { tokenName }
        )
      );
      const cycleRecord = {
        name: tokenName,
        raw: rawTokens[tokenName],
        resolved: normalizeSimpleValue(rawTokens[tokenName] || ""),
        pointerTo: null,
      };
      cache.set(tokenName, cycleRecord);
      return cycleRecord;
    }

    const rawValue = String(rawTokens[tokenName] || "").trim();
    const varMatch = rawValue.match(/^var\(\s*(--[A-Za-z0-9_-]+)\s*(?:,[^)]+)?\)$/i);
    if (!varMatch) {
      const absoluteRecord = {
        name: tokenName,
        raw: rawValue,
        resolved: normalizeSimpleValue(rawValue),
        pointerTo: null,
      };
      cache.set(tokenName, absoluteRecord);
      return absoluteRecord;
    }

    const target = varMatch[1];
    if (!rawTokens[target]) {
      const unresolvedRecord = {
        name: tokenName,
        raw: rawValue,
        resolved: normalizeSimpleValue(rawValue),
        pointerTo: null,
      };
      const key = `${tokenName}|${target}`;
      if (!unresolvedSeen.has(key)) {
        unresolvedSeen.add(key);
        warnings.push(
          makeWarning(
            "UNRESOLVED_TOKEN",
            `token ${tokenName} references missing token ${target}`,
            { tokenName, referencedToken: target }
          )
        );
      }
      cache.set(tokenName, unresolvedRecord);
      return unresolvedRecord;
    }

    const resolvedTarget = resolveToken(target, stack.concat(tokenName));
    const flattenedRecord = {
      name: tokenName,
      raw: rawValue,
      resolved: resolvedTarget.resolved,
      pointerTo: resolvedTarget.pointerTo || target,
    };
    cache.set(tokenName, flattenedRecord);
    return flattenedRecord;
  }

  for (const tokenName of tokenNames) {
    resolveToken(tokenName, []);
  }

  const normalized = {};
  for (const [name, token] of cache.entries()) {
    normalized[name] = token;
  }

  return {
    normalized,
    warnings,
  };
}

function analyseCSS(sourceCss: any, options: any = {}) {
  const parsed = parseCSS(sourceCss);
  const normalizedTokens = normalizeTokens(parsed.rawTokens);
  const globalWarnings = normalizedTokens.warnings.map((warning) =>
    normalizeWarningObject(warning)
  );

  const nodesBySelector = new Map();
  const nodesById = new Map();
  const idAliases = new Map();
  const idCounters = new Map();
  let sourceOrder = 0;

  const createUniqueId = (base) => {
    const key = base || `component_${sourceOrder + 1}`;
    if (!nodesById.has(key)) {
      return key;
    }
    const current = idCounters.get(key) || 1;
    let next = current + 1;
    while (nodesById.has(`${key}#${next}`)) {
      next += 1;
    }
    idCounters.set(key, next);
    return `${key}#${next}`;
  };

  for (const rule of parsed.rules) {
    const selector = normalizeSelector(rule.selector);
    const styleDeclarations = {};
    for (const [prop, value] of Object.entries(rule.declarations)) {
      if (!prop.startsWith("--")) {
        styleDeclarations[prop] = value;
      }
    }
    if (Object.keys(styleDeclarations).length === 0) {
      continue;
    }

    let node = nodesBySelector.get(selector);
    if (!node) {
      const baseId = deriveNodeId(selector, sourceOrder + 1);
      const id = createUniqueId(baseId);
      node = new ComponentNode({ id, selector, sourceOrder: sourceOrder + 1 });
      node.mediaQueriesViewport = new Set();
      node.mediaQueriesUserPref = new Set();
      sourceOrder += 1;
      nodesBySelector.set(selector, node);
      nodesById.set(id, node);
      const alias = id.replace(/^[.#]/, "").toLowerCase();
      if (!idAliases.has(alias)) {
        idAliases.set(alias, id);
      }
    }

    if (rule.mediaQuery && mediaQueryNeedsViewportDependency(rule.mediaQuery)) {
      node.mediaQueriesViewport.add(rule.mediaQuery);
    }
    if (rule.mediaQuery && mediaQueryNeedsUserPreferenceDependency(rule.mediaQuery)) {
      node.mediaQueriesUserPref.add(rule.mediaQuery);
    }

    Object.assign(node.declarations, styleDeclarations);
  }

  const selectorSet = new Set(nodesBySelector.keys());
  const nodes = [...nodesBySelector.values()].sort(
    (a, b) => a.sourceOrder - b.sourceOrder
  );

  for (const node of nodes) {
    const parentSelector = findTreeParentSelector(node.selector, selectorSet);
    if (!parentSelector) continue;
    const parentNode = nodesBySelector.get(parentSelector);
    if (!parentNode) continue;
    node.treeParentId = parentNode.id;
    parentNode.treeChildren.add(node.id);
  }

  for (const node of nodes) {
    node.localClass = BindingClass.STATIC;
    const depDedup = new Set();

    for (const [property, value] of Object.entries(node.declarations)) {
      const valueAnalysis = analyseValue(node.id, property, value, {
        tokenDefinitions: parsed.rawTokens,
      });
      node.normalizedDeclarations[property] = valueAnalysis.normalizedValue;
      node.localClass = maxBinding(node.localClass, valueAnalysis.classification);

      if (valueAnalysis.signals.portalTarget) {
        node.portalTargetRaw = valueAnalysis.signals.portalTarget;
      }
      if (valueAnalysis.signals.containerBoundary) {
        node.isContainerBoundary = true;
      }
      for (const warning of valueAnalysis.warnings) {
        node.warnings.push(
          normalizeWarningObject(warning, { nodeId: node.id, propertyName: property })
        );
      }

      for (const dep of valueAnalysis.deps) {
        const key = `${dep.property}|${dep.depType}|${dep.expression || ""}`;
        if (depDedup.has(key)) continue;
        depDedup.add(key);
        node.deps.push(dep);
      }
    }

    if (node.mediaQueriesViewport && node.mediaQueriesViewport.size > 0) {
      const sortedMediaQueries = [...node.mediaQueriesViewport].sort();
      for (const mediaQuery of sortedMediaQueries) {
        const mediaKey = `__media__|${DepType.VIEWPORT}|${mediaQuery}`;
        if (depDedup.has(mediaKey)) continue;
        depDedup.add(mediaKey);
        node.deps.push(
          new DepEntry({
            componentId: node.id,
            property: "__media__",
            depType: DepType.VIEWPORT,
            invalidationMask: getPropertyBitMask("__media__"),
            expression: mediaQuery,
          })
        );
      }
      node.localClass = maxBinding(node.localClass, BindingClass.DETERMINISTIC);
    }

    if (node.mediaQueriesUserPref && node.mediaQueriesUserPref.size > 0) {
      const sortedPrefQueries = [...node.mediaQueriesUserPref].sort();
      for (const mediaQuery of sortedPrefQueries) {
        // Store the full media query in property for runtime matchMedia wiring.
        const prefKey = `${mediaQuery}|${DepType.USER_PREF}|${mediaQuery}`;
        if (depDedup.has(prefKey)) continue;
        depDedup.add(prefKey);
        node.deps.push(
          new DepEntry({
            componentId: node.id,
            property: mediaQuery,
            depType: DepType.USER_PREF,
            invalidationMask: getPropertyBitMask("__media_pref__"),
            expression: mediaQuery,
          })
        );
      }
      node.localClass = maxBinding(node.localClass, BindingClass.DETERMINISTIC);
    }

    if (selectorHasStructuralPseudo(node.selector)) {
      node.localClass = maxBinding(
        node.localClass,
        BindingClass.NONDETERMINISTIC
      );
      const structureKey = "__selector__|STRUCTURE";
      if (!depDedup.has(structureKey)) {
        node.deps.push(
          new DepEntry({
            componentId: node.id,
            property: "__selector__",
            depType: DepType.STRUCTURE,
            invalidationMask: STRUCTURE_INVALIDATION_MASK,
            expression: node.selector,
          })
        );
      }
      node.warnings.push(
        makeWarning(
          "STRUCTURAL_DYNAMIC",
          "structural selector dependency requires live tree context",
          { nodeId: node.id, propertyName: "__selector__" }
        )
      );
    }
  }

  const containerRegistry = new Set(
    nodes.filter((n) => n.isContainerBoundary).map((n) => n.id)
  );

  function nearestContainerId(node) {
    let cursor = node.treeParentId ? nodesById.get(node.treeParentId) : null;
    while (cursor) {
      if (containerRegistry.has(cursor.id)) {
        return cursor.id;
      }
      cursor = cursor.treeParentId ? nodesById.get(cursor.treeParentId) : null;
    }
    return null;
  }

  for (const node of nodes) {
    for (const dep of node.deps) {
      if (dep.depType !== DepType.CONTAINER_SIZE) continue;
      dep.containerId = nearestContainerId(node);
      if (!dep.containerId) {
        node.warnings.push(
          makeWarning(
            "MISSING_CONTAINER",
            `CONTAINER_SIZE dependency on ${dep.property} has no container ancestor`,
            { nodeId: node.id, propertyName: dep.property }
          )
        );
      }
    }
  }

  for (const node of nodes) {
    if (node.portalTargetRaw) {
      const targetId = resolvePortalTargetId(
        node.portalTargetRaw,
        nodesById,
        nodesBySelector,
        idAliases
      );
      node.portalTargetId = targetId;
      if (!targetId) {
        node.warnings.push(
          makeWarning(
            "PORTAL_MISSING",
            `PORTAL_ID target "${node.portalTargetRaw}" not found; using root fallback`,
            { nodeId: node.id }
          )
        );
      }
    }
    node.effectiveParentId = node.portalTargetId || node.treeParentId || null;
  }

  const visiting = new Set();
  const resolved = new Set();

  function resolveFinalClass(node) {
    if (resolved.has(node.id)) {
      return node.finalClass;
    }
    if (visiting.has(node.id)) {
      node.warnings.push(
        makeWarning(
          "DEP_WARNING",
          "effective-parent cycle detected; breaking chain at this node",
          { nodeId: node.id }
        )
      );
      node.finalClass = node.localClass;
      node.contaminationSource = null;
      resolved.add(node.id);
      return node.finalClass;
    }

    visiting.add(node.id);
    let finalClass = node.localClass;
    let contaminationSource = null;

    if (node.effectiveParentId) {
      const parent = nodesById.get(node.effectiveParentId);
      if (parent) {
        const parentFinal = resolveFinalClass(parent);
        if (BindingRank[parentFinal] > BindingRank[finalClass]) {
          finalClass = parentFinal;
          contaminationSource = parent.contaminationSource || parent.id;
        }
      }
    }

    node.finalClass = finalClass;
    node.contaminationSource = contaminationSource;
    visiting.delete(node.id);
    resolved.add(node.id);
    return node.finalClass;
  }

  for (const node of nodes) {
    resolveFinalClass(node);
  }

  function resolveBoundaryId(node) {
    if (!isDynamicBinding(node.finalClass)) {
      return null;
    }
    if (node.boundaryId) {
      return node.boundaryId;
    }
    const parent = node.effectiveParentId
      ? nodesById.get(node.effectiveParentId)
      : null;
    if (!parent || !isDynamicBinding(parent.finalClass)) {
      node.boundaryId = node.id;
      return node.id;
    }
    node.boundaryId = resolveBoundaryId(parent);
    return node.boundaryId;
  }

  for (const node of nodes) {
    resolveBoundaryId(node);
  }

  function collectBoundarySubgraph(rootNode) {
    const members = [];
    const visited = new Set();
    const stack = [rootNode];

    while (stack.length > 0) {
      const current = stack.pop();
      if (!current || visited.has(current.id)) continue;
      visited.add(current.id);
      members.push(current);

      for (const childId of current.treeChildren) {
        const child = nodesById.get(childId);
        if (!child) continue;
        if (child.portalTargetRaw) continue;
        if (!isDynamicBinding(child.finalClass)) continue;
        if (child.boundaryId !== rootNode.id) continue;
        stack.push(child);
      }
    }

    return members.sort((a, b) => a.sourceOrder - b.sourceOrder);
  }

  const manifests = [];
  const manifestByBoundaryId = new Map();

  for (const node of nodes) {
    if (node.boundaryId !== node.id) continue;
    if (!isDynamicBinding(node.finalClass)) continue;

    const members = collectBoundarySubgraph(node);
    const subgraphIds = members.map((member) => member.id);
    const entries = [];
    const depKeys = new Set();

    for (const member of members) {
      for (const dep of member.deps) {
        if (dep.depType === DepType.THEME) {
          continue;
        }
        const depKey = `${member.id}|${dep.property}|${dep.depType}|${dep.containerId || ""}`;
        if (depKeys.has(depKey)) continue;
        depKeys.add(depKey);
        entries.push({
          componentId: member.id,
          property: dep.property,
          depType: dep.depType,
          invalidationMask: dep.invalidationMask >>> 0,
          expression: dep.expression,
          containerId: dep.containerId || null,
        });
      }
    }

    const flags = [];
    if (members.some((member) => member.portalTargetRaw)) {
      flags.push("PORTAL_DEPENDENCY");
    }
    if (entries.length === 0) {
      flags.push("CONTAMINATION_ONLY");
    }

    const manifest = {
      componentId: node.id,
      depCount: entries.length,
      flags,
      subgraphIds,
      entries,
    };
    manifests.push(manifest);
    manifestByBoundaryId.set(node.id, manifest);
  }

  for (const node of nodes) {
    if (!isDynamicBinding(node.finalClass)) {
      node.emitType = "ResolvedStyleBlock";
      continue;
    }
    if (node.boundaryId === node.id) {
      node.emitType = "DynamicBoundaryMarker+RuleSet+DependencyManifest";
    } else {
      node.emitType = "RuleSet";
    }
  }

  for (const node of nodes) {
    for (const warning of node.warnings) {
      globalWarnings.push(normalizeWarningObject(warning, { nodeId: node.id }));
    }
  }

  const dedupedWarnings = [];
  const unresolvedPairs = new Set();
  for (const warning of globalWarnings) {
    if (warning.type === "UNRESOLVED_TOKEN") {
      const key = unresolvedPairKey(warning);
      if (key) {
        if (unresolvedPairs.has(key)) {
          continue;
        }
        unresolvedPairs.add(key);
      }
    }
    dedupedWarnings.push(warning);
  }

  const summary = {
    total: nodes.length,
    static: nodes.filter((n) => n.finalClass === BindingClass.STATIC).length,
    deterministic: nodes.filter(
      (n) => n.finalClass === BindingClass.DETERMINISTIC
    ).length,
    nondeterministic: nodes.filter(
      (n) => n.finalClass === BindingClass.NONDETERMINISTIC
    ).length,
  };

  return {
    sourceName: options.sourceName || "inline.css",
    tokens: normalizedTokens.normalized,
    containerRegistry: [...containerRegistry],
    nodes: nodes.map((node) => ({
      id: node.id,
      selector: node.selector,
      declarations: node.declarations,
      normalizedDeclarations: node.normalizedDeclarations,
      localClass: node.localClass,
      finalClass: node.finalClass,
      contaminationSource: node.contaminationSource,
      treeParentId: node.treeParentId,
      portalTargetRaw: node.portalTargetRaw,
      portalTargetId: node.portalTargetId,
      effectiveParentId: node.effectiveParentId,
      isContainerBoundary: node.isContainerBoundary,
      deps: node.deps.map((dep) => ({
        componentId: dep.componentId,
        property: dep.property,
        depType: dep.depType,
        invalidationMask: dep.invalidationMask >>> 0,
        expression: dep.expression,
        containerId: dep.containerId,
      })),
      emitType: node.emitType,
      boundaryId: node.boundaryId,
    })),
    manifests,
    manifestByBoundaryId: Object.fromEntries(
      [...manifestByBoundaryId.entries()].map(([k, v]) => [k, v])
    ),
    summary,
    warnings: dedupedWarnings,
  };
}

function findNodeBySelector(analysis, selector) {
  const normalized = normalizeSelector(selector);
  return analysis.nodes.find((node) => normalizeSelector(node.selector) === normalized) || null;
}

function findManifest(analysis, componentId) {
  return analysis.manifests.find((manifest) => manifest.componentId === componentId) || null;
}

export { analyseCSS, findNodeBySelector, findManifest };
