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

# Local mode works without any account or API key; Ark is the optional fallback.
$ollama = Get-Command ollama -ErrorAction SilentlyContinue
if ($ollama) {
  Say 'Ollama detected. Make sure the local vision model is pulled:'
  Write-Host '  ollama pull qwen2.5vl:3b'
} else {
  Warn 'Ollama not found. Local (free) vision needs it:'
  Warn '  winget install --id Ollama.Ollama'
  Warn '  ollama pull qwen2.5vl:3b'
  Warn 'The plugin still works if you set VOLCANO_API_KEY for a cloud fallback instead.'
}

if ($env:VOLCANO_API_KEY) {
  Say 'VOLCANO_API_KEY detected; Ark models can be used as fallback.'
} else {
  Write-Host 'VOLCANO_API_KEY not set (optional). Cloud fallback is skipped, the local model is used.'
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
1) Ollama (local, free):
   winget install --id Ollama.Ollama
   ollama pull qwen2.5vl:3b
   # optional: a second model to try if the first is missing
   # ollama pull moondream

2) DSH: open the Plugins page (or ask the DSH agent: "安装 dsh-vision-ark 插件") and install
   the bundle from npm or this repository. Restart DSH once. The analyze_image tool then appears.
   Settings live in %USERPROFILE%\.dsh-vision\config.json (optional):
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
'@ | Write-Host
