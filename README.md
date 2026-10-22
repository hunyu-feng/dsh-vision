# DSH Vision（火山方舟豆包视觉）

给 DSH Agent（以及任意 MCP 客户端）装上「看图」能力：新增一个 `analyze_image` 工具，把本地图片或图片 URL
交给火山方舟（Volcano Ark）的豆包视觉模型，返回文字回答。支持多模型按序兜底、超时与鉴权分类处理。

同一个包同时提供两种形态：

| 形态 | 入口 | 适用 |
| --- | --- | --- |
| DSH 原生插件 | `index.js`（`inject: ['tools']`，`defineTool`） | DSH / DPH Agent 对话内直接调用 |
| MCP stdio 服务 | `bin/mcp-server.js` | Claude Desktop、Cursor、DSH 的 MCP 客户端等 |

## 功能

- `analyze_image({ image, prompt? })`
  - `image`：本机绝对路径（png / jpeg / webp / gif / bmp，≤ 20 MB）或 `http(s)` URL，必填。
  - `prompt`：针对图片的提问，可选；省略时给出详细描述。
- 默认模型 `doubao-seed-2-0-pro-260215`，通过方舟 OpenAI 兼容接口
  `https://ark.cn-beijing.volces.com/api/v3/chat/completions` 调用。
- `VISION_MODELS` 逗号分隔模型列表，按序尝试；遇到 `429`、`404`、`408`、`409`、`425`、`5xx`、超时、
  网络错误自动切下一个；`401/403` 直接放弃该 provider 剩余候选并报鉴权错误；其他 `4xx`（如 400 参数错）
  立即失败，不浪费 token。
- 本地图片自动嗅探 MIME 并转成 base64 data URL；URL 原样透传，不额外下载。

## 环境变量

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `VOLCANO_API_KEY` | 是 | 火山方舟 API Key（也可用 `ARK_API_KEY`）。不要写进代码。 |
| `VISION_MODELS` | 否 | 逗号分隔的模型 id，按序兜底；可用 `ark:` 前缀显式标注 provider，如 `ark:doubao-seed-2-0-pro-260215,doubao-1-5-vision-pro-32k-250115`。 |
| `ARK_BASE_URL` | 否 | 覆盖方舟 OpenAI 兼容 base URL（默认 `https://ark.cn-beijing.volces.com/api/v3`）。 |

## 安装

### 1) DSH / DPH

在 DSH 里让 Agent 安装（推荐）：

```
安装 dsh-vision-ark 插件，并帮我把 VOLCANO_API_KEY 配好
```

或打开 **插件** 页面，从 npm / 本仓库安装 `dsh-vision-ark`，重启 DSH。插件启用后 `analyze_image`
会出现在工具列表里，卸载插件时工具随之注销（`ctx.tools.register` 是 fiber 级作用域）。

### 2) Claude Desktop / Cursor / 其他 MCP 客户端

```json
{
  "mcpServers": {
    "dsh-vision": {
      "command": "npx",
      "args": ["-y", "dsh-vision-ark"],
      "env": {
        "VOLCANO_API_KEY": "your-key",
        "VISION_MODELS": "doubao-seed-2-0-pro-260215"
      }
    }
  }
}
```

### 3) 一键安装脚本

```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/hunyu-feng/dsh-vision/main/install.sh | bash
```

```powershell
# Windows
irm https://raw.githubusercontent.com/hunyu-feng/dsh-vision/main/install.ps1 | iex
```

脚本会检查 Node ≥ 20、提示 `VOLCANO_API_KEY`、运行 `npx -y dsh-vision-ark --selftest` 自检，
并打印各客户端的配置片段。

### 4) 自检

```bash
npx -y dsh-vision-ark --selftest
# {"ok":true,"server":"dsh-vision","tool":"analyze_image","models":["doubao-seed-2-0-pro-260215"],"apiKeyConfigured":true}
```

## 使用示例

```text
analyze_image image=C:\Users\me\Pictures\error.png prompt="这个报错是什么意思？"
analyze_image image=https://example.com/chart.png prompt="把这张图里的表格转成 Markdown"
```

模型可见的参数 Schema（`defineTool` 声明，自动生成校验器）：

```json
{
  "image": { "type": "string", "required": true },
  "prompt": { "type": "string" }
}
```

工具返回值（`output.schema` 声明的 canonical 值）：`{ "text": "…", "model": "doubao-…" }`。

## 开发与测试

```bash
npm install
npm test        # node --test：本地文件、URL、429/5xx 兜底、401 中止、缺 Key、MCP 协议握手
```

测试用假 `fetch`，不会真的调用方舟，也不需要 API Key。

## 发布（打 tag 即自动发版）

`.github/workflows/publish-mcp.yml` 在推送 `v*` tag 时执行：安装依赖 → 跑测试 → 把 tag 版本同步进
`package.json` 与 `server.json` → `npm publish` → 下载 `mcp-publisher` → `mcp-publisher login github-oidc`
→ `mcp-publisher validate` → `mcp-publisher publish`。

需要在仓库 Settings → Secrets 配置：

| Secret | 用途 |
| --- | --- |
| `NPM_TOKEN` | npm 自动化发布令牌（Granular token，Package: read and write）。 |
| `MCP_GITHUB_TOKEN` | 可选，仅用 PAT 登录注册表时需要；`read:org` 即可，**不要**给仓库权限。 |

`package.json` 的 `mcpName` 必须与 `server.json` 的 `name` 一致（本例 `io.github.hunyu-feng/dsh-vision`），
否则注册表校验会拒绝发布。仓库还需打上 `mcp-server` / `dsh-plugin` 话题便于发现。

## 目录结构

```
index.js                 DSH 原生插件入口（defineTool 注册 analyze_image）
lib/vision.js            核心：图片解析、方舟调用、模型兜底
bin/mcp-server.js        MCP stdio 服务（--selftest 自检）
server.json              MCP Registry 元数据
cordis.patch.yml         DSH bundle patch
locale/{en,zh}.json      插件标题与描述
test/                    node --test 用例（含 MCP 握手）
.github/workflows/       打 tag 自动发布
```

## 隐私

图片只发往你配置的方舟接口（默认 `ark.cn-beijing.volces.com`），插件本身不落盘、不上传别处。
API Key 只从进程环境读取。

## License

MIT
