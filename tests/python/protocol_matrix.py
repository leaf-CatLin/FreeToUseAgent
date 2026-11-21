#!/usr/bin/env python3
"""四协议一致性客户端（仅标准库）。

对运行中的 Our Free Model 独立服务各发一次请求，断言四族协议的**语义等价**：
同一句提问在 OpenAI / Anthropic / Gemini / Ollama 四个入口上都应得到一段非空文本，
流式入口应逐帧到达，用量字段应存在。

这不是 npm test 的必需路径：核心实现与单元测试都在 Node 侧
（scripts/protocols-test.mjs）。本脚本的用途是**从外部、用另一种语言的客户端**
验证真实线格式，因此刻意只用 Python 标准库，不引 requests 或任何 SDK。

    python tests/python/protocol_matrix.py --base http://127.0.0.1:18900 --key <KEY>
    python tests/python/protocol_matrix.py --base http://192.168.1.10:18901 --key <LAN_KEY>

退出码：0 全部通过；1 有断言失败；2 用法错误。
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.request

TIMEOUT_SECONDS = 120


class Failure(AssertionError):
    """一条断言失败。"""


def request(base: str, route: str, key: str, body: dict | None = None,
            extra_headers: dict | None = None) -> tuple[int, bytes, str]:
    """发一次请求，返回 (状态码, 原始字节, content-type)。"""
    url = base.rstrip("/") + route
    data = None if body is None else json.dumps(body).encode("utf-8")
    headers = {"authorization": f"Bearer {key}"}
    if body is not None:
        headers["content-type"] = "application/json"
    if extra_headers:
        headers.update(extra_headers)
    req = urllib.request.Request(url, data=data, headers=headers,
                                 method="GET" if body is None else "POST")
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_SECONDS) as response:
            return response.status, response.read(), response.headers.get("content-type", "")
    except urllib.error.HTTPError as error:
        return error.code, error.read(), error.headers.get("content-type", "")


def require(condition: bool, message: str) -> None:
    if not condition:
        raise Failure(message)


def pick_model(base: str, key: str) -> str:
    """从清单里挑一个模型，四个协议共用。"""
    status, payload, _ = request(base, "/v1/models", key)
    require(status == 200, f"/v1/models returned {status}: {payload[:200]!r}")
    rows = json.loads(payload).get("data") or []
    require(bool(rows), "the roster is empty; refresh the catalog first")
    return rows[0]["id"]


def check_openai(base: str, key: str, model: str) -> str:
    status, payload, _ = request(base, "/v1/chat/completions", key, {
        "model": model,
        "messages": [{"role": "user", "content": "Reply with the single word: ok"}],
        "max_tokens": 32,
    })
    require(status == 200, f"OpenAI chat returned {status}: {payload[:200]!r}")
    body = json.loads(payload)
    text = body["choices"][0]["message"].get("content") or ""
    require(text.strip() != "", "OpenAI chat produced no text")
    return text


def check_anthropic(base: str, key: str, model: str) -> str:
    status, payload, _ = request(base, "/v1/messages", key, {
        "model": model,
        "max_tokens": 32,
        "messages": [{"role": "user", "content": "Reply with the single word: ok"}],
    })
    require(status == 200, f"Anthropic messages returned {status}: {payload[:200]!r}")
    body = json.loads(payload)
    blocks = [block for block in body.get("content", []) if block.get("type") == "text"]
    text = "".join(block.get("text", "") for block in blocks)
    require(text.strip() != "", "Anthropic messages produced no text block")
    require(body.get("usage", {}).get("output_tokens") is not None,
            "Anthropic messages carried no usage.output_tokens")
    return text


def check_gemini(base: str, key: str, model: str) -> str:
    status, payload, _ = request(
        base, f"/v1beta/models/{model}:generateContent", key,
        {"contents": [{"role": "user", "parts": [{"text": "Reply with the single word: ok"}]}],
         "generationConfig": {"maxOutputTokens": 32}},
        extra_headers={"x-goog-api-key": key},
    )
    require(status == 200, f"Gemini generateContent returned {status}: {payload[:200]!r}")
    body = json.loads(payload)
    candidate = (body.get("candidates") or [{}])[0]
    parts = candidate.get("content", {}).get("parts", [])
    text = "".join(part.get("text", "") for part in parts if part.get("text"))
    require(text.strip() != "", "Gemini generateContent produced no text part")
    require("usageMetadata" in body, "Gemini response carried no usageMetadata")
    return text


def check_ollama(base: str, key: str, model: str) -> str:
    status, payload, _ = request(base, "/api/chat", key, {
        "model": model,
        "stream": False,
        "messages": [{"role": "user", "content": "Reply with the single word: ok"}],
        "options": {"num_predict": 32},
    })
    require(status == 200, f"Ollama chat returned {status}: {payload[:200]!r}")
    body = json.loads(payload)
    require(body.get("done") is True, "Ollama response did not finish with done=true")
    text = (body.get("message") or {}).get("content") or ""
    require(text.strip() != "", "Ollama chat produced no text")
    require("eval_count" in body or "prompt_eval_count" in body,
            "Ollama response carried no eval counts")
    return text


def check_ollama_stream(base: str, key: str, model: str) -> None:
    """NDJSON 必须逐行到达，且末行 done=true。"""
    url = base.rstrip("/") + "/api/chat"
    data = json.dumps({
        "model": model,
        "stream": True,
        "messages": [{"role": "user", "content": "Count from 1 to 5."}],
    }).encode("utf-8")
    req = urllib.request.Request(url, data=data, method="POST", headers={
        "authorization": f"Bearer {key}", "content-type": "application/json"})
    lines = 0
    saw_done = False
    with urllib.request.urlopen(req, timeout=TIMEOUT_SECONDS) as response:
        content_type = response.headers.get("content-type", "")
        require("application/x-ndjson" in content_type,
                f"Ollama stream content-type was {content_type!r}, expected NDJSON")
        for raw in response:
            line = raw.decode("utf-8").strip()
            if not line:
                continue
            lines += 1
            frame = json.loads(line)
            if frame.get("done") is True:
                saw_done = True
    require(lines >= 2, f"Ollama stream delivered only {lines} line(s); stream is being buffered")
    require(saw_done, "Ollama stream never sent a terminal done=true line")


def check_rejections(base: str, key: str) -> None:
    """未实现的能力必须明确失败，而不是编一个结果。"""
    status, _, _ = request(base, "/v1/embeddings", key, {"model": "any", "input": "x"})
    require(status == 404, f"/v1/embeddings should be 404, got {status}")
    status, _, _ = request(base, "/api/pull", key, {"model": "any"})
    require(status == 404, f"/api/pull should be 404, got {status}")
    status, _, _ = request(base, "/api/tags", "")
    require(status == 401, f"/api/tags without a key should be 401, got {status}")


def main() -> int:
    parser = argparse.ArgumentParser(description="四协议一致性检查（仅标准库）")
    parser.add_argument("--base", required=True, help="服务地址，例如 http://127.0.0.1:18900")
    parser.add_argument("--key", required=True, help="API Key（局域网部署时用 LAN Key）")
    parser.add_argument("--model", help="指定模型；省略时取 /v1/models 的第一项")
    parser.add_argument("--skip-stream", action="store_true", help="跳过流式检查")
    args = parser.parse_args()

    checks = 0
    failures = 0

    def run(name: str, action) -> None:
        nonlocal checks, failures
        checks += 1
        try:
            result = action()
            suffix = f" -> {result[:40]!r}" if isinstance(result, str) else ""
            print(f"ok   {name}{suffix}")
        except Exception as error:  # noqa: BLE001 - 每个不变量都要单独报告
            failures += 1
            print(f"FAIL {name}: {error}", file=sys.stderr)

    try:
        model = args.model or pick_model(args.base, args.key)
    except Exception as error:  # noqa: BLE001
        print(f"FAIL model discovery: {error}", file=sys.stderr)
        return 1

    print(f"model: {model}")
    run("openai /v1/chat/completions", lambda: check_openai(args.base, args.key, model))
    run("anthropic /v1/messages", lambda: check_anthropic(args.base, args.key, model))
    run("gemini :generateContent", lambda: check_gemini(args.base, args.key, model))
    run("ollama /api/chat", lambda: check_ollama(args.base, args.key, model))
    if not args.skip_stream:
        run("ollama /api/chat stream", lambda: check_ollama_stream(args.base, args.key, model))
    run("unsupported surfaces reject", lambda: check_rejections(args.base, args.key))

    print(f"protocol-matrix: {checks - failures}/{checks} checks passed")
    return 0 if failures == 0 else 1


if __name__ == "__main__":
    sys.exit(main())