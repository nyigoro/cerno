# COMP-SPEC-001 v0.2 Patch Set

This document applies five normative patches discovered in the worked examples validation pass. It is intended to be applied on top of COMP-SPEC-001 v0.1.

## Patch 1: Descendant Invalidation Fan-Out (Issue #01)

Section 5.3 MUST be updated with the following rule:

`DependencyManifest` entries emitted at a dynamic boundary MUST include descendant fan-out coverage. A boundary manifest MUST carry either:

- dependency entries for all runtime-dependent properties in the dynamic subgraph, or
- an explicit descendant invalidation flag plus a complete subgraph membership list.

For runtime portability and deterministic fan-out, this implementation adopts the first form with explicit subgraph membership:

- `manifest.subgraphIds` MUST contain every component ID in the dynamic subgraph rooted at `component_id`.
- Runtime invalidation of any dependency in `entries[]` MUST target all relevant members in `subgraphIds`.

This removes ambiguity when descendants are contaminated but do not emit per-node manifests.

## Patch 2: PORTAL Contamination Severance (Issue #02)

Section 3.3 MUST define portal behavior as classification semantics, not only traversal semantics:

- A component declaring `PORTAL_ID` MUST NOT inherit contamination from its structural tree parent.
- For classification purposes, its effective ancestor is the resolved portal target.
- Tree-edge contamination propagation MUST skip children that declare `PORTAL_ID`.

If the portal target cannot be resolved at compile time, the compiler MUST:

- emit a diagnostic warning, and
- classify the component against a root-static fallback ancestor for safety.

Runtime MUST still implement cycle breaking for dynamically composed binaries.

## Patch 3: Mixed-Operand Function Rule (Issue #03)

Section 2.4 MUST add mixed-operand normalization semantics:

- For `calc()`, `min()`, `max()`, and `clamp()`, if all operands are absolute values, compile-time evaluation is required.
- If any operand is runtime-dependent, the expression is runtime-dependent.
- Absolute sub-operands SHOULD be normalized and inlined before emit.
- Classification is determined by the weakest operand (runtime dependency dominates).

Examples:

- `max(14px, 2cqw)` => runtime-dependent (`CONTAINER_SIZE`)
- `calc(100% - 16px)` => runtime-dependent (`PARENT_SIZE`)

## Patch 4: Add `CONTAINER_SIZE` Dependency Type (Issue #04)

Section 5.2 MUST promote container-size dependency from open question to normative type:

- `dep_type = CONTAINER_SIZE` is required for `cqw`, `cqh`, `cqi`, `cqb`, `cqmin`, and `cqmax`.
- `DependencyEntry` MUST include `container_id` (or equivalent manifest field) when `dep_type = CONTAINER_SIZE`.

This ensures deterministic invalidation targeting for container-query-driven values.

## Patch 5: Container Boundary Registry in Analyze Stage (Issue #05)

Section 1.2 (Analyze Stage) MUST include a required container registry pass before classification:

- Components declaring `container-type: inline-size` or `container-type: size` MUST be registered as container boundaries.
- Runtime-dependent container units in descendants MUST resolve against the nearest registered ancestor container.
- Missing container ancestors MUST produce a warning and fall back to an unresolved container dependency classification.

This registry is a prerequisite for valid `CONTAINER_SIZE` manifest entries and deterministic recomputation.

## Patch 6: Stable Constant Pool Ordering

Before binary emission work begins, compiler output determinism MUST be specified:

- Constant-pool entries MUST be emitted in a stable order independent of encounter order.
- String entries MUST be sorted lexicographically by UTF-8 byte representation.
- Numeric entries MUST be sorted by normalized fixed-point numeric value.

This is required for byte-identical reproducible builds, reliable cache keys, and stable binary diffing.
