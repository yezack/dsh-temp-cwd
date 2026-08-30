/**
 * dsh-temp-cwd — browser half.
 *
 * Adds a 「临时会话」 button to the sidebar footer (list slot
 * sidebar.footer.action, root scope). On click: ask the host to create a
 * timestamped directory, then open a workspace-less session whose cwd points
 * at it (native session/create supports cwd without workspaceId).
 */

import * as React from 'react'

/** Stable cordis plugin name (browser half). */
export const name = 'temp-cwd-client'

/** Services required before the slot entry can mount. */
export const inject = ['slots', 'sessions']

export function apply(ctx: any): void {
  ctx.slots.inject('sidebar.footer.action', () =>
    ctx.slots.register(
      {
        name: 'sidebar.footer.action',
        id: 'temp-cwd',
        order: 10,
      },
      function TempCwdButton() {
        const [busy, setBusy] = React.useState(false)
        return React.createElement(
          'button',
          {
            type: 'button',
            disabled: busy,
            onClick: async () => {
              setBusy(true)
              try {
                const res = await fetch('/api/temp-cwd/mkdir', { method: 'POST' })
                if (!res.ok) throw new Error(`mkdir failed: ${res.status}`)
                const { path } = (await res.json()) as { path: string }
                const sessionId = await ctx.sessions.create({ cwd: path })
                await ctx.sessions.open(sessionId)
              } catch (err) {
                console.error('[temp-cwd] failed to open temp session:', err)
              } finally {
                setBusy(false)
              }
            },
          },
          '临时会话',
        )
      },
    ),
  )
}
