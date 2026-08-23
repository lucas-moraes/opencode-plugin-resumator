# AGENTS.md

Single-file ESM OpenCode plugin. All logic lives in `index.js` (no build step, no TS). Entrypoint: default export `OpenCodeContextCompressorPlugin(context)` (index.js:146).

## Commands

- `npm test` — runs `node --test` on `*.test.js` files (see `index.test.js`). `prepublishOnly` runs the same command.
- `npm run release` — runs tests, creates a tag `v$npm_package_version` from the version you set in `package.json`, then pushes the branch (`git push origin`) and the tag explicitly (`git push origin v$npm_package_version`), triggering the GitHub Actions `publish` workflow (`.github/workflows/publish.yml`). Commit the version bump before running it. Note: avoid `--follow-tags` — it silently skips the tag when the branch is already up-to-date.
- No lint, typecheck, or build scripts.

## Architecture

- Plugin is a function receiving a `context` object, returning a `hooks` map. The only hook used is `"chat:before-send"` (index.js:155).
- `process.cwd()` is the project root (index.js:147) — NOT `context` or the plugin dir. Tests/relative file handling must account for this.
- Config is read live from `opencode.json` at the cwd root under the `contextCompressor` key (index.js:21-45). No schema; unrecognized keys fall back to `DEFAULT_CONFIG` (index.js:10).
- Token counting uses the `tiktoken` package (`get_encoding("cl100k_base")`), cached in a module-level lazy encoder (index.js:56-73). If tiktoken fails to load, it falls back to a crude `ceil(chars / 4)` heuristic. Trigger at 30% of `totalModelLimit` (128000 default).
- The generated system prompt is tagged with `SYSTEM_TAG` (index.js:7) and stripped before token counting to avoid double-counting (index.js:158-160).
- Git status is injected into the system prompt via `git` CLI subprocess calls (`git status --porcelain -b`, `git rev-parse`, `git log`) (index.js:163-217). If the cwd is not a git repo, the block is omitted entirely — never fails the hook.
- Tree pruning uses the `ignore` package (index.js:60-74). It reads the **root** `.gitignore` and merges it with `DEFAULT_IGNORED` (`node_modules`, `dist`, `build`, `coverage`, `.cache`). The matcher is rebuilt on every `chat:before-send` so `.gitignore` changes take effect immediately.
- Project metadata (runtime + deps) is analyzed from the manifest via `analyzeProjectDependencies` (index.js:319, parsing at index.js:257-327): `package.json` (JSON.parse), `pyproject.toml` and `Cargo.toml` (via `smol-toml`). TOML keys preserve hyphens (`requires-python`, `rust-version`, `dev-dependencies`) — read them with bracket access `["requires-python"]`, not dot notation.
- `detectTestsAndDocs` (index.js:334-349) scans the root for test dirs/files (`tests/`, `__tests__/`, `*.test.js`/`*.spec.js`) and docs (`README.md`, `docs/`), plus the `scripts.test` command from `package.json`.
- Both metadata and tests/docs blocks are gated by config flags `enableDependencies`/`enableTestsDocs` (default `true`) in `opencode.json` under `contextCompressor`.
- The plugin also registers two commands (via the `config` hook), intercepted in the `command.execute.before` hook (index.js:496-521): `/resumator-clear` resets session state (`resetTechnicalState` zeroes `modifiedFiles`/`recordedDecisions`), and `/resumator-context` injects the full context block on demand.
- `buildContextBlock` (index.js:441-475) assembles the whole injected context (project tree + git status + metadata + tests/docs + technical state); it's reused by both `chat:before-send` and the `/resumator-context` command.
- `technicalState` is persisted to disk at `ROOT_PATH/.opencode/resumator-state.toon` in TOON format (via `@toon-format/toon`'s `encode`/`decode`, index.js:68-108). It's loaded at plugin instantiation (`loadTechnicalState`, index.js:429) and saved after every `chat:before-send` mutation and on `/resumator-clear` (`saveTechnicalState`), so memory survives terminal close/reopen. A legacy `.json` state file is auto-migrated to `.toon` and removed on first load (`migrateLegacyState`). Writes are atomic (tmp + rename); all disk ops are wrapped in `try/catch` and never break the hook.

## Conventions / gotchas

- Runtime dependencies are `tiktoken` (WASM encoding tables), `ignore` (.gitignore parsing), `smol-toml` (TOML parsing), and `@toon-format/toon` (TOON state serialization). `files` in package.json lists only `index.js`, `README.md`, `LICENSE`; deps are resolved by npm at install time.
- Session state (`technicalState`, index.js:50) is module-level and persists across calls in one process.
- `generateBoundedTree`, `loadIgnoreMatcher`, `buildContextBlock`, `analyzeProjectDependencies`, `detectTestsAndDocs`, `resetTechnicalState`, `loadTechnicalState`, and `saveTechnicalState` are also exported as named exports (index.js:578) for deterministic testing. The ignore matcher is passed via `config.ignoreMatcher`; directory paths are checked with a trailing `/` so `dir/` gitignore rules match correctly.
