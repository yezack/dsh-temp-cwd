/**
 * dsh-temp-cwd — browser half (v11).
 *
 * Placement (user-confirmed): the 「开始临时对话」 pill stays inside the
 * official hero chip row (`heroWorkspaceRow`), because that row has no
 * injectable seat — both hero seats (`conversation.hero.workspace` /
 * `conversation.hero.agentPreset`) are single/root and occupied by official
 * packages, so a slot cell can never coexist there (v7/v8/v9 history). v11
 * keeps the single DOM append (one plain `<button data-temp-cwd>` in the row)
 * but officializes everything around it:
 *
 *  - Store consumption goes through the official inject `hooks` compartment.
 *    The slot renderer turns bare Observable sources (`subscribe` /
 *    `getSnapshot`) into selector props (`useWorkspaceList`,
 *    `useSessionList`) — components never reach into models directly and
 *    never call `useSyncExternalStore` themselves (renderer does it).
 *    v10 crashed exactly here: it called `workspaces.getSnapshot` on the
 *    *controller* (`ctx.workspaces`), which only has commands
 *    (create/delete/rename); `subscribe`/`getSnapshot` live on the model
 *    exposed as `ctx.workspaces.list` (and `ctx.sessions.list`).
 *  - Services stay in the `apply` closure; components receive only
 *    callbacks (`onStartTemp`) plus bound selector hooks.
 *  - The headless host registers on the `sidebar.footer.action` LIST seat
 *    (id `temp-cwd`) purely for lifecycle — it renders nothing there.
 *
 * Click flow (unchanged from v6+): host mkdir → `workspaces.create({ path })`
 * → `sessions.create({ workspaceId })` → `sessions.open` → deferred cleanup
 * after the first message (blank → false) or after switching away. Cleanup
 * subscribes to `sessions.list` at apply level (model API, not React).
 *
 * Visibility rule: the pill mounts only while the hero row exists AND the
 * current session is not attached to any workspace (`workspace.sessionIds`
 * lookup — the same binding check the official ui-workspace / ui-conversation
 * code uses). Since the row unmounts when a session binds a workspace, this
 * is belt & braces; a 1.2 s interval self-heals the pill after React
 * reconciliation disturbs the appended foreign child.
 */

import * as React from 'react'

/** Stable cordis plugin name (browser half). */
export const name = 'temp-cwd-client'

/** Services required before the plugin can mount. */
export const inject = ['slots', 'sessions', 'workspaces', 'uiWorkspace']

/**
 * Module-level pending temp workspace id. While set, the dispose hook and the
 * flow own it; cleared as soon as the cleanup fires.
 */
let tempWorkspaceId: string | null = null

/** The official hero chip row carries this CSS-module suffix (hash-prefixed). */
const HERO_ROW_SELECTOR = '[class*="heroWorkspaceRow"]'

/** css tag id for the pill stylesheet (official style-injection pattern). */
const PILL_CSS_ID = '@yezack/dsh-temp-cwd/pill.css'

/** Pill tooltip (also restored after an error revert). */
const PILL_TITLE = '创建临时工作区并直接开始对话（发送首条消息后自动归入未分组）'

export function apply(ctx: any): void {
  const workspaces = ctx.workspaces
  const sessions = ctx.sessions
  const uiWorkspace = ctx.uiWorkspace

  // Bug A: an un-argued "new session" must NEVER re-attach the current/recent
  // workspace. The host's own startSession treats `target === void 0` by
  // calling sessions.clear() — replicate that for un-argued calls, leave
  // workspaceId-argued calls (explicit pick) untouched.
  const originalStartSession = uiWorkspace.startSession.bind(uiWorkspace)
  uiWorkspace.startSession = (workspaceId?: string) => {
    if (workspaceId === void 0) {
      sessions.clear()
      return
    }
    originalStartSession(workspaceId)
  }

  // Safety net: if the plugin is disposed while a temp workspace is still
  // pending (e.g. the app closes before the first message), remove it.
  ctx.on('dispose', () => {
    if (tempWorkspaceId !== null) {
      const id = tempWorkspaceId
      tempWorkspaceId = null
      workspaces.delete(id).catch((err: any) => {
        console.error('[temp-cwd] dispose cleanup failed:', err)
      })
    }
  })

  ensurePillStyle()

  // Headless host on the official sidebar.footer.action LIST seat (renders
  // nothing visible). Entry-owned `inject` projects:
  //   hooks: { workspaceList, sessionList } — bare models; renderer binds
  //          them into useWorkspaceList/useSessionList selector props.
  //   onStartTemp — the temp-session action, kept in the apply closure.
  ctx.slots.inject('sidebar.footer.action', () =>
    ctx.slots.register(
      {
        name: 'sidebar.footer.action',
        id: 'temp-cwd',
        inject: () => ({
          hooks: {
            /** Workspace model: subscribe/getSnapshot → { items, phase, … }. */
            workspaceList: workspaces.list,
            /** Session list model: subscribe/getSnapshot → { items, current, … }. */
            sessionList: sessions.list,
          },
          onStartTemp: () => createTempSession(sessions, workspaces),
        }),
      },
      TempCwdHost,
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

    // 5. Deferred cleanup: first message (blank → false) or switch away.
    armCleanup(sessions, workspaces, workspace.workspaceId, sessionId)
  } catch (err) {
    // Session create/open failed — don't leave a dangling workspace behind.
    if (tempWorkspaceId === workspace.workspaceId) tempWorkspaceId = null
    workspaces.delete(workspace.workspaceId).catch(() => {})
    throw err
  }
}

/**
 * Subscribe to the session list model and delete the temp workspace at the
 * first moment it is safe (first message sent, or the user switched away).
 * Torn down on first match; delete is fire-and-forget (logged on failure).
 */
function armCleanup(sessions: any, workspaces: any, workspaceId: string, sessionId: string): void {
  let done = false
  const dispose = sessions.list.subscribe(() => {
    if (done) return
    const snap = sessions.list.getSnapshot()
    // The session-list store is seeded as { ids, byId, current, phase, … }
    // and only gains `items` after the first projection; a transient reset
    // (e.g. sessions.clear()) can notify with `items` undefined. Never read
    // `.items` unguarded — a listener throw here would skip the delete and
    // leak the temp workspace.
    const items = Array.isArray(snap?.items) ? snap.items : []
    const entry = items.find((item: any) => item.sessionId === sessionId)
    if (snap?.current !== sessionId || (entry && entry.blank === false)) {
      done = true
      dispose()
      if (tempWorkspaceId === workspaceId) tempWorkspaceId = null
      console.info('[temp-cwd] cleanup: deleting workspace', workspaceId)
      workspaces.delete(workspaceId).then(
        () => console.info('[temp-cwd] cleanup: workspace deleted', workspaceId),
        (err: any) => console.error('[temp-cwd] workspace cleanup failed:', err),
      )
    }
  })
}

/**
 * Headless host — renders nothing. Consumes the two models through the
 * renderer-bound selector hooks (`useWorkspaceList` / `useSessionList`) the
 * same way official slot components do, finds the official hero chip row,
 * and appends/removes the 「开始临时对话」 pill.
 */
function TempCwdHost(props: {
  /** Renderer-bound selector hook over ctx.workspaces.list. */
  useWorkspaceList: <T>(selector: (snapshot: any) => T) => T
  /** Renderer-bound selector hook over ctx.sessions.list. */
  useSessionList: <T>(selector: (snapshot: any) => T) => T
  /** Temp-session action (closure in apply). */
  onStartTemp: () => Promise<void>
}) {
  const { useWorkspaceList, useSessionList, onStartTemp } = props

  // Workspace items (reference-stable between invalidations) — each carries
  // `sessionIds`; the official ui-conversation / ui-workspace code resolves
  // a session's workspace exactly this way.
  const wsItems = useWorkspaceList((snapshot) => snapshot.items)
  // Current session id (undefined while no session is selected).
  const currentSessionId = useSessionList((snapshot) => snapshot.current)

  const bound =
    currentSessionId !== undefined &&
    wsItems.some((w: any) => w.sessionIds.includes(currentSessionId))

  const [row, setRow] = React.useState<HTMLElement | null>(null)
  const pillRef = React.useRef<HTMLButtonElement | null>(null)
  const rowRef = React.useRef<HTMLElement | null>(null)
  const boundRef = React.useRef<boolean>(false)

  // Keep refs in sync so the interval tick can read current values.
  rowRef.current = row
  boundRef.current = bound

  // Store-driven rescan: session/workspace transitions remount/unmount the
  // hero row, so re-locate it every time the state we care about changes.
  React.useEffect(() => {
    setRow(findHeroRow())
  }, [currentSessionId, bound])

  // Mount effect: attach the pill to the current row (if any) whenever the
  // row element or the bound-state changes; remove it otherwise.
  React.useEffect(() => {
    removePill(pillRef)
    if (row === null || bound) return
    pillRef.current = mountPill(row, onStartTemp)
    return () => removePill(pillRef)
  }, [row, bound, onStartTemp])

  // Self-heal tick: catch row remounts that never touch the stores and any
  // React reconciliation that disturbed the appended pill (re-append within
  // ~1.2 s). Cheap: one querySelector when nothing changed.
  React.useEffect(() => {
    const id = window.setInterval(() => {
      const el = findHeroRow()
      if (el !== rowRef.current) {
        setRow(el)
        return
      }
      const pill = pillRef.current
      const shouldMount = el !== null && !boundRef.current
      if (shouldMount && (pill === null || !el.contains(pill))) {
        removePill(pillRef)
        pillRef.current = mountPill(el, onStartTemp)
      } else if (!shouldMount && pill !== null) {
        removePill(pillRef)
      }
    }, 1200)
    return () => window.clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Headless: nothing visible from this seat.
  return null
}

/* ---- pill DOM (imperative — deliberately no react-dom) ---- */

/** Inject the pill stylesheet once (official data-plugin-css convention). */
function ensurePillStyle(): void {
  if (typeof document === 'undefined') return
  if (document.querySelector(`style[data-plugin-css="${PILL_CSS_ID}"]`) !== null) return
  const tag = document.createElement('style')
  tag.dataset.pluginCss = PILL_CSS_ID
  tag.textContent = [
    // Exact chip look: same tokens as the official `…_workspace` chip
    // (radius 16, min-height 28, 13px/500, label-primary, hover bg).
    'button[data-temp-cwd]{display:inline-flex;align-items:center;gap:4px;min-height:28px;max-width:min(100%,360px);box-sizing:border-box;border-radius:16px;padding:0 8px;border:none;background:transparent;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:13px;font-weight:500;line-height:20px;cursor:pointer}',
    'button[data-temp-cwd]:hover{background:var(--dsw-alias-interactive-bg-hover)}',
    'button[data-temp-cwd][data-temp-cwd-state="busy"]{opacity:.65;cursor:wait}',
    'button[data-temp-cwd] svg{flex-shrink:0}',
    'button[data-temp-cwd] span{white-space:nowrap}',
  ].join('\n')
  document.head.appendChild(tag)
}

/** Find the visible official hero chip row (blank conversation state). */
function findHeroRow(): HTMLElement | null {
  const nodes = Array.from(document.querySelectorAll(HERO_ROW_SELECTOR))
  const visible = nodes.find(
    (el) => el instanceof HTMLElement && el.getClientRects().length > 0 && el.offsetParent !== null,
  )
  return (visible ?? nodes[0] ?? null) as HTMLElement | null
}

/** Detach the mounted pill, if any. */
function removePill(pillRef: React.MutableRefObject<HTMLButtonElement | null>): void {
  const pill = pillRef.current
  pillRef.current = null
  if (pill !== null && pill.isConnected) pill.remove()
}

/**
 * Append the 「开始临时对话」 pill to the official hero chip row and wire its
 * click to the temp-session flow. Returns the button (caller keeps it in a
 * ref for removal / self-heal). Busy/error feedback is imperative DOM text
 * updates — no react-dom, no re-render loop.
 */
function mountPill(row: HTMLElement, onStart: () => Promise<void>): HTMLButtonElement {
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.setAttribute('data-temp-cwd', '')
  btn.setAttribute('data-temp-cwd-state', 'idle')
  btn.title = PILL_TITLE
  btn.innerHTML = `${PLUS_SVG}<span>开始临时对话</span>`
  const label = btn.querySelector('span') as HTMLSpanElement | null

  let busy = false
  let revertTimer = 0

  const setBusy = () => {
    if (!btn.isConnected) return
    btn.setAttribute('data-temp-cwd-state', 'busy')
    if (label !== null) label.textContent = '创建中…'
  }
  const setIdle = () => {
    if (!btn.isConnected) return
    btn.setAttribute('data-temp-cwd-state', 'idle')
    if (label !== null) {
      label.textContent = '开始临时对话'
      label.style.color = ''
    }
    btn.title = PILL_TITLE
  }
  const showError = (message: string) => {
    if (!btn.isConnected) return
    btn.setAttribute('data-temp-cwd-state', 'idle')
    if (label !== null) {
      label.textContent = '创建失败'
      label.style.color = 'var(--dsw-alias-danger, #f56c6c)'
    }
    btn.title = message
  }

  btn.addEventListener('click', () => {
    if (busy || !btn.isConnected) return
    busy = true
    window.clearTimeout(revertTimer)
    setBusy()
    onStart()
      .catch((err: unknown) => {
        console.error('[temp-cwd] failed to open temp session:', err)
        const message = err instanceof Error ? err.message : String(err)
        showError(message)
        revertTimer = window.setTimeout(setIdle, 3000)
      })
      .finally(() => {
        busy = false
        // Success normally unmounts the row (session becomes active); only
        // revert to idle if the pill is still around (e.g. still settling).
        if (btn.isConnected && btn.getAttribute('data-temp-cwd-state') !== 'idle') {
          setIdle()
        }
      })
  })

  // Insert the pill immediately after the official 「选择工作区」 chip (first
  // <button> in the row) — the row may also contain a mode/agent-preset chip
  // (e.g. 「CTF解题模式」), so a plain append or flex `order` cannot guarantee
  // the pill's position. Fall back to appending when no chip is found.
  const chip = row.querySelector('button')
  if (chip !== null) chip.after(btn)
  else row.appendChild(btn)
  return btn
}

/* ---- helpers ---- */

/** 14px plus glyph (lucide-style), matching the host's stroke aesthetics. */
const PLUS_SVG =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
  'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M5 12h14"/><path d="M12 5v14"/></svg>'
