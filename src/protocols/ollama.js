/**
 * Ollama 原生线格式编解码器。
 *
 * 仓库已经用 `src/anthropic.js` 处理 Anthropic Messages，用 `src/gemini.js`
 * 处理 Gemini v1beta，本模块补上第三族：Ollama 的 `/api/*`。三者都是
 * “纯函数 codec + 该协议的 SSE/NDJSON 帧渲染器”这一形状：解析后的请求进来，
 * 帧字符串或完整响应出去，不做 I/O，因此可以脱离 socket 单测。
 *
 * 请求翻译：
 *
 * | Ollama 请求 | 内部请求 |
 * | --- | --- |
 * | `messages[].role=user/assistant/system` | 同名字段原样保留 |
 * | `messages[].images[]`（base64，无 mime 前缀） | `{type:'image', attachment:{url:'data:…'}}` |
 * | `tools[].function.{name,description,parameters}` | 扁平 `{name, description, parameters}` |
 * | `options.num_predict` | `maxTokens` |
 * | `options.temperature` / `top_p` / `seed` / `stop` | 同名透传 |
 * | `think`（布尔或档位字符串） | `reasoningEffort` |
 * | `format: 'json'` | `responseFormat: 'json'` |
 *
 * 应答渲染（NDJSON，每条一行 JSON）：
 *
 * - 非流式：一整条 `{model, created_at, message:{role,content}, done:true, ...}`；
 * - 流式：按 chunk 逐行输出 `{model, created_at, message:{role:'assistant',content}, done:false}`，
 *   末行带 `done: true`、`done_reason` 与用量字段；
 * - 思考走 `message.thinking`（Ollama 的 reasoning 字段名）；
 * - 工具调用是 `message.tool_calls[]`，参数是**对象**（不是 JSON 字符串）；
 * - 错误是 `{error: string}`，HTTP 状态同时表达类别。
 *
 * `/api/tags` 用 OpenAI 模型行投影成 Ollama 的模型清单形状。
 *
 * @module src/protocols/ollama.js
 */

const OBJECT = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const invalid = message => { throw Object.assign(new Error(message), { statusCode: 400 }) }

/** 支持的 Ollama 路由。 */
export const OLLAMA_ROUTES = new Set(['/api/tags', '/api/chat', '/api/generate'])

/** Ollama 默认端口上的 `num_ctx` 缺省值；仅用于对齐语义，不参与计费。 */
const DEFAULT_NUM_CTX = 4096

export function ollamaError(res, code, message) {
  const payload = { error: String(message) }
  if (res.destroyed || res.writableEnded) return
  if (res.headersSent) {
    res.write(`${JSON.stringify(payload)}\n`)
    res.end()
    return
  }
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
  })
  res.end(JSON.stringify(payload))
}

/** 把 `created_at` 渲染成 Ollama 的 RFC3339（带纳秒位）格式。 */
function createdAt(now = new Date()) {
  const iso = now.toISOString()
  return `${iso.slice(0, -1)}000Z`
}

function modelName(row) {
  return String(row?.name ?? row?.id ?? '')
}

/** `GET /api/tags`：把内部模型行投影成 Ollama 的清单。 */
export function ollamaTags(rows) {
  return {
    models: rows.map(row => ({
      name: modelName(row),
      model: modelName(row),
      modified_at: createdAt(),
      size: 0,
      digest: '',
      details: {
        parent_model: '',
        format: 'unknown',
        family: '',
        families: [],
        parameter_size: '',
        quantization_level: '',
      },
      // 非 Ollama 官方字段：把上下文与能力带给客户端，不影响兼容性。
      ...(row.context_window ? { context_length: row.context_window } : {}),
      ...(row.vision === true ? { capabilities: ['completion', 'vision'] } : { capabilities: ['completion'] }),
    })),
  }
}

/**
 * 思考档位：Ollama 的 `think` 可以是布尔或 `low|medium|high`，
 * 内部用 `reasoningEffort` 表达。这里给出一条可逆映射。
 */
export function reasoningEffortFromThink(think) {
  if (think === false || think === undefined || think === null) return undefined
  if (think === true) return 'medium'
  const value = String(think).toLowerCase()
  if (value === 'low' || value === 'medium' || value === 'high') return value
  if (value === 'max' || value === 'maximal') return 'high'
  throw invalid('think must be a boolean or one of low, medium, high')
}

/** 把一条 Ollama 图片（裸 base64）包成附件 URL。 */
function imageAttachment(value) {
  if (typeof value !== 'string' || value === '') invalid('images entries must be non-empty base64 strings')
  // Ollama 不收 mimeType，按 PNG 兜底；base64 前缀足以让下游识别为图片。
  return { type: 'image', attachment: { url: `data:image/png;base64,${value}` } }
}

/** 把 Ollama 的一条消息转成内部消息。 */
function fromMessage(message) {
  if (!OBJECT(message)) invalid('messages entries must be objects')
  const role = message.role
  if (role !== 'system' && role !== 'user' && role !== 'assistant' && role !== 'tool') {
    invalid('message role must be system, user, assistant or tool')
  }
  if (role === 'tool') {
    return {
      role: 'tool',
      toolCallId: typeof message.tool_name === 'string' ? message.tool_name : '',
      content: typeof message.content === 'string' ? message.content : '',
    }
  }
  const parts = []
  const content = message.content
  if (typeof content === 'string' && content !== '') parts.push({ type: 'text', text: content })
  else if (content !== undefined && content !== '' && content !== null && typeof content !== 'string') {
    invalid('message content must be a string')
  }
  if (Array.isArray(message.images)) for (const image of message.images) parts.push(imageAttachment(image))
  if (Array.isArray(message.tool_calls)) {
    for (const call of message.tool_calls) {
      const fn = call?.function
      if (!OBJECT(fn) || typeof fn.name !== 'string' || fn.name === '') invalid('tool_calls entries need function.name')
      parts.push({
        type: 'tool-call',
        id: typeof call.id === 'string' ? call.id : undefined,
        name: fn.name,
        arguments: JSON.stringify(OBJECT(fn.arguments) ? fn.arguments : {}),
      })
    }
  }
  if (Array.isArray(message.thinking) || typeof message.thinking === 'string') {
    const text = Array.isArray(message.thinking) ? message.thinking.join('') : message.thinking
    if (text !== '') parts.unshift({ type: 'reasoning', text })
  }
  if (parts.length === 0) parts.push({ type: 'text', text: '' })
  return { role, content: parts }
}

/** 把 Ollama 工具声明转成内部扁平工具。 */
function fromTools(tools) {
  if (!Array.isArray(tools)) return []
  return tools.map(tool => {
    const fn = tool?.function
    if (!OBJECT(fn) || typeof fn.name !== 'string' || fn.name === '') invalid('tools entries need function.name')
    return {
      name: fn.name,
      ...(typeof fn.description === 'string' ? { description: fn.description } : {}),
      ...(OBJECT(fn.parameters) ? { parameters: fn.parameters } : {}),
    }
  })
}

function fromOptions(options, into) {
  if (options === undefined) return
  if (!OBJECT(options)) invalid('options must be an object')
  const allowed = new Set(['num_predict', 'temperature', 'top_p', 'top_k', 'seed', 'stop', 'num_ctx', 'repeat_penalty'])
  for (const key of Object.keys(options)) {
    if (!allowed.has(key)) invalid(`options.${key} is not supported`)
  }
  const numPredict = options.num_predict
  if (numPredict !== undefined) {
    if (!Number.isInteger(numPredict) || numPredict < -1) invalid('options.num_predict must be an integer >= -1')
    // -1 在 Ollama 表示“直到上下文用尽”，内部用省略 maxTokens 表达。
    if (numPredict >= 0) into.maxTokens = numPredict
  }
  for (const key of ['temperature', 'top_p', 'top_k', 'seed', 'repeat_penalty']) {
    if (options[key] === undefined) continue
    if (typeof options[key] !== 'number' || !Number.isFinite(options[key])) invalid(`options.${key} must be a finite number`)
    into[key === 'seed' ? 'seed' : key] = options[key]
  }
  if (options.stop !== undefined) {
    const stop = Array.isArray(options.stop) ? options.stop : [options.stop]
    for (const value of stop) if (typeof value !== 'string' || value === '') invalid('options.stop must be strings')
    into.stop = stop
  }
  if (options.num_ctx !== undefined && (!Number.isInteger(options.num_ctx) || options.num_ctx < 1)) {
    invalid('options.num_ctx must be a positive integer')
  }
}

/**
 * `POST /api/generate` 的 `prompt` 也接受文本，转成单轮 user 消息。
 */
function fromPrompt(body) {
  const prompt = body.prompt
  if (typeof prompt !== 'string') invalid('prompt must be a string')
  const parts = []
  if (body.system !== undefined) {
    if (typeof body.system !== 'string') invalid('system must be a string')
  }
  const messages = []
  if (typeof body.system === 'string' && body.system !== '') messages.push({ role: 'system', content: [{ type: 'text', text: body.system }] })
  parts.push({ type: 'text', text: prompt })
  if (Array.isArray(body.images)) for (const image of body.images) parts.push(imageAttachment(image))
  messages.push({ role: 'user', content: parts })
  return messages
}

/**
 * 解析 Ollama 请求体。
 *
 * @param {object} body - 已解析的 JSON 请求体
 * @param {'chat'|'generate'} route
 * @param {{model?: string}} [options]
 * @returns {object} 内部完成请求
 */
export function fromOllamaRequest(body, route, { model } = {}) {
  if (!OBJECT(body)) invalid('request body must be a JSON object')
  const name = model ?? body.model
  if (typeof name !== 'string' || name === '') invalid('model is required')
  const request = { model: name }
  if (route === 'chat') {
    if (!Array.isArray(body.messages) || body.messages.length === 0) invalid('messages must be a non-empty array')
    request.messages = body.messages.map(fromMessage)
  } else request.messages = fromPrompt(body)
  const tools = fromTools(body.tools)
  if (tools.length > 0) request.tools = tools
  fromOptions(body.options, request)
  const effort = reasoningEffortFromThink(body.think)
  if (effort !== undefined) request.reasoningEffort = effort
  if (body.format !== undefined) {
    if (body.format === 'json') request.responseFormat = 'json'
    else if (OBJECT(body.format)) {
      // Ollama 的结构化输出：把 JSON Schema 当作 responseFormat 直接下发。
      request.responseFormat = { type: 'json_schema', json_schema: { name: 'ollama-format', schema: body.format } }
    } else invalid('format must be "json" or a JSON schema object')
  }
  if (body.keep_alive !== undefined && typeof body.keep_alive !== 'number' && typeof body.keep_alive !== 'string') {
    invalid('keep_alive must be a number or string')
  }
  request.stream = body.stream === true
  return request
}

/** 把内部 usage 投影成 Ollama 的计数字段。 */
function addUsage(target, usage) {
  if (!OBJECT(usage)) return
  const prompt = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0)
  const completion = Number(usage.completion_tokens ?? usage.output_tokens ?? 0)
  if (Number.isFinite(prompt)) target.prompt_eval_count = prompt
  if (Number.isFinite(completion)) target.eval_count = completion
}

/** 内部结束原因 → Ollama 的 `done_reason`。 */
function doneReason(reason) {
  const kind = reason?.kind ?? reason
  if (kind === 'max-tokens' || kind === 'length') return 'length'
  if (kind === 'tool-calls' || kind === 'tool_use') return 'tool_calls'
  return 'stop'
}

/** 工具调用参数从 JSON 字符串还原成对象，Ollama 收对象。 */
function toolCallsOf(calls, seen) {
  const out = []
  for (const call of calls ?? []) {
    const key = call.id ?? `${call.name}:${call.arguments}`
    if (seen.has(key)) continue
    seen.add(key)
    let args = {}
    try { args = JSON.parse(call.arguments ?? '{}') } catch { args = {} }
    if (!OBJECT(args)) args = {}
    out.push({
      ...(call.id ? { id: call.id } : {}),
      function: { name: call.name ?? '', arguments: args },
    })
  }
  return out
}

/**
 * 完成一条 `message` 对象：非流式与流式末行共用。
 *
 * @param {{text: string, reasoning?: string, toolCalls?: Array<object>}} outcome
 */
export function ollamaMessage(outcome, { seen = new Set() } = {}) {
  const message = { role: 'assistant', content: outcome.text ?? '' }
  if (typeof outcome.reasoning === 'string' && outcome.reasoning !== '') message.thinking = outcome.reasoning
  const calls = toolCallsOf(outcome.toolCalls, seen)
  if (calls.length > 0) message.tool_calls = calls
  return message
}

/** 非流式完整响应。 */
export function ollamaResponse(model, outcome, { usage, finish } = {}) {
  const payload = {
    model,
    created_at: createdAt(),
    message: ollamaMessage(outcome),
    done: true,
    done_reason: doneReason(finish),
  }
  addUsage(payload, usage)
  return payload
}

/**
 * 流式帧渲染器。
 *
 * 每次调用返回该 chunk 对应的一行（不含换行符），或在没有可发送内容时返回
 * `undefined`。状态由调用方持有，因此同一实例可在 unit test 里逐 chunk 断言。
 */
export function createOllamaFrames(model) {
  const seen = new Set()
  let finished = false
  return {
    /**
     * @param {object} chunk - 内部完成 chunk
     * @param {{usage?: object, finish?: object}} [extra]
     * @returns {string|undefined}
     */
    render(chunk, extra = {}) {
      if (finished) return undefined
      if (chunk.type === 'text-delta' && chunk.text) {
        return JSON.stringify({ model, created_at: createdAt(), message: { role: 'assistant', content: chunk.text }, done: false })
      }
      if (chunk.type === 'reasoning-delta' && chunk.text) {
        return JSON.stringify({ model, created_at: createdAt(), message: { role: 'assistant', content: '', thinking: chunk.text }, done: false })
      }
      if (chunk.type === 'tool-call' || chunk.type === 'block-end') {
        const calls = toolCallsOf(chunk.type === 'tool-call' ? [chunk] : chunk.block?.type === 'tool-call' ? [chunk.block] : [], seen)
        if (calls.length === 0) return undefined
        return JSON.stringify({ model, created_at: createdAt(), message: { role: 'assistant', content: '', tool_calls: calls }, done: false })
      }
      if (chunk.type === 'finish' || chunk.type === 'aborted' || chunk.type === 'error') {
        finished = true
        const payload = {
          model,
          created_at: createdAt(),
          message: { role: 'assistant', content: '' },
          done: true,
          done_reason: doneReason(chunk.reason ?? chunk.type),
        }
        addUsage(payload, extra.usage ?? chunk.usage)
        if (chunk.type === 'error') payload.error = String(chunk.failure?.message ?? 'upstream failed').slice(0, 1024)
        return JSON.stringify(payload)
      }
      return undefined
    },
    /** 收尾帧：无论上游是否发过 `finish`，客户端都必须收到 `done: true`。 */
    finish(extra = {}) {
      if (finished) return undefined
      finished = true
      const payload = { model, created_at: createdAt(), message: { role: 'assistant', content: '' }, done: true, done_reason: doneReason(extra.finish) }
      addUsage(payload, extra.usage)
      return JSON.stringify(payload)
    },
    get done() { return finished },
  }
}

/** 供路由层使用的 `num_ctx` 缺省值（不参与推理参数校验）。 */
export const OLLAMA_DEFAULT_NUM_CTX = DEFAULT_NUM_CTX
