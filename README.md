<div align="center">
  <img src="icon.svg" alt="Our Free Model — 独立本地服务" width="120">

# Our Free Model（本地推理服务改编版）

  <img alt="许可证" src="https://img.shields.io/badge/license-MIT-263146?style=flat-square">
  <img alt="零依赖" src="https://img.shields.io/badge/dependencies-zero-4b6fff?style=flat-square">
  <img alt="无构建步骤" src="https://img.shields.io/badge/build%20step-none-7da1de?style=flat-square">
  <img alt="运行时" src="https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24-2f6f4f?style=flat-square">
  <img alt="协议" src="https://img.shields.io/badge/protocols-OpenAI%20%7C%20Anthropic%20%7C%20Gemini%20%7C%20Ollama-f0a441?style=flat-square">

</div>

> **改编自** [ebony-vinyl/dsh-our-free-model](https://github.com/ebony-vinyl/dsh-our-free-model)（MIT）。
> 本仓库保留上游的十个免费账号渠道实现，并在其上做成一个**可在局域网常驻部署的本地推理服务**，
> 附带**从 dsh 迁移已有登录凭据**与**多协议互转**两项能力。

---

## 这是什么

一个本地 HTTP 服务：把十个免费账号渠道（LobsterAI、Qoder、Qoder 中国版、TRAE、Cline、Loomy、
Raccoon、MiniMax、ZCode、Gemini）以及匿名免费车道与 Kilo 免费池，统一暴露成
**四族协议**的推理接口：

| 客户端 | 入口 | 流式 |
| --- | --- | --- |
| OpenAI SDK / Codex / 大多数工具 | `/v1/chat/completions`、`/v1/responses` | SSE |
| Claude Code / Anthropic SDK | `/v1/messages`、`/v1/messages/count_tokens` | SSE |
| Google SDK / Gemini 客户端 | `/v1beta/models/{m}:generateContent`、`:streamGenerateContent`、`:countTokens` | SSE |
| Ollama 客户端（Open WebUI、`ChatOllama`、Continue） | `/api/tags`、`/api/chat`、`/api/generate` | NDJSON |

不需要账号、不需要 API Key、不需要填表——渠道登录一次，之后本地所有工具都能用。

## 三条主线

### 1. 常驻部署，推理面上局域网

```powershell
node packages/standalone/cli.mjs --data-dir /srv/ofm/data --port 18900 --lan --lan-port 18901
```

- **管理台只监听回环**，只有推理中继监听 `0.0.0.0`——管理面永远不上局域网。
- 中继使用**独立的 LAN Key**，与本机 API Key 互不通用；轮换立即让旧 Key 失效。
- `--lan-key-out <文件>`：把 LAN Key 以 0600 写入文件，适合没有图形界面的服务器，不经过 stdout。
- 现成托管产物见 [deploy/README.md](deploy/README.md)：systemd、Windows 任务计划、Docker。

### 2. 从 dsh 导出已有登录凭据

```powershell
# 直读 dsh 数据目录，写进本服务自己的凭据库（无需 dsh 在运行）
node packages/standalone/cli.mjs --import-dsh --dsh-home ~/.dsh --data-dir /srv/ofm/data

# 或先导出一份标准备份文件，再到目标机器导入
node packages/standalone/cli.mjs --import-dsh --dsh-home ~/.dsh --out ./ofm-backup.json
node packages/standalone/cli.mjs --import-backup ./ofm-backup.json --data-dir /srv/ofm/data
```

- 迁移十个账号渠道的凭据（`*_ACCOUNT_*`）与账号池；dsh 的平台 Key、平台授权与 EAC 授权不导出。
- 默认**合并**，`--replace` 整体覆盖；`--dry-run` 只报计数；服务在跑时拒绝迁移。
- `.credentials.yaml` 只读；输出与日志**只含计数和路径**，绝不含凭据值。
- 详见 [docs/standalone-dsh-migration.md](docs/standalone-dsh-migration.md)。

### 3. 多协议互转

四条线都是**原生实现**，不是把 OpenAI 请求翻译一次的 shim：Anthropic 调用方拿到
`thinking` 与 `tool_use` 块，Gemini 调用方拿到 `functionCall` 与 `usageMetadata`，
Ollama 调用方拿到对象形式的工具参数与 `prompt_eval_count`/`eval_count`。

协议矩阵、语义映射、curl 示例与能力边界见 [docs/protocols.md](docs/protocols.md)。

## 运行方式

### 前置要求

- **Node.js ≥ 22.19**（推荐 24），无需安装任何依赖——服务本身零 npm 依赖，`npm ci` 只为跑测试。
- 首次使用前，建议先在一台已登录 dsh 的机器上迁出凭据（[见上文 §2](#2-从-dsh-导出已有登录凭据)），
  或在管理台「迁移凭据」页里导入备份；否则渠道处于未登录状态。
- 联网：渠道登录与模型请求需要能访问各上游（Gemini 需能访问 Google）。

### 启动

```powershell
# 在仓库根目录
node packages/standalone/cli.mjs
```

启动时会打印：

1. **一次性管理链接**（10 分钟内有效，打开即完成登录，之后可从 `settings.json` 里的
   `managementKey` 登录）；
2. 实际 HTTP API 地址（默认 `http://127.0.0.1:18900`）与数据目录。

数据目录默认 `~/.our-free-model`（可用 `OFM_HOME` 或 `--data-dir` 覆盖）；端口默认 18900，
被占用时自动换端口。首次启动不发送任何探测请求。

> 想作为常驻后台服务运行（systemd / Windows 任务计划 / Docker），
> 见 [deploy/README.md](deploy/README.md)。

### 本机使用

本机任何 OpenAI / Anthropic / Gemini / Ollama 兼容客户端，把 base URL 指向
`http://127.0.0.1:18900`，把 4 个 tab 里「局域网与密钥」页展示的本机 API Key 当作
Bearer Key 填入即可调用（模型清单见「模型与试算」页）。

### 开放给局域网

```powershell
node packages/standalone/cli.mjs --lan --lan-port 18901
```

- 管理台仍只监听回环；只有推理中继监听 `0.0.0.0`（用 `--lan-port 0` 自动选端口）。
- 局域网客户端使用**独立的 LAN Key**（不与本机 API Key 通用），在「局域网与密钥」页查看与轮换；
  无图形界面可用 `--lan-key-out <file>` 以 0600 落盘，不经 stdout。
- 中继只放行推理路径（模型清单 / chat / responses / messages / Gemini `v1beta` / Ollama `/api/*`），
  管理接口与其它路径一律 404。
- 无 TLS：跨不可信网络请在 WireGuard/Tailscale 之上使用，或用防火墙限制来源。

### 常用选项

| 选项 | 作用 |
| --- | --- |
| `--port <端口>` | 本机监听端口，默认 18900 |
| `--data-dir <目录>` | 数据目录 |
| `--lan` / `--no-lan` | 开启/关闭并保存局域网推理中继 |
| `--lan-port <端口>` | 保存中继期望端口（0 表示自动） |
| `--lan-key-out <文件>` | 启动后把 LAN Key 以 0600 写入该文件 |
| `--import-dsh --dsh-home <目录>` | 从 dsh 数据目录迁移凭据后退出（见 §2） |
| `--import-backup <文件>` | 导入备份文件后退出（见 §2） |
| `--no-refresh` | 跳过启动与周期刷新，仍可手动刷新与推理 |
| `--help` | 查看全部选项 |

## 管理台

本机浏览器打开管理链接后的 4 个页签：

- **概览**：服务信息、本机 API 地址、局域网中继状态、今日 Token 用量
- **迁移凭据**：从 dsh 导入已有登录凭据（演练/覆盖/附带积分账本）、备份导出与导入
- **局域网与密钥**：LAN 中继开关与端口、本机 API Key 与 LAN Key 的查看/复制/轮换、接入信息
- **模型与试算**：模型清单搜索与刷新、单模型试算（OpenAI/Anthropic/Gemini/Ollama 四协议）

管理会话是 HttpOnly + SameSite=Strict Cookie，绑定发起它的一次性链接；重启服务或退出登录即失效。
手动登录用 `settings.json` 里的 `managementKey`；用本机 API Key（`forwardKey`）登录只能查看与试算，
读取或迁移凭据会被拒绝。

## 安全模型

- **管理面不出本机**：Host 与同源围栏要求回环地址；管理 API 拒绝跨站来源。
- **推理面凭据可独立吊销**：LAN Key 泄露只需轮换，本机 API Key 不受影响。
- **凭据不落日志**：`?key=`、`x-api-key`、`x-goog-api-key` 在转发前被剥离；错误信息脱敏。
- **敏感文件 0600**：凭据、设置与备份全部以临时文件 + 原子替换写入。
- **无远程代码替换**：本改编版不内置公告通道，也不内置更新通道；没有可信公钥，
  任何远程 manifest 都会被签名校验拒绝。升级方式是拉取本仓库并重启。
- **无 TLS**：局域网是明文 HTTP + Bearer。只用可信网段，用防火墙限制来源；
  跨不可信网络请套 WireGuard/Tailscale 或反向代理。

## 验证

```powershell
npm ci                          # 仅测试与类型检查需要
npm run test:dsh-migrate        # 凭据迁移与 YAML 子集解析器（离线）
npm run test:protocols          # 四协议 + 局域网中继白名单（离线）
npm run test                     # 全量离线套件
```

可选的一致性检查（需要 Python 3，仅标准库）：

```powershell
python tests/python/protocol_matrix.py --base http://127.0.0.1:18900 --key <KEY>
```

## 仓库结构

```
index.js / client.js / adapter/     dsh 插件形态（Host 半身与浏览器半身）
src/                                插件核心：forward、trust、catalog、channel、vault…
src/protocols/ollama.js             新增：Ollama 原生线编解码
packages/standalone/                独立本地服务：HTTP、管理台、渠道 Worker、CLI
  dsh-migrate.mjs / yaml-refs.mjs   新增：凭据迁移与 .credentials.yaml 解析
packages/standalone/console/        管理台（零依赖 HTML/CSS/JS，无需构建）
deploy/                             新增：systemd / Windows / Docker 部署产物
docs/                               协议矩阵与迁移文档
tests/python/                       可选：四协议一致性客户端
vendor/                             上游吸收的渠道包与模型工作台（各自许可证）
```

## 已知边界

- 管理台不支持远程访问，也不接受自定义监听 host。
- 渠道登录依赖各上游自身的协议；上游改版时对应渠道可能暂时失效。
- 模型清单跟随上游刷新；离线时保留缓存，`provider.status` 的 `models.total` 会为 0。
- 不提供 embeddings、音频、Gemini `files`/`batch`、Ollama 模型管理面，一律 404。
- 管理台是零依赖手工页面（无构建步骤），修改 `packages/standalone/console/` 后重启服务即可。
- 手动登录管理台需输入 `settings.json` 里的 `managementKey`；输入本机 API Key（`forwardKey`）
  只能查看与试算，读取或迁移凭据会被拒绝。用启动时的一次性管理链接可完成全部操作。

## 上游与许可

本仓库改编自 [ebony-vinyl/dsh-our-free-model](https://github.com/ebony-vinyl/dsh-our-free-model)，
沿用其 MIT 许可与全部渠道实现。`vendor/` 下各组件的许可证见各自的 `LICENSE` 与 `NOTICE.md`，
以上游声明为准。

上游项目的 README、发布流程、公告数据与社区入口不属于本仓库的交付内容，已移除。
