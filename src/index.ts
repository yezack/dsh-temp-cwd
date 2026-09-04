/**
 * dsh-temp-cwd — host half.
 *
 * Exposes the filesystem side of a temp workspace lifecycle:
 *
 *  - POST /api/temp-cwd/mkdir           create <root>/<YYYYMMDDHHmmss> and
 *                                       write a .TEMP_WORKSPACE marker inside;
 *                                       returns { path }.
 *  - POST /api/temp-cwd/remove-dir      delete that directory (recursively)
 *                                       ONLY while it still carries the
 *                                       .TEMP_WORKSPACE marker — a marker means
 *                                       "abandoned temp scaffold, safe to
 *                                       remove entirely". No marker → 409.
 *  - POST /api/temp-cwd/remove-marker   drop the marker once the conversation
 *                                       actually started (first message); the
 *                                       folder then belongs to the session and
 *                                       is never deleted by this plugin.
 *
 * The browser half (./client) calls mkdir, adopts the folder as a workspace,
 * opens a session in it, and later asks for remove-dir (abandoned before the
 * first message) or remove-marker (used). Path traversal is guarded: every
 * accepted directory must be a direct child of the configured root whose
 * basename is a bare 14-digit local timestamp.
 */

import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import z from 'schemastery'

/** Stable cordis plugin name (host half). */
export const name = 'temp-cwd'

/** Services required before the routes can mount. */
export const inject = ['webServer']

/** Marker file: presence authorizes whole-folder deletion on abandon. */
export const MARKER_FILE = '.TEMP_WORKSPACE'

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
 * basename is a bare 14-digit timestamp. This is the single traversal guard
 * shared by mkdir/remove-dir/remove-marker.
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

/** Read the `p` query parameter (client sends the absolute directory path). */
function pathParam(req: any): string | null {
  try {
    const url = new URL(req.url ?? '', 'http://localhost')
    const p = url.searchParams.get('p')
    return typeof p === 'string' && p.length > 0 ? p : null
  } catch {
    return null
  }
}

/** Send a small JSON reply. */
function json(res: any, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

/**
 * Mount the mkdir / remove-dir / remove-marker routes.
 * @param ctx - host plugin context carrying webServer.
 * @param config - resolved plugin config (schema defaults applied by the loader).
 */
export function apply(ctx: any, config: any): void {
  const root = resolve(config.rootDirectory)

  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: '/api/temp-cwd/mkdir',
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
    'temp-cwd: mkdir route',
  )

  // Delete the whole temp directory while it still carries the marker.
  // Marker absent → the folder is in use (first message already sent) or
  // foreign → refuse with 409 so we never delete user data.
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: '/api/temp-cwd/remove-dir',
      handler: (req: any, res: any) => {
        const dir = pathParam(req)
        if (dir === null || !isTempDir(root, dir)) {
          json(res, 400, { error: 'invalid path' })
          return
        }
        const marker = join(dir, MARKER_FILE)
        let hasMarker = false
        try {
          hasMarker = statSync(marker).isFile()
        } catch {
          hasMarker = false
        }
        if (!hasMarker) {
          json(res, 409, { removed: false, reason: 'no-marker' })
          return
        }
        rmSync(dir, { recursive: true, force: true })
        json(res, 200, { removed: true })
      },
    }),
    'temp-cwd: remove-dir route',
  )

  // Drop the marker once the conversation actually started (first message).
  // Idempotent: a missing marker is a success.
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: '/api/temp-cwd/remove-marker',
      handler: (req: any, res: any) => {
        const dir = pathParam(req)
        if (dir === null || !isTempDir(root, dir)) {
          json(res, 400, { error: 'invalid path' })
          return
        }
        const marker = join(dir, MARKER_FILE)
        let removed = false
        try {
          rmSync(marker, { force: true })
          removed = true
        } catch {
          removed = false
        }
        json(res, 200, { removed })
      },
    }),
    'temp-cwd: remove-marker route',
  )
}
