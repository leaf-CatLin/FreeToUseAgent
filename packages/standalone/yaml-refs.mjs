/**
 * `.credentials.yaml` 的零依赖 YAML 子集读取器。
 *
 * 独立服务要从 dsh 迁移账号凭据，必须读出 `~/.dsh/.credentials.yaml` 里的
 * `refs:` 块。这个文件由 dsh 核心写出，格式稳定但并非完整的 YAML：
 * 引用值是**单引号包裹的字符串**（内容是 JSON），键名形如
 * `QODER_ACCOUNT_93A58973`。
 *
 * 这里刻意只实现该文件实际用到的子集，而不是引入 YAML 库（本仓库零运行时
 * 依赖）：
 *
 * - 顶层 `version:` 必须是整数，且当前只支持 `1`；缺失或更高版本直接报错，
 *   避免用一份“看起来对”的解析结果继续迁移；
 * - 只解析 `refs:` 块（`records:` 仅统计条数用于摘要，不读取内容）；
 * - 标量支持单引号（`''` 转义、跨行折行）、双引号（JSON 转义）、`|` / `>`
 *   块标量与裸标量；
 * - 锚点、别名、标签、流式集合一律**显式报错并给行号**，不静默降级。
 *
 * @module packages/standalone/yaml-refs.mjs
 */

/** dsh 当前写出的凭据文件版本。 */
export const CREDENTIALS_YAML_VERSION = 1

/** 解析失败时抛出，携带出错行号便于定位。 */
export class CredentialYamlError extends Error {
  constructor(message, { line = null, source = null } = {}) {
    super(message)
    this.name = 'CredentialYamlError'
    this.line = line
    this.source = source
  }
}

const TOP_LEVEL_KEY_RE = /^([A-Za-z0-9_.-]+):(.*)$/
const REF_ENTRY_RE = /^\s*([A-Za-z0-9_.-]{1,200}):(.*)$/

/**
 * 把凭据文件文本解析成 `{ version, refs, recordCount }`。
 *
 * @param {string} text - 文件内容
 * @param {{source?: string}} [options] - 用于错误信息的文件名
 * @returns {{version: number, refs: Record<string, string>, recordCount: number}}
 */
export function parseCredentialRefs(text, { source = '.credentials.yaml' } = {}) {
  const lines = String(text).split(/\r?\n/)
  let version = null
  let versionLine = null
  const refs = {}
  let recordCount = 0
  let section = null

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const trimmed = line.replace(/\s+$/, '')
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const indent = line.length - line.replace(/^\s*/, '').length

    if (indent === 0) {
      const match = TOP_LEVEL_KEY_RE.exec(trimmed)
      if (match === null) throw new CredentialYamlError(`第 ${index + 1} 行不是可识别的顶层键`, { line: index + 1, source })
      const key = match[1]
      section = key === 'refs' ? 'refs' : key === 'records' ? 'records' : null
      if (key === 'version') {
        const raw = match[2].trim()
        if (!/^\d+$/.test(raw)) throw new CredentialYamlError(`第 ${index + 1} 行的 version 必须是整数`, { line: index + 1, source })
        if (version !== null) throw new CredentialYamlError(`第 ${index + 1} 行重复声明 version`, { line: index + 1, source })
        version = Number(raw)
        versionLine = index + 1
      }
      continue
    }

    if (section === 'refs') {
      const entry = readRefEntry(lines, index, index + 1, indent, source)
      refs[entry.key] = entry.value
      // 折行标量可能跨多行，跳到块尾继续。
      index = entry.nextIndex - 1
      continue
    }

    // `records:` 只统计条数，不读取内容。
    if (section === 'records' && indent === 2 && /^\S.*:\s*$/.test(trimmed.trimStart())) recordCount += 1
  }

  if (version === null) throw new CredentialYamlError('缺少顶层 version 字段，无法确认凭据文件版本', { source })
  if (version !== CREDENTIALS_YAML_VERSION) {
    throw new CredentialYamlError(`凭据文件版本不受支持：${version}（当前仅支持 v${CREDENTIALS_YAML_VERSION}）`, { line: versionLine, source })
  }
  return { version, refs, recordCount }
}

/**
 * 读取 `refs:` 块里的一项，返回其键、值以及下一项所在行号。
 */
function readRefEntry(lines, index, lineNo, indent, source) {
  const match = REF_ENTRY_RE.exec(lines[index].replace(/\s+$/, ''))
  if (match === null) throw new CredentialYamlError(`第 ${lineNo} 行不是可识别的凭据引用`, { line: lineNo, source })
  const key = match[1]
  if (!/^[A-Za-z0-9_.-]{1,200}$/.test(key)) throw new CredentialYamlError(`第 ${lineNo} 行的凭据引用名非法`, { line: lineNo, source })
  const scalar = readScalar(lines, index + 1, match[2], indent, lineNo, source)
  return { key, value: scalar.value, nextIndex: scalar.nextIndex }
}

/**
 * 解析一个标量值：首行剩余内容 + 可选的折行/块续行。
 */
function readScalar(lines, fromIndex, first, indent, lineNo, source) {
  const marker = first.trim()
  if (marker === '' || marker[0] === '|' || marker[0] === '>') {
    const block = readBlock(lines, fromIndex, indent, lineNo, source, marker === '' ? null : marker[0])
    return { value: maybeUnquote(block.value, lineNo, source), nextIndex: block.nextIndex }
  }
  const quote = marker[0]
  if (quote === "'" || quote === '"') {
    const firstAttempt = unquote(marker, lineNo, source, quote)
    if (firstAttempt.closed) return { value: firstAttempt.value, nextIndex: fromIndex }
    const { lines: continuation, nextIndex } = collectIndented(lines, fromIndex, indent)
    if (continuation.length === 0) throw new CredentialYamlError(`第 ${lineNo} 行的 ${quote === "'" ? '单引号' : '双引号'}字符串没有闭合`, { line: lineNo, source })
    const combined = [marker, ...continuation].join(' ')
    return { value: unquote(combined, lineNo, source, quote).value, nextIndex }
  }
  if (marker.startsWith('#')) return { value: '', nextIndex: fromIndex }
  rejectUnsupported(marker, lineNo, source)
  return { value: stripTrailingComment(marker), nextIndex: fromIndex }
}

/** 锚点、别名、标签与流式集合不在本文件的实际写法里，遇到即报错。 */
function rejectUnsupported(marker, lineNo, source) {
  if (/^(?:&|\*|!|\{|\[)/.test(marker)) {
    throw new CredentialYamlError(`第 ${lineNo} 行使用了不支持的 YAML 结构（锚点、别名、标签或流式集合）`, { line: lineNo, source })
  }
}

/**
 * 块标量（`|` 字面量、`>` 折叠）或空值：收集缩进更深的行。
 */
function readBlock(lines, fromIndex, indent, lineNo, source, style) {
  const { lines: body, nextIndex } = collectIndented(lines, fromIndex, indent)
  const nonEmpty = body.filter(line => line !== '')
  if (style === '>') return { value: nonEmpty.join(' ').trim(), nextIndex }
  return { value: nonEmpty.join('\n').trim(), nextIndex }
}

/**
 * 块标量的内容本身可能仍是一个带引号的标量（dsh 的折行写法）：
 * 能干净地解开就解开，解不开就按字面量返回。
 */
function maybeUnquote(value, lineNo, source) {
  const trimmed = String(value).trim()
  const quote = trimmed[0]
  if (quote !== "'" && quote !== '"') return trimmed
  const result = unquote(trimmed, lineNo, source, quote)
  return result.closed ? result.value : trimmed
}

/**
 * 收集缩进严格大于 `indent` 的行；遇到空行时仅在下一行仍更深时跳过。
 */
function collectIndented(lines, fromIndex, indent) {
  const out = []
  let index = fromIndex
  while (index < lines.length) {
    const line = lines[index]
    const nonEmpty = line.trim() !== ''
    if (!nonEmpty) {
      const next = lines[index + 1]
      if (next !== undefined && next.trim() !== '' && next.length - next.replace(/^\s*/, '').length > indent) { index += 1; continue }
      break
    }
    const lineIndent = line.length - line.replace(/^\s*/, '').length
    if (lineIndent <= indent) break
    out.push(line.replace(/^\s*/, ''))
    index += 1
  }
  return { lines: out, nextIndex: index }
}

/**
 * 解开一层引号，返回值、剩余文本与是否已闭合。
 * 未闭合时返回 `closed: false`，由调用方决定是报错还是继续收集折行。
 */
function unquote(fragment, lineNo, source, quote) {
  if (quote === "'") {
    let out = ''
    for (let index = 1; index < fragment.length; index += 1) {
      const char = fragment[index]
      if (char === "'") {
        if (fragment[index + 1] === "'") { out += "'"; index += 1 }
        else return { value: out, rest: fragment.slice(index + 1), closed: true }
      } else out += char
    }
    return { value: out, rest: '', closed: false }
  }
  let body = ''
  for (let index = 1; index < fragment.length; index += 1) {
    const char = fragment[index]
    if (char === '\\') { body += char + (fragment[index + 1] ?? ''); index += 1; continue }
    if (char === '"') {
      let parsed
      try { parsed = JSON.parse(`"${body}"`) }
      catch { throw new CredentialYamlError(`第 ${lineNo} 行的双引号字符串转义无效`, { line: lineNo, source }) }
      return { value: parsed, rest: fragment.slice(index + 1), closed: true }
    }
    body += char
  }
  return { value: body, rest: '', closed: false }
}

/** 裸标量去掉尾部注释。 */
function stripTrailingComment(value) {
  const match = /^(.*?)\s+#.*$/.exec(value)
  return match === null ? value.trim() : match[1].trim()
}
