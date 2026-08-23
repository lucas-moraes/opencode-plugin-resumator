# AGENTS.md

Single-file ESM OpenCode plugin. All logic lives in `index.js` (no build step, no TS, no deps). Entrypoint: default export `OpenCodeContextCompressorPlugin(context)` (index.js:146).

## Commands

- `npm test` — runs `node --test` on `*.test.js` files (see `index.test.js`). `prepublishOnly` runs the same command.
- No lint, typecheck, or build scripts.

## Architecture

- Plugin is a function receiving a `context` object, returning a `hooks` map. The only hook used is `"chat:before-send"` (index.js:155).
- `process.cwd()` is the project root (index.js:147) — NOT `context` or the plugin dir. Tests/relative file handling must account for this.
- Config is read live from `opencode.json` at the cwd root under the `contextCompressor` key (index.js:21-45). No schema; unrecognized keys fall back to `DEFAULT_CONFIG` (index.js:10).
- Token counting uses the `tiktoken` package (`get_encoding("cl100k_base")`), cached in a module-level lazy encoder (index.js:56-73). If tiktoken fails to load, it falls back to a crude `ceil(chars / 4)` heuristic. Trigger at 30% of `totalModelLimit` (128000 default).
- The generated system prompt is tagged with `SYSTEM_TAG` (index.js:7) and stripped before token counting to avoid double-counting (index.js:158-160).

## Conventions / gotchas

- Only runtime dependency is `tiktoken` (WASM encoding tables). `files` in package.json lists only `index.js`, `README.md`, `LICENSE`; the dep is resolved by npm at install time.
- Session state (`technicalState`, index.js:50) is module-level and persists across calls in one process.
- `IGNORED_PATHS` (index.js:8) is a `Set` used for tree pruning; tree is bounded by `maxTreeFiles`/`maxTreeDepth`.
