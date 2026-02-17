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

## Run

```bash
npm test
node cli.js test/sample.css --manifests
node cli.js test/sample.css --json --out outputs/sample-report.json
```

## Exit Codes

- `0`: no non-deterministic selectors detected
- `1`: one or more `BIND_NONDETERMINISTIC` components detected
- `2`: CLI/runtime error
