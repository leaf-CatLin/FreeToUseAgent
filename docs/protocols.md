# 多协议接入

本服务对外提供**四族协议**，共用同一批模型与同一份账号凭据。你不需要为不同客户端
准备不同的网关：把每个客户端指向它自己习惯的那个入口即可。

| 客户端类型 | 入口 | 鉴权 | 流式格式 |
| --- | --- | --- | --- |
| OpenAI SDK / Codex / 大多数工具 | `POST /v1/chat/completions` | `Authorization: Bearer` 或 `x-api-key` | SSE |
| OpenAI Responses API | `POST /v1/responses` | 同上 | SSE（命名事件） |
| Claude Code / Anthropic SDK | `POST /v1/messages`、`POST /v1/messages/count_tokens` | 同上 | SSE（命名事件） |
| Google SDK / Gemini 客户端 | `POST /v1beta/models/{model}:generateContent`、`:streamGenerateContent?alt=sse`、`:countTokens`、`GET /v1beta/models` | `x-goog-api-key`、`?key=` 或 Bearer | SSE |
| Ollama 客户端（Open WebUI、`ChatOllama`、Continue） | `GET /api/tags`、`POST /api/chat`、`POST /api/generate` | `Authorization: Bearer` 或 `x-api-key` | NDJSON |

`{model}` 是 `/v1/models` 里的 id。无前缀形式（`/chat/completions`、`/messages`）同样接受。

## 为什么这些协议是原生实现

三条 OpenAI/Anthropic/Gemini 线由 `src/forward.js`、`src/anthropic.js`、`src/gemini.js`
直接实现，Ollama 线由 `src/protocols/ollama.js` 实现。它们都遵循同一形状：
**纯函数 codec（请求 → 内部请求，chunk → 该协议的帧）+ 薄的监听器壳**。
好处是编解码可以脱离 socket 单测（`scripts/protocols-test.mjs`），且工具配对修复、
图像处理、思考档位与 token 优化对所有协议同时生效。

这不是一个把 OpenAI 请求翻译一次的 shim：Anthropic 调用方拿到 `thinking` 与
`tool_use` 块，Gemini 调用方拿到 `functionCall` 与 `usageMetadata`，Ollama 调用方拿到
对象形式的工具参数与 `prompt_eval_count`/`eval_count`。

## 语义映射

| 能力 | OpenAI | Anthropic | Gemini | Ollama |
| --- | --- | --- | --- | --- |
| 文本 | `choices[].delta.content` | `content_block_delta.text_delta` | `candidates[].content.parts[].text` | `message.content` |
| 思考 | `delta.reasoning` | `thinking` 块 | `part.thought` | `message.thinking` |
| 工具参数 | JSON 字符串、增量拼接 | `input` 对象 | `functionCall.args` 对象 | `function.arguments` 对象 |
| 图像输入 | data URL / URL | `image` 块 | `inlineData` | `images[]`（裸 base64） |
| 用量 | `usage` | `usage.input_tokens/output_tokens` | `usageMetadata` | `prompt_eval_count`/`eval_count` |
| 结束原因 | `finish_reason` | `stop_reason` | `finishReason` | `done_reason` |
| 错误 | `{error:{message,type,code}}` | `{type:'error',error:{...}}` | `{error:{code,message,status}}` | `{error: "..."}` |

思考强度统一落到内部的 `reasoningEffort`：Gemini 的
`generationConfig.thinkingConfig`、Ollama 的 `think`（`true`→`medium`，
`low|medium|high` 原样），OpenAI 的 `reasoning_effort`，Anthropic 的 `thinking`。

## 示例

```bash
KEY=...   # 本机：settings.json 的 forwardKey；局域网：LAN Key

# OpenAI
curl -s http://127.0.0.1:18900/v1/chat/completions \
  -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"model":"mimo-v2.6-flash-free","messages":[{"role":"user","content":"你好"}]}'

# Anthropic
curl -s http://127.0.0.1:18900/v1/messages \
  -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"model":"mimo-v2.6-flash-free","max_tokens":256,"messages":[{"role":"user","content":"你好"}]}'

# Gemini（注意 ?alt=sse）
curl -s "http://127.0.0.1:18900/v1beta/models/mimo-v2.6-flash-free:generateContent" \
  -H "x-goog-api-key: $KEY" -H 'content-type: application/json' \
  -d '{"contents":[{"role":"user","parts":[{"text":"你好"}]}]}'

# Ollama（NDJSON）
curl -s http://127.0.0.1:18900/api/chat \
  -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"model":"mimo-v2.6-flash-free","messages":[{"role":"user","content":"你好"}],"stream":true}'
```

Ollama 官方客户端默认连 `http://127.0.0.1:11434`；把它的地址改成
`http://<本机或局域网地址>:<端口>` 即可，无需再自建 Ollama。

## 能力边界（明确不做）

- **embeddings**：`/v1/embeddings`、`/api/embeddings`、`:embedContent` 一律 404。这批模型不下发
  向量，静默返回近似值是更坏的失败。
- **音频/语音**：404。
- **Ollama 的模型管理面**（`/api/pull`、`/api/push`、`/api/create`、`/api/delete`、`/api/copy`）：404。
  本服务不管理本地模型文件。
- **Gemini 的 `files`/`cachedContents`/`batch`**：404。
- **`/v1beta/models/{model}`（单模型 GET）**：本机可访问；局域网中继不转发它，因为
  客户端真正需要的是清单与生成。

## 局域网注意事项

1. **只有推理面上局域网**。管理台与 `/api/management/*` 依然只监听回环，局域网访问一律
   401/404。这是刻意保留的安全边界。
2. **LAN Key 是独立凭据**，与本机 `forwardKey` 互不通用；轮换 LAN Key 立即让旧 Key 失效，
   不影响本机管理。
3. **`?key=` 会被剥离**。Gemini 客户端可以把凭据放在查询串里，但它只用于本跳的鉴权；
   中继转发给回环监听器时会删掉它，并把凭据换成回环密钥，因此 Lan Key 不会出现在
   本机监听器的请求行或日志里。
4. **没有 TLS**。局域网是明文 HTTP。请只用可信网段，用防火墙限制来源；
   跨不可信网络请套 WireGuard/Tailscale 或反向代理。
5. 中继白名单是**精确路径集合 + 一条锚定的 Gemini 正则**；不做百分号解码，`..` 与
   `%2f` 直接不匹配，未列出的一律 404。

## 一致性验证（可选，需要 Python 3）

仓库附带一个只用标准库的四协议一致性客户端：

```bash
python tests/python/protocol_matrix.py --base http://127.0.0.1:18900 --key "$KEY"
```

它对着运行中的服务各发一次文本、一次工具调用、一次流式，断言语义等价。
没有 Python 时可跳过：这不在 `npm test` 的必需路径里。