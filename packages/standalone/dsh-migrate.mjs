/**
 * dsh → 独立服务的账号凭据迁移。
 *
 * 两条路径，覆盖“导出文件”和“直接读文件再备份进自己的凭据库”：
 *
 * 1. `runImportDsh`：从 `~/.dsh`（或 `--dsh-home`）直接读
 *    `.credentials.yaml` 的 `refs:` 与 `channel-pack/state.json`，
 *    按 `channel-pack/backup` v1 协议合成备份载荷，写进独立服务自己的
 *    `channel-credentials.json` / `channel-pack/`。**不需要 dsh 在运行**。
 * 2. `runImportBackup` / `runExportBackup`：导入、导出标准明文备份 JSON，
 *    往返一致。
 *
 * 只迁移十个免费账号渠道的凭据（`*_ACCOUNT_*`），不碰 dsh 的平台账号、
 * 平台 API Key 与 EAC 授权。所有写入都是临时文件 + 原子替换 + 0600，
 * 且绝不打印凭据值：返回值与摘要只包含计数和路径。
 *
 * @module packages/standalone/dsh-migrate.mjs
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { restrictPermissions } from '../../src/open-external.js'
import { parseCredentialRefs } from './yaml-refs.mjs'

/** 备份协议标识，与 `vendor/channel-pack` 的 `BACKUP_FORMAT` 一致。 */
export const BACKUP_FORMAT = 'channel-pack/backup'
/** 备份协议版本，与 `vendor/channel-pack` 的 `BACKUP_VERSION` 一致。 */
export const BACKUP_VERSION = 1
/**
 * 账号渠道前缀表，与 `vendor/channel-pack` 的 `REF_PREFIX_TO_PROVIDER` 同源
 * （含后来合并的 minimax / zcode / opencode / gemini）。按长度降序排列，
 * 保证 `QODERCN_*` 不会被 `QODER_*` 抢先匹配。
 */
const ACCOUNT_PROVIDER_PREFIXES = [
  'LOBSTERAI', 'QODERCN', 'QODER', 'TRAE', 'CLINE', 'LOOMY',
  'RACCOON', 'MINIMAX', 'ZCODE', 'OPENCODE', 'GEMINI',
]

/** 十个免费账号渠道的凭据引用名。 */
export const ACCOUNT_REF_RE = new RegExp(`^(${ACCOUNT_PROVIDER_PREFIXES.join('|')})_ACCOUNT_([0-9A-Fa-f]{6,})$`)
/** 凭据引用名的合法字符与长度。 */
export const REF_KEY_RE = /^[A-Za-z0-9_.-]{1,200}$/
/** 单条凭据值的上限，防止异常文件撑爆内存。 */
export const MAX_CREDENTIAL_BYTES = 256 * 1024
/** 永久积分锁定表的文件版本，与 `vendor/channel-pack` 一致。 */
export const PERMANENT_LOCKS_SCHEMA = 'channel-pack/permanent-locks/v1'

const CREDENTIALS_REL = 'channel-credentials.json'
const STATE_REL = path.join('channel-pack', 'state.json')
const LOCKS_REL = path.join('channel-pack', 'permanent-locks.json')
const LEDGER_REL = path.join('channel-pack', 'token-ledger.json')
const CHECKIN_REL = path.join('channel-pack', 'auto-checkin.json')

/** 迁移过程中的所有失败都抛出这个类型，CLI 据此区分退出码。 */
export class MigrationError extends Error {
  constructor(message, { code = 'MIGRATION' } = {}) {
    super(message)
    this.name = 'MigrationError'
    this.code = code
  }
}

/**
 * 解析 dsh 数据目录：`--dsh-home` → `$DSH_HOME` → `~/.dsh`。
 */
export function resolveDshHome({ dshHome, env = process.env, home = os.homedir() } = {}) {
  const configured = String(dshHome ?? '').trim() || (typeof env.DSH_HOME === 'string' ? env.DSH_HOME.trim() : '')
  return configured === '' ? path.join(home, '.dsh') : path.resolve(configured)
}

/**
 * 解析独立服务数据目录：`--data-dir` → `$OFM_HOME` → `~/.our-free-model`。
 */
export function resolveStandaloneDataDir({ dataDir, env = process.env, home = os.homedir() } = {}) {
  const configured = String(dataDir ?? '').trim() || (typeof env.OFM_HOME === 'string' ? env.OFM_HOME.trim() : '')
  return configured === '' ? path.join(home, '.our-free-model') : path.resolve(configured)
}

function readJsonIfExists(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return fallback
    if (error instanceof SyntaxError) throw new MigrationError(`文件不是合法 JSON：${file}`, { code: 'INVALID_JSON' })
    throw error
  }
}

/**
 * 读取 `~/.dsh/.credentials.yaml` 的凭据引用。
 *
 * @returns {{file: string, refs: Record<string,string>, recordCount: number}}
 */
export function readDshCredentials(dshHome) {
  const file = path.join(dshHome, '.credentials.yaml')
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new MigrationError(`未找到 dsh 凭据文件：${file}；可用 --dsh-home 指定 dsh 数据目录`, { code: 'NO_CREDENTIALS' })
    }
    throw error
  }
  const parsed = parseCredentialRefs(text, { source: file })
  return { file, refs: parsed.refs, recordCount: parsed.recordCount }
}

function asAccountList(value) {
  if (!Array.isArray(value)) return []
  return value.filter(entry => entry !== null && typeof entry === 'object' && !Array.isArray(entry))
}

function asObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

/** 净化永久积分锁定表：只保留键合法且值为 `true` 的条目。 */
export function sanitizePermanentLocks(raw) {
  const source = asObject(raw)
  const next = {}
  for (const [key, value] of Object.entries(source)) {
    if (!/^[a-z][a-z0-9-]*$/.test(key)) throw new MigrationError(`永久积分锁定表包含非法的提供商键：${key}`, { code: 'INVALID_LOCKS' })
    if (value !== true) continue
    next[key] = true
  }
  return next
}

/**
 * 读取 dsh 的账号池状态（`channel-pack/state.json`）与权威锁定表。
 *
 * @returns {{file: string, locksFile: string, exists: boolean, accounts: Array<object>, disabledModels: object, permanentLocks: object, loomyPermanentLocked: boolean}}
 */
export function readDshAccountState(dshHome) {
  const file = path.join(dshHome, STATE_REL)
  const state = readJsonIfExists(file, null)
  const locksFile = path.join(dshHome, LOCKS_REL)
  const locksRaw = readJsonIfExists(locksFile, null)
  const locksTable = asObject(locksRaw?.locks ?? locksRaw ?? state?.permanentLocks ?? {})
  return {
    file,
    locksFile,
    exists: state !== null,
    accounts: asAccountList(state?.accounts),
    disabledModels: asObject(state?.disabledModels),
    permanentLocks: locksTable,
    loomyPermanentLocked: locksTable.loomy === true,
    gatewayEnabled: state?.gatewayEnabled !== false,
    providerOrder: Array.isArray(state?.providerOrder) ? [...state.providerOrder] : [],
  }
}

/**
 * 由凭据引用与账号池合成 `channel-pack/backup` v1 载荷。
 *
 * 只保留十个账号渠道的引用；其余引用计入 `skipped` 并写进 `warnings`。
 */
export function buildBackupPayload({ refs, state, exportedAt = new Date().toISOString() } = {}) {
  const credentials = {}
  const warnings = []
  let skipped = 0
  for (const [ref, value] of Object.entries(refs ?? {})) {
    if (!ACCOUNT_REF_RE.test(ref)) { skipped += 1; continue }
    if (typeof value !== 'string' || value === '') {
      warnings.push(`${ref}：凭据为空或不是字符串，已跳过`)
      skipped += 1
      continue
    }
    credentials[ref] = value
  }
  const locks = sanitizePermanentLocks(state?.permanentLocks)
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt,
    credentials,
    accounts: asAccountList(state?.accounts),
    disabledModels: asObject(state?.disabledModels),
    // 上游备份协议不含这两个字段，但整体覆盖时它们是账号池的一部分：
    // 一并带进载荷，导入时才能真正还原成 dsh 的样子。
    gatewayEnabled: state?.gatewayEnabled !== false,
    providerOrder: Array.isArray(state?.providerOrder) ? [...state.providerOrder] : [],
    permanentLocks: locks,
    loomyPermanentLocked: locks.loomy === true,
    warnings,
    skipped,
  }
}

/** 校验备份载荷的形状，与 `vendor/channel-pack` 的导入契约一致。 */
export function validateBackupPayload(payload) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new MigrationError('备份内容不是对象', { code: 'INVALID_BACKUP' })
  }
  if (!/^[a-z][a-z0-9-]*\/backup$/i.test(String(payload.format ?? ''))) {
    throw new MigrationError(`不是 ${BACKUP_FORMAT} 备份文件`, { code: 'INVALID_BACKUP' })
  }
  if (payload.version !== BACKUP_VERSION) {
    throw new MigrationError(`不支持的备份版本：${payload.version}（当前支持 v${BACKUP_VERSION}）`, { code: 'INVALID_BACKUP' })
  }
  if (typeof payload.exportedAt !== 'string') throw new MigrationError('备份缺少 exportedAt 字段', { code: 'INVALID_BACKUP' })
  if (payload.credentials === null || typeof payload.credentials !== 'object' || Array.isArray(payload.credentials)) {
    throw new MigrationError('备份 credentials 字段无效', { code: 'INVALID_BACKUP' })
  }
  if (!Array.isArray(payload.accounts)) throw new MigrationError('备份 accounts 字段无效', { code: 'INVALID_BACKUP' })
  if (payload.permanentLocks !== undefined && (payload.permanentLocks === null || typeof payload.permanentLocks !== 'object' || Array.isArray(payload.permanentLocks))) {
    throw new MigrationError('备份 permanentLocks 字段无效', { code: 'INVALID_BACKUP' })
  }
  if (payload.disabledModels === null || typeof payload.disabledModels !== 'object' || Array.isArray(payload.disabledModels)) {
    throw new MigrationError('备份 disabledModels 字段无效', { code: 'INVALID_BACKUP' })
  }
  for (const [ref, value] of Object.entries(payload.credentials)) {
    if (!REF_KEY_RE.test(ref)) throw new MigrationError(`备份包含非法凭据引用：${ref}`, { code: 'INVALID_BACKUP' })
    if (typeof value !== 'string') throw new MigrationError(`备份凭据值必须为字符串：${ref}`, { code: 'INVALID_BACKUP' })
    if (Buffer.byteLength(value, 'utf8') > MAX_CREDENTIAL_BYTES) {
      throw new MigrationError(`备份凭据值过大：${ref}`, { code: 'INVALID_BACKUP' })
    }
  }
  return payload
}

/** 原子写入 JSON：临时文件 + `restrictPermissions` + 重命名。 */
function atomicWriteJson(file, value, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const temp = `${file}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`
  try {
    fs.writeFileSync(temp, JSON.stringify(value, null, 2), { mode, flag: 'wx' })
    restrictPermissions(temp)
    fs.renameSync(temp, file)
  } catch (error) {
    try { fs.unlinkSync(temp) } catch { /* 临时文件可能已被清理 */ }
    throw error
  }
}

function removeQuietly(file) {
  try { fs.unlinkSync(file) } catch (error) { if (error.code !== 'ENOENT') throw error }
}

/** 复制一个可选文件，保持 0600。 */
function copyIfExists(source, target) {
  try {
    fs.copyFileSync(source, target)
  } catch (error) {
    if (error.code === 'ENOENT') return
    throw error
  }
  try { restrictPermissions(target) } catch { /* 平台不支持权限收紧时不阻断迁移 */ }
}

/** 数据目录里有服务在运行时拒绝迁移。 */
function assertServiceNotRunning(dataDir) {
  if (fs.existsSync(path.join(dataDir, 'service.lock'))) {
    throw new MigrationError('数据目录已有服务在运行（存在 service.lock）；请先停止服务再迁移', { code: 'SERVICE_RUNNING' })
  }
}

/** 目标已有凭据且未声明覆盖时拒绝，避免悄悄改写现有账号。 */
function assertImportAllowed(dataDir, replace) {
  const file = path.join(dataDir, CREDENTIALS_REL)
  const existing = readJsonIfExists(file, null)
  if (existing === null || Object.keys(existing).length === 0) return
  if (replace) return
  throw new MigrationError(`目标凭据库已有 ${Object.keys(existing).length} 条凭据；加 --replace 整体覆盖，或 --force 合并`, { code: 'CREDENTIALS_EXIST' })
}

/**
 * 把备份载荷写入独立服务数据目录。
 *
 * - `replace`：整体覆盖账号凭据、账号池、黑名单与锁定表；
 * - 否则（`merge`）：凭据按键合并、账号池按 `id` 合并（同 id 以新值为准），
 *   其余既有键与账号保留。
 *
 * @returns {object} 只含计数与路径的摘要，不含任何凭据值。
 */
export function applyBackup(dataDir, payload, { replace = false } = {}) {
  validateBackupPayload(payload)
  const mode = replace ? 'replace' : 'merge'
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 })

  // 凭据库
  const credentialsFile = path.join(dataDir, CREDENTIALS_REL)
  const existingRefs = readJsonIfExists(credentialsFile, null)
  if (existingRefs !== null && (typeof existingRefs !== 'object' || Array.isArray(existingRefs))) {
    throw new MigrationError('已有凭据文件格式错误，拒绝覆盖', { code: 'INVALID_STORE' })
  }
  const existingRefCount = existingRefs === null ? 0 : Object.keys(existingRefs).length
  const credentials = mode === 'replace' ? { ...payload.credentials } : { ...existingRefs, ...payload.credentials }
  atomicWriteJson(credentialsFile, credentials, 0o600)

  // 账号池
  const accountsFile = path.join(dataDir, STATE_REL)
  const existingState = readJsonIfExists(accountsFile, null)
  const existingAccounts = existingState === null ? [] : asAccountList(existingState.accounts)
  const incomingAccounts = payload.accounts.filter(entry => typeof entry.id === 'string' && typeof entry.credentialRef === 'string')
  const dropped = payload.accounts.length - incomingAccounts.length
  const filtered = incomingAccounts.filter(entry => Object.hasOwn(payload.credentials, entry.credentialRef))
  const missing = incomingAccounts.length - filtered.length
  const merged = mode === 'replace' ? [] : existingAccounts.map(entry => ({ ...entry }))
  for (const entry of filtered) {
    const index = merged.findIndex(existing => existing.id === entry.id)
    if (index === -1) merged.push({ ...entry })
    else merged[index] = { ...entry }
  }

  const stateDoc = {
    accounts: merged,
    disabledModels: mode === 'replace' ? { ...payload.disabledModels } : { ...existingState?.disabledModels, ...payload.disabledModels },
    loomyPermanentLocked: payload.loomyPermanentLocked === true,
    gatewayEnabled: existingState?.gatewayEnabled !== false,
    providerOrder: Array.isArray(existingState?.providerOrder)
      ? existingState.providerOrder
      : (Array.isArray(payload.providerOrder) ? payload.providerOrder : []),
  }
  atomicWriteJson(accountsFile, stateDoc, 0o600)

  // 权威锁定表（`channel-pack/permanent-locks.json`），与 state.json 的镜像字段同源。
  const locks = sanitizePermanentLocks(payload.permanentLocks)
  const locksFile = path.join(dataDir, LOCKS_REL)
  if (Object.keys(locks).length > 0) atomicWriteJson(locksFile, { schema: PERMANENT_LOCKS_SCHEMA, locks }, 0o600)
  else if (mode === 'replace') removeQuietly(locksFile)

  return {
    dataDir,
    mode,
    credentialsWritten: Object.keys(credentials).length,
    credentialsKept: existingRefCount,
    accountsWritten: merged.length,
    accountsAdded: filtered.length,
    accountsDropped: dropped,
    accountsMissingCredential: missing,
  }
}

/** 由独立服务自己的数据目录重建备份载荷。 */
export function exportBackup(dataDir) {
  const credentialsFile = path.join(dataDir, CREDENTIALS_REL)
  const credentials = readJsonIfExists(credentialsFile, null)
  if (credentials !== null && (typeof credentials !== 'object' || Array.isArray(credentials))) {
    throw new MigrationError('凭据文件格式错误，无法导出', { code: 'INVALID_STORE' })
  }
  const state = readJsonIfExists(path.join(dataDir, STATE_REL), null)
  const locksRaw = readJsonIfExists(path.join(dataDir, LOCKS_REL), null)
  const locksTable = asObject(locksRaw?.locks ?? locksRaw ?? state?.permanentLocks ?? {})
  const locks = sanitizePermanentLocks(locksTable)
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    credentials: credentials ?? {},
    accounts: asAccountList(state?.accounts),
    disabledModels: asObject(state?.disabledModels),
    permanentLocks: locks,
    loomyPermanentLocked: locks.loomy === true,
  }
}

/**
 * 从 dsh 数据目录直接迁移：读 `.credentials.yaml` + `channel-pack/`，
 * 写独立服务自己的凭据库。dsh 文件只读，绝不修改。
 */
export function runImportDsh({ dshHome, dataDir, out, withLedger = false, replace = false, dryRun = false } = {}) {
  const source = resolveDshHome({ dshHome })
  const target = resolveStandaloneDataDir({ dataDir })
  const credentials = readDshCredentials(source)
  const state = readDshAccountState(source)
  const payload = buildBackupPayload({ refs: credentials.refs, state, exportedAt: new Date().toISOString() })

  assertServiceNotRunning(target)
  let written = null
  if (!dryRun) {
    assertImportAllowed(target, replace)
    written = applyBackup(target, payload, { replace })
    if (withLedger) {
      copyIfExists(path.join(source, LEDGER_REL), path.join(target, LEDGER_REL))
      copyIfExists(path.join(source, CHECKIN_REL), path.join(target, CHECKIN_REL))
    }
  }
  if (out && !dryRun) {
    if (fs.existsSync(out)) throw new MigrationError(`备份文件已存在：${out}；加 --force 覆盖`, { code: 'OUTPUT_EXISTS' })
    atomicWriteJson(out, payload, 0o600)
  }

  return {
    action: 'import-dsh',
    dryRun,
    source,
    dataDir: target,
    out: out ?? null,
    refCount: Object.keys(credentials.refs).length,
    credentialCount: Object.keys(payload.credentials).length,
    accountCount: payload.accounts.length,
    skipped: payload.skipped,
    warnings: payload.warnings,
    written,
  }
}

/** 从标准明文备份文件迁移到独立服务数据目录。 */
export function runImportBackup({ backupFile, dataDir, replace = false, dryRun = false } = {}) {
  const target = resolveStandaloneDataDir({ dataDir })
  let text
  try {
    text = fs.readFileSync(backupFile, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') throw new MigrationError(`未找到备份文件：${backupFile}`, { code: 'NO_BACKUP' })
    throw error
  }
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    throw new MigrationError(`备份文件不是合法 JSON：${backupFile}（插件在浏览器侧加密的备份不适用，请用 --import-dsh 直接读取 dsh 数据目录）`, { code: 'INVALID_JSON' })
  }
  validateBackupPayload(payload)

  assertServiceNotRunning(target)
  let written = null
  if (!dryRun) {
    assertImportAllowed(target, replace)
    written = applyBackup(target, payload, { replace })
  }
  return {
    action: 'import-backup',
    dryRun,
    backupFile,
    dataDir: target,
    credentialCount: Object.keys(payload.credentials).length,
    accountCount: payload.accounts.length,
    skipped: 0,
    warnings: [],
    written,
  }
}

/** 把独立服务自己的账号池导出成标准明文备份文件。 */
export function runExportBackup({ dataDir, out, force = false } = {}) {
  const target = resolveStandaloneDataDir({ dataDir })
  const payload = exportBackup(target)
  if (fs.existsSync(out) && !force) {
    throw new MigrationError(`备份文件已存在：${out}；加 --force 覆盖`, { code: 'OUTPUT_EXISTS' })
  }
  atomicWriteJson(out, payload, 0o600)
  return {
    action: 'export-backup',
    dataDir: target,
    out,
    credentialCount: Object.keys(payload.credentials).length,
    accountCount: payload.accounts.length,
  }
}

/**
 * 把迁移摘要格式化成给终端的文本。**只输出计数与路径，绝不输出凭据值。**
 */
export function formatMigrationSummary(summary) {
  const lines = []
  if (summary.dryRun) lines.push('演练模式（--dry-run）：未写入任何文件')
  lines.push(`来源：${summary.source ?? summary.backupFile ?? ''}`)
  lines.push(`凭据引用 ${summary.refCount ?? '-'} 条；账号凭据 ${summary.credentialCount} 条；账号 ${summary.accountCount} 个`)
  if (summary.skipped) lines.push(`已跳过 ${summary.skipped} 条非账号引用或空凭据`)
  if (summary.accountsDropped) lines.push(`已丢弃 ${summary.accountsDropped} 个缺少合法字段的账号`)
  if (summary.accountsMissingCredential) lines.push(`${summary.accountsMissingCredential} 个账号的凭据缺失，已忽略`)
  if (summary.dataDir) lines.push(`数据目录：${summary.dataDir}`)
  if (summary.out) lines.push(`备份文件：${summary.out}`)
  return `${lines.join('\n')}\n`
}
