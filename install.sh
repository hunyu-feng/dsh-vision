#!/usr/bin/env bash
# One-shot setup helper for dsh-vision-ark (macOS / Linux / WSL).
# Usage: curl -fsSL https://raw.githubusercontent.com/hunyu-feng/dsh-vision/main/install.sh | bash
set -euo pipefail

say() { printf '\033[36m%s\033[0m\n' "$*"; }
warn() { printf '\033[33m%s\033[0m\n' "$*"; }

say 'dsh-vision-ark installer'

if ! command -v node >/dev/null 2>&1; then
  warn 'Node.js is not installed. Install Node 20+ first: https://nodejs.org'
  exit 1
fi
major="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$major" -lt 20 ]; then
  warn "Node $(node -v) is too old; Node 20+ is required."
  exit 1
fi

# Local mode works without any account or API key; Ark is the optional fallback.
if command -v ollama >/dev/null 2>&1; then
  say 'Ollama detected. Make sure the local vision model is pulled:'
  echo '  ollama pull qwen2.5vl:3b'
else
  warn 'Ollama not found. Local (free) vision needs it:'
  warn '  curl -fsSL https://ollama.com/install.sh | sh   # or https://ollama.com/download'
  warn '  ollama pull qwen2.5vl:3b'
  warn 'The plugin still works if you set VOLCANO_API_KEY for a cloud fallback instead.'
fi

if [ -n "${VOLCANO_API_KEY:-}" ]; then
  say 'VOLCANO_API_KEY detected; Ark models can be used as fallback.'
else
  echo 'VOLCANO_API_KEY not set (optional). Cloud fallback is skipped, the local model is used.'
fi

if command -v npx >/dev/null 2>&1; then
  say 'Self-test (starts the MCP server once and lists the tool):'
  npx -y dsh-vision-ark --selftest || warn 'self-test did not complete; check network access to the npm registry'
fi

cat <<'EOF'

Next steps
----------
1) Ollama (local, free):
   curl -fsSL https://ollama.com/install.sh | sh
   ollama pull qwen2.5vl:3b

2) DSH: open the Plugins page (or ask the DSH agent: "安装 dsh-vision-ark 插件") and install
   the bundle from npm or this repository. Restart DSH once. The analyze_image tool then appears.
   Settings live in ~/.dsh-vision/config.json (optional):
   {
     "provider": "ollama",
     "models": "ollama:qwen2.5vl:3b,ark:doubao-seed-2-0-pro-260215",
     "baseUrls": { "ollama": "http://127.0.0.1:11434/v1" },
     "apiKeys": { "ark": "" },
     "timeoutMs": 60000
   }

3) Claude Desktop: add this to claude_desktop_config.json under "mcpServers":
   {
     "dsh-vision": {
       "command": "npx",
       "args": ["-y", "dsh-vision-ark"]
     }
   }

4) Cursor / other MCP clients: command `npx -y dsh-vision-ark`; optional env VISION_MODELS,
   VISION_PROVIDER, OLLAMA_BASE_URL, VOLCANO_API_KEY.

5) Try it: ask the agent "analyze_image ./screenshot.png 这张图里有什么报错？"
EOF
