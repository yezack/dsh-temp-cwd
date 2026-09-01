/**
 * dsh-temp-cwd — browser half (v6).
 *
 * v6 removes ALL UI intervention from v4/v5:
 *   - no React fiber walking, no MutationObserver, no DOM guards,
 *     no placeholder hiding, no host-chip hiding, no custom popover,
 *     no custom chips — nothing touches the host's DOM or editors.
 * The ONLY UI this plugin adds is a single 「新建临时对话」 button in the
 * sidebar footer (the `sidebar.footer.action` list slot).
 *
 * Click flow (all official APIs):
 *   1. POST /api/temp-cwd/mkdir        → host creates a temp directory
 *   2. workspaces.create({ path })     → adopt it as a REAL workspace
 *   3. sessions.create({ workspaceId })→ session attached to that workspace
 *   4. sessions.open(sessionId)        → host renders its NATIVE composer;
 *        because the workspace exists the chip has a title and the input bar
 *        is fully usable — byte-for-byte a normal workspace session.
 *   5. Wait until the session leaves `blank` (first message sent) OR the
 *      user switches to another session — then workspaces.delete(id).
 *      The host keeps the files and the session records and moves the
 *      session into 「未分组」 (official: "文件夹与会话记录会保留，其会话将
 *      显示在 '未分组' 下").
 *
 * Why wait for the first message instead of deleting immediately: a blank
 * (no-message) session without a workspace is inherently locked by the host
 * (`inert = hero && chipTitle === void 0` → "选择一个工作区开始" trigger
 * mode). Deleting only AFTER the first message means the composer is native
 * and usable for the entire conversation, and once the session has content
 * the host no longer locks it (hero goes false), so it stays usable after
 * it lands in 「未分组」. Zero DOM intervention, zero custom input.
 *
 * Bug A (kept): an un-argued "new session" must NEVER re-attach the
 * current/recent workspace. The host's uiWorkspace.startSession() resolves
 * `target = workspaceId ?? currentWorkspaceId ?? recentWorkspace(...)`, so we
 * wrap it: un-argued calls go to sessions.clear() — byte-for-byte the host's
 * own `target === void 0` branch — leaving the hero in the empty (ungrouped)
 * state. workspaceId-argued calls pass through untouched.
 */

import * as React from 'react'

/** Stable cordis plugin name (browser half). */
export const name = 'temp-cwd-client'

/** Services required before the slot entry can mount. */
export const inject = ['slots', 'sessions', 'workspaces', 'uiWorkspace']

/**
 * Module-level pending temp workspace id. While set, the dispose hook and the
 * button flow own it; it is cleared as soon as the cleanup fires.
 */
let tempWorkspaceId: string | null = null

export function apply(ctx: any): void {
  const workspaces = ctx.workspaces
  const sessions = ctx.sessions
  const uiWorkspace = ctx.uiWorkspace

  // Bug A: an un-argued "new session" must NEVER re-attach the current/recent
  // workspace. The host's own startSession treats `target === void 0` by
  // calling sessions.clear() — replicate exactly that for un-argued calls,
  // and leave workspaceId-argued calls (explicit pick) untouched.
  const originalStartSession = uiWorkspace.startSession.bind(uiWorkspace)
  uiWorkspace.startSession = (workspaceId?: string) => {
    if (workspaceId === void 0) {
      sessions.clear()
      return
    }
    originalStartSession(workspaceId)
  }

  // Safety net: if the plugin is ever disposed while a temp workspace is
  // still pending (e.g. the app closes before the first message), remove it
  // so nothing leaks in the workspace list.
  ctx.on('dispose', () => {
    if (tempWorkspaceId !== null) {
      const id = tempWorkspaceId
      tempWorkspaceId = null
      workspaces.delete(id).catch((err: any) => {
        console.error('[temp-cwd] dispose cleanup failed:', err)
      })
    }
  })

  // The one and only UI this plugin adds: a sidebar footer action.
  ctx.slots.inject('sidebar.footer.action', () =>
    ctx.slots.register(
      {
        name: 'sidebar.footer.action',
        id: 'temp-cwd',
        inject: () => ({
          /** Official session controller: create({ workspaceId }) / open(id). */
          sessions,
          /** Official workspace controller: create({ path }) / delete(id). */
          workspaces,
          /** Session list projection model: subscribe / getSnapshot (items carry `blank`). */
          sessionsList: sessions.list,
        }),
      },
      TempSessionButton,
    ),
  )
}

/**
 * Create the temp workspace + session, open it, and arm the deferred cleanup
 * (delete the workspace once the session leaves `blank` or the user switches
 * away). All official API calls; nothing touches the DOM.
 */
async function createTempSession(sessions: any, workspaces: any): Promise<void> {
  // 1. Ask the host for a fresh timestamped temp directory.
  const res = await fetch('/api/temp-cwd/mkdir', { method: 'POST' })
  if (!res.ok) throw new Error(`mkdir failed: ${res.status}`)
  const { path } = (await res.json()) as { path: string }

  // 2. Adopt it as a real workspace — the composer renders natively from now on.
  const workspace = await workspaces.create({ path })
  tempWorkspaceId = workspace.workspaceId

  try {
    // 3. Session attached to that workspace.
    const sessionId = await sessions.create({ workspaceId: workspace.workspaceId })

    // 4. Open it — native InputBar / Lexical composer, chip shows a real title.
    await sessions.open(sessionId)

    // 5. Deferred cleanup: wait for the first message (blank → false) or for
    //    the user to switch away, then delete the workspace. The host keeps
    //    the files and session records and moves the session into 「未分组」.
    armCleanup(sessions, workspaces, workspace.workspaceId, sessionId)
  } catch (err) {
    // Session create/open failed — don't leave a dangling workspace behind.
    if (tempWorkspaceId === workspace.workspaceId) tempWorkspaceId = null
    workspaces.delete(workspace.workspaceId).catch(() => {})
    throw err
  }
}

/**
 * Subscribe to the session list projection and delete the temp workspace at
 * the first moment it is safe:
 *   - the session got its first message (`entry.blank === false`), or
 *   - the user switched to another session (`snap.current !== sessionId`).
 * The subscription is torn down on the first match; the workspace delete is
 * fire-and-forget (logged on failure).
 */
function armCleanup(sessions: any, workspaces: any, workspaceId: string, sessionId: string): void {
  let done = false
  const dispose = sessions.list.subscribe(() => {
    if (done) return
    const snap = sessions.list.getSnapshot()
    const entry = snap.items.find((item: any) => item.sessionId === sessionId)
    if (snap.current !== sessionId || (entry && entry.blank === false)) {
      done = true
      dispose()
      if (tempWorkspaceId === workspaceId) tempWorkspaceId = null
      workspaces.delete(workspaceId).catch((err: any) => {
        console.error('[temp-cwd] workspace cleanup failed:', err)
      })
    }
  })
}

/**
 * Sidebar footer action — the single button this plugin adds. Plain host-
 * token styling, no other UI.
 */
function TempSessionButton(props: any) {
  const { sessions, workspaces } = props
  const [busy, setBusy] = React.useState(false)
  const [hovered, setHovered] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const handle = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await createTempSession(sessions, workspaces)
    } catch (err) {
      console.error('[temp-cwd] failed to open temp session:', err)
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return React.createElement(
    React.Fragment,
    null,
    React.createElement(
      'button',
      {
        type: 'button',
        disabled: busy,
        onClick: handle,
        onMouseEnter: () => setHovered(true),
        onMouseLeave: () => setHovered(false),
        title: '创建临时工作区并直接开始对话（发出第一条消息后自动进入未分组）',
        style: {
          ...actionButtonStyle,
          background: hovered ? 'var(--dsw-alias-interactive-bg-hover)' : 'transparent',
          opacity: busy ? 0.65 : 1,
          cursor: busy ? 'wait' : 'pointer',
        },
      },
      plusIcon(),
      busy ? '创建中…' : '新建临时对话',
    ),
    error
      ? React.createElement('div', { role: 'alert', style: errorStyle }, error)
      : null,
  )
}

/* ---- helpers ---- */

/** Minimal lucide-style plus glyph. */
function plusIcon() {
  return React.createElement(
    'svg',
    {
      width: 14,
      height: 14,
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 2,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      style: { flexShrink: 0 },
    },
    React.createElement('path', { d: 'M5 12h14' }),
    React.createElement('path', { d: 'M12 5v14' }),
  )
}

/* ---- inline styles (host design tokens only) ---- */

const actionButtonStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  width: '100%',
  boxSizing: 'border-box',
  minWidth: 0,
  padding: '6px 8px',
  borderRadius: 8,
  border: 'none',
  color: 'var(--dsw-alias-label-secondary)',
  fontSize: 13,
  fontWeight: 500,
  lineHeight: '20px',
  textAlign: 'left',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
}

const errorStyle = {
  color: 'var(--dsw-alias-danger, #f56c6c)',
  fontSize: 12,
  lineHeight: '16px',
  padding: '2px 8px 4px',
}
