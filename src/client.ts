/**
 * dsh-temp-cwd — browser half (v7).
 *
 * v6 put the single 「新建临时对话」 button in the sidebar footer
 * (`sidebar.footer.action`). The user wants it next to the host's
 * 「选择工作区」 chip in the hero row instead (主界面顶部 chip 的后面).
 *
 * v7 moves it there via the `conversation.hero.agentPreset` single slot,
 * which renders right after the chip in `heroWorkspaceRow`:
 *
 *   heroWorkspaceRow
 *     ├── WorkspaceChip            («选择工作区» chip, host-owned)
 *     ├── conversation.hero.workspace  (workspace picker menu; renders
 *     │                                nothing when closed)
 *     └── conversation.hero.agentPreset ← our button lives here
 *
 * That slot is registered by the official agent-preset plugin, which is NOT
 * enabled in this profile (code profile bundles: no agent-preset), so the
 * seat is free. We register with `priority: 1` while agent-preset uses the
 * default `priority: 0` — the slots kernel renders the LOWEST priority entry
 * ("register at a different priority to shadow it (lowest renders)"), so if
 * the user ever enables agent-preset later, the official seat wins and our
 * button simply disappears. Zero conflict, zero shadowing of official UI.
 *
 * Click flow (all official APIs, unchanged from v6):
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

  // The one and only UI this plugin adds: a 「新建临时对话」 button sitting
  // right after the host's 「选择工作区」 chip in the hero row.
  // The agentPreset seat is free in this profile (agent-preset not enabled);
  // priority 1 vs the official default 0 means the official seat wins if it
  // ever gets enabled — lowest priority renders.
  ctx.slots.inject('conversation.hero.agentPreset', () =>
    ctx.slots.register(
      {
        name: 'conversation.hero.agentPreset',
        priority: 1,
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
 * Hero-row action — the single button this plugin adds, styled as a chip so
 * it sits naturally next to the host's 「选择工作区」 chip (host tokens only).
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
          ...chipButtonStyle,
          background: hovered ? 'var(--dsw-alias-interactive-bg-hover)' : 'transparent',
          opacity: busy ? 0.65 : 1,
          cursor: busy ? 'wait' : 'pointer',
        },
      },
      folderPlusIcon(),
      busy ? '创建中…' : '新建临时对话',
    ),
    error
      ? React.createElement('div', { role: 'alert', style: errorStyle }, error)
      : null,
  )
}

/* ---- helpers ---- */

/** Minimal lucide-style folder-plus glyph. */
function folderPlusIcon() {
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
    React.createElement('path', {
      d: 'M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z',
    }),
    React.createElement('line', { x1: '12', y1: '11', x2: '12', y2: '17' }),
    React.createElement('line', { x1: '9', y1: '14', x2: '15', y2: '14' }),
  )
}

/* ---- inline styles (host design tokens only) ---- */

/** Chip-like action button, harmonized with the host's workspace chip. */
const chipButtonStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  marginLeft: 8,
  padding: '4px 10px',
  borderRadius: 8,
  border: '1px solid var(--dsw-alias-stroke-strong, rgba(128, 128, 128, 0.35))',
  color: 'var(--dsw-alias-label-secondary)',
  fontSize: 13,
  fontWeight: 500,
  lineHeight: '20px',
  whiteSpace: 'nowrap',
  fontFamily: 'inherit',
}

const errorStyle = {
  color: 'var(--dsw-alias-danger, #f56c6c)',
  fontSize: 12,
  lineHeight: '16px',
  padding: '2px 0 0 8px',
}
