import test from "node:test";
import assert from "node:assert";
import { get_encoding } from "tiktoken";
import fs from "fs";
import path from "path";

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
