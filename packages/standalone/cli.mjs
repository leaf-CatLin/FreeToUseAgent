#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { startStandalone } from './service.mjs'
import { restrictPermissions } from '../../src/open-external.js'
import { formatMigrationSummary, runExportBackup, runImportBackup, runImportDsh, expandHome } from './dsh-migrate.mjs'

const usage = `Our Free Model 独立本地服务
用法：node packages/standalone/cli.mjs [选项]

启动与部署
  --port <端口>       监听端口，默认 18900（冲突时自动选择可用端口）
  --data-dir <目录>   数据目录，默认 OFM_HOME 或 ~/.our-free-model
  --no-refresh        跳过启动与周期刷新；仍可手动刷新和推理
  --probe             已停用（保留兼容）：自动探测不会发送任何请求
  --lan               启用并保存 LAN 推理中继（独立密钥，管理页仍仅限本机）
  --no-lan            关闭并保存 LAN 推理中继
  --lan-port <端口>   保存 LAN 期望端口，默认 0；不会单独开启中继
  --lan-key-out <文件> 启动后把 LAN Key 以 0600 写入该文件（已存在则报错）

从 dsh 迁移登录凭据（执行后退出，不启动服务）
  --import-dsh        从 dsh 数据目录直接读取凭据并写入本服务凭据库
  --dsh-home <目录>   dsh 数据目录，默认 DSH_HOME 或 ~/.dsh
  --out <文件>        同时把标准备份 JSON 写到该文件
  --with-ledger       附带迁移积分账本与签到文件
  --replace           整体覆盖既有凭据与账号池（默认合并）
  --force             允许覆盖已存在的目标文件（合并语义）
  --dry-run           只报告将写入的计数，不写任何文件

  --import-backup <文件>  从标准明文备份 JSON 迁移
  --export-backup <文件>  把本服务账号池导出为标准明文备份 JSON

  --help              显示帮助
`

/** 用法错误：迁移动作之间的冲突用退出码 2，与启动期参数错误（沿用既有的 1）区分。 */
class UsageError extends Error {
  constructor(message, { code = 'USAGE' } = {}) {
    super(message)
    this.name = 'UsageError'
    this.code = code
  }
}

/** 启动期参数错误，退出码沿用本 CLI 一直以来的 1。 */
class OptionError extends UsageError {
  constructor(message) {
    super(message, { code: 'OPTION' })
  }
}

const VALUE_FLAGS = new Set(['--port', '--lan-port', '--data-dir', '--dsh-home', '--out', '--lan-key-out', '--import-backup', '--export-backup'])
const BOOLEAN_FLAGS = new Set(['--no-refresh', '--probe', '--lan', '--no-lan', '--import-dsh', '--with-ledger', '--replace', '--force', '--dry-run'])
const ACTION_FLAGS = new Set(['--import-dsh', '--import-backup', '--export-backup'])
const SERVE_FLAGS = new Set(['--port', '--lan', '--no-lan', '--lan-port', '--lan-key-out', '--no-refresh', '--probe'])

function parseArgs(argv) {
  const options = {}
  const seen = new Set()
  for (let index = 2; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag === '--help') {
      process.stdout.write(usage)
      return { options, action: null, help: true }
    }
    if (BOOLEAN_FLAGS.has(flag)) {
      seen.add(flag)
      if (flag === '--no-refresh') options.refresh = false
      else if (flag === '--lan') options.lanEnabled = true
      else if (flag === '--no-lan') options.lanEnabled = false
      else if (flag === '--probe') options.probe = true
      else if (flag === '--import-dsh') options.importDsh = true
      else if (flag === '--with-ledger') options.withLedger = true
      else if (flag === '--replace') options.replace = true
      else if (flag === '--force') options.force = true
      else if (flag === '--dry-run') options.dryRun = true
      continue
    }
    if (!VALUE_FLAGS.has(flag) || argv[index + 1] === undefined || argv[index + 1].startsWith('--')) {
      throw new OptionError(`未知选项或缺少参数：${flag}`)
    }
    const value = argv[++index]
    seen.add(flag)
    if (flag === '--port' || flag === '--lan-port') {
      if (!/^\d+$/.test(value) || Number(value) > 65535) throw new OptionError(`端口必须为 0 到 65535 的整数：${value}`)
      options[flag === '--port' ? 'port' : 'lanPort'] = Number(value)
    } else if (flag === '--data-dir') options.dataDir = path.resolve(expandHome(value))
    else if (flag === '--dsh-home') options.dshHome = path.resolve(expandHome(value))
    else if (flag === '--out') options.out = path.resolve(expandHome(value))
    else if (flag === '--lan-key-out') options.lanKeyOut = path.resolve(expandHome(value))
    else if (flag === '--import-backup') options.backupFile = path.resolve(expandHome(value))
    else options.exportBackupFile = path.resolve(expandHome(value))
  }
  const actions = [...ACTION_FLAGS].filter(flag => seen.has(flag))
  if (actions.length > 1) throw new UsageError(`迁移动作互斥，只能选一个：${actions.join('、')}`)
  const action = actions[0] ?? null
  if (action !== null && [...SERVE_FLAGS].some(flag => seen.has(flag))) {
    throw new UsageError('迁移动作不能与启动选项同时使用')
  }
  return { options, action, help: false }
}

/** 把 LAN Key 从 settings.json 读出并写到用户指定的 0600 文件。 */
function writeLanKeyOut(service, file) {
  if (fs.existsSync(file)) throw new Error(`LAN Key 文件已存在：${file}`)
  let key = ''
  try {
    const settings = JSON.parse(fs.readFileSync(service.keyFile, 'utf8'))
    if (typeof settings.standaloneLanKey === 'string') key = settings.standaloneLanKey
  } catch { /* 读取失败时给出下面的提示 */ }
  if (key === '') throw new Error('尚未生成 LAN Key；请先在管理页查看，或用 --lan 启动服务')
  fs.writeFileSync(file, `${key}\n`, { mode: 0o600, flag: 'wx' })
  restrictPermissions(file)
  process.stdout.write(`LAN Key 已写入：${file}\n`)
}

async function main() {
  const { options, action, help } = parseArgs(process.argv)
  if (help) return

  if (action === '--import-dsh') {
    const summary = runImportDsh({
      dshHome: options.dshHome,
      dataDir: options.dataDir,
      out: options.out,
      withLedger: options.withLedger === true,
      replace: options.replace === true || options.force === true,
      dryRun: options.dryRun === true,
    })
    process.stdout.write(formatMigrationSummary(summary))
    return
  }
  if (action === '--import-backup') {
    const summary = runImportBackup({
      backupFile: options.backupFile,
      dataDir: options.dataDir,
      replace: options.replace === true || options.force === true,
      dryRun: options.dryRun === true,
    })
    process.stdout.write(formatMigrationSummary(summary))
    return
  }
  if (action === '--export-backup') {
    const summary = runExportBackup({ dataDir: options.dataDir, out: options.exportBackupFile, force: options.force === true })
    process.stdout.write(formatMigrationSummary(summary))
    return
  }

  const service = await startStandalone(options)
  let stopping = false
  const shutdown = () => {
    if (stopping) return
    stopping = true
    void service.close().catch(error => {
      process.stderr.write(`停止失败：${error.message}\n`)
      process.exitCode = 1
    })
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
  process.stdout.write(`${service.product} ${service.version}\n管理页面（10 分钟内一次性登录）：${service.managementUrl}\nAPI：${service.url}/v1\nAPI Key 保存在：${service.keyFile}\n`)
  if (service.lan.running) {
    process.stdout.write(`LAN API：${service.lan.baseUrls.join(', ') || `端口 ${service.lan.port}`}\nLAN Key：请在本机管理接口中查看（独立于本机 API Key）\n`)
    if (options.lanKeyOut) writeLanKeyOut(service, options.lanKeyOut)
  } else if (service.lan.error) process.stderr.write(`${service.lan.error}\n`)
}

main().catch(error => {
  if (error.code === 'USAGE') {
    process.stderr.write(`用法错误：${error.message}\n使用 --help 查看用法\n`)
    process.exitCode = 2
    return
  }
  // 启动期参数错误沿用既有的退出码 1：既有调用方（脚本、测试、部署单元）
  // 就是按这个判定“参数不对”的。
  if (error.code === 'OPTION') {
    process.stderr.write(`启动失败：${error.message}\n`)
    process.exitCode = 1
    return
  }
  process.stderr.write(`${error.code === 'EEXIST' ? '启动失败：数据目录已有服务运行，或 service.lock 的归属无法确认；请先退出已有服务。Windows 和 Linux 会自动回收已确认进程退出的陈旧锁。' : `失败：${error.message}`}\n`)
  process.exitCode = 1
})
