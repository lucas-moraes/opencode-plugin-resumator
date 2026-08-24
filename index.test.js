import test from "node:test";
import assert from "node:assert";
import { get_encoding } from "tiktoken";
import fs from "fs";
import path from "path";
import os from "os";

const pluginModule = await import("./index.internal.js");

function sessionMessages(texts) {
  return texts.map((text, i) => ({
    info: { role: i % 2 === 0 ? "user" : "assistant", id: `m${i}` },
    parts: [{ type: "text", text }],
  }));
}

async function runTransform(plugin, texts) {
  const output = { messages: sessionMessages(texts) };
  await plugin["experimental.chat.messages.transform"]({}, output);
  const sysOut = { system: ["base system"] };
  await plugin["experimental.chat.system.transform"]({}, sysOut);
  return sysOut.system[sysOut.system.length - 1];
}

test("plugin returns top-level OpenCode hooks (not nested under hooks)", async () => {
  const plugin = await pluginModule.default({});
  assert.equal(plugin.hooks, undefined, "must not nest under .hooks");
  assert.equal(typeof plugin.config, "function");
  assert.equal(typeof plugin["command.execute.before"], "function");
  assert.equal(typeof plugin["experimental.chat.messages.transform"], "function");
  assert.equal(typeof plugin["experimental.chat.system.transform"], "function");
  assert.equal(typeof plugin["experimental.session.compacting"], "function");
});

test("token counting matches real tiktoken counts (not raw char/4)", async () => {
  const content = "Hello world, this is a short test message.";
  const enc = get_encoding("cl100k_base");
  const expected = enc.encode(content).length;
  enc.free();

  const plugin = await pluginModule.default({});
  const sys = await runTransform(plugin, [content]);
  const match = sys.match(/\((\d+) tokens\)/);
  assert.ok(match, "reports token count in system prompt");
  assert.equal(Number(match[1]), expected);
});

test("system transform injects project structure and technical state", async () => {
  const plugin = await pluginModule.default({});
  const sys = await runTransform(plugin, ["Hello world, this is a short test message."]);
  assert.match(sys, /### PROJECT STRUCTURE ###/);
  assert.match(sys, /### PERSISTENT TECHNICAL STATE ###/);
  assert.match(sys, /PLUGIN_OPENCODE_CONTEXT_HEADER/);
});

test("tree generation is rooted at process.cwd() by default", async () => {
  const plugin = await pluginModule.default({});
  const sys = await runTransform(plugin, ["Hello"]);
  assert.ok(fs.existsSync(path.join(process.cwd(), "package.json")), "cwd is project root");
  assert.match(sys, /package\.json/);
});

test("plugin prefers context.directory over process.cwd()", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "resumator-"));
  try {
    fs.writeFileSync(path.join(root, "unique-root-marker.txt"), "");
    const plugin = await pluginModule.default({ directory: root });
    const sys = await runTransform(plugin, ["Hello"]);
    assert.match(sys, /unique-root-marker\.txt/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("system prompt includes git status when in a git repo", async () => {
  const plugin = await pluginModule.default({});
  const sys = await runTransform(plugin, ["Hello"]);
  assert.match(sys, /### GIT STATUS ###/);
  assert.match(sys, /Recent commits:/);
  assert.match(sys, /^[A-Za-z][\w./-]*|\bHEAD\b/m);
});

test("system transform strips previous SYSTEM_TAG entries before re-injecting", async () => {
  const plugin = await pluginModule.default({});
  await plugin["experimental.chat.messages.transform"]({}, { messages: sessionMessages(["hi"]) });
  const sysOut = {
    system: [
      "base",
      `${pluginModule.buildContextBlock(process.cwd(), { totalModelLimit: 128000 }, "1.0", 10)}\nold`,
    ],
  };
  await plugin["experimental.chat.system.transform"]({}, sysOut);
  const tagged = sysOut.system.filter((s) => typeof s === "string" && s.includes("PLUGIN_OPENCODE_CONTEXT_HEADER"));
  assert.equal(tagged.length, 1);
  assert.ok(sysOut.system.includes("base"));
});

test("tree omits paths from .gitignore and default ignores", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "resumator-"));
  try {
    fs.mkdirSync(path.join(root, "src"));
    fs.mkdirSync(path.join(root, "generated"));
    fs.mkdirSync(path.join(root, "node_modules"));
    fs.writeFileSync(path.join(root, "src", "app.js"), "");
    fs.writeFileSync(path.join(root, "generated", "bundle.js"), "");
    fs.writeFileSync(path.join(root, "node_modules", "pkg.js"), "");
    fs.writeFileSync(path.join(root, "keep.txt"), "");
    fs.writeFileSync(path.join(root, ".gitignore"), "generated/\n");

    const matcher = pluginModule.loadIgnoreMatcher(root);
    const { treeText } = pluginModule.generateBoundedTree(root, {
      maxTreeDepth: 4,
      maxTreeFiles: 100,
      ignoreMatcher: matcher,
    });

    assert.match(treeText, /src\//);
    assert.match(treeText, /app\.js/);
    assert.match(treeText, /keep\.txt/);
    assert.doesNotMatch(treeText, /generated/);
    assert.doesNotMatch(treeText, /node_modules/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("default ignores apply even without a .gitignore", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "resumator-"));
  try {
    fs.mkdirSync(path.join(root, "dist"));
    fs.writeFileSync(path.join(root, "dist", "app.js"), "");
    fs.writeFileSync(path.join(root, "app.js"), "");

    const matcher = pluginModule.loadIgnoreMatcher(root);
    assert.ok(matcher.ignores("dist/"), "dist is ignored by default");
    assert.ok(!matcher.ignores("app.js/"), "app.js is not ignored");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("analyzeProjectDependencies reads package.json runtime and deps incl devDeps", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "resumator-"));
  try {
    fs.writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({
        name: "demo",
        engines: { node: ">=20" },
        dependencies: { express: "^4" },
        devDependencies: { jest: "^29" },
      }),
    );
    const line = pluginModule.analyzeProjectDependencies(root);
    assert.match(line, /Runtime: Node >=20/);
    assert.match(line, /express/);
    assert.match(line, /jest/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("analyzeProjectDependencies reads pyproject.toml", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "resumator-"));
  try {
    fs.writeFileSync(
      path.join(root, "pyproject.toml"),
      '[project]\nname = "demo"\nrequires-python = ">=3.11"\ndependencies = ["requests>=2", "flask[async]>=3"]\n',
    );
    const line = pluginModule.analyzeProjectDependencies(root);
    assert.match(line, /Runtime: Python >=3.11/);
    assert.match(line, /requests/);
    assert.match(line, /flask/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("analyzeProjectDependencies reads Cargo.toml incl dev-dependencies", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "resumator-"));
  try {
    fs.writeFileSync(
      path.join(root, "Cargo.toml"),
      '[package]\nname = "demo"\nedition = "2021"\n\n[dependencies]\nserde = "1"\n\n[dev-dependencies]\ncriterion = "0.5"\n',
    );
    const line = pluginModule.analyzeProjectDependencies(root);
    assert.match(line, /Rust/);
    assert.match(line, /serde/);
    assert.match(line, /criterion/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("analyzeProjectDependencies returns null when no manifest exists", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "resumator-"));
  try {
    assert.equal(pluginModule.analyzeProjectDependencies(root), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("detectTestsAndDocs finds test dirs, test files, and docs", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "resumator-"));
  try {
    fs.mkdirSync(path.join(root, "tests"));
    fs.mkdirSync(path.join(root, "docs"));
    fs.writeFileSync(path.join(root, "app.test.js"), "");
    fs.writeFileSync(path.join(root, "README.md"), "");
    fs.writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ scripts: { test: "vitest run" } }),
    );
    const block = pluginModule.detectTestsAndDocs(root);
    assert.match(block, /Tests:/);
    assert.match(block, /vitest run/);
    assert.match(block, /tests/);
    assert.match(block, /app\.test\.js/);
    assert.match(block, /Docs:/);
    assert.match(block, /README\.md/);
    assert.match(block, /docs/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("detectTestsAndDocs returns null when nothing found", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "resumator-"));
  try {
    fs.writeFileSync(path.join(root, "app.js"), "");
    assert.equal(pluginModule.detectTestsAndDocs(root), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("config hook registers the resumator commands", async () => {
  const plugin = await pluginModule.default({});
  const cfg = {};
  await plugin.config(cfg);
  assert.ok(cfg.command, "command map is created");
  assert.ok(cfg.command["resumator-clear"], "resumator-clear is registered");
  assert.equal(cfg.command["resumator-clear"].description, "Reset saved files/decisions after a focus change");
  assert.ok(cfg.command["resumator-clear"].template.length > 0);
  assert.ok(cfg.command["resumator-context"], "resumator-context is registered");
  assert.equal(
    cfg.command["resumator-context"].description,
    "Inject the current project context (tree, git status, metadata, tests/docs, technical state)",
  );
  assert.ok(cfg.command["resumator-context"].template.length > 0);
});

test("command.execute.before clears state and replaces parts for resumator-clear", async () => {
  const plugin = await pluginModule.default({});
  const output = { parts: [{ type: "text", text: "original" }] };
  await plugin["command.execute.before"](
    { command: "resumator-clear", sessionID: "s", arguments: "" },
    output,
  );
  assert.equal(output.parts.length, 1);
  assert.match(output.parts[0].text, /Session state cleared/);
});

test("command.execute.before injects context block for resumator-context", async () => {
  const plugin = await pluginModule.default({});
  const output = { parts: [{ type: "text", text: "original" }] };
  await plugin["command.execute.before"](
    { command: "resumator-context", sessionID: "s", arguments: "" },
    output,
  );
  assert.equal(output.parts.length, 1);
  const text = output.parts[0].text;
  assert.match(text, /### PROJECT STRUCTURE ###/);
  assert.match(text, /### PERSISTENT TECHNICAL STATE ###/);
});

test("buildContextBlock returns the full context block", async () => {
  const root = process.cwd();
  const block = pluginModule.buildContextBlock(
    root,
    { totalModelLimit: 128000, enableDependencies: true, enableTestsDocs: true },
    0.1,
    12,
  );
  assert.match(block, /### PROJECT STRUCTURE ###/);
  assert.match(block, /### PERSISTENT TECHNICAL STATE ###/);
  assert.match(block, /Context usage on send: ~0.1% \(12 tokens\)/);
});

test("command.execute.before leaves other commands untouched", async () => {
  const plugin = await pluginModule.default({});
  const output = { parts: [{ type: "text", text: "original" }] };
  await plugin["command.execute.before"]({ command: "other", sessionID: "s", arguments: "" }, output);
  assert.equal(output.parts[0].text, "original");
});

test("messages transform extracts files/decisions; clear resets them", async () => {
  const plugin = await pluginModule.default({});

  const sys1 = await runTransform(plugin, ["Worked on src/app.js. Decision: use Result monad."]);
  assert.match(sys1, /src\/app\.js/);
  assert.match(sys1, /use Result monad/);

  const output = { parts: [{ type: "text", text: "x" }] };
  await plugin["command.execute.before"]({ command: "resumator-clear", sessionID: "s", arguments: "" }, output);

  const sys2 = await runTransform(plugin, ["hello"]);
  assert.match(sys2, /Modified files in session: None/);
  assert.match(sys2, /Recorded decisions: None/);
});

test("session.compacting injects technical state context", async () => {
  const plugin = await pluginModule.default({});
  await plugin["experimental.chat.messages.transform"](
    {},
    { messages: sessionMessages(["Edited src/comp.js. Decision: keep TOON."]) },
  );
  const output = { context: [] };
  await plugin["experimental.session.compacting"]({ sessionID: "s" }, output);
  assert.equal(output.context.length, 1);
  assert.match(output.context[0], /### RESUMATOR TECHNICAL STATE ###/);
  assert.match(output.context[0], /src\/comp\.js/);
  assert.match(output.context[0], /keep TOON/);
});

test("estimateTokens supports legacy content and session parts shapes", () => {
  const a = pluginModule.estimateTokens([{ role: "user", content: "abcd" }]);
  const b = pluginModule.estimateTokens([{ info: { role: "user" }, parts: [{ type: "text", text: "abcd" }] }]);
  const c = pluginModule.estimateTokens([{ type: "text", text: "abcd" }]);
  assert.equal(a, b);
  assert.equal(b, c);
  assert.ok(a > 0);
});

test("saveTechnicalState and loadTechnicalState round-trip (TOON)", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "resumator-"));
  try {
    const out = { parts: [] };
    const p = await pluginModule.default({});
    await p["experimental.chat.messages.transform"](
      {},
      { messages: sessionMessages(["Edited src/a.js. Decision: use X."]) },
    );

    const srcFile = path.join(process.cwd(), ".opencode", "resumator-state.toon");
    fs.mkdirSync(path.join(root, ".opencode"), { recursive: true });
    fs.copyFileSync(srcFile, path.join(root, ".opencode", "resumator-state.toon"));
    assert.match(fs.readFileSync(path.join(root, ".opencode", "resumator-state.toon"), "utf8"), /^modifiedFiles\[\d+\]:/);

    const loaded = pluginModule.loadTechnicalState(root);
    assert.ok([...loaded.modifiedFiles].includes("src/a.js"));
    assert.ok([...loaded.recordedDecisions].some((d) => d.includes("use X")));

    await p["command.execute.before"]({ command: "resumator-clear" }, out);
    const cleared = pluginModule.loadTechnicalState(process.cwd());
    assert.deepEqual([...cleared.modifiedFiles], []);
  } finally {
    fs.rmSync(path.join(process.cwd(), ".opencode"), { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("loadTechnicalState returns empty state when no file exists", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "resumator-"));
  try {
    const state = pluginModule.loadTechnicalState(root);
    assert.deepEqual([...state.modifiedFiles], []);
    assert.deepEqual([...state.recordedDecisions], []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("loadTechnicalState handles corrupt TOON gracefully", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "resumator-"));
  try {
    fs.mkdirSync(path.join(root, ".opencode"));
    fs.writeFileSync(path.join(root, ".opencode", "resumator-state.toon"), "modifiedFiles[ not valid toon");
    const state = pluginModule.loadTechnicalState(root);
    assert.deepEqual([...state.modifiedFiles], []);
    assert.deepEqual([...state.recordedDecisions], []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("loadTechnicalState migrates legacy JSON state to TOON", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "resumator-"));
  try {
    fs.mkdirSync(path.join(root, ".opencode"));
    fs.writeFileSync(
      path.join(root, ".opencode", "resumator-state.json"),
      JSON.stringify({ modifiedFiles: ["src/legacy.js"], recordedDecisions: ["Decision: keep"] }),
    );
    const state = pluginModule.loadTechnicalState(root);
    assert.deepEqual([...state.modifiedFiles], ["src/legacy.js"]);
    assert.deepEqual([...state.recordedDecisions], ["Decision: keep"]);
    assert.ok(!fs.existsSync(path.join(root, ".opencode", "resumator-state.json")));
    assert.ok(fs.existsSync(path.join(root, ".opencode", "resumator-state.toon")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
