# One-shot setup helper for dsh-vision-ark (Windows).
# Usage: irm https://raw.githubusercontent.com/hunyu-feng/dsh-vision/main/install.ps1 | iex
$ErrorActionPreference = 'Stop'

function Say($text) { Write-Host $text -ForegroundColor Cyan }
function Warn($text) { Write-Host $text -ForegroundColor Yellow }

Say 'dsh-vision-ark installer'
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Warn 'Node.js is not installed. Install Node 20+ first: https://nodejs.org'
  exit 1
}
$major = [int](& node -p 'process.versions.node.split(".")[0]')
if ($major -lt 20) {
  Warn "Node $(& node -v) is too old; Node 20+ is required."
  exit 1
}

if (-not $env:VOLCANO_API_KEY) {
  Warn 'VOLCANO_API_KEY is not set.'
  Warn 'Create a key at https://console.volcengine.com/ark (火山方舟), then set it:'
  Warn '  $env:VOLCANO_API_KEY = "your-key"    # or setx VOLCANO_API_KEY "your-key"'
} else {
  Say 'VOLCANO_API_KEY detected.'
}

$npx = Get-Command npx -ErrorAction SilentlyContinue
if ($npx) {
  Say 'Self-test (starts the MCP server once and lists the tool):'
  & npx -y dsh-vision-ark --selftest
  if ($LASTEXITCODE -ne 0) { Warn 'self-test did not complete; check network access to the npm registry' }
}

@'

Next steps
----------
1) DSH: open the Plugins page (or ask the DSH agent: "安装 dsh-vision-ark 插件") and install
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

4) Try it: ask the agent "analyze_image ./screenshot.png 这张图里有什么报错？"
'@ | Write-Host
