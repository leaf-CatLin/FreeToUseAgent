<div align="center">
  <img src="icon.svg" alt="Our Free Model — standalone local inference service" width="120">

# Our Free Model (adapted local inference service)

[简体中文](README.md) | **English**

  <img alt="License" src="https://img.shields.io/badge/license-MIT-263146?style=flat-square">
  <img alt="Zero dependencies" src="https://img.shields.io/badge/dependencies-zero-4b6fff?style=flat-square">
  <img alt="No build step" src="https://img.shields.io/badge/build%20step-none-7da1de?style=flat-square">
  <img alt="Runtime" src="https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24-2f6f4f?style=flat-square">
  <img alt="Protocols" src="https://img.shields.io/badge/protocols-OpenAI%20%7C%20Anthropic%20%7C%20Gemini%20%7C%20Ollama-f0a441?style=flat-square">

</div>

> **Adapted from** [ebony-vinyl/dsh-our-free-model](https://github.com/ebony-vinyl/dsh-our-free-model) (MIT).
> This repository keeps upstream's ten free account channels and turns them into a
> **standalone local inference service you can run on a LAN**, with
> **credential migration from dsh** and **multi-protocol translation** on top.

---

## What this is

A local HTTP service that exposes ten free account channels (LobsterAI, Qoder, Qoder CN,
TRAE, Cline, Loomy, Raccoon, MiniMax, ZCode, Gemini) plus the anonymous free lane and the
Kilo free pool through **four protocol families**:

| Client | Endpoint | Streaming |
| --- | --- | --- |
| OpenAI SDK / Codex / most tools | `/v1/chat/completions`, `/v1/responses` | SSE |
| Claude Code / Anthropic SDK | `/v1/messages`, `/v1/messages/count_tokens` | SSE |
| Google SDK / Gemini clients | `/v1beta/models/{m}:generateContent`, `:streamGenerateContent`, `:countTokens` | SSE |
| Ollama clients (Open WebUI, `ChatOllama`, Continue) | `/api/tags`, `/api/chat`, `/api/generate` | NDJSON |

No account, no API key, no sign-up form: log a channel in once and every local tool can use it.

## The three additions

### 1. Run as a service, expose inference to the LAN

```powershell
node packages/standalone/cli.mjs --data-dir /srv/ofm/data --port 18900 --lan --lan-port 18901
```

- **The management console stays on loopback.** Only the inference relay binds `0.0.0.0`.
- The relay uses a **separate LAN key**, never the local API key; rotating it revokes the old one immediately.
- `--lan-key-out <file>` writes the LAN key with 0600 for headless servers, without printing it.
- Ready-made hosting: [deploy/README.md](deploy/README.md) — systemd, Windows Task Scheduler, Docker.

### 2. Export existing dsh credentials

```powershell
# Read the dsh data directory directly (dsh does not need to be running)
node packages/standalone/cli.mjs --import-dsh --dsh-home ~/.dsh --data-dir /srv/ofm/data

# Or produce a portable backup file, then import it on the target machine
node packages/standalone/cli.mjs --import-dsh --dsh-home ~/.dsh --out ./ofm-backup.json
node packages/standalone/cli.mjs --import-backup ./ofm-backup.json --data-dir /srv/ofm/data
```

- Migrates the ten account-channel credentials (`*_ACCOUNT_*`) and the account pool. dsh's
  platform keys, platform grants and EAC authorization are deliberately not exported.
- **Merges** by default; `--replace` overwrites. `--dry-run` reports counts only. Refused while the service runs.
- `.credentials.yaml` is read-only; stdout and logs carry **counts and paths only**, never credential values.
- Full details: [docs/standalone-dsh-migration.md](docs/standalone-dsh-migration.md) (Chinese).

### 3. Multi-protocol translation

All four wires are **native implementations**, not an OpenAI request translated once:
Anthropic callers get `thinking` and `tool_use` blocks, Gemini callers get `functionCall`
and `usageMetadata`, Ollama callers get tool arguments as objects plus
`prompt_eval_count` / `eval_count`.

Protocol matrix, semantic mapping and capability boundaries:
[docs/protocols.md](docs/protocols.md) (Chinese).

## Running

### Prerequisites

- **Node.js ≥ 22.19** (24 recommended). No dependencies to install — the service itself has zero npm
  dependencies; `npm ci` is only needed to run the test suite.
- Before first use, migrate credentials from a machine where dsh is already logged in
  ([§2](#2-export-existing-dsh-credentials)) or import a backup from the console's
  “Migrate credentials” tab; otherwise the channels are logged out.
- Network: channel login and model requests need to reach each upstream (Gemini needs Google).

### Start

```powershell
# From the repository root
node packages/standalone/cli.mjs
```

Startup prints:

1. A **one-time management link** (valid for 10 minutes; opening it logs you in. Afterwards you can
   sign in with the `managementKey` from `settings.json`);
2. The actual HTTP API address (default `http://127.0.0.1:18900`) and the data directory.

The data directory defaults to `~/.our-free-model` (`OFM_HOME` or `--data-dir` overrides it); the
port defaults to `18900` and moves automatically when taken. The first start sends no probe.

> To host it as a background service (systemd / Windows Task Scheduler / Docker),
> see [deploy/README.md](deploy/README.md).

### Local use

Point any OpenAI / Anthropic / Gemini / Ollama compatible client at `http://127.0.0.1:18900` and use
the local API key shown on the “LAN & keys” tab as the bearer key (model list on the
“Models & trial” tab).

### Expose to the LAN

```powershell
node packages/standalone/cli.mjs --lan --lan-port 18901
```

- The management console still listens on loopback only; only the inference relay binds `0.0.0.0`
  (use `--lan-port 0` to pick a free port automatically).
- LAN clients use a **separate LAN key** (never the local API key), shown and rotated on the
  “LAN & keys” tab; on headless servers use `--lan-key-out <file>` to write it with 0600, not stdout.
- The relay only carries inference paths (model list / chat / responses / messages / Gemini `v1beta` /
  Ollama `/api/*`); management endpoints and everything else return 404.
- No TLS: cross an untrusted network through WireGuard/Tailscale, or restrict sources with a firewall.

### Common options

| Option | Effect |
| --- | --- |
| `--port <port>` | Local listener port, default 18900 |
| `--data-dir <dir>` | Data directory |
| `--lan` / `--no-lan` | Enable/disable and persist the LAN inference relay |
| `--lan-port <port>` | Persisted relay port (0 = automatic) |
| `--lan-key-out <file>` | Write the LAN key with 0600 after start |
| `--import-dsh --dsh-home <dir>` | Migrate credentials from a dsh data directory, then exit (§2) |
| `--import-backup <file>` | Import a backup file, then exit (§2) |
| `--no-refresh` | Skip boot and periodic refresh; manual refresh and inference still work |
| `--help` | All options |

## Console

Open the management link from the console's four tabs:

- **Overview**: service info, local API address, LAN relay status, today's token usage
- **Migrate credentials**: import existing dsh logins (dry-run / overwrite / with ledger), export and import backups
- **LAN & keys**: LAN relay switch and port, view/copy/rotate the local API key and LAN key, connection info
- **Models & trial**: searchable model list with refresh, per-model trial across all four protocols

The management session is an HttpOnly + SameSite=Strict cookie bound to the one-time link that
created it; restarting the service or signing out invalidates it. To sign in manually, use the
`managementKey` from `settings.json`; signing in with the local API key (`forwardKey`) only allows
viewing and trials — reading or migrating credentials is refused.

## Security model

- **Management never leaves the machine**: the Host and same-origin fence require a loopback
  address, and the management API refuses cross-site sources.
- **Inference credentials are independently revocable**: a leaked LAN key costs one rotation,
  not the local API key.
- **No credentials in logs**: `?key=`, `x-api-key` and `x-goog-api-key` are stripped before
  forwarding; error text is redacted.
- **Sensitive files are 0600**, written through a temp file and an atomic rename.
- **No remote code replacement**: this adaptation ships no announcement channel and no update
  channel. With no pinned public key, every remote manifest fails signature verification.
  Updating means pulling this repository and restarting.
- **No TLS**: the LAN wire is plain HTTP with a bearer token. Keep it on a trusted network and
  restrict sources with a firewall; cross an untrusted network through WireGuard/Tailscale or a
  reverse proxy.

## Verification

```powershell
npm ci                          # only needed for tests and type checking
npm run test:dsh-migrate        # credential migration and the YAML subset parser (offline)
npm run test:protocols          # four protocols plus the LAN relay allowlist (offline)
npm run test                    # the full offline suite
```

Optional consistency check (Python 3, standard library only):

```powershell
python tests/python/protocol_matrix.py --base http://127.0.0.1:18900 --key <KEY>
```

## Layout

```
index.js / client.js / adapter/    dsh plugin form (host half and browser half)
src/                               plugin core: forward, trust, catalog, channel, vault…
src/protocols/ollama.js            new: native Ollama codec
packages/standalone/               standalone service: HTTP, console, channel worker, CLI
  dsh-migrate.mjs / yaml-refs.mjs  new: credential migration and .credentials.yaml parser
packages/standalone/console/       hand-written console (zero-dependency; no build step)
deploy/                            new: systemd / Windows / Docker hosting
docs/                              protocol matrix and migration docs
tests/python/                      optional four-protocol consistency client
vendor/                            absorbed channel pack and model workspace (own licenses)
```

## Known limitations

- The console does not support remote access and rejects a custom listener host.
- Channel logins depend on each upstream's own protocol; a breaking upstream change can disable a channel.
- The model roster follows upstream refreshes; offline, the cache is kept and `provider.status`
  reports `models.total: 0`.
- No embeddings, audio, Gemini `files`/`batch` or Ollama model-management endpoints — all 404.
- The console is a hand-written zero-dependency page (no build step); editing
  `packages/standalone/console/` and restarting the service is enough.
- Signs in on the console with the `managementKey` from `settings.json`; using the local API
  key (`forwardKey`) grants viewing and probes only, and credential reads/migrations are
  refused. The one-time management link printed at startup can do everything.

## Upstream and license

Adapted from [ebony-vinyl/dsh-our-free-model](https://github.com/ebony-vinyl/dsh-our-free-model),
keeping its MIT license and all channel implementations. Licenses for the components under
`vendor/` are stated in their own `LICENSE` and `NOTICE.md`, which take precedence.

Upstream's README, release pipeline, announcement data and community links are not part of this
repository's deliverables and have been removed.