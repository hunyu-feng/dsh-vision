#!/usr/bin/env bash
# One-shot setup helper for dsh-vision-ark.
# Usage: curl -fsSL https://raw.githubusercontent.com/hunyu-feng/dsh-vision/main/install.sh | bash
set -euo pipefail

say() { printf '\033[36m%s\033[0m\n' "$*"; }
warn() { printf '\033[33m%s\033[0m\n' "$*" >&2; }

say "dsh-vision-ark installer"
if ! command -v node >/dev/null 2>&1; then
  warn "Node.js is not installed. Install Node 20+ first: https://nodejs.org"
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  warn "Node $(node -v) is too old; Node 20+ is required."
  exit 1
fi

if [ -z "${VOLCANO_API_KEY:-}" ]; then
  warn "VOLCANO_API_KEY is not set."
  warn "Create a key at https://console.volcengine.com/ark (火山方舟), then export it:"
  warn '  export VOLCANO_API_KEY="your-key"'
else
  say "VOLCANO_API_KEY detected."
fi

if command -v npx >/dev/null 2>&1; then
  say "Self-test (starts the MCP server once and lists the tool):"
  npx -y dsh-vision-ark --selftest || warn "self-test did not complete; check network access to the npm registry"
fi

cat <<'EOF'

Next steps
----------
1) DSH: open the Plugins page (or ask the DSH agent: “安装 dsh-vision-ark 插件”) and install
   the bundle from npm or this repository. Restart DSH once. The analyze_image tool then appears.

2) Claude Desktop: add this to claude_desktop_config.json under "mcpServers":
   {
     "dsh-vision": {
       "command": "npx",
       "args": ["-y", "dsh-vision-ark"],
       "env": { "VOLCANO_API_KEY": "your-key" }
     }
   }

3) Cursor / other MCP clients: command `npx -y dsh-vision-ark`, env VOLCANO_API_KEY (required),
   optional VISION_MODELS (comma separated, tried in order).

4) Try it: ask the agent “analyze_image ./screenshot.png 这张图里有什么报错？”
EOF
