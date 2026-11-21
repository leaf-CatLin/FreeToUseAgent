/**
 * 桌面更新通道在本改编版中被关闭。
 *
 * 上游的 `desktop-update.mjs` 会从项目自己的 GitHub releases 下载桌面安装包并
 * 生成原生安装凭据。那意味着一次「检查更新」就能把本地代码换成上游版本，
 * 本次改编的独立服务、凭据迁移与多协议改动会被整体覆盖。
 *
 * 因此 `REPO` 为空：`supported` 恒为 false，`check()` 与 `download()` 都以
 * 明确的 503 拒绝，`selectDesktopRelease` / `installerChecksum` 这些纯函数仍然
 * 保留（它们本身不联网，也是「外部安装包地址一律拒绝」这条规则的证明）。
 *
 * 本套件验证的是这条不变量本身，以及管理接口在被拒绝时的形状。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { createDesktopUpdater, selectDesktopRelease, newerVersion, installerChecksum } from '../packages/standalone/desktop-update.mjs'

// `realpath` because macOS hands out a temp dir under `/var`, which is a symlink
// to `/private/var`.
const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-desktop-update-')))
const bytes = Buffer.from('官方安装包下载夹具，不执行安装')
const sha = crypto.createHash('sha256').update(bytes).digest('hex')

/** 一个记录所有出站请求的替身：任何下载尝试都会留下痕迹。 */
let requests = 0
const fixtureFetch = async () => {
  requests += 1
  return new Response('should never be reached', { status: 500 })
}

let checks = 0
const check = async (name, run) => {
  await run()
  console.log(`ok ${++checks} - ${name}`)
}

const release = version => ({
  tag_name: `v${version}`, draft: false, prerelease: false, body: '更新说明',
  assets: [
    { name: `Our.Free.Model_${version}_x64-setup.exe`, size: bytes.length,
      browser_download_url: `https://github.com/some-owner/some-repo/releases/download/v${version}/Our.Free.Model_${version}_x64-setup.exe` },
    { name: 'SHA256SUMS',
      browser_download_url: `https://github.com/some-owner/some-repo/releases/download/v${version}/SHA256SUMS` },
  ],
})

const manager = (name, extra = {}) => createDesktopUpdater({
  dataDir: path.join(scratch, name), version: '2.7.1', platform: 'win32', arch: 'x64',
  fetchImpl: fixtureFetch, ...extra,
})

try {
  await check('本改编版不支持任何桌面更新：supported 恒为 false', () => {
    const updater = manager('status')
    const status = updater.status()
    assert.equal(status.supported, false)
    assert.equal(status.available, false)
    assert.equal(status.latest, null)
  })

  await check('检查更新被拒绝，且不发出任何网络请求', () => {
    const updater = manager('check')
    const before = requests
    assert.throws(() => updater.check(), error => error.statusCode === 503)
    assert.equal(requests, before, 'a disabled channel must not reach the network')
  })

  await check('下载被拒绝，既不产生安装凭据也不写临时文件', async () => {
    const updater = manager('download')
    assert.throws(() => updater.download(), error => error.statusCode === 503)
    const directory = path.join(scratch, 'download', 'desktop-updates')
    assert.equal(fs.existsSync(path.join(directory, 'ready.json')), false)
    assert.equal(fs.existsSync(directory), false)
  })

  await check('关闭后的管理器仍然只报「不支持」，不泄露内部状态', () => {
    const updater = manager('closed')
    updater.close()
    // Both "this build has no channel" and "the manager is closed" answer 503;
    // the build's own refusal wins because it is checked first.
    assert.throws(() => updater.check(), error => error.statusCode === 503)
  })

  await check('纯函数保留：版本比较与外部安装包地址仍然被拒绝', () => {
    assert.equal(newerVersion('2.10.0', '2.9.9'), true)
    assert.equal(newerVersion('2.7.1', '2.7.1'), false)
    // With no release repository configured, *every* asset URL is "not this
    // project", so no release can ever be selected — not even a well-formed one.
    assert.throws(() => selectDesktopRelease([release('2.7.3')]), /不属于本项目/)
    // A differently-named asset never reaches the URL check; it is filtered by the
    // installer name first, so the answer is simply "nothing selectable".
    assert.equal(selectDesktopRelease([release('2.7.3')], 'arm64'), null)
    assert.equal(selectDesktopRelease([{ tag_name: 'v3.0.0', assets: [{ name: 'plugin.tgz' }] }]), null)
    const foreign = release('2.7.3')
    foreign.assets[0].browser_download_url = 'https://evil.invalid/setup.exe'
    assert.throws(() => selectDesktopRelease([foreign]), /官方发布源/)
    assert.throws(() => installerChecksum(`${sha}  setup.exe\n${sha}  setup.exe`, 'setup.exe'), /唯一/)
    assert.equal(installerChecksum(`${sha}  setup.exe\n`, 'setup.exe'), sha)
  })

  await check('管理接口：需要私有会话与同源，且检查更新同样被拒绝', async () => {
    const savedFetch = globalThis.fetch
    const previousVersion = process.env.OFM_DESKTOP_VERSION
    process.env.OFM_DESKTOP_VERSION = '2.7.1'
    // 只替换非回环流量：任何往上游取的请求都会把计数打上去，从而被断言发现。
    globalThis.fetch = (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      return ['127.0.0.1', 'localhost'].includes(url.hostname) ? savedFetch(input, init) : fixtureFetch(url.href, init)
    }
    let service
    try {
      const { startStandalone } = await import('../packages/standalone/service.mjs')
      service = await startStandalone({
        dataDir: path.join(scratch, 'http'), port: 0, refresh: false, logger: { warn() {} },
        desktopPlatform: 'win32', desktopArch: 'x64',
      })
      const api = '/api/management/desktop-update'
      const request = (route, options = {}) => savedFetch(service.url + route, {
        ...options,
        headers: { origin: service.url, 'content-type': 'application/json', ...options.headers },
      })

      assert.equal((await request(api)).status, 401, '未鉴权时拒绝')
      const key = JSON.parse(fs.readFileSync(service.keyFile)).forwardKey
      assert.equal((await request(api, { headers: { authorization: `Bearer ${key}` } })).status, 403, '本机 Key 不足以进入管理面')

      const token = new URLSearchParams(new URL(service.managementUrl).hash.slice(1)).get('login')
      const login = await request('/api/management/session', { method: 'POST', body: JSON.stringify({ bootstrapToken: token }) })
      assert.equal(login.status, 200)
      const cookie = login.headers.get('set-cookie').split(';')[0]

      const status = await (await request(api, { headers: { cookie } })).json()
      assert.equal(status.supported, false, '状态里明确写出不支持')
      assert.equal(status.available, false)

      assert.equal((await request(`${api}/check`, { method: 'POST', body: '{}', headers: { cookie, origin: 'https://foreign.invalid' } })).status, 403, '跨站被拒')
      assert.equal((await request(`${api}/install`, { method: 'POST', body: '{}', headers: { cookie } })).status, 404, '没有 HTTP 安装入口')

      const before = requests
      assert.equal((await request(`${api}/check`, { method: 'POST', body: '{}', headers: { cookie } })).status, 503, '检查更新被拒绝')
      assert.equal((await request(`${api}/download`, { method: 'POST', body: '{}', headers: { cookie } })).status, 503, '下载被拒绝')
      assert.equal(requests, before, '两条路径都没有触达网络')
    } finally {
      await service?.close()
      globalThis.fetch = savedFetch
      if (previousVersion === undefined) delete process.env.OFM_DESKTOP_VERSION
      else process.env.OFM_DESKTOP_VERSION = previousVersion
    }
  })

  console.log(`${checks}/${checks} 桌面更新通道关闭检查通过；全程未发出任何外网请求`)
} finally {
  assert.equal(path.dirname(scratch), fs.realpathSync(os.tmpdir()))
  fs.rmSync(scratch, { recursive: true, force: true })
}