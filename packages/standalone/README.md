# Our Free Model 独立本地服务

这是独立产品的源码入口，不需要 DSH、Cordis、DSH profile 或宿主凭据库。
已提供独立 HTTP 服务、网页管理、EAC 和十个账号渠道；独立安装制品尚未发布。
本阶段从完整仓库运行，暂不能仅复制本目录或将它单独作为 npm 包安装。

## 启动

需要符合仓库 `engines` 要求的 Node.js。在仓库根目录执行：

```powershell
npm run start:standalone
```

也可以指定端口和数据目录：

```powershell
npm run start:standalone -- --port 18900 --data-dir F:\ofm-data
```

启动打印管理页面的一次性登录链接、实际 API 地址与密钥文件位置，不打印 API Key。
在浏览器打开管理链接即可使用控制台，链接 10 分钟内有效且仅能兑换一次。
默认端口是 `18900`；
端口被占用时沿用共享监听器的自动选端口逻辑。后续启动优先使用本产品上次保存的端口；
`--port` 可以覆盖，`0` 表示由系统分配。

## 数据与鉴权

- 默认目录：`~/.our-free-model`；环境变量 `OFM_HOME` 或 `--data-dir` 可以覆盖。
- 不读取 `DSH_HOME`，不导入 DSH 的配置或凭据。
- 账号凭据保存在 `channel-credentials.json`，账号池、积分与账本位于 `channel-pack/`；
  EAC 授权保存在 `eac-user.json`，均属于当前独立数据目录。
- 首次启动不会自动搬迁插件账号。需要迁移时，在插件中导出账号备份，再在独立网页的
  “免费账号渠道 → 供应商与备份”手动导入。备份包含明文凭据，请妥善保存。
  也可以在**服务未运行**时用命令行直读 dsh 数据目录迁移，见下文「从 dsh 迁移凭据」。

## 从 dsh 迁移凭据（本改编版新增）

```powershell
node packages/standalone/cli.mjs --import-dsh [--dsh-home <目录>] [--data-dir <目录>] [--out <文件>] [--with-ledger] [--replace] [--dry-run]
node packages/standalone/cli.mjs --import-backup <文件> [--data-dir <目录>] [--replace] [--dry-run]
node packages/standalone/cli.mjs --export-backup <文件> [--data-dir <目录>] [--force]
```

| 参数 | 含义 |
| --- | --- |
| `--import-dsh` | 读 `<dsh>/.credentials.yaml` 的 `refs:` 与 `<dsh>/channel-pack/`，写入本服务凭据库；不需要 dsh 在运行 |
| `--dsh-home <目录>` | dsh 数据目录，省略时取 `$DSH_HOME`，再缺省 `~/.dsh` |
| `--out <文件>` | 迁移同时落盘一份标准备份 JSON |
| `--with-ledger` | 附带迁移积分账本与签到文件 |
| `--replace` | 整体覆盖既有凭据与账号池（默认合并） |
| `--dry-run` | 只报告计数，不写文件 |

- 只迁移十个账号渠道的凭据（`*_ACCOUNT_*`）与账号池；平台 Key、平台授权与 EAC 授权不导出。
- 迁移动作**不启动服务、不取锁、不监听端口**，执行完退出；服务在运行时（存在
  `service.lock`）会被拒绝。
- dsh 文件只读；终端输出只含计数与路径，绝不含凭据值。
- 退出码：`0` 成功，`1` 运行期失败（找不到文件、版本不支持、目标已有凭据等），
  `2` 迁移动作互斥或与启动选项混用。
- 完整字段语义、失败码与安全约定见仓库
  [`docs/standalone-dsh-migration.md`](../../docs/standalone-dsh-migration.md)。
- API Key 为此产品单独生成，保存在该目录的 `settings.json` 的 `forwardKey` 字段。
- `GET /health` 提供不含凭据的产品状态；推理接口与模型清单需要 `Authorization: Bearer <API Key>`。
- 同一个数据目录只能启动一个本地服务实例。正常退出会清除 `service.lock`。
- 异常退出后若锁仍存在，先检查锁文件记录的 PID，确认旧进程已停止，再移除该锁文件。
- 管理页面和管理 API 只监听回环地址；局域网推理需要显式开启独立中继。

插件仍使用 `DSH_HOME/our-free-model` 或 `~/.dsh/our-free-model`，两者默认互不影响。
不要主动把独立服务的 `OFM_HOME` 指向插件的数据目录。

## 局域网推理

首次启动默认关闭。可在本机管理接口中设置，或通过 CLI 显式开启并保存：

```powershell
npm run start:standalone -- --lan --lan-port 18901
npm run start:standalone -- --no-lan
```

`--lan-port` 单独使用只保存端口，不启用中继。省略开关时沿用已保存设置。
中继监听 `0.0.0.0`，仅转发白名单里的推理路径：
模型清单（`/v1/models`、`/models`、`/v1beta/models`、`/api/tags`）、
Chat Completions、Responses、Messages、Messages count_tokens、
Gemini 的 `:generateContent` / `:streamGenerateContent` / `:countTokens`、
Ollama 的 `/api/chat` 与 `/api/generate`（支持 `/v1` 前缀和无前缀形式）。
Gemini 的单模型路径按锚定正则匹配，不做百分号解码，`..` 与 `%2f` 直接不匹配。
流式响应与取消沿用本机推理实现。`/`、`/health`、页面资源和所有管理路径均不转发；
OPTIONS 只返回 CORS 预检，不返回管理数据。

中继在接受 LAN Key 后**把它剥掉**再转发：`Authorization` 换成回环密钥，
`x-api-key` 与 `x-goog-api-key` 请求头被删除，Gemini 的 `?key=` 查询参数也被移除。
因此 LAN Key 既不会出现在本机监听器的请求行，也不会进它的日志。

LAN 客户端使用本机管理接口单独生成的 LAN Key，不能使用或索取本机 `forwardKey`。
LAN Key 保存在当前独立目录的 `settings.json` 的 `standaloneLanKey` 字段中；
关闭中继、正常退出和重启均保留该密钥。轮换 LAN Key 立即使旧 LAN Key 失效，
本机 API Key 和管理会话继续可用。轮换本机 API Key 后中继自动使用新本机密钥。
只把 LAN Key 交给可信客户端，并在需要时通过防火墙限制访问来源。
无图形界面的服务器可以加 `--lan-key-out <文件>`：服务启动后把 Key 以 0600 写入该文件
（不打印到 stdout）。托管产物（systemd / Windows 任务计划 / Docker）见仓库 `deploy/`。

本机管理 API 使用已有会话或本机 Bearer Key，契约如下：

| 接口 | 请求或返回 |
| --- | --- |
| `POST /api/management/settings` | 接受 `standaloneLanEnabled`（布尔）和 `standaloneLanPort`（0 到 65535 整数）；返回 `settings` 和 `lan` |
| `GET /api/management/summary` | `settings` 包含上述设置；`lan` 包含运行状态，不含密钥 |
| `GET /api/management/lan/key` | `{key}`；尚未生成时为空字符串 |
| `POST /api/management/lan/key/rotate` | 请求必须恰好是 `{confirm:true}`；返回新 `{key}` |

`lan` 字段为 `{enabled,running,host,requestedPort,port,addresses,baseUrls,error}`。
`enabled` 表示保存的 LAN 意愿；服务总开关关闭时它可以为 true，而 `running` 为 false。
`requestedPort` 为期望端口，0 表示每次启动自动分配；实际端口只出现在 `port`，
不会写回覆盖期望端口，停止时为 null。固定端口被占用时保留设置，
`running:false` 且 `error` 给出失败代码；释放端口后重新应用设置可重试。
关闭服务总开关或 LAN 开关会立即停止中继并释放端口，正常退出也会释放端口。
`baseUrls` 为检测到的本机网卡 IPv4 地址及实际端口，切换网络后重新读取摘要即可更新。
未知字段、自定义监听 host、目标地址和客户端提交的密钥均不接受。

这只解决 issue #351 的 LAN 推理接入。issue #216 的 Docker / FPK / NAS
远程管理部署仍未实现：管理监听器和 Host 信任围栏仍限 loopback，
不支持 `--host`、`OFM_ALLOW_NON_LOOPBACK` 或 `OFM_TRUSTED_HOSTS` 放宽管理访问。
容器映射中继端口可供已配置的推理客户端连接，但不能据此从 LAN 打开管理页，
也没有提供容器镜像、FPK 包或容器内账号 OAuth 登录适配。

## 当前接口与渠道

- `GET /v1/models`
- `POST /v1/chat/completions`，包括流式与非流式请求
- `POST /v1/responses`，包括流式与非流式请求
- 匿名免费模型与 Kilo 免费模型
- EAC 原 GitHub 授权、签名请求和资源池；独立应用使用自己的授权文件
- LobsterAI、
  Qoder、Qoder 中国版、TRAE、Cline、Loomy、Raccoon、MiniMax Code、ZCode、Gemini
- 原渠道登录、账号池和轮换、续期、模型开关、每日签到、积分锁定、账本及备份
- 本地模型缓存、用量统计、周期刷新、请求取消与退出清理
- `GET /`：独立网页管理台（零依赖，无构建步骤）
- `/api/management/*`：同源管理接口，使用管理会话（Cookie）鉴权；
  凭据迁移接口额外要求管理密钥会话

启动先绑定监听器，再异步刷新模型清单。首次运行默认不发可用性探测请求；
`--probe` 可启用并保存自动探测设置，以后启动沿用，可在网页设置中关闭。
上游不可达时保留缓存；`--no-refresh` 跳过核心的启动刷新与周期任务，
手动刷新、探测和推理仍可用。账号渠道初始化目录、登录轮询、续期和自动签到沿用渠道自身规则；
`--no-refresh` 不会关闭这些任务，自动签到可在渠道页面关闭。
自动探测遇到限流遵守核心退避；页面主动探测会强制重新检查，并产生推理请求。

独立账号渠道采用每实例 Worker 隔离，通过同一个服务端口和 API Key 提供
`provider/model` 模型 ID。启动先挂载 HTTP，账号清单在后台加载，不等待所有供应商网络响应。
EAC 在独立页面自行授权；不会使用 DSH 的 EAC token。原插件的宿主判定保持原样。
插件热重载、自更新和宿主 Agent 自动续跑不挂载在独立入口。

## 网页管理

管理台是 `console/` 目录下三个手写文件（`index.html`、`console.css`、`console.js`）
加仓库根 `icon.svg`，由本机服务直接提供，没有构建步骤、不依赖 React/Vite 和任何 CDN。
修改这三个文件后重启服务即可生效。页面结构为四个标签页：

- **概览**：本机 API 地址、数据目录、模型总数、局域网中继状态、今日用量。
- **迁移凭据**：从 dsh 数据目录导入已有登录凭据（演练/整体覆盖/附带积分账本）、
  导出当前账号池为备份文件、或导入 `channel-pack/backup` 备份文件。
- **局域网与密钥**：启用/保存 LAN 推理中继与期望端口，查看并轮换本机 API Key 与 LAN Key，
  接入地址与 curl 示例。
- **模型与试算**：模型清单搜索/刷新，以及用 OpenAI / Anthropic / Gemini / Ollama
  四种协议在线试算。

管理会话是一次性登录链接或管理密钥换取的 HttpOnly、SameSite=Strict Cookie；
重启服务或退出管理会清除会话。用本机 API Key（`forwardKey`）也能登录，
但读取、导入与导出凭据的接口会拒绝它——只有一次性链接或 `settings.json` 里的
`managementKey` 建立的会话可以操作凭据。试算接口不读凭据，本机 Key 即可使用。

页面每 20 秒在可见时刷新一次状态，读取状态不发送推理请求。密钥只在浏览器的
内存中展示，不写入 localStorage 或 URL；显示/复制/轮换均需点击按钮触发。
试算默认限制 4096 个输出 Token，通过回环 HTTP 以所选协议的真实请求发往推理端口，
未选模型或服务暂停时给出可读错误。试算与刷新会消耗上游额度，请勿发送敏感内容。

此前的 React 管理台（`frontend/` + `web/` 构建产物、TanStack 虚拟列表、插件中心、
EAC 协付页面等）已在本改编版中整体移除，由上述零依赖页面取代。

## Gemini 与 Cline 网络连接

这两条渠道的登录、续期和模型请求会读取 `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY`；没有环境代理时，Windows 自动读取当前用户的手动系统代理。环境代理遵守 `NO_PROXY`，系统代理遵守 `ProxyOverride`，回环请求不自动使用代理。无需设置 `NODE_USE_ENV_PROXY`。

Windows 手动代理配置最多缓存 30 秒；PAC 自动配置脚本不在支持范围内。独立服务尚未提供插件的订阅出口功能，使用环境代理或手动系统代理即可。Gemini 需要能访问 Google 的授权、令牌、身份和 Code Assist 端点；浏览器授权成功不代表后台连接成功，网络错误会显示连接路径和底层错误码。

## 验证

```powershell
npm run test:standalone
npm run test:management
npm run test:standalone-channels
node scripts/channel-network-test.mjs
node scripts/standalone-lan-test.mjs
npm run test:contributor
```

独立服务专项测试只使用本机 HTTP 替身，不访问真实上游。测试覆盖独立数据与密钥、
两个 API 协议、流式响应、缓存、并发刷新、退出清理及进程级 DSH 依赖隔离。
管理专项测试覆盖会话、同源防护、设置校验与持久化、暂停后恢复、模型操作、
密钥轮换、重启与自动刷新调度；浏览器验收使用独立数据目录和本机上游替身。
管理台专项测试（`scripts/console-test.mjs`）覆盖静态资源封闭集合、管理密钥会话
权限边界、迁移三入口（dsh 演练/整体覆盖、备份导入校验、导出落盘）、LAN 设置与
四条协议的试算链路。渠道专项运行真实适配器与原授权逻辑，网络重定向至本机替身，
覆盖多实例隔离、工具和图片、Chat/Responses、积分锁定、备份、用量、取消与退出。
未逐家验收外部真实账号登录。

加载本机替身的验收进程会在管理摘要中标记 `networkMode: fixture`，网页显示醒目的测试提示。
替身进程不能用于真实账号登录；实际使用应按上方命令启动独立服务，
并使用正式的独立数据目录，避免将测试账号和模拟额度误当成真实数据。

## 重新生成渠道产物

运行服务无需安装 React 或 esbuild，仓库包含已生成的本地脚本和样式。修改生成器或共享页面后执行：

```powershell
npm ci --prefix packages/standalone --ignore-scripts
npm run build:standalone-channels
node scripts/build-standalone-channels.mjs --check
```

管理台没有构建步骤（`console/` 三文件直接由服务提供）；渠道产物生成器只替换
平台承载及页面连接方式，不修改原插件的 `client.js` 与渠道包。
原渠道的 WASM 和共享核心仍来自完整仓库；单独复制本目录不能运行。
