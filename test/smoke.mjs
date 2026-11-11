/**
 * Smoke test for the Host half of dsh-open-in-qoder.
 *
 * The real `apply()` runs against a minimal stand-in for the Cordis context and
 * the Web carrier: routes are captured as they register, request/response
 * objects are fakes, and the application bundle is a throwaway directory whose
 * CLI is a two-line shell script. No DSH process and no IDE are involved.
 *
 * Run with: node test/smoke.mjs
 */
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.js'

/** Build a fake `.app` bundle whose in-bundle CLI exits immediately. */
function fakeBundle() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-open-in-qoder-'))
  const appPath = join(root, 'Qoder CN IDE.app')
  const binDir = join(appPath, 'Contents/Resources/app/bin')
  mkdirSync(binDir, { recursive: true })
  const cli = join(binDir, 'qodercn')
  writeFileSync(cli, '#!/bin/sh\nexit 0\n', 'utf8')
  chmodSync(cli, 0o755)
  return { root, appPath }
}

/** Minimal Cordis context: effect/register/disposer plus the injected services. */
function createContext(options = {}) {
  const routes = new Map()
  const disposers = []
  return {
    routes,
    get(name, fallback) {
      if (name === 'connection') return options.connection
      return fallback
    },
    effect(effect) {
      const disposer = effect()
      disposers.push(disposer)
      return disposer
    },
    webServer: {
      register(route) {
        assert.equal(routes.has(route.path), false, `duplicate route ${route.path}`)
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
    },
    disposeAll() {
      for (const dispose of disposers.reverse()) dispose?.()
    },
  }
}

/** HTTP response stand-in capturing status, headers and the JSON body. */
function fakeResponse() {
  const res = {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      res.statusCode = status
      Object.assign(res.headers, headers ?? {})
    },
    end(chunk) {
      if (typeof chunk === 'string') res.body = chunk
    },
  }
  return res
}

/** HTTP request stand-in: an EventEmitter carrying method, headers and a body. */
function fakeRequest({ method = 'GET', headers = {}, body = undefined } = {}) {
  const req = new EventEmitter()
  req.method = method
  req.headers = headers
  req.resume = () => {}
  process.nextTick(() => {
    if (body !== undefined) req.emit('data', Buffer.from(body, 'utf8'))
    req.emit('end')
  })
  return req
}

/** Drive one captured route and resolve with the fake response. */
async function call(route, request) {
  const response = fakeResponse()
  await route.handler(request, response)
  return response
}

/** Parse the JSON envelope a route wrote. */
function envelope(response) {
  assert.notEqual(response.body, '', 'route wrote no body')
  return JSON.parse(response.body)
}

const admitted = { requestRejection: () => undefined }
const unauthorized = { requestRejection: () => 401 }
const forbidden = { requestRejection: () => 403 }

/** Mount the plugin once and hand back its context plus the routes. */
function mount(options = {}) {
  const connection = 'connection' in options ? options.connection : admitted
  const ctx = createContext({ connection })
  apply(ctx, options.config)
  return { ctx, status: ctx.routes.get('/open-in-qoder/status'), open: ctx.routes.get('/open-in-qoder/open') }
}

// --- routes register -------------------------------------------------------
{
  const { ctx, status, open } = mount({ config: { appPath: fakeBundle().appPath } })
  assert.ok(status, 'status route missing')
  assert.ok(open, 'open route missing')
  assert.equal(ctx.routes.size, 2)
  ctx.disposeAll()
  assert.equal(ctx.routes.size, 0, 'routes must be released with the plugin')
  console.log('ok - routes register and dispose')
}

// --- status reports a resolved bundle --------------------------------------
{
  const { appPath } = fakeBundle()
  const { status } = mount({ config: { appPath } })
  const response = await call(status, fakeRequest({ method: 'GET' }))
  assert.equal(response.statusCode, 200)
  const payload = envelope(response)
  assert.equal(payload.ok, true)
  assert.equal(payload.value.available, true)
  assert.equal(payload.value.launcher, 'cli')
  assert.equal(payload.value.appPath, appPath)
  assert.equal(payload.value.label, 'Qoder CN IDE')

  const head = await call(status, fakeRequest({ method: 'HEAD' }))
  assert.equal(head.statusCode, 200)

  const wrongMethod = await call(status, fakeRequest({ method: 'POST' }))
  assert.equal(wrongMethod.statusCode, 405)
  assert.equal(wrongMethod.headers.allow, 'GET, HEAD')
  console.log('ok - status resolves the bundle and rejects wrong methods')
}

// --- status reports a missing bundle without failing -----------------------
{
  const { status, open } = mount({ config: { appPath: join(tmpdir(), 'definitely-not-installed.app') } })
  const response = await call(status, fakeRequest({ method: 'GET' }))
  assert.equal(response.statusCode, 200)
  const payload = envelope(response)
  assert.equal(payload.value.available, false)
  assert.equal(payload.value.launcher, null)

  const refused = await call(open, fakeRequest({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: tmpdir() }),
  }))
  assert.equal(refused.statusCode, 503)
  assert.equal(envelope(refused).error.code, 'app-unavailable')
  console.log('ok - missing application is reported, not thrown')
}

// --- the trust fence -------------------------------------------------------
{
  const { status } = mount({ connection: unauthorized, config: { appPath: fakeBundle().appPath } })
  const response = await call(status, fakeRequest({ method: 'GET' }))
  assert.equal(response.statusCode, 401)
  assert.equal(envelope(response).error.code, 'unauthorized')
}
{
  const { status } = mount({ connection: forbidden, config: { appPath: fakeBundle().appPath } })
  const response = await call(status, fakeRequest({ method: 'GET' }))
  assert.equal(response.statusCode, 403)
}
{
  const { status } = mount({ connection: undefined, config: { appPath: fakeBundle().appPath } })
  const response = await call(status, fakeRequest({ method: 'GET' }))
  assert.equal(response.statusCode, 403, 'a Host without Connection must refuse, not degrade')
  console.log('ok - requests outside the Host browser authentication are refused')
}

// --- the open route --------------------------------------------------------
{
  const { appPath } = fakeBundle()
  const { open } = mount({ config: { appPath } })
  const target = mkdtempSync(join(tmpdir(), 'dsh-workspace-'))

  const response = await call(open, fakeRequest({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: target }),
  }))
  assert.equal(response.statusCode, 200)
  const payload = envelope(response)
  assert.equal(payload.ok, true)
  assert.equal(payload.value.launched, true)
  assert.equal(payload.value.path, target)
  assert.equal(payload.value.launcher, 'cli')

  const withCharset = await call(open, fakeRequest({
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ path: target }),
  }))
  assert.equal(withCharset.statusCode, 200)
  console.log('ok - open launches the configured application')
}

// --- open route input handling ---------------------------------------------
{
  const { open } = mount({ config: { appPath: fakeBundle().appPath } })
  const request = (overrides) => fakeRequest({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: tmpdir() }),
    ...overrides,
  })

  assert.equal((await call(open, request({ method: 'GET' }))).statusCode, 405)
  assert.equal((await call(open, request({ headers: { 'content-type': 'text/plain' } }))).statusCode, 415)
  assert.equal((await call(open, request({ body: 'not json' }))).statusCode, 400)
  assert.equal((await call(open, request({ body: JSON.stringify({ path: 'relative/dir' }) }))).statusCode, 400)
  assert.equal((await call(open, request({ body: JSON.stringify({ path: join(tmpdir(), 'nope-missing') }) }))).statusCode, 400)

  const oversized = await call(open, request({ body: JSON.stringify({ path: tmpdir(), pad: 'x'.repeat(20 * 1024) }) }))
  assert.equal(oversized.statusCode, 413)
  console.log('ok - open route validates method, media type, body shape and path')
}

// --- configurable label and bundle name ------------------------------------
{
  const { appPath } = fakeBundle()
  const { status } = mount({ config: { appPath, label: 'My IDE' } })
  const payload = envelope(await call(status, fakeRequest({ method: 'GET' })))
  assert.equal(payload.value.label, 'My IDE')
  console.log('ok - row config overrides the label')
}

console.log('\nall checks passed')