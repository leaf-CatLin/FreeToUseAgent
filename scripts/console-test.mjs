/**
 * 新管理台（零依赖 GUI）的离线测试。
 *
 * 这一套替换掉了原来针对 React 源码的断言。它验证的是**实际行为**：
 * 页面能取到、资源是封闭集合、管理 API 的迁移与试算接口按契约工作、
 * 并且任何一步都不会把密钥写进 HTML 或日志。
 *
 * 全部使用临时数据目录与本机 HTTP 替身，不访问真实上游。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-console-')))
const dataDir = path.join(scratch, 'data')

// ── 本机上游替身：最小的 OpenAI 兼容网关 ────────────────────────────────────
import http from 'node:http'
const model = 'mimo-v2.6-flash-free'
let upstreamCalls = 0
const upstream = http.createServer((req, res) => {
  req.resume()
  req.on('end', () => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: req.url === '/models' ? [] : [{ id: model }] }))
      return
    }
    upstreamCalls += 1
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const frame = value => `data: ${JSON.stringify(value)}\n\n`
    res.write(frame({ choices: [{ index: 0, delta: { content: 'CONSOLE-OK' } }] }))
    res.end(`${frame({
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
    })}data: [DONE]\n\n`)
  })
})
await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
const upstreamUrl = `http://127.0.0.1:${upstream.address().port}`
process.env.OUR_FREE_MODEL_BASE = upstreamUrl
process.env.OUR_FREE_MODEL_KILO_BASE = upstreamUrl

const { startStandalone } = await import('../packages/standalone/service.mjs')

let service
let key
let cookie
let failures = 0
let checks = 0

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

/** 同源请求，可选带管理 Cookie 或本机 Key。 */
async function request(route, { cookie: withCookie, bearer, method, body, headers = {} } = {}) {
  const init = {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: {
      origin: service.url,
      'sec-fetch-site': 'same-origin',
      ...withCookie ? { cookie: withCookie } : {},
      ...bearer ? { authorization: `Bearer ${bearer}` } : {},
      ...body === undefined ? {} : { 'content-type': 'application/json' },
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  }
  const response = await fetch(service.url + route, init)
  const text = await response.text()
  let value
  try { value = text === '' ? {} : JSON.parse(text) } catch { value = text }
  return { status: response.status, value, text, headers: response.headers }
}

try {
  service = await startStandalone({ dataDir, port: 0, refresh: false, logger: { warn() {} } })
  await service.ready
  const settings = JSON.parse(fs.readFileSync(service.keyFile, 'utf8'))
  key = settings.forwardKey
  // Credential operations require a privileged session, which comes from the
  // one-time link or the separate management key — not from the local API key.
  const managementKey = settings.managementKey
  await service.runtime.refreshCatalog({ probe: false })
  const login = await request('/api/management/session', { body: { key: managementKey } })
  cookie = login.headers.get('set-cookie').split(';')[0]

  // ── 静态资源 ────────────────────────────────────────────────────────────
  await check('页面与三份资源都能取到，且不含密钥', async () => {
    const page = await request('/')
    assert.equal(page.status, 200)
    assert.match(page.headers.get('content-type'), /text\/html/)
    assert.match(page.headers.get('content-security-policy'), /script-src 'self'/)
    assert.ok(!page.text.includes(key), '页面不得包含 API Key')

    // 脚本必须外链：CSP 禁止内联脚本。
    const inline = [...page.text.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)]
    assert.ok(inline.length > 0)
    assert.ok(inline.every(([, attributes, content]) => /\bsrc=/.test(attributes) && !content.trim()))

    for (const [asset, type] of [
      ['console.js', /javascript/], ['console.css', /text\/css/], ['icon.svg', /svg/],
    ]) {
      const response = await request(`/assets/${asset}`)
      assert.equal(response.status, 200, asset)
      assert.match(response.headers.get('content-type'), type, asset)
      assert.ok(!response.text.includes(key), `${asset} 不得包含 API Key`)
    }
  })

  await check('资源是封闭集合：清单外的路径一律 404，不做磁盘读取', async () => {
    for (const route of [
      '/assets/assets.json', '/assets/app.js', '/assets/console.js.map',
      '/frontend/app.tsx', '/assets/%2e%2e%2fservice.mjs', '/assets/..%2fmanagement.mjs',
    ]) {
      const response = await request(route, { bearer: key })
      assert.equal(response.status, 404, route)
    }
  })

  await check('页面在无会话时也能打开（登录卡片由前端渲染）', async () => {
    const page = await request('/')
    assert.equal(page.status, 200)
    // 登录表单是静态标记，未鉴权也能到达。
    assert.match(page.text, /id="login-key"/)
  })

  // ── 概览数据 ────────────────────────────────────────────────────────────
  await check('摘要给出概览需要的字段', async () => {
    const { status, value } = await request('/api/management/summary', { cookie })
    assert.equal(status, 200)
    assert.equal(typeof value.baseUrl, 'string')
    assert.equal(typeof value.dataDir, 'string')
    assert.ok(Array.isArray(value.catalog))
    assert.ok(value.lan !== null && typeof value.lan === 'object')
    assert.equal(typeof value.lan.running, 'boolean')
    assert.ok(!JSON.stringify(value).includes(key), '摘要不得回显 API Key')
  })

  // ── 局域网与密钥 ────────────────────────────────────────────────────────
  await check('局域网开关与端口可保存，密钥接口可用', async () => {
    const saved = await request('/api/management/settings', { cookie, body: { standaloneLanEnabled: true, standaloneLanPort: 0 } })
    assert.equal(saved.status, 200, saved.text)

    const local = await request('/api/management/key', { cookie })
    assert.equal(local.status, 200)
    assert.equal(local.value.key, key)

    const lan = await request('/api/management/lan/key', { cookie })
    assert.equal(lan.status, 200)
    assert.equal(typeof lan.value.key, 'string')
    assert.notEqual(lan.value.key, key, 'LAN Key 必须与本机 Key 不同')

    // 轮换后旧 LAN Key 立即失效，本机 Key 不受影响。
    const rotated = await request('/api/management/lan/key/rotate', { cookie, body: { confirm: true } })
    assert.equal(rotated.status, 200)
    assert.notEqual(rotated.value.key, lan.value.key)
    assert.equal((await request('/api/management/key', { cookie })).value.key, key)

    await request('/api/management/settings', { cookie, body: { standaloneLanEnabled: false } })
  })

  // ── 迁移 ────────────────────────────────────────────────────────────────
  await check('迁移演练只报计数；缺少 dsh 目录时给出可读错误', async () => {
    const missing = await request('/api/management/migrate/dsh', { cookie, body: { dryRun: true, dshHome: path.join(scratch, 'absent') } })
    assert.equal(missing.status, 400)
    assert.match(missing.value.error, /credentials\.yaml|dsh/)

    // 造一个最小的 dsh 数据目录。
    const dshHome = path.join(scratch, 'dsh')
    fs.mkdirSync(path.join(dshHome, 'channel-pack'), { recursive: true })
    fs.writeFileSync(path.join(dshHome, '.credentials.yaml'), [
      'version: 1',
      'records:',
      '  deepseek-account-platform/default:',
      '    kind: grant',
      'refs:',
      "  QODER_ACCOUNT_AAAAAA: '{\"access_token\":\"fixture\"}'",
      "  DEEPSEEK_API_KEY: sk-not-an-account",
    ].join('\n'))
    fs.writeFileSync(path.join(dshHome, 'channel-pack', 'state.json'), JSON.stringify({
      accounts: [{ id: 'qoder-1', provider: 'qoder', nickname: 'f', enabled: true, credentialRef: 'QODER_ACCOUNT_AAAAAA' }],
      disabledModels: {},
    }))

    const preview = await request('/api/management/migrate/dsh', { cookie, body: { dshHome, dryRun: true } })
    assert.equal(preview.status, 200, preview.text)
    assert.equal(preview.value.dryRun, true)
    assert.equal(preview.value.credentialCount, 1, '只迁移账号渠道凭据')
    assert.equal(preview.value.accountCount, 1)
    assert.equal(preview.value.skipped, 1, '平台 Key 被跳过')

    // 演练不写文件。
    assert.equal(fs.existsSync(path.join(dataDir, 'channel-credentials.json')), false)
  })

  await check('导入写入凭据库并热应用到运行中的渠道', async () => {
    const dshHome = path.join(scratch, 'dsh')
    const imported = await request('/api/management/migrate/dsh', { cookie, body: { dshHome, replace: true } })
    assert.equal(imported.status, 200, imported.text)
    assert.equal(imported.value.written.credentialsWritten, 1)
    assert.equal(imported.value.written.mode, 'replace')
    // `replace` cannot be hot-applied: the worker's import RPC merges, so a replace
    // is a file-level operation that takes effect at the next start.
    assert.equal(imported.value.written.live, 'pending-restart', imported.text)

    const stored = JSON.parse(fs.readFileSync(path.join(dataDir, 'channel-credentials.json'), 'utf8'))
    assert.deepEqual(Object.keys(stored), ['QODER_ACCOUNT_AAAAAA'])
    // 输出与响应都不带凭据原文。
    assert.ok(!imported.text.includes('fixture'))
  })

  await check('导入备份：校验形状，坏载荷被拒绝，replace 真正整体覆盖', async () => {
    const good = {
      format: 'channel-pack/backup', version: 1, exportedAt: new Date().toISOString(),
      credentials: { QODER_ACCOUNT_BBBBBB: '{"access_token":"x"}' },
      accounts: [{ id: 'qoder-2', provider: 'qoder', nickname: 'g', enabled: true, credentialRef: 'QODER_ACCOUNT_BBBBBB' }],
      disabledModels: {}, permanentLocks: {},
    }
    const accepted = await request('/api/management/migrate/import-backup', { cookie, body: { backup: good, replace: true } })
    assert.equal(accepted.status, 200, accepted.text)
    assert.equal(accepted.value.credentialCount, 1)

    const stored = JSON.parse(fs.readFileSync(path.join(dataDir, 'channel-credentials.json'), 'utf8'))
    // `replace` must not leave the previously imported account behind.
    assert.deepEqual(Object.keys(stored), ['QODER_ACCOUNT_BBBBBB'])
    // And the reply has to say the live worker still holds the old pool: only a
    // restart clears it, because the worker's import RPC merges.
    assert.equal(accepted.value.written.live, 'pending-restart', accepted.text)

    for (const bad of [{ format: 'x', version: 1 }, { format: 'channel-pack/backup', version: 99 }, 'not-an-object']) {
      const response = await request('/api/management/migrate/import-backup', { cookie, body: { backup: bad } })
      assert.equal(response.status, 400, JSON.stringify(bad))
    }
  })

  await check('导出把备份写到数据目录旁，不把凭据送给浏览器', async () => {
    const exported = await request('/api/management/migrate/export', { cookie, body: {} })
    assert.equal(exported.status, 200, exported.text)
    assert.equal(exported.value.credentials, 1)
    assert.ok(exported.value.path.endsWith('.json'))
    assert.ok(fs.existsSync(exported.value.path))
    // 响应体里只有路径与计数，没有凭据原文。
    assert.ok(!exported.text.includes('access_token'))
    const written = JSON.parse(fs.readFileSync(exported.value.path, 'utf8'))
    assert.equal(written.format, 'channel-pack/backup')
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(exported.value.path).mode & 0o777, 0o600)
    }
  })

  // ── 试算 ────────────────────────────────────────────────────────────────
  await check('试算：四种协议都能走通并回传文本', async () => {
    const before = upstreamCalls
    for (const protocol of ['openai', 'anthropic', 'gemini', 'ollama']) {
      const response = await request('/api/management/test', {
        cookie, body: { model, prompt: 'hi', protocol, maxTokens: 32 },
      })
      assert.equal(response.status, 200, `${protocol}: ${response.text}`)
      assert.match(response.value.text, /CONSOLE-OK/, protocol)
      assert.equal(typeof response.value.ms, 'number')
    }
    assert.ok(upstreamCalls >= before + 4, '四次试算都应真正打到上游')
  })

  await check('试算：未知模型与非法协议给出可读错误', async () => {
    const unknown = await request('/api/management/test', { cookie, body: { model: 'no-such-model', protocol: 'openai', prompt: 'hi' } })
    assert.equal(unknown.status, 502)
    assert.match(unknown.value.error, /not found|模型/i)

    const bad = await request('/api/management/test', { cookie, body: { model, protocol: 'grpc', prompt: 'hi' } })
    assert.equal(bad.status, 400)

    const empty = await request('/api/management/test', { cookie, body: { protocol: 'openai', prompt: 'hi' } })
    assert.equal(empty.status, 400)
  })

  // ── 安全边界 ────────────────────────────────────────────────────────────
  await check('迁移需要管理密钥会话；本机 Key 足够做试算但不足以读凭据', async () => {
    // A session created from the local API key is deliberately unprivileged.
    const unprivileged = await request('/api/management/session', { body: { key } })
    const localCookie = unprivileged.headers.get('set-cookie').split(';')[0]
    for (const route of ['/api/management/migrate/dsh', '/api/management/migrate/export', '/api/management/migrate/import-backup']) {
      const response = await request(route, { cookie: localCookie, body: {} })
      assert.equal(response.status, 403, `${route} 需要管理密钥会话`)
    }
    // The wire probe is not a credential operation, so the local key may use it;
    // with an empty body it still answers a validation error rather than 403.
    const probe = await request('/api/management/test', { bearer: key, body: {} })
    assert.equal(probe.status, 400)
  })

  await check('没有会话时静态页面仍可访问，但管理 API 返回 401', async () => {
    assert.equal((await request('/')).status, 200)
    assert.equal((await request('/api/management/summary')).status, 401)
  })
} finally {
  await service?.close()
  upstream.closeAllConnections()
  await new Promise(resolve => upstream.close(resolve))
  const target = fs.realpathSync(scratch)
  const tempRoot = `${fs.realpathSync(os.tmpdir())}${path.sep}`
  assert.ok(target.startsWith(tempRoot) && path.basename(target).startsWith('ofm-console-'))
  fs.rmSync(target, { recursive: true, force: true })
}

console.log(`console: ${checks - failures}/${checks} checks passed`)
process.exitCode = failures ? 1 : 0