/**
 * 凭据迁移离线测试：`.credentials.yaml` 子集解析、备份载荷合成、写入语义、
 * 以及 CLI 的三条迁移动作。
 *
 * 全部使用临时目录与伪造凭据值，不触碰真实 `~/.dsh`，也不发任何网络请求。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const { CredentialYamlError, parseCredentialRefs } = await import('../packages/standalone/yaml-refs.mjs')
const {
  BACKUP_FORMAT, BACKUP_VERSION, MigrationError,
  applyBackup, buildBackupPayload, formatMigrationSummary, readDshAccountState,
  readDshCredentials, runExportBackup, runImportBackup, runImportDsh, validateBackupPayload,
} = await import('../packages/standalone/dsh-migrate.mjs')

/** 与真实 dsh 凭据文件同构的样本：平台 key、十个渠道账号、折行值、空值、非法键。 */
const CREDENTIALS_YAML = [
  'version: 1',
  'records:',
  '  deepseek-account-platform/default:',
  '    kind: grant',
  '    payload:',
  '      token: record-secret-value',
  'refs:',
  '  DEEPSEEK_API_KEY: sk-plain-non-account',
  "  QODER_ACCOUNT_93A58973: '{\"access_token\":\"tok-qoder\"}'",
  "  QODERCN_ACCOUNT_4C16188A: '{\"access_token\":\"tok-qodercn\"}'",
  "  TRAE_ACCOUNT_C60952B0: '{\"access_token\":\"tok-trae\"}'",
  "  LOOMY_ACCOUNT_DEADBEEF: '{\"access_token\":\"tok-loomy\"}'",
  '  GEMINI_ACCOUNT_FEED12:',
  "      '{\"access_token\":\"tok-gemini-folded\"}'",
  "  RACCOON_ACCOUNT_123ABC: '{\"access_token\":\"tok-raccoon\"}'",
  "  MINIMAX_ACCOUNT_ABCDEF: '{\"access_token\":\"tok-minimax\"}'",
  "  A_ACCOUNT_123456: '{\"access_token\":\"tok-unknown-provider\"}'",
  "  BROKEN_ACCOUNT_XXXXXX: ''",
].join('\n')

const STATE_JSON = {
  accounts: [
    { id: 'qoder-ea60f4ab', provider: 'qoder', nickname: 'crazying-dev', enabled: true, credentialRef: 'QODER_ACCOUNT_93A58973', refreshable: true, createdAt: 1, expiresAt: 2 },
    { id: 'trae-01563196', provider: 'trae', nickname: '用户', enabled: true, credentialRef: 'TRAE_ACCOUNT_C60952B0', refreshable: true },
    { id: 'broken-00000000', provider: 'qoder', nickname: '缺凭据', enabled: true, credentialRef: 'QODER_ACCOUNT_ZZZZZZ' },
    { id: 'noref-00000000', provider: 'trae', nickname: '没有引用', enabled: true },
  ],
  disabledModels: { 'model-a': 1 },
  loomyPermanentLocked: false,
  gatewayEnabled: true,
  providerOrder: ['qoder'],
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-dsh-migrate-'))
const dshHome = path.join(scratch, 'dsh')
const channelPackDir = path.join(dshHome, 'channel-pack')
fs.mkdirSync(channelPackDir, { recursive: true })
fs.writeFileSync(path.join(dshHome, '.credentials.yaml'), CREDENTIALS_YAML)
fs.writeFileSync(path.join(channelPackDir, 'state.json'), JSON.stringify(STATE_JSON, null, 2))
fs.writeFileSync(path.join(channelPackDir, 'token-ledger.json'), JSON.stringify({ entries: [] }, null, 2))
fs.writeFileSync(path.join(channelPackDir, 'auto-checkin.json'), JSON.stringify({ enabled: false }, null, 2))
fs.writeFileSync(path.join(channelPackDir, 'permanent-locks.json'), JSON.stringify({ schema: 'channel-pack/permanent-locks/v1', locks: { loomy: true } }, null, 2))

const credentialsFile = dataDir => path.join(dataDir, 'channel-credentials.json')
const stateFile = dataDir => path.join(dataDir, 'channel-pack', 'state.json')
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'))

let failures = 0
let checks = 0
const blockers = []
const check = async (name, run) => {
  checks += 1
  try {
    await run()
    console.log(`ok   ${name}`)
  } catch (error) {
    failures += 1
    console.error(`FAIL ${name}: ${error.stack}`)
  }
}

try {
  await check('解析器：版本、单引号、折行、空值与 records 计数', () => {
    const parsed = parseCredentialRefs(CREDENTIALS_YAML, { source: 'fixture' })
    assert.equal(parsed.version, 1)
    assert.equal(parsed.refs['QODER_ACCOUNT_93A58973'], '{"access_token":"tok-qoder"}')
    assert.equal(parsed.refs['QODERCN_ACCOUNT_4C16188A'], '{"access_token":"tok-qodercn"}')
    assert.equal(parsed.refs['GEMINI_ACCOUNT_FEED12'], '{"access_token":"tok-gemini-folded"}')
    assert.equal(parsed.refs['BROKEN_ACCOUNT_XXXXXX'], '')
    assert.equal(parsed.recordCount, 1)
  })

  await check('解析器：CRLF、双引号、裸标量与行内注释', () => {
    const crlf = ['version: 1', 'refs:', "  QODER_ACCOUNT_AAAAAA: '{\"access_token\":\"tok-crlf\"}'"].join('\r\n')
    assert.equal(parseCredentialRefs(crlf).refs['QODER_ACCOUNT_AAAAAA'], '{"access_token":"tok-crlf"}')
    const mixed = [
      'version: 1',
      'refs:',
      '  QODER_ACCOUNT_BBBBBB: "{\\"access_token\\":\\"tok-double\\"}"',
      '  QODER_ACCOUNT_CCCCCC: plain-value',
      '  CLINE_ACCOUNT_DDDDDD: # 行内注释',
    ].join('\n')
    const parsed = parseCredentialRefs(mixed)
    assert.equal(parsed.refs['QODER_ACCOUNT_BBBBBB'], '{"access_token":"tok-double"}')
    assert.equal(parsed.refs['QODER_ACCOUNT_CCCCCC'], 'plain-value')
    assert.equal(parsed.refs['CLINE_ACCOUNT_DDDDDD'], '')
  })

  await check('解析器：未闭合引号、缺失/更高版本、不支持的结构都明确报错', () => {
    const unterminated = ['version: 1', 'refs:', "  QODER_ACCOUNT_EEEEEE: '{\"access_token\":\"unterminated}"].join('\n')
    assert.throws(() => parseCredentialRefs(unterminated), CredentialYamlError)
    assert.throws(() => parseCredentialRefs('refs:\n  QODER_ACCOUNT_AAAAAA: 1\n'), CredentialYamlError)
    assert.throws(() => parseCredentialRefs(['version: 2', 'refs:', '  QODER_ACCOUNT_AAAAAA: 1'].join('\n')), CredentialYamlError)
    assert.throws(() => parseCredentialRefs(['version: 1', 'refs:', '  QODER_ACCOUNT_AAAAAA: *alias'].join('\n')), CredentialYamlError)
    assert.throws(() => parseCredentialRefs(['version: 1', 'refs:', '  QODER_ACCOUNT_AAAAAA: !!str value'].join('\n')), CredentialYamlError)
    assert.throws(() => parseCredentialRefs(['version: 1', 'refs:', '  QODER_ACCOUNT_AAAAAA: [a, b]'].join('\n')), CredentialYamlError)
  })

  await check('合成：只保留十个账号渠道，其余引用与空值计入跳过', () => {
    const credentials = readDshCredentials(dshHome)
    const state = readDshAccountState(dshHome)
    const payload = buildBackupPayload({ refs: credentials.refs, state })
    assert.equal(payload.format, BACKUP_FORMAT)
    assert.equal(payload.version, BACKUP_VERSION)
    assert.equal(payload.credentials['QODER_ACCOUNT_93A58973'], '{"access_token":"tok-qoder"}')
    assert.equal(payload.credentials['GEMINI_ACCOUNT_FEED12'], '{"access_token":"tok-gemini-folded"}')
    assert.equal(Object.hasOwn(payload.credentials, 'DEEPSEEK_API_KEY'), false)
    assert.equal(Object.hasOwn(payload.credentials, 'A_ACCOUNT_123456'), false)
    assert.equal(Object.hasOwn(payload.credentials, 'BROKEN_ACCOUNT_XXXXXX'), false)
    assert.equal(payload.skipped, 3)
    assert.equal(payload.permanentLocks.loomy, true)
    assert.equal(payload.loomyPermanentLocked, true)
    assert.equal(payload.accounts.length, STATE_JSON.accounts.length)
    assert.equal(payload.disabledModels['model-a'], 1)
  })

  await check('写入（replace）：凭据、账号池、锁定表与既有开关字段', () => {
    const target = path.join(scratch, 'data-replace')
    const credentials = readDshCredentials(dshHome)
    const state = readDshAccountState(dshHome)
    const payload = buildBackupPayload({ refs: credentials.refs, state })
    const written = applyBackup(target, payload, { replace: true })
    const creds = readJson(credentialsFile(target))
    assert.equal(Object.keys(creds).length, Object.keys(payload.credentials).length)
    assert.equal(creds['QODER_ACCOUNT_93A58973'], payload.credentials['QODER_ACCOUNT_93A58973'])
    const saved = readJson(stateFile(target))
    assert.equal(saved.accounts.length, 2)
    assert.equal(saved.gatewayEnabled, true)
    assert.deepEqual(saved.providerOrder, ['qoder'])
    assert.equal(saved.disabledModels['model-a'], 1)
    const locks = readJson(path.join(target, 'channel-pack', 'permanent-locks.json'))
    assert.equal(locks.schema, 'channel-pack/permanent-locks/v1')
    assert.equal(locks.locks.loomy, true)
    assert.equal(written.accountsDropped, 1)
    assert.equal(written.accountsMissingCredential, 1)
    if (process.platform !== 'win32') assert.equal(fs.statSync(credentialsFile(target)).mode & 0o777, 0o600)
  })

  await check('写入（merge）：保留既有凭据与账号，按 id 覆盖', () => {
    const target = path.join(scratch, 'data-merge')
    fs.mkdirSync(path.join(target, 'channel-pack'), { recursive: true })
    fs.writeFileSync(credentialsFile(target), JSON.stringify({ QODER_ACCOUNT_93A58973: 'stale', KEEP_ACCOUNT_123456: 'keep' }))
    fs.writeFileSync(stateFile(target), JSON.stringify({
      accounts: [{ id: 'qoder-ea60f4ab', provider: 'qoder', nickname: '旧昵称', credentialRef: 'QODER_ACCOUNT_93A58973' }],
      gatewayEnabled: false, providerOrder: ['x'],
    }))
    const credentials = readDshCredentials(dshHome)
    const state = readDshAccountState(dshHome)
    const payload = buildBackupPayload({ refs: credentials.refs, state })
    const written = applyBackup(target, payload)
    const creds = readJson(credentialsFile(target))
    assert.equal(creds['QODER_ACCOUNT_93A58973'], payload.credentials['QODER_ACCOUNT_93A58973'])
    assert.equal(creds.KEEP_ACCOUNT_123456, 'keep')
    assert.equal(written.credentialsKept, 2)
    const saved = readJson(stateFile(target))
    assert.equal(saved.gatewayEnabled, false)
    assert.deepEqual(saved.providerOrder, ['x'])
    const quoder = saved.accounts.find(entry => entry.id === 'qoder-ea60f4ab')
    assert.equal(quoder.nickname, 'crazying-dev')
    assert.equal(saved.accounts.length, 2)
  })

  await check('演练：--dry-run 不写任何文件', () => {
    const target = path.join(scratch, 'data-dry')
    fs.mkdirSync(target, { recursive: true })
    const summary = runImportDsh({ dshHome, dataDir: target, dryRun: true })
    assert.equal(summary.dryRun, true)
    assert.equal(fs.existsSync(credentialsFile(target)), false)
    assert.equal(fs.existsSync(stateFile(target)), false)
    const text = formatMigrationSummary(summary)
    assert.ok(text.includes('演练模式'))
    assert.ok(!text.includes('tok-qoder'))
  })

  await check('安全：服务在运行时、目标已有凭据时拒绝迁移', () => {
    const locked = path.join(scratch, 'data-lock')
    fs.mkdirSync(locked, { recursive: true })
    fs.writeFileSync(path.join(locked, 'service.lock'), '{}')
    assert.throws(() => runImportDsh({ dshHome, dataDir: locked }), MigrationError)

    const existing = path.join(scratch, 'data-exist')
    fs.mkdirSync(existing, { recursive: true })
    fs.writeFileSync(credentialsFile(existing), JSON.stringify({ QODER_ACCOUNT_AAAAAA: 'x' }))
    assert.throws(() => runImportDsh({ dshHome, dataDir: existing }), MigrationError)
    const forced = runImportDsh({ dshHome, dataDir: existing, replace: true })
    assert.equal(forced.written.credentialsKept, 1)
    assert.ok(fs.existsSync(credentialsFile(existing)))
  })

  await check('迁移：dsh 文件只读，摘要与输出不含凭据值', () => {
    const target = path.join(scratch, 'data-e2e')
    const before = fs.readFileSync(path.join(dshHome, '.credentials.yaml'))
    const summary = runImportDsh({ dshHome, dataDir: target })
    const after = fs.readFileSync(path.join(dshHome, '.credentials.yaml'))
    assert.deepEqual(after, before)
    assert.equal(summary.source, dshHome)
    assert.equal(summary.refCount, Object.keys(readDshCredentials(dshHome).refs).length)
    assert.equal(summary.accountCount, STATE_JSON.accounts.length)
    assert.equal(summary.skipped, 3)
    const text = formatMigrationSummary(summary)
    assert.ok(!text.includes('tok-qoder'))
    assert.ok(!text.includes('sk-plain-non-account'))
    assert.ok(!text.includes('record-secret-value'))
  })

  await check('往返：导出备份文件再导入，凭据完全一致', () => {
    const target = path.join(scratch, 'data-e2e')
    const outFile = path.join(scratch, 'backup.json')
    const exported = runExportBackup({ dataDir: target, out: outFile })
    assert.equal(exported.credentialCount, readJson(credentialsFile(target)) ? Object.keys(readJson(credentialsFile(target))).length : 0)
    const payload = readJson(outFile)
    assert.equal(payload.format, BACKUP_FORMAT)
    assert.equal(payload.version, BACKUP_VERSION)
    const existing = readJson(credentialsFile(target))
    assert.deepEqual(Object.keys(payload.credentials).sort(), Object.keys(existing).sort())
    assert.deepEqual(payload.credentials, existing)
    assert.throws(() => runExportBackup({ dataDir: target, out: outFile }), MigrationError)

    const round = path.join(scratch, 'data-round')
    const result = runImportBackup({ backupFile: outFile, dataDir: round, replace: true })
    assert.equal(result.credentialCount, exported.credentialCount)
    assert.deepEqual(readJson(credentialsFile(round)), existing)
  })

  await check('备份校验：坏 JSON、加密信封与非法载荷都被拒绝', () => {
    const badFile = path.join(scratch, 'bad.json')
    fs.writeFileSync(badFile, 'not json')
    assert.throws(() => runImportBackup({ backupFile: badFile, dataDir: path.join(scratch, 'data-bad') }), MigrationError)
    assert.throws(() => validateBackupPayload({ format: 'x', version: 2 }), MigrationError)
    const complete = { format: BACKUP_FORMAT, version: BACKUP_VERSION, exportedAt: 'now', credentials: {}, accounts: [], disabledModels: {} }
    assert.doesNotThrow(() => validateBackupPayload(complete))
    assert.throws(() => validateBackupPayload({ ...complete, credentials: { 'BAD KEY': 'x' } }), MigrationError)
    assert.throws(() => validateBackupPayload({ ...complete, credentials: { QODER_ACCOUNT_AAAAAA: 42 } }), MigrationError)
    assert.throws(() => validateBackupPayload({ ...complete, permanentLocks: [] }), MigrationError)
    assert.throws(() => validateBackupPayload({ ...complete, accounts: {} }), MigrationError)
  })

  await check('CLI：--import-dsh --dry-run 与真实迁移、--out、--export-backup、--import-backup', () => {
    const cli = path.join(root, 'packages', 'standalone', 'cli.mjs')
    const run = args => spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 60_000 })
    const dryDir = path.join(scratch, 'data-cli-dry')
    const dry = run(['--import-dsh', '--dsh-home', dshHome, '--data-dir', dryDir, '--dry-run'])
    assert.equal(dry.status, 0, dry.stderr)
    assert.ok(dry.stdout.includes('演练模式'))
    assert.ok(!dry.stdout.includes('tok-qoder'))
    assert.equal(fs.existsSync(credentialsFile(dryDir)), false)

    const cliDir = path.join(scratch, 'data-cli')
    const cliOut = path.join(scratch, 'cli-backup.json')
    const imported = run(['--import-dsh', '--dsh-home', dshHome, '--data-dir', cliDir, '--out', cliOut])
    assert.equal(imported.status, 0, imported.stderr)
    assert.ok(fs.existsSync(credentialsFile(cliDir)))
    assert.ok(fs.existsSync(cliOut))
    assert.ok(!imported.stdout.includes('tok-qoder'))
    assert.ok(!imported.stdout.includes('sk-plain-non-account'))

    const exportFile = path.join(scratch, 'cli-export.json')
    const exported = run(['--export-backup', exportFile, '--data-dir', cliDir])
    assert.equal(exported.status, 0, exported.stderr)

    const importedAgain = run(['--import-backup', exportFile, '--data-dir', path.join(scratch, 'data-cli-import'), '--replace'])
    assert.equal(importedAgain.status, 0, importedAgain.stderr)
    assert.deepEqual(readJson(credentialsFile(path.join(scratch, 'data-cli-import'))), readJson(credentialsFile(cliDir)))
  })

  await check('CLI：迁移用法冲突退出码 2，启动参数错误沿用 1，--help 退出码 0', () => {
    const cli = path.join(root, 'packages', 'standalone', 'cli.mjs')
    const run = args => spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 60_000 })
    // 迁移动作互斥 / 与启动选项混用：新增语义，退出码 2。
    assert.equal(run(['--import-dsh', '--lan']).status, 2)
    assert.equal(run(['--import-backup', 'a', '--export-backup', 'b']).status, 2)
    // 未知选项与非法端口属于启动期参数错误，沿用既有退出码 1。
    assert.equal(run(['--nope']).status, 1)
    assert.equal(run(['--port', '70000']).status, 1)
    const help = run(['--help'])
    assert.equal(help.status, 0)
    assert.ok(help.stdout.includes('--import-dsh'))
    assert.ok(help.stdout.includes('--lan-key-out'))
  })
} finally {
  for (const blocker of blockers) await blocker?.()
  const target = fs.realpathSync(scratch)
  const tempRoot = `${fs.realpathSync(os.tmpdir())}${path.sep}`
  assert.ok(target.startsWith(tempRoot) && path.basename(target).startsWith('ofm-dsh-migrate-'))
  fs.rmSync(target, { recursive: true, force: true })
}

console.log(`dsh-migrate: ${checks - failures}/${checks} checks passed`)
process.exitCode = failures ? 1 : 0
