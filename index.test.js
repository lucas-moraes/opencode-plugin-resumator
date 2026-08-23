import test from "node:test";
import assert from "node:assert";
import { get_encoding } from "tiktoken";
import fs from "fs";
import path from "path";
import os from "os";

const pluginModule = await import("./index.js");

function freshContext() {
  return {
    messages: [
      { role: "user", content: "Hello world, this is a short test message." },
      { role: "assistant", content: "Understood. I will proceed with the task." },
    ],
  };
}

test("plugin is callable and returns a chat:before-send hook", async () => {
  const plugin = await pluginModule.default({});
  assert.ok(plugin.hooks, "plugin exposes hooks");
  assert.equal(typeof plugin.hooks["chat:before-send"], "function");
});

test("token counting matches real tiktoken counts (not raw char/4)", async () => {
  const content = "Hello world, this is a short test message.";
  const enc = get_encoding("cl100k_base");
  const expected = enc.encode(content).length;
  enc.free();

  const plugin = await pluginModule.default({});
  const res = await plugin.hooks["chat:before-send"]({
    messages: [{ role: "user", content }],
    client: { chat: async () => ({ content: "summary" }) },
  });

  const sys = res.messages[0].content;
  const match = sys.match(/\((\d+) tokens\)/);
  assert.ok(match, "reports token count in system prompt");
  assert.equal(Number(match[1]), expected);
});

test("system prompt includes project structure and technical state", async () => {
  const plugin = await pluginModule.default({});
  const res = await plugin.hooks["chat:before-send"]({
    ...freshContext(),
    client: { chat: async () => ({ content: "summary" }) },
  });

  const sys = res.messages[0].content;
  assert.match(sys, /### PROJECT STRUCTURE ###/);
  assert.match(sys, /### PERSISTENT TECHNICAL STATE ###/);
  assert.match(sys, /PLUGIN_OPENCODE_CONTEXT_HEADER/);
});

test("tree generation is rooted at process.cwd()", async () => {
  const plugin = await pluginModule.default({});
  const res = await plugin.hooks["chat:before-send"]({
    ...freshContext(),
    client: { chat: async () => ({ content: "summary" }) },
  });
  const sys = res.messages[0].content;
  assert.ok(fs.existsSync(path.join(process.cwd(), "package.json")), "cwd is project root");
  assert.match(sys, /package\.json/);
});

test("system prompt includes git status when in a git repo", async () => {
  const plugin = await pluginModule.default({});
  const res = await plugin.hooks["chat:before-send"]({
    ...freshContext(),
    client: { chat: async () => ({ content: "summary" }) },
  });
  const sys = res.messages[0].content;
  assert.match(sys, /### GIT STATUS ###/);
  assert.match(sys, /Recent commits:/);
  // The git block always carries a branch heading — a named branch or HEAD (detached).
  assert.match(sys, /^[A-Za-z][\w./-]*|\bHEAD\b/m);
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

test("config hook registers the resumator-clear command", async () => {
  const plugin = await pluginModule.default({});
  const cfg = {};
  await plugin.hooks.config(cfg);
  assert.ok(cfg.command, "command map is created");
  assert.ok(cfg.command["resumator-clear"], "resumator-clear is registered");
  assert.equal(cfg.command["resumator-clear"].description, "Reset saved files/decisions after a focus change");
  assert.ok(cfg.command["resumator-clear"].template.length > 0);
});

test("command.execute.before clears state and replaces parts for resumator-clear", async () => {
  const plugin = await pluginModule.default({});
  const output = { parts: [{ type: "text", text: "original" }] };
  await plugin.hooks["command.execute.before"](
    { command: "resumator-clear", sessionID: "s", arguments: "" },
    output,
  );
  assert.equal(output.parts.length, 1);
  assert.match(output.parts[0].text, /Session state cleared/);
});

test("command.execute.before leaves other commands untouched", async () => {
  const plugin = await pluginModule.default({});
  const output = { parts: [{ type: "text", text: "original" }] };
  await plugin.hooks["command.execute.before"]({ command: "other", sessionID: "s", arguments: "" }, output);
  assert.equal(output.parts[0].text, "original");
});

test("resetTechnicalState clears modified files and decisions", async () => {
  const plugin = await pluginModule.default({});
  const hook = plugin.hooks["chat:before-send"];

  const send = async (content) => {
    const res = await hook({ messages: [{ role: "user", content }], client: { chat: async () => ({ content: "s" }) } });
    return res.messages[0].content;
  };

  const sys1 = await send("Worked on src/app.js. Decision: use Result monad.");
  assert.match(sys1, /src\/app\.js/);
  assert.match(sys1, /use Result monad/);

  const output = { parts: [{ type: "text", text: "x" }] };
  await plugin.hooks["command.execute.before"]({ command: "resumator-clear", sessionID: "s", arguments: "" }, output);

  const sys2 = await send("hello");
  assert.match(sys2, /Modified files in session: None/);
  assert.match(sys2, /Recorded decisions: None/);
});

test("saveTechnicalState and loadTechnicalState round-trip (TOON)", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "resumator-"));
  try {
    // Populate module state through a chat send (also persists to repo cwd),
    // then exercise save/load helpers against the temp root.
    const out = { parts: [] };
    return (async () => {
      const p = await pluginModule.default({});
      await p.hooks["chat:before-send"]({
        messages: [{ role: "user", content: "Edited src/a.js. Decision: use X." }],
        client: { chat: async () => ({ content: "s" }) },
      });

      // Copy the freshly-saved TOON file into the temp root to simulate persisted state
      const srcFile = path.join(process.cwd(), ".opencode", "resumator-state.toon");
      fs.mkdirSync(path.join(root, ".opencode"), { recursive: true });
      fs.copyFileSync(srcFile, path.join(root, ".opencode", "resumator-state.toon"));
      assert.match(fs.readFileSync(path.join(root, ".opencode", "resumator-state.toon"), "utf8"), /^modifiedFiles\[\d+\]:/);

      const loaded = pluginModule.loadTechnicalState(root);
      assert.ok([...loaded.modifiedFiles].includes("src/a.js"));
      assert.ok([...loaded.recordedDecisions].some((d) => d.includes("use X")));

      // clear + persist via command hook (writes to repo cwd), then verify helpers
      await p.hooks["command.execute.before"]({ command: "resumator-clear" }, out);
      const cleared = pluginModule.loadTechnicalState(process.cwd());
      assert.deepEqual([...cleared.modifiedFiles], []);
    })();
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
    // legacy removed, TOON created
    assert.ok(!fs.existsSync(path.join(root, ".opencode", "resumator-state.json")));
    assert.ok(fs.existsSync(path.join(root, ".opencode", "resumator-state.toon")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
