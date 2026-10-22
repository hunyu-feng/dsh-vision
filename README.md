# DSH Vision（本地 Ollama 优先 + 火山方舟兜底）

> 本地开发备忘（怎么改、改完怎么生效、踩过的坑）：见 [NOTES.md](./NOTES.md)。

给 DSH Agent（以及任意 MCP 客户端）装上「看图」能力：新增一个 `analyze_image` 工具，把本地图片或图片 URL
交给视觉模型，返回文字回答。**默认走本机 Ollama，不花钱、不需要账号**；愿意接云端时，火山方舟（豆包）
作为第二候选自动兜底，任何一项都可以通过配置或环境变量换掉。

同一个包同时提供两种形态：

| 形态 | 入口 | 适用 |
| --- | --- | --- |
| DSH 原生插件 | `index.js`（`inject: ['tools']`，`defineTool`） | DSH / DPH Agent 对话内直接调用 |
| MCP stdio 服务 | `bin/mcp-server.js` | Claude Desktop、Cursor、DSH 的 MCP 客户端等 |

## 功能

- `analyze_image({ image, prompt? })`
  - `image`：本机绝对路径（png / jpeg / webp / gif / bmp，≤ 20 MB）或 `http(s)` URL，必填。
  - `prompt`：针对图片的提问，可选；省略时给出详细描述。
- 默认候选链：`ollama:qwen2.5vl:3b` → `ark:doubao-seed-2-0-pro-260215`。
  - 本地模型需要先 `ollama pull qwen2.5vl:3b`；没装 Ollama 时该候选网络失败，会自动切下一个。
  - `ark:` 候选只有配置了 Key 才会被尝试；没配 Key 直接跳过，不会报错（这就是「零花费」的意思）。
- 失败分类：
  - `429`、`404`、`408`、`409`、`425`、`5xx`、超时、网络错误 → 切下一个候选；
  - `401/403` → 放弃该 provider 剩余候选（Key 无效就没必要重试）；
  - 其它 `4xx`（如 400 参数错）→ 立即失败，不浪费 token。
- 本地图片自动嗅探 MIME 并转成 base64 data URL；URL 原样透传，不额外下载。

## 环境变量

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `VISION_MODELS` | 否 | 逗号分隔候选链，可带 provider 前缀：`ollama:qwen2.5vl:3b,ark:doubao-seed-2-0-pro-260215`。默认就是这一串。 |
| `VISION_PROVIDER` | 否 | 不带前缀的模型 id 归到哪个 provider：`ollama`（默认）/ `ark` / `openai`。 |
| `OLLAMA_BASE_URL` | 否 | 本地 Ollama 的 OpenAI 兼容地址，默认 `http://127.0.0.1:11434/v1`。 |
| `VOLCANO_API_KEY` | 否 | 火山方舟 Key（也可用 `ARK_API_KEY`）。只有配置了 `ark:` 候选时才需要。 |
| `ARK_BASE_URL` | 否 | 火山方舟 base URL，默认 `https://ark.cn-beijing.volces.com/api/v3`。 |
| `VISION_BASE_URL` / `VISION_API_KEY` | 否 | 接任意 OpenAI 兼容服务时用（provider 名 `openai`）。 |
| `VISION_TIMEOUT_MS` | 否 | 单次请求超时，默认 60000。 |
| `DSH_VISION_HOME` | 否 | 设置文件目录，默认 `~/.dsh-vision`。 |

## 设置文件（接入位置）

不想动环境变量时，把配置写到 `~/.dsh-vision/config.json`（Windows：`%USERPROFILE%\.dsh-vision\config.json`）。
环境变量优先级更高，设置文件只做默认值：

```json
{
  "provider": "ollama",
  "models": "ollama:qwen2.5vl:3b,ark:doubao-seed-2-0-pro-260215",
  "baseUrls": { "ollama": "http://127.0.0.1:11434/v1", "ark": "https://ark.cn-beijing.volces.com/api/v3" },
  "apiKeys": { "ark": "" },
  "timeoutMs": 60000
}
```

- 换本地模型：把 `models` 改成 `ollama:moondream` 之类，并 `ollama pull moondream`。
- 接云端：填 `apiKeys.ark`，或设置 `VOLCANO_API_KEY`，`ark:` 候选就会生效。
- 接公司内网 / 自建 OpenAI 兼容服务：`"provider": "openai"`，配 `baseUrls.openai` 与 `apiKeys.openai`。

## 安装

### 1) 本地视觉模型（免费）

Windows：

```powershell
winget install --id Ollama.Ollama
ollama pull qwen2.5vl:3b
```

macOS / Linux：

```bash
curl -fsSL https://ollama.com/install.sh | sh
ollama pull qwen2.5vl:3b
```

### 2) DSH / DPH

```
安装 dsh-vision 插件，并帮我把本地 Ollama 模型配好
```

或手动指定仓库/包名安装，然后重启 DSH。重启后 `analyze_image` 直接可用，不需要 Key。

### 3) 一键脚本

```powershell
irm https://raw.githubusercontent.com/hunyu-feng/dsh-vision/main/install.ps1 | iex   # Windows
curl -fsSL https://raw.githubusercontent.com/hunyu-feng/dsh-vision/main/install.sh | bash  # macOS / Linux
```

脚本会检查 Node ≥ 20、提示 Ollama 拉模型、跑一次 `npx -y dsh-vision --selftest`。

### 4) 其它 MCP 客户端

```json
{
  "mcpServers": {
    "dsh-vision": { "command": "npx", "args": ["-y", "dsh-vision"] }
  }
}
```

需要云端兜底时再补 `"env": { "VOLCANO_API_KEY": "..." }`。

## 使用示例

```
analyze_image  D:\pictures\error.png  提示词：这张截图里报了什么错？
analyze_image  ./design.png           提示词：把界面里的字段名全部抄下来
analyze_image  https://example.com/chart.png
```

返回根值是 `{ text, model, provider }`；DSH 里只渲染 `text`。

## 发布（维护者）

打 `v*` tag 触发 `.github/workflows/publish-mcp.yml`：

1. `npm publish`（需要仓库 Secret `NPM_TOKEN`）；
2. 下载 `mcp-publisher`，用 GitHub OIDC 登录 MCP Registry；
3. `mcp-publisher publish` 把 `server.json` 登记到官方 Registry。

| Secret | 用途 |
| --- | --- |
| `NPM_TOKEN` | npm 发布 `dsh-vision`（Granular token，Read and write + Publish） |
| `MCP_GITHUB_TOKEN` | 可选：不用 OIDC、改走 PAT 登录 Registry 时使用（`read:org` 即可） |

不需要自动发版时，本地手动流程：

```bash
npm publish
curl -fsSL "https://github.com/modelcontextprotocol/registry/releases/latest/download/mcp-publisher_linux_amd64.tar.gz" | tar xz
./mcp-publisher login github --token "$(gh auth token)"
./mcp-publisher validate server.json && ./mcp-publisher publish
```

## 项目结构

```
index.js                 DSH 插件入口：defineTool + ctx.tools.register
lib/vision.js            核心：provider 解析、图片编码、候选链、失败分类
bin/mcp-server.js        MCP stdio 服务（复用 lib/vision.js）
cordis.patch.yml         DSH bundle 安装补丁
locale/{zh,en}.json      插件在 DSH 里的标题/描述
server.json              MCP Registry 元数据
install.ps1 / install.sh 一键安装脚本
test/                    node --test 用例（本地/URL/兜底/鉴权/设置文件）
```

## 隐私

- 本地模式：图片只发给本机 `127.0.0.1:11434`，不出网。
- 云端模式：图片会发给火山方舟；Key 只从环境变量或设置文件读取，不写进日志。
