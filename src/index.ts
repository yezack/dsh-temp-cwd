/**
 * dsh-temp-cwd — host half (v14, host-centric lifecycle).
 *
 * All temp-session lifecycle DECISIONS live here, in the single host
 * process, so multiple UI windows can never race each other:
 *
 *  - POST /api/temp-cwd/start                 mkdir <root>/<ts> + marker,
 *                                             return { path }.
 *  - POST /api/temp-cwd/register?p=&w=&s=     remember { workspaceId,
 *                                             sessionId } for that path.
 *  - POST /api/temp-cwd/finalize?p=           first message: drop marker,
 *                                             registry.delete(workspace)
 *                                             (folder kept, session kept).
 *  - POST /api/temp-cwd/abandon?p=&s=         abandoned before first message:
 *                                             debounced 2s per path (single
 *                                             flight, finalize cancels) then
 *                                             archive session + delete
 *                                             workspace + remove the folder.
 *
 * A periodic sweep (30 s) cleans ledger entries whose marker is older than
 * 60 s and whose session/workspace is gone or archived — the safety net for
 * "user switched away and never came back" / crashed windows. Everything is
 * idempotent, so any number of windows may call the same endpoint.
 *
 * The host talks to the app through the injected `workspaceRegistry`
 * service (delete(id) keeps the directory and session logs; archiveSession
 * removes a session from every grouping surface) and does its own guarded
 * fs work (path traversal: direct child of root, bare 14-digit basename).
 */

import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import z from 'schemastery'

/** Stable cordis plugin name (host half). */
export const name = 'temp-cwd'

/** Services required before the routes can mount. */
export const inject = ['webServer', 'workspaceRegistry']

/** Marker file: presence authorizes whole-folder deletion on abandon. */
export const MARKER_FILE = '.TEMP_WORKSPACE'

/** Settings namespace for the plugin configuration card (shared with client). */
export const SETTINGS_NS = '@yezack/dsh-temp-cwd/settings'

/** Settings schema: an empty rootDirectory means "use the Config default". */
export const SettingsSchema = z.object({
  rootDirectory: z.string().default(''),
})

/** Abandon is debounced this long (ms) — duplicate calls coalesce. */
const ABANDON_DEBOUNCE_MS = 2000

/** Ledger entries whose marker is older than this get swept (ms). */
const SWEEP_AGE_MS = 60_000

/** Sweep tick interval (ms). */
const SWEEP_INTERVAL_MS = 30_000

/** Plugin config, validated by the same-named schemastery schema. */
export const Config = z.object({
  /** Root directory holding the timestamped temp workspaces. */
  rootDirectory: z.string().default(join(homedir(), 'Documents', 'dsh-workspaces')),
})

/** Local-time stamp: YYYYMMDDHHmmss, safe as a directory name. */
function timestamp(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

/**
 * A directory is a temp target only when it is a DIRECT child of `root` whose
 * basename is a bare 14-digit timestamp. Single traversal guard everywhere.
 */
function isTempDir(root: string, candidate: string): boolean {
  const base = basename(candidate)
  const rootSep = root.endsWith(sep) ? root : root + sep
  return (
    candidate.startsWith(rootSep) &&
    candidate.slice(rootSep.length).split(sep).length === 1 &&
    /^\d{14}$/.test(base)
  )
}

/** Read a query parameter from the request URL. */
function queryParam(req: any, key: string): string | null {
  try {
    const url = new URL(req.url ?? '', 'http://localhost')
    const value = url.searchParams.get(key)
    return typeof value === 'string' && value.length > 0 ? value : null
  } catch {
    return null
  }
}

/** Send a small JSON reply. */
function json(res: any, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

/** Marker file exists? */
function hasMarker(dir: string): boolean {
  try {
    return statSync(join(dir, MARKER_FILE)).isFile()
  } catch {
    return false
  }
}

/** Marker mtime, or 0 when absent. */
function markerMtime(dir: string): number {
  try {
    return statSync(join(dir, MARKER_FILE)).mtimeMs
  } catch {
    return 0
  }
}

/** Recursively remove a temp dir, but ONLY while its marker still exists. */
function removeDirIfMarkered(dir: string): boolean {
  if (!hasMarker(dir)) return false
  rmSync(dir, { recursive: true, force: true })
  return true
}

/** Drop the marker file (folder then belongs to the session). */
function dropMarker(dir: string): void {
  try {
    rmSync(join(dir, MARKER_FILE), { force: true })
  } catch {
    // ignore
  }
}

interface LedgerEntry {
  workspaceId: string | null
  sessionId: string | null
  createdAt: number
  abandonTimer: NodeJS.Timeout | null
}

/**
 * Mount the temp lifecycle routes and the sweep timer.
 * @param ctx - host plugin context (webServer + workspaceRegistry).
 * @param config - resolved plugin config.
 */
export function apply(ctx: any, config: any): void {
  // Root directory: Config default first, then live-overridable from the
  // plugin settings card (saved via the settings namespace below). Routes and
  // the sweep timer read the current value through this `let`.
  let root = resolve(config.rootDirectory)
  const registry = ctx.workspaceRegistry

  // Settings-backed override: when the user saves a rootDirectory in the
  // plugin settings page it replaces the default from the next request on.
  try {
    ctx.inject(['settings'], (settingsCtx: any) => {
      const scope = settingsCtx.settings.register(SETTINGS_NS, SettingsSchema, {
        base: { rootDirectory: '' },
      })
      const applyOverride = () => {
        const value = scope.getSnapshot?.().value ?? scope.getSnapshot?.()
        const dir = value?.rootDirectory
        if (typeof dir === 'string' && dir.trim().length > 0) {
          root = resolve(dir.trim())
          console.info('[temp-cwd] [host] temp root directory =', root)
        } else if (value !== void 0) {
          root = resolve(config.rootDirectory)
        }
      }
      applyOverride()
      if (typeof scope.on === 'function') scope.on('update', applyOverride)
      else if (typeof scope.subscribe === 'function') scope.subscribe(applyOverride)
    })
  } catch (err) {
    console.warn('[temp-cwd] [host] settings scope unavailable, using Config default:', err)
  }

  /** path → ledger entry (the single host-side source of truth). */
  const ledger = new Map<string, LedgerEntry>()

  const finalizeNow = (dir: string, entry: LedgerEntry | undefined) => {
    if (entry?.abandonTimer !== null && entry?.abandonTimer !== undefined) {
      clearTimeout(entry.abandonTimer)
      entry.abandonTimer = null
    }
    ledger.delete(dir)
    dropMarker(dir)
    const workspaceId = entry?.workspaceId
    if (workspaceId !== null && workspaceId !== undefined) {
      registry.delete(workspaceId).catch((err: any) => {
        if (!String(err?.message ?? err).includes('unknown')) {
          console.warn('[temp-cwd] finalize: workspace delete failed:', err)
        }
      })
    }
    console.info('[temp-cwd] [host] finalized (folder kept, workspace removed)', dir)
  }

  const abandonNow = (dir: string, entry: LedgerEntry | undefined) => {
    if (entry?.abandonTimer !== null && entry?.abandonTimer !== undefined) {
      clearTimeout(entry.abandonTimer)
      entry.abandonTimer = null
    }
    ledger.delete(dir)
    console.info('[temp-cwd] [host] abandon executing', dir)
    const job = async () => {
      // Archive the still-blank session first so it can never surface as a
      // lonely 未分组 row after the workspace is gone.
      const sessionId = entry?.sessionId
      if (sessionId !== null && sessionId !== undefined) {
        try {
          if (await registry.sessionKnown(sessionId)) {
            await registry.archiveSession(sessionId)
          }
        } catch (err) {
          console.warn('[temp-cwd] [host] abandon archive failed (ignored):', err)
        }
      }
      const workspaceId = entry?.workspaceId
      if (workspaceId !== null && workspaceId !== undefined) {
        try {
          await registry.delete(workspaceId)
        } catch (err) {
          if (!String(err?.message ?? err).includes('unknown')) {
            console.warn('[temp-cwd] [host] abandon workspace delete failed:', err)
          }
        }
      }
      removeDirIfMarkered(dir)
    }
    void job()
  }

  const scheduleAbandon = (dir: string, entry: LedgerEntry) => {
    if (entry.abandonTimer !== null) {
      // Debounce: a later abandon call just resets the timer.
      clearTimeout(entry.abandonTimer)
    }
    entry.abandonTimer = setTimeout(() => {
      entry.abandonTimer = null
      abandonNow(dir, ledger.get(dir))
    }, ABANDON_DEBOUNCE_MS)
  }

  const sweep = () => {
    const now = Date.now()
    for (const [dir, entry] of [...ledger.entries()]) {
      if (entry.abandonTimer !== null && entry.abandonTimer !== undefined) continue
      if (now - markerMtime(dir) < SWEEP_AGE_MS) continue
      console.info('[temp-cwd] [host] sweep cleaning stale temp', dir)
      abandonNow(dir, entry)
    }
  }

  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: '/api/temp-cwd/start',
      handler: (_req: any, res: any) => {
        const seg = timestamp()
        const dir = join(root, seg)
        if (!isTempDir(root, dir)) {
          json(res, 400, { error: 'invalid path' })
          return
        }
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, MARKER_FILE), new Date().toISOString(), 'utf8')
        json(res, 200, { path: dir })
      },
    }),
    'temp-cwd: start route',
  )

  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: '/api/temp-cwd/register',
      handler: (req: any, res: any) => {
        const dir = queryParam(req, 'p')
        if (dir === null || !isTempDir(root, dir) || !hasMarker(dir)) {
          json(res, 400, { error: 'invalid path or missing marker' })
          return
        }
        const workspaceId = queryParam(req, 'w')
        const sessionId = queryParam(req, 's')
        if (workspaceId === null || sessionId === null) {
          json(res, 400, { error: 'workspaceId and sessionId required' })
          return
        }
        const existing = ledger.get(dir)
        if (existing !== undefined) {
          existing.workspaceId = workspaceId
          existing.sessionId = sessionId
          if (existing.abandonTimer !== null && existing.abandonTimer !== undefined) {
            clearTimeout(existing.abandonTimer)
            existing.abandonTimer = null
          }
        } else {
          ledger.set(dir, {
            workspaceId,
            sessionId,
            createdAt: Date.now(),
            abandonTimer: null,
          })
        }
        console.info('[temp-cwd] [host] registered', { dir, workspaceId, sessionId })
        json(res, 200, { ok: true })
      },
    }),
    'temp-cwd: register route',
  )

  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: '/api/temp-cwd/finalize',
      handler: (req: any, res: any) => {
        const dir = queryParam(req, 'p')
        if (dir === null || !isTempDir(root, dir)) {
          json(res, 400, { error: 'invalid path' })
          return
        }
        finalizeNow(dir, ledger.get(dir))
        json(res, 200, { ok: true })
      },
    }),
    'temp-cwd: finalize route',
  )

  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: '/api/temp-cwd/abandon',
      handler: (req: any, res: any) => {
        const dir = queryParam(req, 'p')
        if (dir === null || !isTempDir(root, dir)) {
          json(res, 400, { error: 'invalid path' })
          return
        }
        const sessionId = queryParam(req, 's')
        const existing = ledger.get(dir)
        if (existing === undefined) {
          // Unknown to the ledger — an idempotent no-op (maybe already
          // finalized by another window).
          json(res, 200, { ok: true })
          return
        }
        if (sessionId !== null) existing.sessionId = sessionId
        scheduleAbandon(dir, existing)
        json(res, 200, { ok: true, debouncedMs: ABANDON_DEBOUNCE_MS })
      },
    }),
    'temp-cwd: abandon route',
  )

  // Boot cleanup (cheap, folder-only): remove leftover scaffold dirs from
  // earlier runs whose markers are older than a day. Workspace records are
  // intentionally NOT touched here — the client still hides temp-titled rows.
  try {
    for (const child of readdirSync(root)) {
      const dir = join(root, child)
      if (!isTempDir(root, dir)) continue
      if (markerMtime(dir) > 0 && Date.now() - markerMtime(dir) > 24 * 60 * 60 * 1000) {
        removeDirIfMarkered(dir)
      }
    }
  } catch {
    // root missing — fine.
  }

  const sweepTimer = setInterval(sweep, SWEEP_INTERVAL_MS)
  ctx.effect(
    () => () => {
      clearInterval(sweepTimer)
      for (const [, entry] of ledger) {
        if (entry.abandonTimer !== null && entry.abandonTimer !== undefined) {
          clearTimeout(entry.abandonTimer)
        }
      }
    },
    'temp-cwd: sweep timer',
  )
}
