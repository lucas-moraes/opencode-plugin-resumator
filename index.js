import fs from "fs";
import path from "path";

// ============================================================================
// 1. CONFIGURATION & CONSTANTS WITH FALLBACK DEFAULTS
// ============================================================================
const SYSTEM_TAG = "<!-- PLUGIN_OPENCODE_CONTEXT_HEADER -->";
const IGNORED_PATHS = new Set(["node_modules", ".git", "dist", "build", ".opencode", "coverage", ".cache"]);

const DEFAULT_CONFIG = {
  totalModelLimit: 128000,
  triggerPercentage: 0.3, // 30% trigger
  keepLatest: 4,
  maxTreeFiles: 100,
  maxTreeDepth: 4,
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

// ============================================================================
// 3. UTILITY FUNCTIONS
// ============================================================================
function estimateTokens(messages) {
  return messages.reduce((acc, msg) => {
    const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content || "");
    return acc + Math.ceil(content.length / 4);
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

  function traverse(currentDir, prefix = "", depth = 0) {
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
      .filter((item) => !IGNORED_PATHS.has(item) && !item.startsWith("."))
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
        result += traverse(fullPath, newPrefix, depth + 1);
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
// 4. MAIN OPENCODE PLUGIN
// ============================================================================
export default async function OpenCodeContextCompressorPlugin(context) {
  const ROOT_PATH = process.cwd();

  // Load configuration dynamically from opencode.json
  const config = loadUserConfig(ROOT_PATH);
  const tokenTriggerThreshold = Math.floor(config.totalModelLimit * config.triggerPercentage);

  return {
    hooks: {
      "chat:before-send": async ({ messages, client }) => {
        messages.forEach((msg) => extractCriticalData(msg.content));

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

        const { treeText, totalCounted, truncated } = generateBoundedTree(ROOT_PATH, config);
        const truncationWarning = truncated ? `\n> ⚠️ *Tree truncated at ${totalCounted} files to save tokens.*` : "";

        const systemPrompt = {
          role: "system",
          content: `${SYSTEM_TAG}
### PROJECT STRUCTURE ###
\`\`\`text
${treeText}\`\`\`${truncationWarning}

### PERSISTENT TECHNICAL STATE ###
- Modified files in session: ${Array.from(technicalState.modifiedFiles).join(", ") || "None"}
- Recorded decisions: ${Array.from(technicalState.recordedDecisions).join(" | ") || "None"}
- Context usage on send: ~${currentPercentage}% (${currentTokens} tokens)
`,
        };

        return {
          messages: [systemPrompt, ...processedHistory],
        };
      },
    },
  };
}
