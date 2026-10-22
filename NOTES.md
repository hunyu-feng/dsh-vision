# dsh-vision 本地开发备忘

这个文件是给"在这台机器上继续开发它的人"看的：当前挂在哪、改完怎么生效、怎么验证、有哪些坑。
面向使用者的说明在 [README.md](./README.md)。

## 它是什么

DSH 宿主插件 + 可独立运行的 MCP server，让 agent 通过视觉模型"看"图片：
注册原生工具 `analyze_image`（本地 Ollama 优先，Volcano Ark 兜底）。

- 包名 / 目录名 / 仓库名统一为 `dsh-vision`
- 仓库：https://github.com/hunyu-feng/dsh-vision
- 未发布到 npm（`npm view dsh-vision` 404），所以包名目前只在本机有意义

## 本地挂载状态（desktop profile）

- 源码目录：`C:\Users\wang7\Documents\deepseek-harness\default-workspace\dsh-vision`
- profile 目录：`C:\Users\wang7\.dsh\profiles\desktop`
- `package.json` 依赖：`"dsh-vision": "file:C:/Users/wang7/Documents/deepseek-harness/default-workspace/dsh-vision"`
- `dsh.profile.bundles` 中包含 `dsh-vision`
- 入口：`index.js`（`name = 'dsh-vision'`、`inject = ['tools']`），实现在 `lib/vision.js`

依赖只有 `@deepseek-ai/dsh-tools`（版本跟宿主对齐，当前 `0.2.1-rc.2`）。首次安装前若宿主的
环境里没有这个包，先在插件目录跑一次 `pnpm install`；之后 `install_bundle` 会复用。

## 改完代码怎么生效（最容易踩的坑）

**改 `index.js` / `lib/*.js` 后，禁用再启用插件是没用的。**

- DSH 用 ESM 加载插件，模块缓存按**绝对路径**算；同路径再 import 拿到的还是旧模块。
- 因此工具行为不会变，只会在重启宿主后才加载新代码。

三种让新代码生效的方式，按推荐顺序：

1. **重启 DSH 宿主**（最稳，改多少文件都行）。
2. **换路径**：把插件目录改名（例如 `dsh-vision` → `dsh-vision-next`），同步改
   `package.json` 的 name、`cordis.patch.yml` 的 id/name，然后
   `remove_bundle` + `install_bundle`（target 传 `file:<新绝对路径>`）。路径变 = 模块 URL 变。
3. **dev 副本**：复制整个包目录，改 name / patch id / 工具名加后缀，把 `node_modules`
   软链到原包（省一次 `pnpm install`），再 `install_bundle` 装上。
   这样原插件和新代码可以同时在线对比，验证完记得 `remove_bundle` 并删目录。

`install_bundle` 的 target 用 `file:` 绝对路径即可；工具的注册/卸载是 fiber 作用域的，
插件禁用时 `analyze_image` 会自动从工具表里消失，`apply()` 里不需要写清理代码。

## 怎么验证

```bash
# 单元测试（node --test，自动发现 test/）
node --test

# MCP server 自检（需要能访问本地 Ollama 或配置了 ARK_API_KEY）
node bin/mcp-server.js --selftest
```

在 DSH 里则直接调用 `analyze_image`（传绝对路径最稳）：

```
analyze_image({ image: "C:/path/to/shot.png", prompt: "这是什么报错？" })
```

HTTP 上没有本插件自己的路由，所以不能用 curl 探活；能列到 `analyze_image` 工具就说明加载成功。

## 环境变量

| 变量 | 作用 |
| --- | --- |
| `VISION_MODELS` | 覆盖默认模型链（逗号分隔），先本机 Ollama，后 Ark |
| `OLLAMA_BASE_URL` | 自定义 Ollama 地址，默认 `http://127.0.0.1:11434` |
| `ARK_API_KEY` | 火山方舟 key；不配则只用本地 Ollama |

## 已知限制

- 本地 Ollama 没拉模型、或 Ark key 无效时，`analyze_image` 会直接报错而不是悄悄降级成"看不见"。
- 时间较长的视觉推理是串行的（工具 `timeoutMs` 180s），大图/多问题建议拆开问。
- MCP server（`bin/mcp-server.js`）和宿主插件共用 `lib/vision.js`，改实现时两边一起受益，
  但 MCP 的入参校验在 `bin/` 里，别只改一边。

## 改名历史

- 2026-10-22：包名 `dsh-vision-ark` → `dsh-vision`（目录与仓库本来就是 `dsh-vision`），
  bin 命令同步为 `dsh-vision` / `dsh-vision-mcp`，`server.json` identifier、install 脚本、
  README 与 publish workflow 一并更新。旧名在 npm 上未发布，无兼容负担。
