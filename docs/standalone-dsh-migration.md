# 从 dsh 迁移登录凭据

本服务使用**自己的**数据目录与凭据库，不读取 `DSH_HOME`，也不修改 dsh 的任何文件。
若你已经在 dsh 桌面端登录好免费账号渠道，可以用一条命令把这些账号搬过来，
不必在新的部署里重新授权十次。

## 验证迁移结果

迁移后启动服务，在**本机**管理台看「免费账号渠道」页，或直接查接口：

```bash
KEY=$(node -p "require('<data-dir>/settings.json').forwardKey")
H="authorization: Bearer $KEY"

# 账号总数（与迁移摘要里的「账号 N 个」应对得上）
curl -s -X POST http://127.0.0.1:18900/api/management/channels/rpc \
  -H "$H" -H 'content-type: application/json' -d '{"method":"backup.status","payload":{}}'
# => {"ok":true,"value":{"accounts":14,"withoutExpiry":0}}

# 每个渠道的账号数与模型数
curl -s -X POST http://127.0.0.1:18900/api/management/channels/rpc \
  -H "$H" -H 'content-type: application/json' \
  -d '{"method":"provider.status","payload":{"providers":["qoder","trae","lobsterai"]}}'

# 某个渠道的账号明细（**必须带 provider**：不带参数返回空是上游 RPC 的既有语义）
curl -s -X POST http://127.0.0.1:18900/api/management/channels/rpc \
  -H "$H" -H 'content-type: application/json' \
  -d '{"method":"account.list","payload":{"provider":"qoder"}}'
```

渠道模型目录由上游实时拉取，需要网络可达：`provider.status` 里 `models.total`
大于 0 就说明该渠道的模型清单已拿到。离线时账号仍在、`backup.status` 计数不变，
只是模型清单为空。

## 迁移什么

| 来源 | 内容 | 是否迁移 |
| --- | --- | --- |
| `<dsh>/.credentials.yaml` 的 `refs:` | `QODER_ACCOUNT_*`、`LOBSTERAI_ACCOUNT_*`、`TRAE_ACCOUNT_*`、`QODERCN_ACCOUNT_*`、`CLINE_ACCOUNT_*`、`LOOMY_ACCOUNT_*`、`RACCOON_ACCOUNT_*`、`MINIMAX_ACCOUNT_*`、`ZCODE_ACCOUNT_*`、`GEMINI_ACCOUNT_*`、`OPENCODE_ACCOUNT_*` | ✅ |
| 同上 `refs:` 里的平台凭据 | 例如 `DEEPSEEK_API_KEY`、`ME_DEEPSEEK_API_KEY` | ❌ 跳过并计数 |
| `<dsh>/.credentials.yaml` 的 `records:` | dsh 平台的授权记录（`deepseek-account-platform/default` 等） | ❌ 只统计条数，不读取内容 |
| `<dsh>/channel-pack/state.json` | 账号池：昵称、启用状态、优先级、限流、模型黑名单 | ✅ |
| `<dsh>/channel-pack/permanent-locks.json` | 永久积分锁定表（权威） | ✅ |
| `<dsh>/channel-pack/token-ledger.json`、`auto-checkin.json` | 积分账本与自动签到 | 仅 `--with-ledger` |
| `<dsh>/our-free-model/eac-user.json` | EAC 协付授权 | ❌ 独立端有自己的授权文件 |

只迁移**账号渠道**是刻意的：平台 Key 与 EAC 授权在独立端没有消费者，
多搬一份只是多一份明文暴露面。

## 三条命令

```powershell
# 1) 直接读 dsh 数据目录，写进本服务凭据库（无需 dsh 正在运行）
node packages/standalone/cli.mjs --import-dsh --dsh-home ~/.dsh --data-dir /srv/ofm/data

# 2) 只要一份可搬运的文件（标准备份 JSON）
node packages/standalone/cli.mjs --import-dsh --dsh-home ~/.dsh --out ./ofm-backup.json

# 3) 在目标机器上导入那份文件
node packages/standalone/cli.mjs --import-backup ./ofm-backup.json --data-dir /srv/ofm/data
```

反方向——把本服务当前的账号池导出成备份——用
`node packages/standalone/cli.mjs --export-backup ./ofm-backup.json --data-dir <目录>`。

## 参数语义

| 参数 | 含义 |
| --- | --- |
| `--dsh-home <目录>` | dsh 数据目录；省略时取 `$DSH_HOME`，再缺省为 `~/.dsh` |
| `--data-dir <目录>` | 本服务数据目录；省略时取 `$OFM_HOME`，再缺省为 `~/.our-free-model` |
| `--out <文件>` | 迁移的同时把标准备份 JSON 写到该文件（已存在则报错，加 `--force` 覆盖） |
| `--with-ledger` | 附带迁移积分账本与签到文件 |
| `--replace` | 整体覆盖既有凭据与账号池（默认**合并**） |
| `--dry-run` | 只报告将写入的计数，不写任何文件 |
| `--force` | 允许覆盖已存在的目标文件；对凭据库等价于 `--replace` |

合并且语义：凭据按键合并、账号池按 `id` 合并（同 `id` 以新值覆盖），
未列出的既有键与账号保留。整体覆盖会连带写入 `disabledModels`、永久积分锁定表，
并保留既有的 `gatewayEnabled`/`providerOrder`（缺省时用来源里的值）。

## 写入的文件

| 文件 | 内容 | 权限 |
| --- | --- | --- |
| `<data-dir>/channel-credentials.json` | `{ "QODER_ACCOUNT_…": "<凭据原文>" }` | 0600 |
| `<data-dir>/channel-pack/state.json` | 账号池 + 模型黑名单 + 锁定镜像字段 | 0600 |
| `<data-dir>/channel-pack/permanent-locks.json` | 永久积分锁定表（有锁定时才写） | 0600 |

全部走**临时文件 + 原子替换**；`settings.json` 不在迁移范围内，因此 `forwardKey`、
`standaloneLanKey`、端口等既有设置不受影响。

## 安全约定

- `.credentials.yaml` 只读不写；迁移前后文件字节不变（有测试锁定这一点）。
- 摘要与终端输出**只含计数与路径**，绝不含凭据值（有测试扫描 stdout/stderr）。
- 目标已有凭据且未声明覆盖时**拒绝迁移**，不会悄悄改写现有账号。
- 数据目录存在 `service.lock`（服务在跑）时拒绝迁移。
- 备份文件是**明文** JSON，含可用的 refresh token。搬运完请删除或加密保存；
  不要提交进版本库，不要放到共享目录。

## 失败码

| 退出码 | 场景 | 处理 |
| --- | --- | --- |
| `0` | 迁移成功（或 `--dry-run` 完成） | — |
| `1` | 运行期失败：找不到凭据文件、版本不支持、JSON 非法、目标已有凭据、服务在运行、备份文件已存在等 | 看提示信息；需要覆盖时加 `--replace`/`--force` |
| `2` | 迁移动作互斥，或与 `--lan`/`--port` 等启动选项同时使用 | 一次只做一件事 |

## 版本与格式

`.credentials.yaml` 由 dsh 核心写出，当前为 `version: 1`。解析器只实现该文件实际用到的
YAML 子集（单引号、双引号、`|`/`>` 块标量、裸标量、折行），并**显式拒绝**锚点、别名、
标签与流式集合。遇到不认识的版本或用不上的结构会带行号报错，而不是猜一个结果——
此时请改用 `--import-backup`，导入由插件「账号备份」导出的明文 JSON。

备份协议是 `channel-pack/backup` v1，与插件内 `vendor/channel-pack` 的导出格式同源，
字段为 `{format, version, exportedAt, credentials, accounts, disabledModels, permanentLocks, loomyPermanentLocked}`；
本改编版额外带上 `gatewayEnabled`/`providerOrder`，导入时作为可选字段处理。

> 插件在浏览器侧导出的备份是**加密信封**，不是本协议。本方案不改插件，
> 所以那类文件请先用上面的 `--import-dsh` 直读 dsh 数据目录。