# 把 Our Free Model 部署成常驻服务

本目录是改编版新增的部署产物。服务本体仍是仓库里的独立服务
（`packages/standalone`），这里只提供把它托管起来所需的文件。

## 关键约束（先读这一段）

- **管理台只监听回环**。`http://127.0.0.1:<本机端口>/` 与 `/api/management/*` 不接受
  局域网来源，这是 `src/trust.js` 的围栏，本改编版没有放宽它。
- **只有推理面上局域网**。`--lan` 开启的中继监听 `0.0.0.0`，只转发模型清单与推理路径，
  使用**独立的 LAN Key**，与本机 API Key 互不通用。
- **没有 TLS**。局域网是明文 HTTP + Bearer。请把服务放在可信网段，用防火墙限制来源；
  跨网段请在 WireGuard/Tailscale 之上使用，或在本服务前面加一层反向代理。
- **LAN Key 等同于额度**。拿到它的人可以用这台机器的免费额度。泄漏就轮换。

## 取 LAN Key 的三种方式

1. **本机管理台**：在服务器本机打开启动时打印的管理链接 → 「局域网与密钥」→ 复制 LAN Key。
2. **启动参数 `--lan-key-out`**：适合没有图形界面的服务器，Key 以 0600 写入指定文件，
   不经过 stdout，因此不会进日志。
   ```powershell
   node packages/standalone/cli.mjs --lan --lan-port 18901 --lan-key-out /etc/ofm/lan.key
   ```
3. **容器内回环调用**：
   ```bash
   docker exec ofm node -e "fetch('http://127.0.0.1:18900/api/management/lan/key',{headers:{authorization:'Bearer '+require('/data/settings.json').forwardKey}}).then(r=>r.text()).then(console.log)"
   ```

轮换：本机管理台「轮换 LAN Key」，或
`POST /api/management/lan/key/rotate` 且请求体**恰好**是 `{"confirm":true}`。

## 从 dsh 迁移已有登录凭据

服务用自己数据目录里的凭据库，不读 `DSH_HOME`。要在服务器上复用桌面机里已经登录好的
十个免费账号渠道，先迁移：

```powershell
# 在装过 dsh 的机器上：直接读 dsh 数据目录，写入本服务凭据库
node packages/standalone/cli.mjs --import-dsh --dsh-home ~/.dsh --data-dir /srv/ofm/data

# 只需要一份可搬运的备份文件时
node packages/standalone/cli.mjs --import-dsh --dsh-home ~/.dsh --out ./ofm-backup.json

# 在目标机器上导入那份备份
node packages/standalone/cli.mjs --import-backup ./ofm-backup.json --data-dir /srv/ofm/data
```

- 迁移动作**不启动服务、不取锁、不监听端口**，执行完就退出。
- 只迁移十个账号渠道的凭据（`*_ACCOUNT_*`）；dsh 的平台账号、平台 Key 与 EAC 授权不导出。
- 默认**合并**；`--replace` 整体覆盖。目标已有凭据时默认拒绝，避免悄悄改写。
- `--dry-run` 只报告计数，不写文件。
- 备份文件是**明文** JSON，含可用的 refresh token；搬运后请删除或加密保存。
- 服务正在运行时（存在 `service.lock`）迁移会被拒绝，先停服务。

## systemd（Linux）

```bash
sudo useradd --system --home /srv/ofm --shell /usr/sbin/nologin ofm
sudo install -d -o ofm -g ofm -m 0700 /srv/ofm/data
sudo cp deploy/systemd/our-free-model.service /etc/systemd/system/
# 按需修改 User / ExecStart 里的路径与端口
sudo systemctl daemon-reload
sudo systemctl enable --now our-free-model
sudo systemctl status our-free-model
journalctl -u our-free-model -f
```

先在本机（或 SSH 隧道）打开管理页把 LAN 开关与端口设好，之后重启由 systemd 托管。
`--lan` 会把这个意愿写进 `settings.json`，所以重启后仍然生效。

## Windows（任务计划程序）

以管理员身份：

```powershell
# 安装（默认端口 18900，LAN 中继 18901）
.\deploy\windows\install-service.ps1 -NodePath (Get-Command node).Source `
  -RepoPath 'C:\ofm\dsh-our-free-model' -DataDir 'C:\ofm\data' -LanPort 18901

# 查看状态 / 停止 / 卸载
Get-ScheduledTask -TaskName 'OurFreeModel'
Stop-ScheduledTask -TaskName 'OurFreeModel'
.\deploy\windows\uninstall-service.ps1
```

脚本会同时创建入站防火墙规则（仅私网配置）。日志写到 `<DataDir>\logs\`。

## Docker

```bash
docker build -f deploy/docker/Dockerfile -t ofm-standalone .
docker compose -f deploy/docker/docker-compose.yml up -d
```

- 数据卷挂在 `/data`（`OFM_HOME=/data`）。
- 只发布 18900（管理，**仍只回环可访问**，容器内 healthcheck 用它）以外的 18901 中继端口。
  实际上 18900 不必发布到宿主机；需要本机管理时用 `-p 127.0.0.1:18900:18900`。
- 首次启动后用 `docker logs` 拿到一次性管理链接，或先 `docker exec` 迁移凭据。

## 排错

| 现象 | 原因与处理 |
| --- | --- |
| 启动报「数据目录已有服务运行」 | 存在 `service.lock`。确认没有旧进程后再删除；Windows/Linux 会自动回收已确认退出的陈旧锁。 |
| LAN 端口起不来，摘要里 `error` 是 `EADDRINUSE` | 端口被占用。设置里保留的是**期望端口**，释放后重新应用设置即可重试。 |
| 局域网客户端 401 | 用了本机 API Key。局域网只认 LAN Key。 |
| 局域网客户端 404 | 路径不在中继白名单（例如 `/`、`/health`、管理接口、`/v1/embeddings`）。 |
| 局域网能列表但不能对话 | 上游不可达或模型不可用；看服务日志与「模型清单」页的探测结果。 |