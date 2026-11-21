/**
 * 管理台前端逻辑。
 *
 * 零依赖、无构建步骤：浏览器直接加载这个模块。它只做三件事——
 * 兑换管理会话、读状态、把结果画到已经存在于 index.html 的节点里。
 *
 * 安全约定（与后端一致）：
 * - 密钥永远不写进 URL，也不放进 localStorage；只在需要时读进内存并渲染。
 * - 一次性登录令牌从 URL fragment 取，兑换后立即从地址栏抹掉。
 * - 所有会改状态的操作都要求同源 Origin，由后端围栏再次校验。
 */

const PREFIX = '/api/management'

/** 当前内存里的密钥副本，仅在“显示/复制”时使用。 */
const secrets = { local: '', lan: '' }

let summary = null
let testController = null

// ── 基础工具 ────────────────────────────────────────────────────────────────

const $ = id => document.getElementById(id)
const el = (tag, props = {}) => Object.assign(document.createElement(tag), props)

/** 相对时间，用于“刚刚刷新”这类提示。 */
function ago(timestamp) {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return '从未'
  const seconds = Math.round((Date.now() - timestamp) / 1000)
  if (seconds < 5) return '刚刚'
  if (seconds < 60) return `${seconds} 秒前`
  if (seconds < 3600) return `${Math.round(seconds / 60)} 分钟前`
  if (seconds < 86400) return `${Math.round(seconds / 3600)} 小时前`
  return `${Math.round(seconds / 86400)} 天前`
}

const number = value => Number.isFinite(Number(value)) ? Number(value).toLocaleString('zh-CN') : '—'

/** 一个 token 数量的可读写法：131072 → 128K。 */
function tokens(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return '—'
  if (n >= 1024 * 1024) return `${Math.round(n / (1024 * 1024))}M`
  if (n >= 1024) return `${Math.round(n / 1024)}K`
  return String(n)
}

/** 调一次管理接口；非 2xx 抛出带后端消息的错误。 */
async function api(route, { method = 'GET', body, signal } = {}) {
  const options = {
    method,
    headers: { origin: location.origin },
    signal,
    // 管理会话是 HttpOnly Cookie，必须显式携带；同源请求默认也会带，这里写明意图。
    credentials: 'same-origin',
  }
  if (body !== undefined) {
    options.headers['content-type'] = 'application/json'
    options.body = JSON.stringify(body)
  }
  const response = await fetch(`${PREFIX}${route}`, options)
  const text = await response.text()
  let payload
  try { payload = text === '' ? {} : JSON.parse(text) } catch { payload = { error: text } }
  if (!response.ok) {
    const error = new Error(payload?.error ?? `HTTP ${response.status}`)
    error.status = response.status
    throw error
  }
  return payload
}

/** 把结果写进一个 output 块。 */
function showOutput(node, message, kind = '') {
  node.hidden = false
  node.className = `output ${kind}`.trim()
  node.textContent = message
}

function reportError(node, error) {
  // A 403 here is the privilege fence, not a bug: the session was created with the
  // local API key, which every tool on this machine holds. Say what to do instead
  // of showing a bare status code.
  if (error?.status === 403) {
    showOutput(node,
      `权限不足：凭据操作需要管理密钥会话。\n` +
      `本机 API Key（forwardKey）可以查看状态与试算，但不能读取或迁移凭据。\n` +
      `请用启动时打印的一次性管理链接，或用 settings.json 里的 managementKey 登录。`, 'bad')
    return
  }
  showOutput(node, `失败：${error?.message ?? error}`, 'bad')
}

// ── 会话 ────────────────────────────────────────────────────────────────────

/** 启动：先试已有会话，失败再尝试一次性令牌，最后退回登录表单。 */
async function boot() {
  const fragment = location.hash.startsWith('#login=') ? location.hash.slice('#login='.length) : ''
  // 令牌是一次性的：无论成败都先从地址栏抹掉，避免留在历史记录里。
  if (fragment !== '') history.replaceState(null, '', location.pathname)

  try {
    await api('/summary')
    return start()
  } catch { /* 没有有效会话，继续尝试其他入口 */ }

  if (fragment !== '') {
    try {
      await api('/session', { method: 'POST', body: { bootstrapToken: fragment } })
      return start()
    } catch (error) {
      showLogin(`登录链接已失效：${error.message}`)
      return
    }
  }
  showLogin()
}

function showLogin(message = '') {
  $('app').hidden = true
  $('login').hidden = false
  if (message !== '') {
    $('login-error').textContent = message
    $('login-error').hidden = false
  }
  $('login-key').focus()
}

async function start() {
  $('login').hidden = true
  $('app').hidden = false
  await refresh()
  wire()
}

// ── 数据读取与渲染 ──────────────────────────────────────────────────────────

async function refresh() {
  try {
    summary = await api('/summary')
    renderOverview()
    renderLan()
    renderModels()
    setHealth(true)
  } catch (error) {
    if (error.status === 401) { showLogin('管理会话已过期，请重新登录。'); return }
    setHealth(false, error.message)
  }
}

function setHealth(ok, detail = '') {
  const pill = $('health-pill')
  pill.className = `pill ${ok ? 'ok' : 'bad'}`
  pill.textContent = ok ? '运行中' : `异常${detail === '' ? '' : `：${detail}`}`
  pill.title = ok ? '管理会话有效，服务在线' : detail
}

function renderOverview() {
  const info = summary
  const settings = info.settings ?? {}
  $('product-line').textContent = info.networkMode === 'fixture' ? '本地推理服务（测试替身）' : '本地推理服务'
  $('f-version').textContent = info.version ?? '—'
  $('foot-version').textContent = `${info.product ?? 'our-free-model'} ${info.version ?? ''}`.trim()
  $('f-datadir').textContent = info.dataDir ?? '—'
  $('f-api').textContent = info.baseUrl ? `${info.baseUrl}/v1` : '—'
  $('f-inference').textContent = settings.enabled === false ? '已暂停' : '启用'
  $('f-models').textContent = number((info.catalog ?? []).length)

  const lan = info.lan ?? {}
  $('f-lan').textContent = lan.running ? `运行中 · 端口 ${lan.port}` : (lan.enabled ? '已启用但未运行' : '未启用')
  $('f-lanurl').textContent = (lan.baseUrls ?? []).length > 0 ? lan.baseUrls.join('  ') : '—'
  $('f-lankey').textContent = secrets.lan === '' ? '点「局域网与密钥」查看' : secrets.lan

  const usage = info.usage ?? summary.usage ?? null
  const rows = usage?.totals ?? usage ?? null
  $('f-turns').textContent = rows ? number(rows.turns ?? rows.userTurns ?? 0) : '见经典视图'
  $('f-in').textContent = rows ? number(rows.inputTokens ?? rows.input ?? 0) : '—'
  $('f-out').textContent = rows ? number(rows.outputTokens ?? rows.output ?? 0) : '—'
  $('f-failed').textContent = rows ? number(rows.failed ?? rows.failedTurns ?? 0) : '—'
}

function renderLan() {
  const lan = summary?.lan ?? {}
  const settings = summary?.settings ?? {}
  $('lan-enabled').checked = lan.enabled === true
  $('lan-port').value = String(settings.standaloneLanPort ?? 0)
  $('l-state').textContent = lan.running ? '运行中' : (lan.enabled ? '已启用，未运行' : '未启用')
  $('l-port').textContent = lan.port === null || lan.port === undefined ? '—' : String(lan.port)
  $('l-urls').textContent = (lan.baseUrls ?? []).length > 0 ? lan.baseUrls.join('\n') : '—'
  if (lan.error) $('l-state').textContent = `启动失败：${lan.error}`

  const base = summary?.baseUrl ?? location.origin
  $('s-openai').textContent = `${base}/v1`
  $('s-curl').textContent =
    `curl ${base}/v1/chat/completions \\\n` +
    `  -H "authorization: Bearer <API Key>" \\\n` +
    `  -H 'content-type: application/json' \\\n` +
    `  -d '{"model":"<模型 ID>","messages":[{"role":"user","content":"你好"}]}'`
}

function renderModels() {
  const catalog = summary?.catalog ?? []
  const filter = $('m-search').value.trim().toLowerCase()
  const rows = filter === ''
    ? catalog
    : catalog.filter(row => `${row.id} ${row.name ?? ''}`.toLowerCase().includes(filter))

  $('m-count').textContent = filter === '' ? `（${catalog.length}）` : `（${rows.length}/${catalog.length}）`

  const tbody = $('m-rows')
  tbody.textContent = ''
  if (rows.length === 0) {
    const tr = el('tr')
    const td = el('td', { colSpan: 6, className: 'muted' })
    td.textContent = catalog.length === 0 ? '清单为空，点「刷新清单」从上游拉取' : '没有匹配的模型'
    tr.append(td)
    tbody.append(tr)
  } else {
    for (const row of rows) tbody.append(modelRow(row))
  }

  // 试算下拉框跟着清单走，保留当前选择。
  const select = $('t-model')
  const previous = select.value
  select.textContent = ''
  for (const row of catalog) {
    const option = el('option', { value: row.id })
    option.textContent = row.channel && row.channel !== 'anonymous' ? `${row.id}（${row.channel}）` : row.id
    select.append(option)
  }
  if (previous !== '' && catalog.some(row => row.id === previous)) select.value = previous
  else if (catalog.length > 0) select.value = catalog[0].id

  $('m-hint').textContent = catalog.length === 0
    ? '清单为空：点「刷新清单」重新拉取上游目录；离线时只保留缓存。'
    : `最近同步：${ago(summary?.catalogSyncedAt)}`
}

function modelRow(row) {
  const tr = el('tr')

  const id = el('td', { className: 'id' })
  id.textContent = row.id
  tr.append(id)

  const channel = el('td')
  channel.textContent = row.channel ?? 'anonymous'
  tr.append(channel)

  const context = el('td')
  context.textContent = tokens(row.contextWindow)
  tr.append(context)

  const output = el('td')
  output.textContent = tokens(row.maxOutput)
  tr.append(output)

  const caps = el('td')
  for (const [on, label] of [[row.vision, '视觉'], [row.reasoning, '思考'], [row.routable, '可路由']]) {
    if (on !== true) continue
    const tag = el('span', { className: 'tag' })
    tag.textContent = label
    caps.append(tag)
  }
  if (caps.childElementCount === 0) {
    const tag = el('span', { className: 'tag' })
    tag.textContent = row.availability ?? '未知'
    caps.append(tag)
  }
  tr.append(caps)

  const actions = el('td')
  const test = el('button', { className: 'ghost small' })
  test.textContent = '试算'
  test.addEventListener('click', () => {
    $('t-model').value = row.id
    switchView('models')
    $('t-prompt').focus()
  })
  actions.append(test)
  tr.append(actions)

  return tr
}

// ── 交互 ────────────────────────────────────────────────────────────────────

function switchView(name) {
  for (const tab of document.querySelectorAll('.tabs button')) {
    tab.setAttribute('aria-selected', String(tab.dataset.view === name))
  }
  for (const panel of document.querySelectorAll('[data-panel]')) {
    panel.hidden = panel.dataset.panel !== name
  }
  if (name === 'lan') void loadSecrets()
}

/** 只在切到密钥页时读取密钥，读完即留在内存，不落盘。 */
async function loadSecrets() {
  try {
    if (secrets.local === '') {
      const { key } = await api('/key')
      secrets.local = typeof key === 'string' ? key : ''
    }
  } catch (error) { reportError($('migrate-out'), error) }
  try {
    if (secrets.lan === '') {
      const { key } = await api('/lan/key')
      secrets.lan = typeof key === 'string' ? key : ''
    }
  } catch { /* LAN Key 可能尚未生成 */ }
  for (const [id, value] of [['k-local', secrets.local], ['k-lan', secrets.lan]]) {
    const node = $(id)
    node.textContent = node.dataset.revealed === 'true' ? (value || '（尚未生成）') : '••••••••••••'
  }
}

function wire() {
  for (const tab of document.querySelectorAll('.tabs button')) {
    tab.addEventListener('click', () => switchView(tab.dataset.view))
  }

  $('m-search').addEventListener('input', renderModels)

  $('signout').hidden = false
  $('signout').addEventListener('click', async () => {
    try { await api('/logout', { method: 'POST', body: {} }) } catch { /* 会话可能已失效 */ }
    location.reload()
  })

  $('btn-refresh').addEventListener('click', async event => {
    const button = event.currentTarget
    button.disabled = true
    button.textContent = '刷新中…'
    try {
      await api('/models/refresh', { method: 'POST', body: { probe: false } })
      await refresh()
      $('m-hint').textContent = `刷新完成：${ago(Date.now())}`
    } catch (error) {
      $('m-hint').textContent = `刷新失败：${error.message}`
    } finally {
      button.disabled = false
      button.textContent = '刷新清单'
    }
  })

  // ── 密钥显示与复制 ──
  for (const button of document.querySelectorAll('[data-reveal]')) {
    button.addEventListener('click', () => {
      const node = $(button.dataset.reveal)
      const revealed = node.dataset.revealed === 'true'
      node.dataset.revealed = String(!revealed)
      node.textContent = revealed
        ? '••••••••••••'
        : (node.id === 'k-local' ? secrets.local : secrets.lan) || '（尚未生成）'
      button.textContent = revealed ? '显示' : '隐藏'
    })
  }
  for (const button of document.querySelectorAll('[data-copy]')) {
    button.addEventListener('click', async () => {
      const value = button.dataset.copy === 'k-local' ? secrets.local : secrets.lan
      if (value === '') return
      try {
        await navigator.clipboard.writeText(value)
        const label = button.textContent
        button.textContent = '已复制'
        setTimeout(() => { button.textContent = label }, 1500)
      } catch { /* 剪贴板被拒时静默：用户仍可手动选中 */ }
    })
  }

  $('btn-rotate-lan').addEventListener('click', async () => {
    if (!confirm('轮换后旧的 LAN Key 立即失效，局域网客户端需要更新配置。继续？')) return
    try {
      const { key } = await api('/lan/key/rotate', { method: 'POST', body: { confirm: true } })
      secrets.lan = key
      $('k-lan').dataset.revealed = 'false'
      $('k-lan').textContent = '••••••••••••'
      await refresh()
    } catch (error) { alert(`轮换失败：${error.message}`) }
  })

  $('btn-rotate-local').addEventListener('click', async () => {
    if (!confirm('轮换本机 API Key 会让所有本地客户端立即失效。继续？')) return
    try {
      const { key } = await api('/key/rotate', { method: 'POST', body: { confirm: true } })
      secrets.local = key
      $('k-local').dataset.revealed = 'false'
      $('k-local').textContent = '••••••••••••'
      await refresh()
    } catch (error) { alert(`轮换失败：${error.message}`) }
  })

  // ── 局域网 ──
  $('btn-save-lan').addEventListener('click', async event => {
    const button = event.currentTarget
    const raw = $('lan-port').value.trim()
    const port = raw === '' ? 0 : Number(raw)
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      alert('端口必须是 0 到 65535 的整数')
      return
    }
    button.disabled = true
    try {
      await api('/settings', { method: 'POST', body: { standaloneLanEnabled: $('lan-enabled').checked, standaloneLanPort: port } })
      await refresh()
      secrets.lan = ''
      if (summary?.lan?.running) await loadSecrets()
    } catch (error) { alert(`保存失败：${error.message}`) }
    finally { button.disabled = false }
  })

  // ── 迁移 ──
  $('btn-preview-dsh').addEventListener('click', () => runMigration(true))
  $('btn-import-dsh').addEventListener('click', () => runMigration(false))

  $('btn-export-backup').addEventListener('click', async () => {
    const out = $('backup-out')
    try {
      // 备份由后端写成文件，前端只负责说明位置；不把凭据送进浏览器。
      const result = await api('/migrate/export', { method: 'POST', body: {} })
      showOutput(out, `已导出到：${result.path}\n凭据 ${result.credentials} 条，账号 ${result.accounts} 个。\n该文件是明文，请妥善保存。`, 'ok')
    } catch (error) { reportError(out, error) }
  })

  $('file-import').addEventListener('change', async event => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    const out = $('backup-out')
    try {
      const text = await file.text()
      let payload
      try { payload = JSON.parse(text) } catch {
        throw new Error('文件不是 JSON；插件在浏览器侧加密的备份不适用，请改用「从 dsh 导入」')
      }
      const result = await api('/migrate/import-backup', { method: 'POST', body: { backup: payload, replace: $('replace').checked } })
      showOutput(out, describeMigration(result), 'ok')
      await refresh()
    } catch (error) { reportError(out, error) }
  })

  // ── 试算 ──
  $('btn-test').addEventListener('click', runTest)
  $('btn-test-cancel').addEventListener('click', () => {
    testController?.abort()
    testController = null
  })

  $('login-form').addEventListener('submit', async event => {
    event.preventDefault()
    const key = $('login-key').value.trim()
    const error = $('login-error')
    error.hidden = true
    $('login-submit').disabled = true
    try {
      await api('/session', { method: 'POST', body: { key } })
      $('login-key').value = ''
      await start()
    } catch (problem) {
      error.textContent = problem.message
      error.hidden = false
    } finally { $('login-submit').disabled = false }
  })
}

function describeMigration(result) {
  const lines = []
  if (result.dryRun) lines.push('演练模式：未写入任何文件')
  if (result.source) lines.push(`来源：${result.source}`)
  if (result.credentialCount !== undefined) lines.push(`账号凭据：${result.credentialCount} 条`)
  if (result.accountCount !== undefined) lines.push(`账号：${result.accountCount} 个`)
  if (result.skipped) lines.push(`已跳过 ${result.skipped} 条非账号引用或空凭据`)
  const written = result.written
  if (written) {
    lines.push(`写入凭据 ${written.credentialsWritten} 条；账号池 ${written.accountsWritten} 个（${written.mode === 'replace' ? '整体覆盖' : '合并'}）`)
    if (written.accountsMissingCredential) lines.push(`${written.accountsMissingCredential} 个账号的凭据缺失，已忽略`)
  }
  return lines.join('\n')
}

async function runMigration(dryRun) {
  const out = $('migrate-out')
  const button = dryRun ? $('btn-preview-dsh') : $('btn-import-dsh')
  button.disabled = true
  showOutput(out, dryRun ? '正在统计…' : '正在写入…')
  try {
    const body = {
      dryRun,
      replace: $('replace').checked,
      withLedger: $('with-ledger').checked,
    }
    const dshHome = $('dsh-home').value.trim()
    if (dshHome !== '') body.dshHome = dshHome
    const result = await api('/migrate/dsh', { method: 'POST', body })
    showOutput(out, describeMigration(result), 'ok')
    if (!dryRun) await refresh()
  } catch (error) { reportError(out, error) }
  finally { button.disabled = false }
}

/** 四种协议各发一次请求，把可读结果或原始错误显示出来。 */
async function runTest() {
  const out = $('t-out')
  const model = $('t-model').value
  if (model === '') { reportError(out, new Error('清单为空，先刷新模型清单')); return }
  const prompt = $('t-prompt').value.trim() || '回复一句话证明链路通了'
  const maxTokens = Math.max(16, Math.min(4096, Number($('t-max').value) || 128))
  const protocol = $('t-proto').value

  testController?.abort()
  testController = new AbortController()
  $('btn-test').disabled = true
  $('btn-test-cancel').hidden = false
  showOutput(out, '请求中…')

  try {
    const result = await api('/test', {
      method: 'POST',
      body: { model, prompt, maxTokens, protocol },
      signal: testController.signal,
    })
    const header = `${protocol} · ${model} · ${result.ms ?? '?'} ms`
    showOutput(out, `${header}\n\n${result.text ?? '（空响应）'}`, 'ok')
  } catch (error) {
    if (error.name === 'AbortError') showOutput(out, '已取消')
    else reportError(out, error)
  } finally {
    testController = null
    $('btn-test').disabled = false
    $('btn-test-cancel').hidden = true
  }
}

// 服务暂停或重启后，页面上的状态会变旧：定期轻量重读一次摘要。
setInterval(() => { if ($('app').hidden === false && document.visibilityState === 'visible') void refresh() }, 20_000)

void boot()