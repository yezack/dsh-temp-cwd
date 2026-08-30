/**
 * dsh-temp-cwd — host half.
 *
 * Exposes POST /api/temp-cwd/mkdir, which creates a timestamped directory
 * under a configurable root (default ~/Documents/dsh-workspaces) and returns
 * its absolute path. The browser half (./client) calls it, then opens a
 * workspace-less session whose cwd points at that directory via the native
 * session/create API (cwd without workspaceId).
 */

import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import z from 'schemastery'

/** Stable cordis plugin name (host half). */
export const name = 'temp-cwd'

/** Services required before the mkdir route can mount. */
export const inject = ['webServer']

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
 * Mount the mkdir route.
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
        // Path-traversal guard: seg is a bare timestamp, dir must remain a
        // direct child of root.
        if (dir.split(sep).slice(0, -1).join(sep) !== root) {
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'invalid path' }))
          return
        }
        mkdirSync(dir, { recursive: true })
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ path: dir }))
      },
    }),
    'temp-cwd: mkdir route',
  )
}
