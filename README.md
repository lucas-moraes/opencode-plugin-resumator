# opencode-plugin-resumator

Automated context compression and project tree mapping plugin for OpenCode.

## Features

- **Automatic Context Compression:** Triggers context summarization at 30% capacity.
- **Dynamic File Tree:** Injects a real-time bounded project structure into the system prompt.
- **State Retention:** Preserves modified files and key technical decisions across compressions.

## Installation

```bash
npm install opencode-plugin-resumator
```

## Development

```bash
npm install   # installs the tiktoken dependency
npm test      # runs node --test on *.test.js
```

## Configuration

Optional settings under the `contextCompressor` key in `opencode.json` at the project root:

```json
{
  "contextCompressor": {
    "totalModelLimit": 128000,
    "triggerPercentage": 0.3
  }
}
```

Token usage is counted with `tiktoken` (`cl100k_base` encoding), falling back to a char/4 heuristic if the library cannot be loaded.
