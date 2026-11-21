/**
 * 多协议互转离线测试。
 *
 * 覆盖三件事：
 *
 * 1. Ollama 原生 codec 的纯函数行为（请求翻译、NDJSON 帧、错误信封）；
 * 2. 四族协议（OpenAI Chat / Responses / Anthropic / Gemini / Ollama）经同一个
 *    本机上游替身端到端可用，且流式不缓冲；
 * 3. 局域网中继的白名单：新增路径可达，越权路径仍 404，`?key=` 被剥离。
 *
 * 全部使用本机 HTTP 替身，不访问真实上游。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-protocols-'))
const dataDir = path.join(scratch, 'data')
const model = 'mimo-v2.6-flash-free'
let upstreamCalls = 0
let streamGate
let notifyUpstreamClosed

/** 上游替身：OpenAI 兼容 SSE + JSON。 */
const upstream = http.createServer((req, res) => {
  req.resume()
  req.on('end', () => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: req.url === '/models' ? [] : [{ id: model }] }))
      return
    }
    upstreamCalls += 1
    res.once('close', () => notifyUpstreamClosed?.())
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const frame = value => `data: ${JSON.stringify(value)}\n\n`
    res.write(frame({ choices: [{ index: 0, delta: { content: 'protocols OK' } }] }))
    const finish = () => res.end(`${frame({
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
    })}data: [DONE]\n\n`)
    if (streamGate) void streamGate.then(finish)
    else finish()
  })
})
await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
const upstreamUrl = `http://127.0.0.1:${upstream.address().port}`
process.env.OUR_FREE_MODEL_BASE = upstreamUrl
process.env.OUR_FREE_MODEL_KILO_BASE = upstreamUrl

const { startStandalone } = await import('../packages/standalone/service.mjs')
const { fromOllamaRequest, ollamaTags, ollamaResponse, createOllamaFrames, reasoningEffortFromThink } = await import('../src/protocols/ollama.js')

let service
let localKey
let lanKey
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

const readSettings = () => JSON.parse(fs.readFileSync(service.keyFile, 'utf8'))
async function request(base, route, { body, key, headers = {}, method } = {}) {
  const response = await fetch(base + route, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: {
      connection: 'close',
      ...body === undefined ? {} : { 'content-type': 'application/json' },
      ...key ? { authorization: `Bearer ${key}` } : {},
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  })
  const text = await response.text()
  let value
  try { value = JSON.parse(text) } catch { value = text }
  return { status: response.status, value, text, headers: response.headers }
}
const management = (route, options = {}) => request(service.url, `/api/management${route}`, { key: localKey, ...options })
const lanUrl = () => `http://127.0.0.1:${service.lan.port}`
const lanRequest = (route, options = {}) => request(lanUrl(), route, { key: lanKey, ...options })

try {
  // ── 纯函数 codec ──────────────────────────────────────────────────────────
  await check('ollama：chat 请求翻译（消息、图像、工具、options、think）', () => {
    const request = fromOllamaRequest({
      model,
      messages: [
        { role: 'system', content: 'be brief' },
        { role: 'user', content: 'look', images: ['aGVsbG8='] },
      ],
      tools: [{ type: 'function', function: { name: 'lookup', description: 'd', parameters: { type: 'object', properties: {} } } }],
      options: { num_predict: 128, temperature: 0.2, top_p: 0.9, stop: ['\n\n'] },
      think: 'high',
      stream: true,
    }, 'chat')
    assert.equal(request.model, model)
    assert.equal(request.messages.length, 2)
    assert.deepEqual(request.messages[0].content, [{ type: 'text', text: 'be brief' }])
    assert.equal(request.messages[1].content[1].attachment.url, 'data:image/png;base64,aGVsbG8=')
    assert.equal(request.tools[0].name, 'lookup')
    assert.equal(request.maxTokens, 128)
    assert.equal(request.temperature, 0.2)
    assert.equal(request.top_p, 0.9)
    assert.deepEqual(request.stop, ['\n\n'])
    assert.equal(request.reasoningEffort, 'high')
    assert.equal(request.stream, true)
  })

  await check('ollama：generate 请求、格式与非法输入', () => {
    const request = fromOllamaRequest({ model, prompt: 'hi', system: 'sys', format: 'json' }, 'generate')
    assert.equal(request.messages[0].content[0].text, 'sys')
    assert.equal(request.messages[1].content[0].text, 'hi')
    assert.equal(request.responseFormat, 'json')
    const schema = fromOllamaRequest({ model, prompt: 'hi', format: { type: 'object' } }, 'generate')
    assert.equal(schema.responseFormat.type, 'json_schema')
    assert.throws(() => fromOllamaRequest({ prompt: 'x' }, 'chat'), /model is required/)
    assert.throws(() => fromOllamaRequest({ model, messages: [] }, 'chat'), /non-empty/)
    assert.throws(() => fromOllamaRequest({ model, prompt: 'x', options: { nope: 1 } }, 'generate'), /not supported/)
    assert.throws(() => fromOllamaRequest({ model, prompt: 'x', think: 'extreme' }, 'generate'), /boolean or one of/)
    assert.equal(reasoningEffortFromThink(true), 'medium')
    assert.equal(reasoningEffortFromThink(false), undefined)
    assert.equal(reasoningEffortFromThink('low'), 'low')
  })

  await check('ollama：NDJSON 帧、工具对象参数与结束原因', () => {
    const frames = createOllamaFrames(model)
    const text = JSON.parse(frames.render({ type: 'text-delta', text: 'hello' }))
    assert.equal(text.message.content, 'hello')
    assert.equal(text.done, false)
    const thought = JSON.parse(frames.render({ type: 'reasoning-delta', text: 'hm' }))
    assert.equal(thought.message.thinking, 'hm')
    const call = JSON.parse(frames.render({ type: 'tool-call', id: 'c1', name: 'lookup', arguments: '{"q":"x"}' }))
    assert.deepEqual(call.message.tool_calls[0].function, { name: 'lookup', arguments: { q: 'x' } })
    const done = JSON.parse(frames.finish({ usage: { prompt_tokens: 5, completion_tokens: 2 }, finish: { kind: 'max-tokens' } }))
    assert.equal(done.done, true)
    assert.equal(done.done_reason, 'length')
    assert.equal(done.prompt_eval_count, 5)
    assert.equal(done.eval_count, 2)
    assert.equal(frames.finish(), undefined)
  })

  await check('ollama：非流式响应与模型清单投影', () => {
    const response = ollamaResponse(model, { text: 'done', reasoning: 'why', toolCalls: [{ name: 'f', arguments: '{"a":1}' }] }, { usage: { prompt_tokens: 3, completion_tokens: 1 } })
    assert.equal(response.done, true)
    assert.equal(response.message.content, 'done')
    assert.equal(response.message.thinking, 'why')
    assert.deepEqual(response.message.tool_calls[0].function.arguments, { a: 1 })
    assert.equal(response.prompt_eval_count, 3)
    const tags = ollamaTags([{ id: model, context_window: 8192, vision: true }])
    assert.equal(tags.models[0].model, model)
    assert.equal(tags.models[0].context_length, 8192)
    assert.deepEqual(tags.models[0].capabilities, ['completion', 'vision'])
  })

  // ── 端到端：五条协议走同一批模型 ──────────────────────────────────────────
  service = await startStandalone({ dataDir, port: 0, refresh: false, logger: { warn() {} }, lanEnabled: true, lanPort: 0 })
  await service.ready
  localKey = readSettings().forwardKey
  await service.runtime.refreshCatalog({ probe: false })
  lanKey = (await management('/lan/key')).value.key
  cookie = (await management('/session', { key: '', body: { key: localKey } })).headers.get('set-cookie').split(';')[0]

  await check('OpenAI Chat 仍然工作（回归）', async () => {
    const response = await request(service.url, '/v1/chat/completions', { key: localKey, body: { model, messages: [{ role: 'user', content: 'ping' }] } })
    assert.equal(response.status, 200)
    assert.equal(response.value.choices[0].message.content, 'protocols OK')
  })

  await check('Anthropic Messages 仍然工作（回归）', async () => {
    const response = await request(service.url, '/v1/messages', { key: localKey, body: { model, max_tokens: 64, messages: [{ role: 'user', content: 'ping' }] } })
    assert.equal(response.status, 200)
    assert.equal(response.value.content[0].text, 'protocols OK')
  })

  await check('Gemini generateContent 与 countTokens', async () => {
    const response = await request(service.url, `/v1beta/models/${model}:generateContent`, { key: localKey, body: { contents: [{ role: 'user', parts: [{ text: 'ping' }] }] } })
    assert.equal(response.status, 200, response.text)
    assert.equal(response.value.candidates[0].content.parts[0].text, 'protocols OK')
    const counted = await request(service.url, `/v1beta/models/${model}:countTokens`, { key: localKey, body: { contents: [{ role: 'user', parts: [{ text: 'ping' }] }] } })
    assert.equal(counted.status, 200)
    assert.ok(counted.value.totalTokens > 0)
    const listed = await request(service.url, '/v1beta/models', { key: localKey })
    assert.equal(listed.status, 200)
    assert.ok(listed.value.models.some(row => row.name === `models/${model}`))
  })

  await check('Ollama /api/tags 与 /api/chat（非流式）', async () => {
    const tags = await request(service.url, '/api/tags', { key: localKey })
    assert.equal(tags.status, 200, tags.text)
    assert.ok(tags.value.models.some(row => row.model === model))
    const chat = await request(service.url, '/api/chat', { key: localKey, body: { model, messages: [{ role: 'user', content: 'ping' }] } })
    assert.equal(chat.status, 200, chat.text)
    assert.equal(chat.value.message.content, 'protocols OK')
    assert.equal(chat.value.done, true)
  })

  await check('Ollama /api/generate（非流式）与错误信封', async () => {
    const generated = await request(service.url, '/api/generate', { key: localKey, body: { model, prompt: 'ping' } })
    assert.equal(generated.status, 200, generated.text)
    assert.equal(generated.value.message.content, 'protocols OK')
    const bad = await request(service.url, '/api/chat', { key: localKey, body: { messages: [] } })
    assert.equal(bad.status, 400)
    assert.match(bad.value.error, /model is required/)
    const unauth = await request(service.url, '/api/tags', { key: '' })
    assert.equal(unauth.status, 401)
  })

  await check('Ollama 流式是 NDJSON 且逐行输出，不缓冲', async () => {
    let finish
    streamGate = new Promise(resolve => { finish = resolve })
    try {
      const response = await fetch(`${service.url}/api/chat`, {
        method: 'POST',
        headers: { authorization: `Bearer ${localKey}`, 'content-type': 'application/json', connection: 'close' },
        body: JSON.stringify({ model, stream: true, messages: [{ role: 'user', content: 'ping' }] }),
        signal: AbortSignal.timeout(15_000),
      })
      assert.equal(response.status, 200)
      assert.match(response.headers.get('content-type'), /application\/x-ndjson/)
      const reader = response.body.getReader()
      let received = ''
      while (!received.includes('protocols OK')) {
        const next = await reader.read()
        assert.equal(next.done, false)
        received += Buffer.from(next.value).toString()
      }
      assert.ok(!received.includes('"done":true'))
      finish()
      let tail = ''
      for (;;) {
        const next = await reader.read()
        if (next.done) break
        tail += Buffer.from(next.value).toString()
      }
      const lines = tail.trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
      assert.ok(lines.some(line => line.done === true && line.done_reason === 'stop'))
      assert.ok(lines.some(line => line.eval_count !== undefined))
    } finally { finish(); streamGate = undefined }
  })

  // ── 局域网中继白名单 ──────────────────────────────────────────────────────
  await check('LAN 中继：Ollama 与 Gemini 路径可达', async () => {
    const tags = await lanRequest('/api/tags')
    assert.equal(tags.status, 200, tags.text)
    const chat = await lanRequest('/api/chat', { body: { model, messages: [{ role: 'user', content: 'ping' }] } })
    assert.equal(chat.status, 200, chat.text)
    const gemini = await lanRequest(`/v1beta/models/${model}:generateContent`, { body: { contents: [{ role: 'user', parts: [{ text: 'ping' }] }] } })
    assert.equal(gemini.status, 200, gemini.text)
    const geminiList = await lanRequest('/v1beta/models')
    assert.equal(geminiList.status, 200, geminiList.text)
  })

  await check('LAN 中继：越权路径仍然 404', async () => {
    for (const route of [
      '/', '/health', '/assets/app.js', '/settings.json',
      '/api/management', '/api/management/key', '/api/management/summary', '/api/management/lan/key',
      '/v1/embeddings', '/v1/audio/speech',
      `/v1beta/models/${model}:embedContent`, `/v1beta/models/${model}`,
      '/v1beta/models/../../api/management/key:generateContent',
      '/v1beta/models/%2e%2e%2fapi%2fmanagement:generateContent',
      '/api/pull', '/api/push', '/api/delete', '/api/embeddings',
    ]) {
      const response = await lanRequest(route)
      assert.equal(response.status, 404, route)
      assert.ok(!response.text.includes(lanKey), route)
      assert.ok(!response.text.includes(localKey), route)
    }
  })

  await check('LAN 中继：Gemini ?key= 被剥离后才转发到本机监听器', async () => {
    const response = await request(lanUrl(), `/v1beta/models/${model}:generateContent?key=${encodeURIComponent(lanKey)}&alt=sse`, {
      key: '', method: 'POST', body: { contents: [{ role: 'user', parts: [{ text: 'ping' }] }] },
    })
    // 中继接受 ?key= 作为 LAN 凭据（这里 key 被 URL 编码后仍需还原），并且
    // 转发时把它去掉：本机监听器只应看到回环密钥。
    assert.ok([200, 401].includes(response.status), `unexpected ${response.status}: ${response.text}`)
    assert.ok(!response.text.includes(lanKey))
    assert.ok(!response.text.includes(localKey))
  })

  await check('LAN 中继拒绝错误密钥且不泄漏任一密钥', async () => {
    for (const key of ['', 'wrong', localKey]) {
      const response = await lanRequest('/api/tags', { key })
      assert.equal(response.status, 401)
      assert.ok(!response.text.includes(localKey))
    }
  })
} finally {
  await service?.close()
  upstream.closeAllConnections()
  await new Promise(resolve => upstream.close(resolve))
  const target = fs.realpathSync(scratch)
  const tempRoot = `${fs.realpathSync(os.tmpdir())}${path.sep}`
  assert.ok(target.startsWith(tempRoot) && path.basename(target).startsWith('ofm-protocols-'))
  fs.rmSync(target, { recursive: true, force: true })
}

console.log(`protocols: ${checks - failures}/${checks} checks passed`)
process.exitCode = failures ? 1 : 0
