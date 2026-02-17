import { BindingClass } from "./types";

const ANSI = Object.freeze({
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
});

function color(text: string, code: string): string {
  return `${code}${text}${ANSI.reset}`;
}

function classColor(binding: string): string {
  if (binding === BindingClass.STATIC) return ANSI.green;
  if (binding === BindingClass.DETERMINISTIC) return ANSI.yellow;
  return ANSI.red;
}

function percent(count: number, total: number): string {
  if (total === 0) return "0%";
  return `${Math.round((count / total) * 100)}%`;
}

function formatSummary(analysis: any): string {
  const s = analysis.summary;
  return [
    color("Classification Summary", ANSI.bold),
    `  Total components: ${s.total}`,
    `  ${color(BindingClass.STATIC, classColor(BindingClass.STATIC))}: ${s.static} (${percent(s.static, s.total)})`,
    `  ${color(BindingClass.DETERMINISTIC, classColor(BindingClass.DETERMINISTIC))}: ${s.deterministic} (${percent(s.deterministic, s.total)})`,
    `  ${color(BindingClass.NONDETERMINISTIC, classColor(BindingClass.NONDETERMINISTIC))}: ${s.nondeterministic} (${percent(s.nondeterministic, s.total)})`,
  ].join("\n");
}

function formatNodes(analysis: any): string {
  const lines = [color("Components", ANSI.bold)];
  for (const node of analysis.nodes) {
    const local = node.localClass.replace("BIND_", "");
    const final = color(node.finalClass, classColor(node.finalClass));
    const contamination = node.contaminationSource
      ? ` | local:${local} | <- ${node.contaminationSource}`
      : ` | local:${local}`;
    const deps = node.deps
      .filter((dep: any) => dep.depType !== "THEME")
      .map((dep: any) => {
        if (dep.depType === "CONTAINER_SIZE" && dep.containerId) {
          return `${dep.depType}(${dep.property})->[${dep.containerId}]`;
        }
        return `${dep.depType}(${dep.property})`;
      })
      .join(", ");
    const depInfo = deps ? ` | deps: ${deps}` : "";
    lines.push(
      `  ${node.id}  ${final}${contamination} | emit:${node.emitType}${depInfo}`
    );
  }
  return lines.join("\n");
}

function formatManifests(analysis: any): string {
  const lines = [color("Dependency Manifests", ANSI.bold)];
  if (analysis.manifests.length === 0) {
    lines.push("  (none)");
    return lines.join("\n");
  }
  for (const manifest of analysis.manifests) {
    lines.push(
      `  ${manifest.componentId} | deps:${manifest.depCount} | subgraph:[${manifest.subgraphIds.join(", ")}]`
    );
    for (const entry of manifest.entries) {
      const container = entry.containerId ? ` -> ${entry.containerId}` : "";
      lines.push(
        `    - ${entry.componentId}.${entry.property}: ${entry.depType}${container} mask=0x${entry.invalidationMask
          .toString(16)
          .toUpperCase()
          .padStart(8, "0")}`
      );
    }
  }
  return lines.join("\n");
}

function formatWarnings(analysis: any): string {
  if (!analysis.warnings || analysis.warnings.length === 0) {
    return "";
  }
  const lines = [color("Warnings", ANSI.bold)];
  for (const warning of analysis.warnings) {
    if (warning && typeof warning === "object") {
      const type = warning.type || "WARNING";
      const nodeId = warning.nodeId ? `${warning.nodeId}: ` : "";
      const msg = warning.msg || warning.message || "";
      lines.push(`  ${color("! ", ANSI.red)}[${type}] ${nodeId}${msg}`);
    } else {
      lines.push(`  ${color("! ", ANSI.red)}${warning}`);
    }
  }
  return lines.join("\n");
}

export function renderReport(
  analysis: any,
  options: { manifests?: boolean } = {}
): string {
  const parts = [
    `${color("Source", ANSI.bold)}: ${analysis.sourceName}`,
    formatSummary(analysis),
    formatNodes(analysis),
  ];
  if (options.manifests) {
    parts.push(formatManifests(analysis));
  }
  const warnings = formatWarnings(analysis);
  if (warnings) {
    parts.push(warnings);
  }
  return parts.join("\n\n");
}

export function toJSON(analysis: any): string {
  return JSON.stringify(analysis, null, 2);
}

