import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { get_encoding } from "tiktoken";
import ignore from "ignore";
import { parse as parseToml } from "smol-toml";
import { encode as encodeToon, decode as decodeToon } from "@toon-format/toon";

// ============================================================================
// 1. CONFIGURATION & CONSTANTS WITH FALLBACK DEFAULTS
// ============================================================================
const SYSTEM_TAG = "<!-- PLUGIN_OPENCODE_CONTEXT_HEADER -->";
const DEFAULT_IGNORED = ["node_modules", "dist", "build", "coverage", ".cache"];

const DEFAULT_CONFIG = {
  totalModelLimit: 128000,
  triggerPercentage: 0.3, // 30% trigger
  keepLatest: 4,
  maxTreeFiles: 100,
  maxTreeDepth: 4,
  enableDependencies: true,
  enableTestsDocs: true,
};

/**
 * Reads user plugin settings from opencode.json in the project root
 */
function loadUserConfig(rootPath) {
  const configPath = path.join(rootPath, "opencode.json");
  if (!fs.existsSync(configPath)) {
    return DEFAULT_CONFIG;
  }

  try {
    const rawData = fs.readFileSync(configPath, "utf8");
    const parsed = JSON.parse(rawData);

    // Read custom settings under "contextCompressor" key (or fallback to defaults)
    const userSettings = parsed.contextCompressor || {};

    return {
      totalModelLimit: userSettings.totalModelLimit ?? DEFAULT_CONFIG.totalModelLimit,
      triggerPercentage: userSettings.triggerPercentage ?? DEFAULT_CONFIG.triggerPercentage,
      keepLatest: userSettings.keepLatest ?? DEFAULT_CONFIG.keepLatest,
      maxTreeFiles: userSettings.maxTreeFiles ?? DEFAULT_CONFIG.maxTreeFiles,
      maxTreeDepth: userSettings.maxTreeDepth ?? DEFAULT_CONFIG.maxTreeDepth,
      enableDependencies: userSettings.enableDependencies ?? DEFAULT_CONFIG.enableDependencies,
      enableTestsDocs: userSettings.enableTestsDocs ?? DEFAULT_CONFIG.enableTestsDocs,
    };
  } catch (err) {
    console.warn("[Plugin] Failed to parse opencode.json, falling back to defaults:", err.message);
    return DEFAULT_CONFIG;
  }
}

// ============================================================================
// 2. PERSISTENT SESSION STATE
// ============================================================================
let technicalState = {
  modifiedFiles: new Set(),
  recordedDecisions: new Set(),
};

function resetTechnicalState() {
  technicalState.modifiedFiles = new Set();
  technicalState.recordedDecisions = new Set();
}

// ============================================================================
// 2a. DISK PERSISTENCE
// ============================================================================
function stateFilePath(rootPath) {
  return path.join(rootPath, ".opencode", "resumator-state.toon");
}

function legacyStateFilePath(rootPath) {
  return path.join(rootPath, ".opencode", "resumator-state.json");
}

function migrateLegacyState(rootPath) {
  const legacy = legacyStateFilePath(rootPath);
  const current = stateFilePath(rootPath);
  if (fs.existsSync(legacy) && !fs.existsSync(current)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(legacy, "utf8"));
      technicalState = {
        modifiedFiles: new Set(Array.isArray(parsed.modifiedFiles) ? parsed.modifiedFiles : []),
        recordedDecisions: new Set(Array.isArray(parsed.recordedDecisions) ? parsed.recordedDecisions : []),
      };
      saveTechnicalState(rootPath);
      fs.rmSync(legacy, { force: true });
    } catch (err) {
      console.warn("[Plugin] Failed to migrate legacy state:", err.message);
    }
  }
}

function saveTechnicalState(rootPath) {
  try {
    const file = stateFilePath(rootPath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const payload = encodeToon({
      modifiedFiles: Array.from(technicalState.modifiedFiles),
      recordedDecisions: Array.from(technicalState.recordedDecisions),
    });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, payload);
    fs.renameSync(tmp, file);
  } catch (err) {
    console.warn("[Plugin] Failed to save technical state:", err.message);
  }
}

function loadTechnicalState(rootPath) {
  try {
    migrateLegacyState(rootPath);
    const file = stateFilePath(rootPath);
    if (!fs.existsSync(file)) {
      return { modifiedFiles: new Set(), recordedDecisions: new Set() };
    }
    const parsed = decodeToon(fs.readFileSync(file, "utf8"));
    return {
      modifiedFiles: new Set(Array.isArray(parsed.modifiedFiles) ? parsed.modifiedFiles : []),
      recordedDecisions: new Set(Array.isArray(parsed.recordedDecisions) ? parsed.recordedDecisions : []),
    };
  } catch (err) {
    console.warn("[Plugin] Failed to load technical state:", err.message);
    return { modifiedFiles: new Set(), recordedDecisions: new Set() };
  }
}

// ============================================================================
// 2b. GITIGNORE MATCHER
// ============================================================================
function loadIgnoreMatcher(rootPath) {
  const matcher = ignore().add(DEFAULT_IGNORED);
  const gitignorePath = path.join(rootPath, ".gitignore");
  if (fs.existsSync(gitignorePath)) {
    try {
      matcher.add(fs.readFileSync(gitignorePath, "utf8"));
    } catch (err) {
      console.warn("[Plugin] Failed to read .gitignore:", err.message);
    }
  }
  return matcher;
}

// ============================================================================
// 3. UTILITY FUNCTIONS
// ============================================================================
let cachedEncoding = null;

function getTokenCounter() {
  try {
    if (!cachedEncoding) {
      cachedEncoding = get_encoding("cl100k_base");
    }
    return (text) => cachedEncoding.encode(text).length;
  } catch (err) {
    console.warn("[Plugin] tiktoken unavailable, falling back to char/4 heuristic:", err.message);
    return (text) => Math.ceil(text.length / 4);
  }
}

const countTokens = getTokenCounter();

function estimateTokens(messages) {
  return messages.reduce((acc, msg) => {
    const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content || "");
    return acc + countTokens(content);
  }, 0);
}

function extractCriticalData(text) {
  if (typeof text !== "string") return;

  const fileRegex = /(?:[\w-]+\/)+[\w-]+\.[\w-]+|[\w-]+\.(?:js|ts|jsx|tsx|json|py|html|css)/g;
  const files = text.match(fileRegex);
  if (files) {
    files.forEach((f) => technicalState.modifiedFiles.add(f));
  }

  if (text.includes("Decision:") || text.includes("Decided:")) {
    technicalState.recordedDecisions.add(text);
  }
}

function generateBoundedTree(dirPath, config) {
  let fileCounter = 0;
  let limitReached = false;

  function traverse(currentDir, relDir = "", prefix = "", depth = 0) {
    if (depth > config.maxTreeDepth) {
      return `${prefix}└── ... (maximum depth reached)\n`;
    }

    let items = [];
    try {
      items = fs.readdirSync(currentDir);
    } catch (e) {
      return "";
    }

    const filteredItems = items
      .filter((item) => {
        if (item.startsWith(".")) return false;
        const rel = path.posix.join(relDir, item);
        return !config.ignoreMatcher.ignores(`${rel}/`);
      })
      .sort((a, b) => {
        const fullA = path.join(currentDir, a);
        const fullB = path.join(currentDir, b);
        const isDirA = fs.existsSync(fullA) && fs.statSync(fullA).isDirectory();
        const isDirB = fs.existsSync(fullB) && fs.statSync(fullB).isDirectory();
        return isDirB - isDirA;
      });

    let result = "";
    for (let i = 0; i < filteredItems.length; i++) {
      const item = filteredItems[i];
      const isLast = i === filteredItems.length - 1;
      const fullPath = path.join(currentDir, item);
      const pointer = isLast ? "└── " : "├── ";

      let stats;
      try {
        stats = fs.statSync(fullPath);
      } catch (e) {
        continue;
      }

      if (stats.isDirectory()) {
        result += `${prefix}${pointer}${item}/\n`;
        const newPrefix = prefix + (isLast ? "    " : "│   ");
        result += traverse(fullPath, path.posix.join(relDir, item), newPrefix, depth + 1);
      } else {
        fileCounter++;
        if (fileCounter > config.maxTreeFiles) {
          if (!limitReached) {
            result += `${prefix}${pointer}... [${config.maxTreeFiles} FILES LIMIT REACHED]\n`;
            limitReached = true;
          }
          break;
        }
        result += `${prefix}${pointer}${item}\n`;
      }
    }

    return result;
  }

  const treeText = traverse(dirPath);
  return { treeText, totalCounted: fileCounter, truncated: limitReached };
}

// ============================================================================
// 3b. GIT STATUS AWARENESS
// ============================================================================
function runGit(args, rootPath) {
  try {
    return execSync(`git ${args}`, {
      cwd: rootPath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

function generateGitStatus(rootPath) {
  const branch = runGit("rev-parse --abbrev-ref HEAD", rootPath);
  if (branch === null) {
    return null;
  }

  const currentBranch = branch.trim();
  const porcelain = (runGit("status --porcelain -b", rootPath) || "").trim();
  const lines = porcelain.split("\n").filter((l) => l.length > 0);

  let heading = currentBranch;
  if (lines.length > 0 && lines[0].startsWith("##")) {
    const branchLine = lines[0].slice(2).trim();
    const aheadMatch = branchLine.match(/ahead (\d+)/);
    const behindMatch = branchLine.match(/behind (\d+)/);
    if (aheadMatch || behindMatch) {
      const parts = [];
      if (aheadMatch) parts.push(`${aheadMatch[1]} ahead`);
      if (behindMatch) parts.push(`${behindMatch[1]} behind`);
      heading += ` (${parts.join(", ")})`;
    }
    lines.shift();
  }

  const staged = [];
  const unstaged = [];
  const untracked = [];

  for (const line of lines) {
    const index = line[0];
    const work = line[1] ?? " ";
    const file = line.slice(3);

    if (line.startsWith("??")) {
      untracked.push(file);
    } else if (index !== " " && index !== "?") {
      staged.push(`${index} ${file}`);
    } else if (work !== " " && work !== "?") {
      unstaged.push(`${work} ${file}`);
    }
  }

  const section = (title, items) => (items.length ? `${title}:\n${items.map((i) => `  - ${i}`).join("\n")}` : null);
  const parts = [section("Staged", staged), section("Modified", unstaged), section("Untracked", untracked)].filter(Boolean);

  const recentLog = runGit("log --oneline -5", rootPath);
  const recent = recentLog ? `\nRecent commits:\n${recentLog.trim().split("\n").map((l) => `  ${l}`).join("\n")}` : "";

  return {
    heading,
    summary: `${heading}${parts.length ? `\n${parts.join("\n")}` : " — working tree clean"}${recent}`,
  };
}

// ============================================================================
// 3c. PROJECT DEPENDENCY ANALYSIS
// ============================================================================
function compactDepNames(deps) {
  if (!deps || typeof deps !== "object") return [];
  return Object.keys(deps);
}

function analyzePackageJson(rootPath) {
  const pkgPath = path.join(rootPath, "package.json");
  if (!fs.existsSync(pkgPath)) return null;
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    const runtime = pkg.engines?.node ? `Node ${pkg.engines.node}` : "Node";
    const deps = [...compactDepNames(pkg.dependencies), ...compactDepNames(pkg.devDependencies)];
    return `Runtime: ${runtime}${deps.length ? ` | deps: ${deps.join(", ")}` : ""}`;
  } catch (err) {
    console.warn("[Plugin] Failed to parse package.json:", err.message);
    return null;
  }
}

function analyzePyprojectToml(rootPath) {
  const manifestPath = path.join(rootPath, "pyproject.toml");
  if (!fs.existsSync(manifestPath)) return null;
  try {
    const data = parseToml(fs.readFileSync(manifestPath, "utf8"));
    const project = data.project || {};
    const pythonVersion = project.requires_python ?? project["requires-python"];
    const runtime = pythonVersion ? `Python ${pythonVersion}` : "Python";
    let deps = [];
    if (Array.isArray(project.dependencies)) {
      deps = project.dependencies.map((d) => (typeof d === "string" ? d.split(/[=<>~!;[]/, 1)[0].trim() : String(d)));
    } else if (data["tool"]?.poetry?.dependencies) {
      deps = Object.keys(data["tool"].poetry.dependencies).filter((k) => k !== "python");
    }
    return `Runtime: ${runtime}${deps.length ? ` | deps: ${deps.join(", ")}` : ""}`;
  } catch (err) {
    console.warn("[Plugin] Failed to parse pyproject.toml:", err.message);
    return null;
  }
}

function analyzeCargoToml(rootPath) {
  const manifestPath = path.join(rootPath, "Cargo.toml");
  if (!fs.existsSync(manifestPath)) return null;
  try {
    const data = parseToml(fs.readFileSync(manifestPath, "utf8"));
    const pkg = data.package || {};
    const rustVersion = pkg.rust_version ?? pkg["rust-version"];
    const runtime = rustVersion
      ? `Rust ${rustVersion}`
      : pkg.edition
        ? `Rust (edition ${pkg.edition})`
        : "Rust";
    const deps = [...compactDepNames(data.dependencies), ...compactDepNames(data["dev-dependencies"])];
    return `Runtime: ${runtime}${deps.length ? ` | deps: ${deps.join(", ")}` : ""}`;
  } catch (err) {
    console.warn("[Plugin] Failed to parse Cargo.toml:", err.message);
    return null;
  }
}

function analyzeProjectDependencies(rootPath) {
  return (
    analyzePackageJson(rootPath) ||
    analyzePyprojectToml(rootPath) ||
    analyzeCargoToml(rootPath) ||
    null
  );
}

// ============================================================================
// 3d. TESTS & DOCS DETECTION
// ============================================================================
const TEST_DIRS = ["tests", "test", "__tests__", "spec"];
const DOC_FILES = ["README.md", "CONTRIBUTING.md", "docs"];

function detectTestsAndDocs(rootPath) {
  let entries = [];
  try {
    entries = fs.readdirSync(rootPath);
  } catch (err) {
    return null;
  }

  const testDirs = TEST_DIRS.filter((d) => entries.includes(d));
  const testFiles = entries.filter((e) => /\.(test|spec)\.(js|ts|jsx|tsx|mjs|cjs|py|rs)$/.test(e));
  const hasTests = testDirs.length > 0 || testFiles.length > 0;

  const docs = DOC_FILES.filter((d) => entries.includes(d));

  const testCommand = analyzePackageJson(rootPath) && (() => {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(rootPath, "package.json"), "utf8"));
      return pkg.scripts?.test ? pkg.scripts.test : null;
    } catch {
      return null;
    }
  })();

  const parts = [];
  if (hasTests) {
    const locations = [...testDirs, ...testFiles];
    parts.push(`Tests: ${testCommand ? `"${testCommand}"` : "present"} (${locations.join(", ")})`);
  }
  if (docs.length) {
    parts.push(`Docs: ${docs.join(", ")}`);
  }

  return parts.length ? parts.join("\n") : null;
}

// ============================================================================
// 4. CONTEXT BLOCK BUILDING
// ============================================================================
function buildContextBlock(rootPath, config, currentPercentage, currentTokens) {
  const { treeText, totalCounted, truncated } = generateBoundedTree(rootPath, {
    ...config,
    ignoreMatcher: loadIgnoreMatcher(rootPath),
  });
  const truncationWarning = truncated ? `\n> ⚠️ *Tree truncated at ${totalCounted} files to save tokens.*` : "";

  const gitStatus = generateGitStatus(rootPath);
  const gitBlock = gitStatus
    ? `### GIT STATUS ###
\`\`\`text
${gitStatus.summary}\`\`\`
`
    : "";

  const depsLine = config.enableDependencies ? analyzeProjectDependencies(rootPath) : null;
  const depsBlock = depsLine ? `### PROJECT METADATA ###
${depsLine}

` : "";

  const testsDocs = config.enableTestsDocs ? detectTestsAndDocs(rootPath) : null;
  const testsDocsBlock = testsDocs ? `### TESTS & DOCS ###
\`\`\`text
${testsDocs}\`\`\`

` : "";

  return `${SYSTEM_TAG}
### PROJECT STRUCTURE ###
\`\`\`text
${treeText}\`\`\`${truncationWarning}

${depsBlock}${testsDocsBlock}${gitBlock}### PERSISTENT TECHNICAL STATE ###
- Modified files in session: ${Array.from(technicalState.modifiedFiles).join(", ") || "None"}
- Recorded decisions: ${Array.from(technicalState.recordedDecisions).join(" | ") || "None"}
- Context usage on send: ~${currentPercentage}% (${currentTokens} tokens)
`;
}

// ============================================================================
// 5. MAIN OPENCODE PLUGIN
// ============================================================================
async function OpenCodeContextCompressorPlugin(context) {
  const ROOT_PATH = process.cwd();

  // Load configuration dynamically from opencode.json
  const config = loadUserConfig(ROOT_PATH);
  const tokenTriggerThreshold = Math.floor(config.totalModelLimit * config.triggerPercentage);

  // Restore persisted session state from disk (survives terminal close/reopen)
  technicalState = loadTechnicalState(ROOT_PATH);

  return {
    hooks: {
      config: (cfg) => {
        cfg.command = cfg.command || {};
        cfg.command["resumator-clear"] = {
          description: "Reset saved files/decisions after a focus change",
          template: "The user changed focus. Reset the saved modified files and recorded decisions. Acknowledge briefly.",
        };
        cfg.command["resumator-context"] = {
          description: "Inject the current project context (tree, git status, metadata, tests/docs, technical state)",
          template: "The user requested the current project context. Review it and acknowledge.",
        };
      },
      "command.execute.before": async ({ command }, output) => {
        if (command === "resumator-clear") {
          resetTechnicalState();
          saveTechnicalState(ROOT_PATH);
          output.parts = [
            {
              type: "text",
              text: "[Resumator] Session state cleared: modified files and recorded decisions reset.",
            },
          ];
        } else if (command === "resumator-context") {
          const currentTokens = estimateTokens(output.parts);
          const currentPercentage = ((currentTokens / config.totalModelLimit) * 100).toFixed(1);
          output.parts = [
            {
              type: "text",
              text: buildContextBlock(ROOT_PATH, config, currentPercentage, currentTokens),
            },
          ];
        }
      },
      "chat:before-send": async ({ messages, client }) => {
        messages.forEach((msg) => extractCriticalData(msg.content));
        saveTechnicalState(ROOT_PATH);

        const cleanMessages = messages.filter(
          (msg) => !(msg.role === "system" && typeof msg.content === "string" && msg.content.includes(SYSTEM_TAG)),
        );

        const currentTokens = estimateTokens(cleanMessages);
        const currentPercentage = ((currentTokens / config.totalModelLimit) * 100).toFixed(1);

        let processedHistory = [...cleanMessages];

        if (currentTokens >= tokenTriggerThreshold && cleanMessages.length > config.keepLatest + 1) {
          const messagesToSummarize = cleanMessages.slice(0, cleanMessages.length - config.keepLatest);
          const recentMessages = cleanMessages.slice(cleanMessages.length - config.keepLatest);

          const summaryResponse = await client.chat({
            messages: [
              ...messagesToSummarize,
              {
                role: "user",
                content:
                  "Summarize the conversations, requests, and progress so far into a concise summary. Do not include file structure or decisions already recorded in system memory.",
              },
            ],
          });

          processedHistory = [
            {
              role: "system",
              content: `[AUTOMATIC CONTEXT SUMMARY - ${config.triggerPercentage * 100}% TRIGGER REACHED]:\n${summaryResponse.content}`,
            },
            ...recentMessages,
          ];
        }

        const systemPrompt = {
          role: "system",
          content: buildContextBlock(ROOT_PATH, config, currentPercentage, currentTokens),
        };

        return {
          messages: [systemPrompt, ...processedHistory],
        };
      },
    },
  };
}

export { loadIgnoreMatcher, generateBoundedTree, buildContextBlock, analyzeProjectDependencies, detectTestsAndDocs, resetTechnicalState, loadTechnicalState, saveTechnicalState, DEFAULT_IGNORED, OpenCodeContextCompressorPlugin };
export default OpenCodeContextCompressorPlugin;
