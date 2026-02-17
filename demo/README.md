# Browser Demo

This folder contains a complete browser demo for Binary SOM runtime loading:

- `index.html` - demo UI + browser loader integration
- `styles.css` - source style rules for demo components
- `styles.som` - generated binary stylesheet
- `fallback.css` - generated NONDETERMINISTIC fallback rules
- `fallback-map.json` - NONDETERMINISTIC hash → selector map for runtime diagnostics

## Rebuild demo assets

```bash
npm run demo:build
```

## Run locally

Serve the repo root with any static file server and open `demo/index.html`.
The demo imports runtime modules from `/dist/browser/*`, so serving only the `demo/`
folder will not load the modules.

Example:

```bash
npm run demo:serve
```
