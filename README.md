# cerno

Binary SOM analyser prototype implementing COMP-SPEC-001 v0.2 behavior:

- Three-tier binding classes: `BIND_STATIC`, `BIND_DETERMINISTIC`, `BIND_NONDETERMINISTIC`
- Five-phase analysis pipeline:
  - local classification
  - contamination propagation
  - portal contamination severance
  - boundary identification
  - dependency manifest emission
- Container boundary registry and `CONTAINER_SIZE` dependency tracking
- Boundary manifests with full `subgraphIds` fan-out lists

## Source Of Truth

- `src/**/*.ts` is canonical source.
- Runtime/CLI/test entrypoints consume built artifacts from `dist/src/*`.
- Build before running direct scripts that depend on compiled output.

## Run

```bash
npm test
npm run test:all
npm run analyze:sample
npm run analyze -- test/sample.css --json --out outputs/sample-report.json
```

## Exit Codes

- `0`: no non-deterministic selectors detected
- `1`: one or more `BIND_NONDETERMINISTIC` components detected
- `2`: CLI/runtime error
