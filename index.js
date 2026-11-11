/**
 * Host half of dsh-open-in-qoder.
 *
 * The shipped Open In... control owns a fixed, compile-time catalog of editors,
 * Git GUIs and terminals (the `@deepseek-ai/dsh-host-open-in-app` package), so a
 * deployment cannot add its own application through `cordis.patch.yml`. This row
 * fills that gap for one application: it resolves the local Qoder CN IDE bundle,
 * serves a two-route surface under `/open-in-qoder`, and launches the IDE on a
 * workspace directory the browser asks for.
 *
 * Routes (both fenced by the Host's own browser authentication):
 *
 * - `GET  /open-in-qoder/status` → `{ ok: true, value: { available, label, appPath, launcher } }`
 * - `POST /open-in-qoder/open`   → body `{ "path": "<absolute directory>" }`
 *
 * Resolution happens once per plugin life: a freshly installed IDE appears after
 * a DSH restart, which is the same rule the shipped catalog documents. The
 * browser half lives in `./client` and renders the header button.
 *
 * Every value a deployment may want to change is read from the row's `config`
 * (see README): `appName`, `appPath`, `label`, `cliRelativePath`, `useCli` and
 * `launchWatchMs`. No schema is exported on purpose, so the row accepts the
 * documented object without pulling a schema package into a linked checkout.
 */
import { spawn } from 'node:child_process'
import { accessSync, constants, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

/** Hard dependency: this row serves HTTP routes. */
export const inject = ['webServer']

/** Route family this row owns. */
const ROUTE = '/open-in-qoder'
/** Application looked up in the known application directories by default. */
const DEFAULT_APP_NAME = 'Qoder CN IDE'
/** In-bundle launcher the VS Code family ships (`code`, `qodercn`, ...). */
const DEFAULT_CLI_RELATIVE_PATH = 'Contents/Resources/app/bin/qodercn'
/** Human label shown in the header tooltip when nothing else is configured. */
const DEFAULT_LABEL = 'Qoder CN IDE'
/** Request body ceiling for the open route. */
const MAX_BODY_BYTES = 16 * 1024
/** Default early-failure watch window for one launch. */
const DEFAULT_LAUNCH_WATCH_MS = 1200

/** One JSON response with the shared envelope headers. */
function writeJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  })
  res.end(payload)
}

/** Reject a wrong method with the one method the route accepts. */
function methodNotAllowed(res, allow) {
  res.writeHead(405, { allow })
  res.end()
}

/** Collect a bounded request body as UTF-8 text; null past the ceiling. */
function readBoundedBody(req) {
  return new Promise((resolve) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.byteLength
      if (size > MAX_BODY_BYTES) {
        req.resume()
        resolve(null)
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', () => resolve(null))
  })
}

/** Parse the open-route body: a JSON object carrying one absolute string path. */
function parseOpenBody(text) {
  let body
  try {
    body = JSON.parse(text)
  } catch {
    return undefined
  }
  if (body === null || typeof body !== 'object') return undefined
  return typeof body.path === 'string' ? { path: body.path } : undefined
}

/** Whether one filesystem entry is an existing directory. */
function isDirectory(path) {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** Whether one filesystem entry is an existing executable file. */
function isExecutable(path) {
  try {
    if (!statSync(path).isFile()) return false
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** Accept only an absolute path that currently resolves to a directory. */
function admitDirectory(value) {
  if (typeof value !== 'string' || value === '' || !isAbsolute(value)) return undefined
  return isDirectory(value) ? value : undefined
}

/**
 * Inherited environment with credential-shaped variables dropped, so a launch
 * hands the IDE no API keys, tokens or SSH agent of this Host process.
 */
function scrubbedParentEnv() {
  const kept = {}
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    if (/KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|AUTH/i.test(name)) continue
    kept[name] = value
  }
  return kept
}

/** Read one optional string field from the row config. */
function stringField(config, name) {
  const value = config?.[name]
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** Normalize the row config into the facts resolution and launch need. */
function normalizeConfig(raw) {
  const config = raw !== null && typeof raw === 'object' ? raw : {}
  const appName = stringField(config, 'appName') ?? DEFAULT_APP_NAME
  const bundleName = appName.endsWith('.app') ? appName : `${appName}.app`
  const outputPath = stringField(config, 'appPath')
  const watch = config?.launchWatchMs
  return {
    bundleName,
    appPath: outputPath === undefined ? undefined : expandHome(outputPath),
    label: stringField(config, 'label') ?? DEFAULT_LABEL,
    cliRelativePath: stringField(config, 'cliRelativePath') ?? DEFAULT_CLI_RELATIVE_PATH,
    useCli: config?.useCli !== false,
    launchWatchMs: typeof watch === 'number' && Number.isFinite(watch) && watch > 0
      ? Math.min(watch, 10000)
      : DEFAULT_LAUNCH_WATCH_MS,
  }
}

/** Expand a leading `~/` against the Host home directory. */
function expandHome(path) {
  return path.startsWith('~/') ? join(homedir(), path.slice(2)) : path
}

/**
 * Resolve the application bundle: an explicit `appPath` wins, then the known
 * application directories the shipped catalog also trusts.
 * @param config - normalized row config.
 * @returns the bundle path, or undefined when the Host holds no such bundle.
 */
function resolveApplication(config) {
  if (config.appPath !== undefined) return isDirectory(config.appPath) ? config.appPath : undefined
  for (const root of ['/Applications', join(homedir(), 'Applications')]) {
    const candidate = join(root, config.bundleName)
    if (isDirectory(candidate)) return candidate
  }
  return undefined
}

/**
 * Pick the launcher for one resolved bundle: the in-bundle CLI when the row
 * allows it and the file is executable, otherwise the OS `open -a` verb (the
 * bundle declares a `public.folder` document type, so a directory is accepted).
 * @param appPath - resolved `.app` bundle path.
 * @param config - normalized row config.
 * @returns the launcher facts, or undefined when nothing can launch the app.
 */
function resolveLauncher(appPath, config) {
  const cli = join(appPath, config.cliRelativePath)
  if (config.useCli && isExecutable(cli)) return { kind: 'cli', command: cli, args: [] }
  return { kind: 'open', command: 'open', args: ['-a', appPath] }
}

/**
 * Launch one application on a directory, detached from this Host process.
 *
 * Success is decoupled from process exit: VS Code family launchers may stay in
 * the foreground for the queue they drive, so a launcher still running when the
 * watch window closes counts as launched and is left running. A spawn failure or
 * a nonzero exit inside the window is a real failure.
 * @param launcher - resolved launcher facts.
 * @param target - absolute directory to open.
 * @param watchMs - early-failure watch window.
 * @returns after the launch is counted successful.
 */
function launchDetached(launcher, target, watchMs) {
  return new Promise((resolve, reject) => {
    let settled = false
    let timer
    const child = spawn(launcher.command, [...launcher.args, target], {
      detached: true,
      stdio: 'ignore',
      env: scrubbedParentEnv(),
    })
    const settle = (finish) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.unref()
      finish()
    }
    timer = setTimeout(() => settle(resolve), watchMs)
    child.on('error', (error) => settle(() => reject(error)))
    child.on('exit', (code, signal) => {
      if (code === 0) {
        settle(resolve)
        return
      }
      settle(() => reject(new Error(`launcher exited with code ${String(code)}, signal ${String(signal)}`)))
    })
  })
}

/**
 * Mount the status and open routes.
 * @param ctx - Host context carrying `webServer`.
 * @param config - row config (see README).
 */
export function apply(ctx, config) {
  const resolved = normalizeConfig(config)
  const appPath = resolveApplication(resolved)
  const launcher = appPath === undefined ? undefined : resolveLauncher(appPath, resolved)
  const available = launcher !== undefined

  /**
   * Admit one request through the Host's browser-authentication gate — the same
   * `connection.requestRejection` check Connection applies to its own routes. A
   * deployment without Connection, or one whose check throws, is refused rather
   * than degraded to a weaker Host/Origin test.
   * @param req - incoming HTTP request.
   * @returns the status to reject with, or undefined when admitted.
   */
  function admissionRejection(req) {
    let connection
    try {
      connection = ctx.get('connection', false)
    } catch {
      connection = undefined
    }
    if (connection === null || connection === undefined
      || typeof connection.requestRejection !== 'function') {
      return 403
    }
    try {
      const rejection = connection.requestRejection({ headers: req.headers })
      return rejection === 401 || rejection === 403 ? rejection : undefined
    } catch {
      return 403
    }
  }

  /** Report an admission rejection in the shared envelope. */
  function rejectUnauthorized(res, status) {
    writeJson(res, status, {
      ok: false,
      error: {
        code: status === 401 ? 'unauthorized' : 'forbidden',
        message: 'browser authentication required',
      },
    })
  }

  /** Current resolution, as the browser reads it. */
  function statusValue() {
    return {
      available,
      label: resolved.label,
      appPath: appPath ?? null,
      launcher: launcher?.kind ?? null,
    }
  }

  /** `GET /open-in-qoder/status`. */
  async function statusHandler(req, res) {
    const rejection = admissionRejection(req)
    if (rejection !== undefined) {
      rejectUnauthorized(res, rejection)
      return
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      methodNotAllowed(res, 'GET, HEAD')
      return
    }
    writeJson(res, 200, { ok: true, value: statusValue() })
  }

  /** `POST /open-in-qoder/open`. */
  async function openHandler(req, res) {
    const rejection = admissionRejection(req)
    if (rejection !== undefined) {
      rejectUnauthorized(res, rejection)
      return
    }
    if (req.method !== 'POST') {
      methodNotAllowed(res, 'POST')
      return
    }
    const contentType = String(req.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase()
    if (contentType !== 'application/json') {
      writeJson(res, 415, {
        ok: false,
        error: { code: 'unsupported-media-type', message: 'content-type must be application/json' },
      })
      return
    }
    const text = await readBoundedBody(req)
    if (text === null) {
      writeJson(res, 413, {
        ok: false,
        error: { code: 'payload-too-large', message: `request body exceeds ${String(MAX_BODY_BYTES)} bytes` },
      })
      return
    }
    const body = parseOpenBody(text)
    if (body === undefined) {
      writeJson(res, 400, {
        ok: false,
        error: { code: 'bad-request', message: 'body must be {"path":"<absolute directory>"}' },
      })
      return
    }
    const target = admitDirectory(body.path)
    if (target === undefined) {
      writeJson(res, 400, {
        ok: false,
        error: { code: 'path-not-found', message: 'path must be an existing absolute directory' },
      })
      return
    }
    if (launcher === undefined) {
      writeJson(res, 503, {
        ok: false,
        error: { code: 'app-unavailable', message: `${resolved.bundleName} is not installed on this Host` },
      })
      return
    }
    try {
      await launchDetached(launcher, target, resolved.launchWatchMs)
    } catch (error) {
      writeJson(res, 502, {
        ok: false,
        error: { code: 'launch-failed', message: String(error?.message ?? error) },
      })
      return
    }
    writeJson(res, 200, {
      ok: true,
      value: { launched: true, path: target, appPath: appPath, launcher: launcher.kind },
    })
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE}/status`,
    handler: statusHandler,
  }), `open-in-qoder: GET ${ROUTE}/status`)

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE}/open`,
    handler: openHandler,
  }), `open-in-qoder: POST ${ROUTE}/open`)
}