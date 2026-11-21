import { modelAvailability } from '../../src/model-test.js'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { buildStats } from '../../src/core/stats.js'
import { generateKey } from '../../src/forward.js'
import { structuralRejection } from '../../src/trust.js'
import { openLoginTerminal } from './login-terminal.mjs'
import { publicModelVisibility, validateModelVisibility, isModelHidden } from '../../src/store.js'
import { createWorkbench } from './workbench.mjs'
import { createProviderManagement } from './providers.mjs'
import { createWorkbenchLibrary } from './library.mjs'
import { createRoutingManagement } from './routing.mjs'
import { createDesktopUpdater } from './desktop-update.mjs'
import { createFeedback } from './feedback.mjs'
import { DISCLAIMER, DISCLAIMER_VERSION, disclaimerAcknowledged } from '../../src/disclaimer.js'
import { pageBridgeSource } from '../../src/plugins.js'
import {
  MigrationError, applyBackup, buildBackupPayload, exportBackup, readDshAccountState,
  readDshCredentials, resolveDshHome, validateBackupPayload,
} from './dsh-migrate.mjs'
import { restrictPermissions } from '../../src/open-external.js'


const PREFIX = '/api/management'
const BOOTSTRAP_MS = 10 * 60_000
const SESSION_MS = 8 * 60 * 60_000
const MAX_BODY_BYTES = 16 * 1024
/**
 * The console's static surface.
 *
 * This adaptation replaced the prebuilt React console (which shipped upstream's
 * branding and none of this fork's features) with a hand-written, dependency-free
 * page. There is no build step and no asset manifest: these four files are the
 * whole interface, and the list is a closed set — a request for anything else is
 * a 404, so no request path is ever turned into a disk read.
 */
const ASSETS = new Map([
  ['/', ['console/index.html', 'text/html; charset=utf-8']],
  ['/assets/console.css', ['console/console.css', 'text/css; charset=utf-8']],
  ['/assets/console.js', ['console/console.js', 'text/javascript; charset=utf-8']],
  // The icon is the repository's own, shared with the desktop package.
  ['/assets/icon.svg', ['../../icon.svg', 'image/svg+xml']],
])
/** A page with a live session may be opened at this long-lived path. */
const HOME_PATH = '/'
const SECURITY_HEADERS = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
}

function fail(statusCode, message) {
  return Object.assign(new Error(message), { statusCode })
}

function matches(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string' || expected === '') return false
  const left = Buffer.from(actual)
  const right = Buffer.from(expected)
  return left.length === right.length && crypto.timingSafeEqual(left, right)
}

async function readBody(req, limit = MAX_BODY_BYTES) {
  if (!String(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
    throw fail(415, '请求必须使用 application/json')
  }
  let bytes = 0
  const chunks = []
  for await (const chunk of req) {
    bytes += chunk.length
    if (bytes > limit) throw fail(413, '请求内容过大')
    chunks.push(chunk)
  }
  let value
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw fail(400, '请求不是有效 JSON') }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw fail(400, '请求必须是 JSON 对象')
  return value
}

function validateSettings(patch) {
  const visibility = validateModelVisibility(patch)
  const booleans = new Set(['enabled', 'exposeRegionModels', 'streamRecovery', 'standaloneProbe', 'standaloneLanEnabled', 'developerPlugins', 'autoUpdateExtensions'])
  const numbers = { probeIntervalMinutes: [1, 1440], defaultMaxTokens: [512, 131072], standaloneLanPort: [0, 65535] }
  const result = {}
  for (const [key, value] of Object.entries(patch)) {
    if (Object.hasOwn(visibility, key)) { result[key] = visibility[key]; continue }
    if (booleans.has(key)) {
      if (typeof value !== 'boolean') throw fail(400, `${key} 必须是布尔值`)
    } else if (Object.hasOwn(numbers, key)) {
      const [min, max] = numbers[key]
      if (!Number.isInteger(value) || value < min || value > max) throw fail(400, `${key} 必须是 ${min} 到 ${max} 的整数`)
    } else throw fail(400, `不支持的设置字段：${key}`)
    result[key] = value
  }
  return result
}

export function managementSettings(value) {
  return {
    ...publicModelVisibility(value),
    enabled: value.enabled !== false,
    exposeRegionModels: value.exposeRegionModels !== false,
    streamRecovery: value.streamRecovery !== false,
    standaloneProbe: value.standaloneProbe === true,
    standaloneLanEnabled: value.standaloneLanEnabled === true,
    standaloneLanPort: value.standaloneLanPort ?? 0,
    probeIntervalMinutes: value.probeIntervalMinutes ?? 15,
    defaultMaxTokens: value.defaultMaxTokens ?? 32768,
    developerPlugins: value.developerPlugins === true,
    autoUpdateExtensions: value.autoUpdateExtensions === true,
  }
}

/** 管理读写要求鉴权；登录恢复仅允许同源页面触发固定本机动作。 */
export function createManagement({ stores, runtime, channels, eac, subscriptions, workbenchOptions, magpieEngine, magpieModels, extensions, onEngineStarted, onSubscriptionsChanged, info, onSettingsChanged, loginTerminal = openLoginTerminal, desktopPlatform = process.platform, desktopArch = process.arch }) {
  // `desktopPlatform`/`desktopArch` are threaded from the caller instead of read
  // from `process` so the Windows-only update flow stays exercisable on a test
  // runner that is neither (`desktop-update.mjs` already takes them this way).
  const desktopUpdate = createDesktopUpdater({ dataDir: info().dataDir, version: process.env.OFM_DESKTOP_VERSION, platform: desktopPlatform, arch: desktopArch })
  let bootstrap = { token: crypto.randomBytes(32).toString('base64url'), until: Date.now() + BOOTSTRAP_MS }
  const sessions = new Map()
  const privilegedSessions = new Set()
  let cookieName
  let closed = false
  let terminalOpening = false
  let terminalOpenedAt = null
  const loginPlatform = process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'unsupported'
  const assets = new Map([...ASSETS].map(([url, [file, type]]) => [
    url, { type, body: fs.readFileSync(new URL(`./${file}`, import.meta.url)) },
  ]))
  const json = (res, status, payload, headers = {}) => {
    res.writeHead(status, { ...SECURITY_HEADERS, 'content-type': 'application/json; charset=utf-8', ...headers })
    res.end(JSON.stringify(payload))
  }
  /**
   * Validate one uploaded backup document.
   *
   * The console hands over whatever JSON the user picked, so the shape is checked
   * by the same contract the CLI uses before a single byte is written.
   */
  function buildAndValidate(payload) {
    return validateBackupPayload(payload)
  }

  /**
   * Persist a backup, then bring the running channel worker up to date.
   *
   * Two constraints found by measurement, not assumption:
   *
   * 1. `applyBackup` is the only step that can *drop* refs — the worker's
   *    `backup.import` RPC merges, so importing B after A leaves both in place.
   * 2. The RPC also rewrites the credential file from the worker's in-memory view,
   *    so running it after a `replace` write puts the old refs straight back.
   *
   * Therefore: a `merge` import can use the RPC (it only adds, which is exactly
   * what a merge wants, and it updates the live pool). A `replace` import writes
   * the files and does *not* call the RPC — the reply reports `pending-restart`,
   * because only a restart makes the worker forget the refs that were dropped.
   */
  async function applyPayloadToRunningChannels(payload, replace) {
    const written = applyBackup(info().dataDir, payload, { replace })
    if (channels === undefined) return { ...written, live: 'unavailable' }
    if (replace) {
      // See (2) above: the RPC would resurrect the refs `replace` just removed.
      return { ...written, live: 'pending-restart' }
    }
    try {
      const reply = await channels.rpc({ method: 'backup.import', payload: { payload } })
      if (reply?.ok === true) {
        await channels.refresh({ report: true }).catch(() => {})
        return { ...written, live: 'applied' }
      }
      return { ...written, live: 'refused', liveError: String(reply?.error?.message ?? '') }
    } catch (error) {
      return { ...written, live: 'pending-restart', liveError: String(error?.message ?? error) }
    }
  }

  /**
   * Send one prompt to the local inference listener in the chosen protocol shape
   * and return the text it answered with.
   *
   * Deliberately over loopback HTTP against the running listener: the console's
   * probe must exercise what a real client would hit, including the relay's
   * authentication, not an internal shortcut.
   */
  async function runProtocolProbe({ base, key, protocol, model, prompt, maxTokens, signal }) {
    const root = base.replace(/\/+$/, '')
    const started = Date.now()
    const call = async (url, init) => {
      const response = await fetch(url, { ...init, signal })
      const text = await response.text()
      if (!response.ok) {
        let message = text.slice(0, 500)
        try { message = JSON.parse(text)?.error?.message ?? message } catch { /* keep the raw body */ }
        throw new Error(`${response.status} ${message}`)
      }
      return text
    }
    if (protocol === 'openai') {
      const raw = await call(`${root}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] }),
      })
      const body = JSON.parse(raw)
      const choice = body.choices?.[0]
      const text = choice?.message?.content ?? choice?.message?.reasoning ?? ''
      return { text: String(text), ms: Date.now() - started, finish: choice?.finish_reason ?? null, usage: body.usage ?? null }
    }
    if (protocol === 'anthropic') {
      const raw = await call(`${root}/v1/messages`, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] }),
      })
      const body = JSON.parse(raw)
      const text = (body.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('')
      return { text, ms: Date.now() - started, finish: body.stop_reason ?? null, usage: body.usage ?? null }
    }
    if (protocol === 'gemini') {
      const raw = await call(`${root}/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        headers: { 'x-goog-api-key': key, 'content-type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: maxTokens },
        }),
      })
      const body = JSON.parse(raw)
      const parts = body.candidates?.[0]?.content?.parts ?? []
      const text = parts.filter(part => part.text && part.thought !== true).map(part => part.text).join('')
      return { text, ms: Date.now() - started, finish: body.candidates?.[0]?.finishReason ?? null, usage: body.usageMetadata ?? null }
    }
    const raw = await call(`${root}/api/chat`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model, stream: false, messages: [{ role: 'user', content: prompt }], options: { num_predict: maxTokens } }),
    })
    const body = JSON.parse(raw)
    return {
      text: String(body.message?.content ?? ''),
      ms: Date.now() - started,
      finish: body.done_reason ?? null,
      usage: { prompt_tokens: body.prompt_eval_count, completion_tokens: body.eval_count },
    }
  }

  const cookie = req => {
    const parts = String(req.headers.cookie ?? '').split(';')
    return parts.map(value => value.trim()).find(value => value.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1)
  }
  const clearCookie = () => `${cookieName}=; Path=${PREFIX}; HttpOnly; SameSite=Strict; Max-Age=0`
  const pruneSessions = () => {
    for (const [id, until] of sessions) if (until <= Date.now()) {
      sessions.delete(id)
      privilegedSessions.delete(id)
    }
  }
  /**
   * Sliding renewal: an active console session never expires mid-use.
   *
   * A fixed 8h deadline killed the page while the user was looking at it
   * (issue #557) — the cookie outlived the server-side record, so the next
   * request 401'd with no way to recover but a manual re-login. Touching the
   * record on each authenticated request keeps an idle console expiring on
   * schedule while a busy one stays alive. The cookie's `Max-Age` is not
   * rewritten here, so a closed tab still drops the session within 8h.
   */
  const touchSession = id => {
    if (typeof id !== 'string' || id === '') return
    const until = sessions.get(id)
    if (until === undefined) return
    const renewed = Date.now() + SESSION_MS
    // Only write when the extension is meaningful, so a busy console does not
    // rewrite the map on every request.
    if (renewed - until > 60_000) sessions.set(id, renewed)
  }
  const authenticated = req => {
    const bearer = /^Bearer (.+)$/i.exec(String(req.headers.authorization ?? ''))?.[1]
    if (matches(bearer, stores.settings.get().forwardKey)) return true
    pruneSessions()
    const id = cookie(req)
    touchSession(id)
    return sessions.has(id)
  }
  const sessionAuthenticated = req => {
    pruneSessions()
    const id = cookie(req)
    touchSession(id)
    return sessions.has(id) && privilegedSessions.has(id)
  }
  const persist = patch => {
    const previous = stores.settings.get()
    stores.settings.update(patch)
    stores.settings.flush()
    if (stores.settings.writeFailed) {
      // 不向页面谎报保存成功；保留原运行配置并由后续写入重试落盘。
      stores.settings.value = previous
      throw fail(500, '无法保存设置，请检查数据目录权限和磁盘空间')
    }
  }
  const workbench = runtime && typeof info().dataDir === 'string' ? createWorkbench({
    dataDir: info().dataDir,
    info: () => ({ ...info(), enabled: stores.settings.get().enabled !== false }),
    key: () => stores.settings.get().forwardKey,
    modelRows: () => runtime.publicModelRows(),
    ...workbenchOptions,
  }) : undefined
  const providerManagement = runtime ? createProviderManagement({ stores, runtime, persist }) : undefined
  const routingManagement = runtime ? createRoutingManagement({ stores, runtime, persist }) : undefined
  const library = workbench ? createWorkbenchLibrary({ dataDir: info().dataDir, workbench }) : undefined
  const feedback = createFeedback({ settings: () => stores.settings.get(), persist })
  workbench?.setLibrary(library)
  const summary = () => {
    const state = runtime.state()
    const available = stores.availability.get()
    const routable = new Set(runtime.publicModelRows().map(entry => entry.id))
    return {
      ...info(),
      channels: channels?.state(),
      eacAuth: eac?.cached(),
      settings: managementSettings(stores.settings.get()),
      catalogSyncedAt: stores.settings.get().catalogSyncedAt ?? 0,
      probedAt: available.at ?? 0,
      lane: available.lane ?? null,
      extensions: extensions !== undefined ? { installed: extensions.listInstalled() } : null,
      plugins: extensions !== undefined ? {
        installedCount: extensions.listInstalled().filter(record => record.builtin !== true).length,
        builtinCount: extensions.listInstalled().filter(record => record.builtin === true).length,
        pages: extensions.pages(),
        developerPlugins: stores.settings.get().developerPlugins === true,
      } : null,
      catalog: state.catalog.map(entry => {
        const measured = modelAvailability(entry.id, available, Boolean(entry.channel))
        return ({
        id: entry.id, name: entry.name, channel: entry.channel ?? 'anonymous',
        vision: entry.vision === true, reasoning: entry.reasoning === true || (entry.reasoning !== null && typeof entry.reasoning === 'object'),
        contextWindow: entry.contextWindow ?? entry.context_window, maxOutput: entry.maxOutput ?? entry.max_tokens,
        routable: routable.has(entry.id),
        hiddenByUser: isModelHidden(entry, state.settings),
        hiddenByGroup: isModelHidden(entry, { ...state.settings, hiddenModelIds: [] }),
        ...measured, availability: measured.availabilitySource === 'listing' ? 'listed' : measured.availability,
      }) }),
    }
  }

  const PLUGIN_ASSET_RE = /^\/api\/management\/plugins\/assets\/([a-f0-9]{32})\/(.+)$/
  const pluginAssetPath = pathname => PLUGIN_ASSET_RE.test(pathname)

  /** The one host script a page plugin may load. It is static, has no secrets,
   *  and only opens the postMessage channel back to this console. */
  function injectPluginBridge(html, source) {
    const tag = `<script src="${source}"></script>`
    const text = String(html)
    if (/<\/head\s*>/i.test(text)) return text.replace(/<\/head\s*>/i, `${tag}</head>`)
    return `${tag}${text}`
  }

  /**
   * Serve one page asset. The URL token is the capability: the iframe has an
   * opaque origin and no session, so authorization is "this file was declared
   * by the plugin this boot minted the token for". Everything else is 404.
   */
  function servePluginAsset(req, res, pathname) {
    const match = PLUGIN_ASSET_RE.exec(pathname)
    if (match === null) { res.writeHead(404); res.end(); return }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return }
    const token = match[1]
    let relative
    try { relative = decodeURIComponent(match[2]) } catch { res.writeHead(400); res.end(); return }
    if (relative === '' || relative.includes('..') || relative.includes('\\') || relative.includes('\0')) {
      res.writeHead(404); res.end(); return
    }
    const origin = (() => {
      try { return new URL(info().baseUrl).origin } catch { return `http://${req.headers.host}` }
    })()
    const headers = {
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'cross-origin-resource-policy': 'cross-origin',
      'access-control-allow-origin': '*',
      'content-security-policy': `default-src 'none'; script-src ${origin}; style-src 'unsafe-inline' ${origin}; img-src data: blob: ${origin}; font-src ${origin}; connect-src 'none'; frame-ancestors ${origin}; base-uri 'none'; form-action 'none'`,
    }
    if (relative === '__bridge.js') {
      const body = Buffer.from(pageBridgeSource())
      res.writeHead(200, { ...headers, 'content-type': 'text/javascript; charset=utf-8', 'content-length': body.length })
      res.end(req.method === 'HEAD' ? undefined : body)
      return
    }
    const asset = extensions?.pageAsset(token, relative)
    if (asset === undefined || asset === null) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); res.end('not found'); return }
    let body = asset.bytes
    if (asset.type.startsWith('text/html')) {
      body = Buffer.from(injectPluginBridge(body.toString('utf8'), `/api/management/plugins/assets/${token}/__bridge.js`))
    }
    res.writeHead(200, { ...headers, 'content-type': asset.type, 'content-length': body.length })
    res.end(req.method === 'HEAD' ? undefined : body)
  }

  async function route(req, res, pathname) {

    const method = req.method ?? 'GET'
    const reply = (statusCode, payload, headers) => json(res, statusCode, payload, headers)
    if (method === 'POST' && pathname === `${PREFIX}/login/terminal`) {
      // 此入口发生在登录前，必须有浏览器的同源 Origin，拒绝跨站和无来源调用。
      if (req.headers.origin !== new URL(`http://${req.headers.host}`).origin ||
          req.headers['sec-fetch-site'] !== 'same-origin') {
        throw fail(403, '请从本机登录页面点击获取令牌')
      }
      const body = await readBody(req)
      if (Object.keys(body).length !== 0) throw fail(400, '获取令牌不接受路径或命令参数')
      if (terminalOpening || (terminalOpenedAt !== null && Date.now() - terminalOpenedAt < 30_000)) {
        throw fail(429, '已请求打开终端，请检查弹出的窗口，30 秒后可重试')
      }
      terminalOpening = true
      try {
        await loginTerminal(info().dataDir)
        terminalOpenedAt = Date.now()
        json(res, 200, { ok: true })
      } finally { terminalOpening = false }
      return
    }
    if (method === 'POST' && pathname === `${PREFIX}/session`) {
      const body = await readBody(req)
      const validBootstrap = bootstrap !== null && bootstrap.until > Date.now() && matches(body.bootstrapToken, bootstrap.token)
      const validManagementKey = matches(body.key, stores.settings.get().managementKey)
      if (!validBootstrap && !validManagementKey && !matches(body.key, stores.settings.get().forwardKey)) throw fail(401, '登录链接已失效或登录令牌不正确')
      pruneSessions()
      if (sessions.size >= 64) throw fail(429, '管理会话过多，请稍后重试')
      // The bootstrap link is deliberately single-use (a test pins that: a
      // replayable one-time link is a replayable credential). What #557 asked
      // for is the *session* surviving normal use, which `touchSession` now
      // handles — a live console is renewed on every authenticated request
      // instead of dying at a fixed 8h mark.
      if (validBootstrap) bootstrap = null
      const id = crypto.randomBytes(32).toString('base64url')
      sessions.set(id, Date.now() + SESSION_MS)
      if (validBootstrap || validManagementKey) privilegedSessions.add(id)
      json(res, 200, { ok: true }, {
        'set-cookie': `${cookieName}=${id}; Path=${PREFIX}; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MS / 1000}`,
      })
      return
    }
    const privilegedManagementRoute =
      pathname === `${PREFIX}/desktop-update` || pathname.startsWith(`${PREFIX}/desktop-update/`)
      ||
      pathname === `${PREFIX}/workbench` || pathname.startsWith(`${PREFIX}/workbench/`)
      || pathname === `${PREFIX}/library` || pathname.startsWith(`${PREFIX}/library/`)
      || pathname === `${PREFIX}/providers` || pathname.startsWith(`${PREFIX}/providers/`)
      || pathname === `${PREFIX}/subscriptions` || pathname.startsWith(`${PREFIX}/subscriptions/`)
      || pathname === `${PREFIX}/routing` || pathname.startsWith(`${PREFIX}/routing/`)
      || pathname === `${PREFIX}/engine` || pathname.startsWith(`${PREFIX}/engine/`)
      || pathname === `${PREFIX}/extensions` || pathname.startsWith(`${PREFIX}/extensions/`)
      || pathname === `${PREFIX}/plugins` || pathname.startsWith(`${PREFIX}/plugins/`)
      || pathname === `${PREFIX}/feedback` || pathname.startsWith(`${PREFIX}/feedback/`)
      // Credential migration reads and writes secrets, so a session created from
      // the local API key is not enough: it needs a management-key or one-time-link
      // session. The local key is handed to every tool on the machine, and it must
      // not also be enough to export the account pool.
      // `/test` is deliberately NOT here — a wire probe only spends quota on models
      // the caller could already call directly.
      || pathname.startsWith(`${PREFIX}/migrate/`)
    // A sandboxed plugin page inside the workspace carries a per-run HMAC
    // capability in its own path; it has an opaque origin and cannot send this
    // console's session. The engine validates the capability and serves only
    // that plugin's files, exactly as it does for the plugin build. This has to
    // be decided before the session check for the same reason.
    const enginePluginAsset = ['GET', 'HEAD'].includes(req.method)
      && /^\/api\/management\/engine\/ui\/_magpie\/plugin\/[a-f0-9]{32}\/[^?]+$/.test(pathname)
    const pluginPageAsset = ['GET', 'HEAD'].includes(req.method) && pluginAssetPath(pathname)
    if (!authenticated(req) && !enginePluginAsset && !pluginPageAsset) throw fail(401, '请先登录管理页面')
    if (privilegedManagementRoute && !sessionAuthenticated(req) && !enginePluginAsset && !pluginPageAsset) {
      throw fail(403, '此管理操作需要已登录的本地管理会话')
    }
    // ── the plugin center (behind the same session fence) ────────────────────
    // `/plugins` is the current surface; `/extensions` stays as an alias so an
    // older console and the DSH-side marketplace keep working unchanged.
    const pluginBase = pathname === `${PREFIX}/plugins` || pathname.startsWith(`${PREFIX}/plugins/`)
      ? `${PREFIX}/plugins`
      : pathname === `${PREFIX}/extensions` || pathname.startsWith(`${PREFIX}/extensions/`)
        ? `${PREFIX}/extensions`
        : null
    if (pluginBase !== null) {
      // A composition that mounted no plugin runtime answers "unavailable",
      // never a TypeError.
      if (extensions === undefined) return reply(503, { error: 'the plugin platform is unavailable' })
      const suffix = pathname.slice(pluginBase.length)
      const readJsonBody = () => readBody(req)
      if (method === 'GET' && suffix === '') {
        // A first paint waits briefly for the boot warm-up and hears why a read
        // failed, rather than being told the index is unreadable when it is
        // simply still downloading.
        const status = await extensions.registryStatusSoon()
        return reply(200, {
          installed: extensions.listInstalled(),
          registry: status.registry,
          registryError: status.error,
          pages: extensions.pages(),
          audit: extensions.auditTail(100),
          updates: extensions.updatesAvailable(),
          registryMeta: extensions.registryMeta(),
          settings: {
            developerPlugins: stores.settings.get().developerPlugins === true,
            autoUpdateExtensions: stores.settings.get().autoUpdateExtensions === true,
          },
        })
      }
      if (method === 'GET' && suffix === '/pages') return reply(200, { pages: extensions.pages() })
      if (method === 'GET' && suffix === '/audit') return reply(200, { entries: extensions.auditTail(100) })
      if (method === 'GET' && suffix === '/cover') {
        const id = new URL(req.url ?? '/', 'http://localhost').searchParams.get('id') ?? ''
        const image = await extensions.coverImage(id)
        if (image === null) return reply(404, { error: 'cover not found' })
        res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': image.contentType, 'content-length': image.bytes.length })
        res.end(image.bytes)
        return
      }
      if (method === 'POST' && suffix === '/registry/refresh') {
        try {
          await extensions.refreshRegistry({ force: true })
          return reply(200, { ok: true, installed: extensions.listInstalled(), registry: extensions.registryView() })
        } catch (error) {
          return reply(502, { error: String(error?.message ?? error), installed: extensions.listInstalled() })
        }
      }
      if (method === 'POST' && suffix === '/install') {
        try {
          const body = await readJsonBody()
          const record = await extensions.install(String(body?.id ?? ''), { version: typeof body?.version === 'string' ? body.version : undefined })
          return reply(200, { ok: true, record, installed: extensions.listInstalled(), pages: extensions.pages() })
        } catch (error) {
          return reply(400, { error: String(error?.message ?? error) })
        }
      }
      if (method === 'POST' && suffix === '/install-local') {
        try {
          if (stores.settings.get().developerPlugins !== true) throw fail(403, '请先在插件中心开启开发者模式')
          const body = await readJsonBody()
          const record = await extensions.installLocal({
            path: String(body?.path ?? ''),
            acknowledgeUnsigned: body?.acknowledgeUnsigned === true,
          })
          return reply(200, { ok: true, record, installed: extensions.listInstalled(), pages: extensions.pages() })
        } catch (error) {
          return reply(error.statusCode ?? 400, { error: String(error?.message ?? error) })
        }
      }
      if (method === 'POST' && suffix === '/uninstall') {
        try {
          const body = await readJsonBody()
          await extensions.uninstall(String(body?.id ?? ''))
          return reply(200, { ok: true, installed: extensions.listInstalled(), pages: extensions.pages() })
        } catch (error) {
          return reply(400, { error: String(error?.message ?? error) })
        }
      }
      if (method === 'POST' && suffix === '/toggle') {
        try {
          const body = await readJsonBody()
          const record = await extensions.setEnabled(String(body?.id ?? ''), body?.enabled === true)
          return reply(200, { ok: true, record, installed: extensions.listInstalled(), pages: extensions.pages() })
        } catch (error) {
          return reply(400, { error: String(error?.message ?? error) })
        }
      }
      if (method === 'POST' && suffix === '/config') {
        try {
          const body = await readJsonBody()
          const record = await extensions.saveConfig(String(body?.id ?? ''), body?.values ?? {})
          // `installed` rides along so a saved config field is reflected by the
          // card that rendered it.
          return reply(200, { ok: true, record, installed: extensions.listInstalled() })
        } catch (error) {
          return reply(400, { error: String(error?.message ?? error) })
        }
      }
      if (method === 'POST' && suffix === '/secret') {
        try {
          const body = await readJsonBody()
          const record = await extensions.saveSecret(String(body?.id ?? ''), String(body?.key ?? ''), body?.value)
          return reply(200, { ok: true, record, installed: extensions.listInstalled() })
        } catch (error) {
          return reply(400, { error: String(error?.message ?? error) })
        }
      }
      if (method === 'POST' && suffix === '/self-test') {
        try {
          const body = await readJsonBody()
          return reply(200, await extensions.runSelfTest(String(body?.id ?? '')))
        } catch (error) {
          return reply(400, { error: String(error?.message ?? error) })
        }
      }
      if (method === 'POST' && suffix === '/page-rpc') {
        try {
          const body = await readBody(req, 96 * 1024)
          const result = await extensions.pageRpc(
            String(body?.pluginId ?? ''), String(body?.pageId ?? ''), String(body?.method ?? ''), body?.params ?? {},
          )
          return reply(200, { ok: true, result })
        } catch (error) {
          return reply(400, { error: String(error?.message ?? error) })
        }
      }
      return reply(404, { error: '插件接口不存在' })
    }

    if (method === 'POST' && pathname === `${PREFIX}/logout`) {
      await readBody(req)
      sessions.delete(cookie(req))
      privilegedSessions.delete(cookie(req))
      json(res, 200, { ok: true }, { 'set-cookie': clearCookie() })
    } else if (pathname === `${PREFIX}/desktop-update` && method === 'GET') {
      json(res, 200, desktopUpdate.status())
    } else if (pathname === `${PREFIX}/desktop-update/check` && method === 'POST') {
      await readBody(req)
      json(res, 200, desktopUpdate.check())
    } else if (pathname === `${PREFIX}/desktop-update/download` && method === 'POST') {
      await readBody(req)
      json(res, 200, desktopUpdate.download())
    } else if (method === 'GET' && pathname === `${PREFIX}/summary`) {
      json(res, 200, summary())
    } else if (method === 'GET' && pathname === `${PREFIX}/stats`) {
      json(res, 200, buildStats(stores.stats.get(), runtime.catalog))
    } else if (method === 'GET' && pathname === `${PREFIX}/engine/status`) {
      json(res, 200, magpieEngine?.status() ?? { state: 'unavailable', available: false })
    } else if (method === 'POST' && pathname === `${PREFIX}/engine/start`) {
      await readBody(req)
      if (!magpieEngine) throw fail(503, '模型工作台不可用')
      await magpieEngine.start()
      await magpieModels?.refresh()
      onEngineStarted?.()
      json(res, 200, magpieEngine.status())
    } else if (method === 'POST' && pathname === `${PREFIX}/engine/refresh`) {
      await readBody(req)
      if (!magpieEngine) throw fail(503, '模型工作台不可用')
      await magpieModels?.refresh()
      json(res, 200, { ok: true })
    } else if (pathname === `${PREFIX}/engine/ui` || pathname.startsWith(`${PREFIX}/engine/ui/`)) {
      if (!magpieEngine) throw fail(503, '模型工作台不可用')
      if (magpieEngine.status().state !== 'ready') throw fail(503, '模型工作台尚未启动')
      if (pathname === `${PREFIX}/engine/ui` && !req.url.endsWith('/')) {
        res.writeHead(302, { location: `${PREFIX}/engine/ui/` })
        return res.end()
      }
      // The embedded page is same-origin HTML that the engine rewrites for this
      // mount; a POST from it is how the workspace reports a change, and the
      // published catalog has to follow.
      res.once('finish', () => {
        if (req.method === 'POST') void magpieModels?.refresh().catch(() => {})
      })
      const upstream = req.url.slice(PREFIX.length + '/engine/ui'.length) || '/'
      // The engine derives its visible mount from the plugin build's own path
      // (`/api/our-free-model/engine/ui/`). This console mounts the same UI at a
      // different prefix, so both the mount it should treat as its own and the
      // prefix it should emit are passed explicitly instead of guessed.
      const mount = `${PREFIX}/engine/ui/`
      await magpieEngine.proxy(req, res, upstream, { prefix: mount, mount })
      return
    } else if (pathname === `${PREFIX}/workbench` && method === 'GET' && workbench) {
      json(res, 200, { clients: workbench.clients(), accounts: subscriptions?.list() ?? [] })
    } else if (pathname.startsWith(`${PREFIX}/workbench/clients/`) && method === 'POST' && workbench) {
      const body = await readBody(req)
      const action = pathname.slice(`${PREFIX}/workbench/clients/`.length)
      if (action === 'save') json(res, 200, workbench.save(body))
      else if (action === 'launch') json(res, 200, await workbench.launch(body))
      else if (action === 'stop') json(res, 200, await workbench.stop(body))
      else throw fail(404, '客户端操作不存在')
    } else if (pathname === `${PREFIX}/library` && method === 'GET' && library) {
      json(res, 200, library.list())
    } else if (pathname === `${PREFIX}/routing` && method === 'GET' && routingManagement) {
      json(res, 200, routingManagement.list())
    } else if (pathname.startsWith(`${PREFIX}/routing/`) && method === 'POST' && routingManagement) {
      const action = pathname.slice(`${PREFIX}/routing/`.length)
      if (!['save', 'remove', 'preview'].includes(action)) throw fail(404, '路由组操作不存在')
      json(res, 200, routingManagement[action](await readBody(req, 128 * 1024)))
    } else if (pathname.startsWith(`${PREFIX}/library/`) && method === 'POST' && library) {
      const action = pathname.slice(`${PREFIX}/library/`.length)
      const actions = {
        'profiles/save': 'saveProfile', 'profiles/apply': 'applyProfile', 'profiles/remove': 'removeProfile',
        'resources/save': 'saveResource', 'resources/remove': 'removeResource',
      }
      const body = await readBody(req, 1024 * 1024 + 8192)
      if (!Object.hasOwn(actions, action)) throw fail(404, '资源操作不存在')
      json(res, 200, library[actions[action]](body))
    } else if (pathname === `${PREFIX}/providers` && method === 'GET' && providerManagement) {
      json(res, 200, providerManagement.list())
    } else if (pathname.startsWith(`${PREFIX}/providers/`) && method === 'POST' && providerManagement) {
      const action = pathname.slice(`${PREFIX}/providers/`.length)
      const body = await readBody(req, 128 * 1024)
      if (!['save', 'remove', 'test', 'discover'].includes(action)) throw fail(404, '供应商操作不存在')
      const controller = new AbortController()
      const abort = () => controller.abort()
      res.once('close', abort)
      try { json(res, 200, await providerManagement[action](body, controller.signal)) }
      finally { res.removeListener('close', abort) }
    } else if (pathname === `${PREFIX}/subscriptions` && method === 'GET' && subscriptions) {
      json(res, 200, { accounts: subscriptions.list() })
    } else if (pathname === `${PREFIX}/subscriptions/discover` && method === 'GET' && subscriptions) {
      const discovered = await subscriptions.discover()
      json(res, 200, { candidates: [
        { provider: 'codex', label: 'Codex / ChatGPT' },
        { provider: 'claude', label: 'Claude Code' },
        { provider: 'gemini', label: 'Gemini CLI' },
      ].map(row => ({ ...row, available: discovered.some(candidate => candidate.provider === row.provider) })) })
    } else if (pathname.startsWith(`${PREFIX}/subscriptions/`) && method === 'POST' && subscriptions) {
      const action = pathname.slice(`${PREFIX}/subscriptions/`.length)
      const body = await readBody(req, 1024 * 1024)
      if (action === 'import') await subscriptions.import(body)
      else if (action === 'import-local') await subscriptions.importLocal(body)
      else if (action === 'enabled') await subscriptions.setEnabled(body)
      else if (action === 'remove') await subscriptions.remove(body)
      else if (action === 'quota') {
        const controller = new AbortController()
        const abort = () => controller.abort()
        res.once('close', abort)
        try { await subscriptions.refreshQuota({ ...body, signal: controller.signal }) }
        finally { res.removeListener('close', abort) }
      } else throw fail(404, '订阅操作不存在')
      runtime.syncAggregateCatalog()
      json(res, 200, { accounts: subscriptions.list() })
    } else if (method === 'GET' && pathname === `${PREFIX}/feedback`) {
      json(res, 200, feedback.status())
    } else if (method === 'POST' && pathname.startsWith(`${PREFIX}/feedback/`)) {
      const action = pathname.slice(`${PREFIX}/feedback/`.length)
      const body = await readBody(req, 32 * 1024)
      if (action === 'start') json(res, 200, await feedback.start())
      else if (action === 'poll') json(res, 200, await feedback.poll(body))
      else if (action === 'signout') json(res, 200, feedback.signOut())
      else if (action === 'submit') json(res, 200, await feedback.submit(body))
      else throw fail(404, '反馈操作不存在')
    } else if (method === 'POST' && pathname === `${PREFIX}/channels/rpc` && channels) {
      // 渠道备份导入包含多账号凭据，仍限制总大小，但不能套设置表单的 16KB。
      const body = await readBody(req, 8 * 1024 * 1024)
      if (body.method === 'gateway.getEnabled' || body.method === 'gateway.setEnabled') {
        if (body.method === 'gateway.setEnabled') {
          if (typeof body.payload?.enabled !== 'boolean') throw fail(400, 'enabled 必须是布尔值')
          persist({ enabled: body.payload.enabled })
          await onSettingsChanged()
        }
        const base = new URL(info().baseUrl)
        json(res, 200, { ok: true, value: {
          enabled: stores.settings.get().enabled !== false, running: stores.settings.get().enabled !== false,
          blockedByEnv: false, address: { host: base.hostname, port: Number(base.port) },
          apiKey: { value: stores.settings.get().forwardKey, path: `${info().dataDir}/settings.json`, fromEnv: false },
          models: runtime.publicModelRows(), modelsSource: 'catalog',
        } })
      } else {
        const controller = new AbortController()
        const abort = () => controller.abort()
        res.once('close', abort)
        try { json(res, 200, await channels.rpc(body, controller.signal)) }
        finally { res.removeListener('close', abort) }
      }
    } else if (eac && pathname.startsWith(`${PREFIX}/eac/`)) {
      const params = new URL(req.url, 'http://localhost').searchParams
      const route = pathname.slice(PREFIX.length)
      let result
      if (method === 'GET' && route === '/eac/status') result = await eac.status()
      else if (method === 'GET' && route === '/eac/login/poll') result = await eac.poll(params.get('link') ?? '')
      else if (method === 'GET' && route === '/eac/pool') result = await eac.pool()
      else if (method === 'POST') {
        await readBody(req)
        if (route === '/eac/login/start') result = await eac.start()
        else if (route === '/eac/login/cancel') result = eac.cancel(params.get('link') ?? '')
        else if (route === '/eac/logout') result = await eac.logout()
      }
      if (result === undefined) throw fail(404, 'EAC 接口不存在')
      if (result.error) throw fail(502, result.error)
      if (result.ok === false) throw fail(500, '无法移除本地授权')
      json(res, 200, result)
    } else if (method === 'GET' && pathname === `${PREFIX}/disclaimer`) {
      json(res, 200, { ...DISCLAIMER, acknowledged: disclaimerAcknowledged(stores.settings.get()) })
    } else if (method === 'POST' && pathname === `${PREFIX}/disclaimer/ack`) {
      persist({ disclaimerAck: DISCLAIMER_VERSION })
      json(res, 200, { ok: true, acknowledged: true })
    } else if (method === 'POST' && pathname === `${PREFIX}/settings`) {
      const patch = validateSettings(await readBody(req))
      persist(patch)
      await onSettingsChanged()
      json(res, 200, { settings: managementSettings(stores.settings.get()), lan: info().lan })
    } else if (method === 'GET' && pathname === `${PREFIX}/lan/key`) {
      json(res, 200, { key: stores.settings.get().standaloneLanKey ?? '' })
    } else if (method === 'POST' && pathname === `${PREFIX}/lan/key/rotate`) {
      const body = await readBody(req)
      if (body.confirm !== true || Object.keys(body).length !== 1) throw fail(400, 'LAN key rotation requires only confirm: true')
      persist({ standaloneLanKey: generateKey() })
      json(res, 200, { key: stores.settings.get().standaloneLanKey })
    } else if (method === 'GET' && pathname === `${PREFIX}/key`) {
      json(res, 200, { key: stores.settings.get().forwardKey })
    } else if (method === 'POST' && pathname === `${PREFIX}/key/rotate`) {
      const body = await readBody(req)
      if (body.confirm !== true) throw fail(400, '请确认轮换 API Key')
      const id = cookie(req)
      persist({ forwardKey: generateKey() })
      // 仅当前管理会话保留；旧密钥与其他会话立即失效。
      const until = sessions.get(id)
      const privileged = privilegedSessions.has(id)
      sessions.clear()
      privilegedSessions.clear()
      if (until) sessions.set(id, until)
      if (until && privileged) privilegedSessions.add(id)
      bootstrap = null
      json(res, 200, { key: stores.settings.get().forwardKey })
    } else if (method === 'POST' && pathname === `${PREFIX}/models/refresh`) {
      const body = await readBody(req)
      if (body.probe !== undefined && typeof body.probe !== 'boolean') throw fail(400, 'probe 必须是布尔值')
      const { sources } = await runtime.refreshCatalog({ probe: body.probe === true, force: body.probe === true, report: true })
      json(res, 200, { ...summary(), sources })
    // ── credential migration (this adaptation) ──────────────────────────────
    //
    // The migration itself lives in `dsh-migrate.mjs` and is also reachable from
    // the CLI. These routes exist so the console can do it without a terminal.
    //
    // A successful import is applied to the *running* channel worker through its
    // own `backup.import` RPC, so the account pool reflects the new credentials
    // immediately instead of after a restart. When the worker is unavailable the
    // files are still written and the reply says so.
    } else if (method === 'POST' && pathname === `${PREFIX}/migrate/dsh`) {
      const body = await readBody(req)
      const dryRun = body.dryRun === true
      let dshHome
      try {
        dshHome = resolveDshHome({ dshHome: typeof body.dshHome === 'string' ? body.dshHome : undefined })
      } catch (error) { throw fail(400, `dsh 数据目录无效：${error.message}`) }
      let payload
      try {
        const credentials = readDshCredentials(dshHome)
        const state = readDshAccountState(dshHome)
        payload = buildBackupPayload({ refs: credentials.refs, state })
      } catch (error) {
        if (error instanceof MigrationError || error?.name === 'CredentialYamlError') throw fail(400, error.message)
        throw fail(500, `读取 dsh 数据目录失败：${error.message}`)
      }
      if (dryRun) {
        json(res, 200, {
          dryRun: true, source: dshHome,
          credentialCount: Object.keys(payload.credentials).length,
          accountCount: payload.accounts.length,
          skipped: payload.skipped,
        })
        return
      }
      const applied = await applyPayloadToRunningChannels(payload, body.replace === true)
      json(res, 200, {
        dryRun: false, source: dshHome,
        credentialCount: Object.keys(payload.credentials).length,
        accountCount: payload.accounts.length,
        skipped: payload.skipped,
        written: applied,
      })
    } else if (method === 'POST' && pathname === `${PREFIX}/migrate/import-backup`) {
      const body = await readBody(req, 8 * 1024 * 1024)
      if (body.backup === null || typeof body.backup !== 'object' || Array.isArray(body.backup)) {
        throw fail(400, '备份内容必须是 JSON 对象')
      }
      let payload
      try { payload = buildAndValidate(body.backup) } catch (error) {
        if (error instanceof MigrationError) throw fail(400, error.message)
        throw error
      }
      const applied = await applyPayloadToRunningChannels(payload, body.replace !== false)
      json(res, 200, {
        dryRun: false,
        credentialCount: Object.keys(payload.credentials).length,
        accountCount: payload.accounts.length,
        skipped: 0,
        written: applied,
      })
    } else if (method === 'POST' && pathname === `${PREFIX}/migrate/export`) {
      await readBody(req)
      // The export is written beside the data directory, never streamed into the
      // browser: a plaintext credential blob should not travel through a page.
      const directory = path.join(info().dataDir, 'backups')
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const target = path.join(directory, `ofm-backup-${stamp}.json`)
      const payload = exportBackup(info().dataDir)
      const temporary = `${target}.tmp`
      fs.writeFileSync(temporary, JSON.stringify(payload, null, 2), { mode: 0o600, flag: 'wx' })
      restrictPermissions(temporary)
      fs.renameSync(temporary, target)
      json(res, 200, {
        path: target,
        credentials: Object.keys(payload.credentials).length,
        accounts: payload.accounts.length,
      })
    } else if (method === 'POST' && pathname === `${PREFIX}/test`) {
      // One prompt, four protocols: this is the console's "does the wire work"
      // probe. It talks to the local inference listener over loopback HTTP, so it
      // exercises the exact surface a real client would use.
      const body = await readBody(req)
      if (stores.settings.get().enabled === false) throw fail(503, '推理服务已暂停，请先启用')
      if (typeof body.model !== 'string' || body.model === '' || body.model.length > 300) throw fail(400, '请选择有效模型')
      const protocol = typeof body.protocol === 'string' ? body.protocol : 'openai'
      if (!['openai', 'anthropic', 'gemini', 'ollama'].includes(protocol)) throw fail(400, '不支持的协议')
      const maxTokens = Number.isInteger(body.maxTokens) ? Math.max(16, Math.min(4096, body.maxTokens)) : 128
      const prompt = typeof body.prompt === 'string' && body.prompt !== '' ? body.prompt.slice(0, 8000) : 'ping'
      const controller = new AbortController()
      const abort = () => controller.abort()
      res.once('close', abort)
      try {
        const result = await runProtocolProbe({ base: info().baseUrl, key: stores.settings.get().forwardKey, protocol, model: body.model, prompt, maxTokens, signal: controller.signal })
        if (!controller.signal.aborted) json(res, 200, result)
      } catch (error) {
        if (!controller.signal.aborted) throw fail(502, String(error.message ?? '试算失败'))
      } finally {
        res.removeListener('close', abort)
      }
    } else if (method === 'POST' && pathname === `${PREFIX}/models/test`) {
      const body = await readBody(req)
      if (stores.settings.get().enabled === false) throw fail(503, '推理服务已暂停，请先在服务设置中启用')
      if (typeof body.model !== 'string' || body.model.length > 300) throw fail(400, '请选择有效模型')
      const controller = new AbortController()
      const abort = () => controller.abort()
      res.once('close', abort)
      try {
        const result = await runtime.testModel(body.model, undefined, { signal: controller.signal })
        if (!controller.signal.aborted) json(res, 200, result)
      } catch (error) {
        if (!controller.signal.aborted) throw fail(error.status === 404 ? 404 : error.code === 'TIMEOUT' ? 504 : 502, String(error.message ?? '模型测试失败'))
      } finally {
        res.removeListener('close', abort)
      }
    } else throw fail(404, '管理接口不存在')
  }

  return {
    setPort(port) { cookieName = `ofm_management_${port}` },
    get bootstrapFragment() { return bootstrap === null ? '' : `#login=${bootstrap.token}` },
    async handleRequest(req, res) {
      const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
      const asset = assets.get(pathname)
      const isApi = pathname === PREFIX || pathname.startsWith(`${PREFIX}/`)
      const pageAsset = ['GET', 'HEAD'].includes(req.method) && pluginAssetPath(pathname)
      if (!asset && !isApi) return false
      // 不接受插件专用 dsh-app Referer；独立管理只允许本页面的 HTTP 来源。
      const referer = req.headers.referer
      const origin = req.headers.origin
      const malformedSource = [referer, origin].some(value => value !== undefined && (
        typeof value !== 'string' || !value.startsWith('http://')
      ))
      if (closed || !cookieName) json(res, 503, { error: '服务正在停止或启动' })
      // A page asset is a capability URL: the sandboxed iframe has an opaque
      // origin and sends no session. It must be decided before both the
      // same-site source fence and the session check.
      else if (pageAsset) servePluginAsset(req, res, pathname)
      else if (malformedSource || structuralRejection(req) !== undefined) json(res, 403, { error: '管理接口仅允许本机同源访问' })
      else if (asset) {
        if (req.method !== 'GET' && req.method !== 'HEAD') json(res, 405, { error: '资源仅支持 GET 或 HEAD' })
        else {
          res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': asset.type })
          res.end(req.method === 'HEAD' ? undefined : asset.body)
        }
      } else {
        try { await route(req, res, pathname) } catch (error) {
          if (!res.destroyed && !res.headersSent) json(res, error.statusCode ?? 500, {
            error: error.statusCode ? error.message : '管理操作失败，请查看服务日志',
          })
        }
      }
      return true
    },
    dispose() { desktopUpdate.close(); closed = true; bootstrap = null; sessions.clear(); privilegedSessions.clear(); return workbench?.dispose() },
  }
}
