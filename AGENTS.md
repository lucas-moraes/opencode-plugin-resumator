# AGENTS.md

ESM OpenCode plugin. Logic lives in `index.internal.js`; `index.js` re-exports the default. Entrypoint: default export `OpenCodeContextCompressorPlugin(context)` (index.internal.js).

## Commands

- `npm test` — runs `node --test` on `*.test.js` files (see `index.test.js`). `prepublishOnly` runs the same command.
- `npm run release` — runs tests, creates a tag `v$npm_package_version` from the version you set in `package.json`, then pushes the branch (`git push origin`) and the tag explicitly (`git push origin v$npm_package_version`), triggering the GitHub Actions `publish` workflow (`.github/workflows/publish.yml`). Commit the version bump before running it. Note: avoid `--follow-tags` — it silently skips the tag when the branch is already up-to-date.
- No lint, typecheck, or build scripts.

## Architecture

- Plugin is a function receiving a `context` object (`PluginInput`), returning a **flat** `Hooks` map (OpenCode API). Do **not** nest under `{ hooks: { ... } }` — the runtime reads top-level keys only (`hook.config`, `hook[name]`).
- Root path: `context.directory || process.cwd()`. Tests that pass `{}` fall back to `process.cwd()`.
- Config is read live from `opencode.json` at the root under the `contextCompressor` key (`loadUserConfig`). Unrecognized keys fall back to `DEFAULT_CONFIG`.
- Token counting uses the `tiktoken` package (`get_encoding("cl100k_base")`), cached in a module-level lazy encoder. If tiktoken fails to load, it falls back to a crude `ceil(chars / 4)` heuristic. `estimateTokens` accepts legacy `{ content }`, session `{ info, parts }`, and bare `Part[]`.
- The generated system block is tagged with `SYSTEM_TAG` and stripped from `output.system` before re-injection in `experimental.chat.system.transform` to avoid double-counting.
- Git status is injected into the context block via `git` CLI subprocess calls. If the cwd is not a git repo, the block is omitted entirely — never fails the hook.
- Tree pruning uses the `ignore` package. It reads the **root** `.gitignore` and merges it with `DEFAULT_IGNORED` (`node_modules`, `dist`, `build`, `coverage`, `.cache`). The matcher is rebuilt on every context build so `.gitignore` changes take effect immediately.
- Project metadata (runtime + deps) is analyzed via `analyzeProjectDependencies`: `package.json` (JSON.parse), `pyproject.toml` and `Cargo.toml` (via `smol-toml`). TOML keys preserve hyphens — use bracket access `["requires-python"]`, not dot notation.
- `detectTestsAndDocs` scans the root for test dirs/files and docs, plus `scripts.test` from `package.json`.
- Both metadata and tests/docs blocks are gated by config flags `enableDependencies`/`enableTestsDocs` (default `true`) in `opencode.json` under `contextCompressor`.
- Hooks registered (flat return):
  - `config` — registers `/resumator-clear` and `/resumator-context` on `cfg.command`.
  - `command.execute.before` — clear state or inject full context block into `output.parts`.
  - `experimental.chat.messages.transform` — extract files/decisions from message parts, update token usage cache, persist state.
  - `experimental.chat.system.transform` — inject `buildContextBlock` into `output.system`.
  - `experimental.session.compacting` — push technical state (and optional metadata) into OpenCode’s native compaction via `output.context`.
- DIY history rewrite / `client.chat` summarization was removed; OpenCode’s built-in compaction owns summarization. The plugin enriches it and injects project context every turn.
- `buildContextBlock` assembles the whole injected context (project tree + git status + metadata + tests/docs + technical state); reused by system transform and `/resumator-context`.
- `technicalState` is persisted to disk at `<root>/.opencode/resumator-state.toon` in TOON format (via `@toon-format/toon`). Loaded at plugin instantiation (`loadTechnicalState`) and saved after every messages-transform mutation and on `/resumator-clear`. Legacy `.json` state is auto-migrated to `.toon`. Writes are atomic (tmp + rename); all disk ops are wrapped in `try/catch` and never break the hook.

## Conventions / gotchas

- Runtime dependencies are `tiktoken`, `ignore`, `smol-toml`, and `@toon-format/toon`. `files` in package.json lists `index.js`, `index.internal.js`, `README.md`, `LICENSE`.
- Session state (`technicalState`) is module-level and persists across calls in one process.
- `generateBoundedTree`, `loadIgnoreMatcher`, `buildContextBlock`, `buildCompactionContext`, `analyzeProjectDependencies`, `detectTestsAndDocs`, `resetTechnicalState`, `loadTechnicalState`, `saveTechnicalState`, `estimateTokens`, and `extractCriticalDataFromMessages` are named exports for testing. The ignore matcher is passed via `config.ignoreMatcher`; directory paths are checked with a trailing `/` so `dir/` gitignore rules match correctly.
