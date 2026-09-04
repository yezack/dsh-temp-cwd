/**
 * dsh-temp-cwd — browser half (v12).
 *
 * Placement (user-confirmed): the 「开始临时对话」 pill stays inside the
 * official hero chip row (`heroWorkspaceRow`), because that row has no
 * injectable seat — both hero seats (`conversation.hero.workspace` /
 * `conversation.hero.agentPreset`) are single/root and occupied by official
 * packages, so a slot cell can never coexist there (v7/v8/v9 history). The
 * pill is one plain DOM `<button data-temp-cwd>` appended into the row.
 *
 * Store consumption is official: the headless host component (registered on
 * the `sidebar.footer.action` LIST seat, renders nothing) reads the models
 * through the renderer-bound selector props `useWorkspaceList` /
 * `useSessionList`, which come from the inject `hooks` compartment
 * (`workspaceList: ctx.workspaces.list`, `sessionList: ctx.sessions.list`).
 * Services (controllers) never cross into React — actions stay in `apply`.
 * v10 crashed with `workspaces.getSnapshot is not a function` because it
 * called subscribe/getSnapshot on the controller instead of the model.
 *
 * Temp-folder lifecycle (v12, marker-based):
 *
 *   1. Click pill → host `mkdir` creates <root>/<timestamp> AND writes a
 *      `.TEMP_WORKSPACE` marker inside it.
 *   2. Adopt the folder as a real workspace (`workspaces.create({ path })`),
 *      create + open a session attached to it — the composer renders 100%
 *      native. `tempPending` remembers { workspaceId, path }.
 *   3. First message sent (blank → false): the session is real now. The
 *      plugin removes the marker (host remove-marker) and deletes the
 *      workspace — the session falls into 「未分组」 and the folder is kept.
 *   4. Abandoned before the first message (switch away, un-argued
 *      "new session" clears it, or plugin dispose): the folder still carries
 *      the marker, so the host removes the WHOLE directory (remove-dir) —
 *      empty temp dirs can no longer accumulate. Workspaces.delete removes
 *      the sidebar entry; files/folders created inside before that point are
 *      discarded too (marker = "abandoned scaffold, safe to remove entirely").
 */

import * as React from 'react'

/** Stable cordis plugin name (browser half). */
export const name = 'temp-cwd-client'

/** Services required before the plugin can mount. */
export const inject = ['slots', 'sessions', 'workspaces', 'uiWorkspace']

/**
 * The pending temp workspace (created, not yet finalized by first message or
 * by abandon cleanup). Cleared when cleanup fires; the dispose hook uses it
 * as a safety net (app closing while a temp session is still blank).
 */
let tempPending: { workspaceId: string; path: string } | null = null

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
  // pending (app closes before the first message), the folder is still an
  // abandoned scaffold (marker present) → remove the whole directory, then
  // delete the workspace. If the marker is already gone the host no-ops.
  ctx.on('dispose', () => {
    if (tempPending === null) return
    const pending = tempPending
    tempPending = null
    hostRemoveDir(pending.path)
    workspaces.delete(pending.workspaceId).catch((err: any) => {
      console.error('[temp-cwd] dispose cleanup failed:', err)
    })
  })

  ensurePillStyle()

  // Headless host on the official sidebar.footer.action LIST seat (renders
  // nothing visible). Entry-owned `inject` projects the two bare models as
  // hook sources (renderer binds useWorkspaceList / useSessionList) plus the
  // temp-session action kept in the apply closure.
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
 * Create the temp workspace + session, open it, and arm the deferred cleanup.
 * The host mkdir route creates the folder AND the .TEMP_WORKSPACE marker.
 */
async function createTempSession(sessions: any, workspaces: any): Promise<void> {
  // 1. Ask the host for a fresh timestamped temp directory (+ marker).
  const res = await fetch('/api/temp-cwd/mkdir', { method: 'POST' })
  if (!res.ok) throw new Error(`mkdir failed: ${res.status}`)
  const { path } = (await res.json()) as { path: string }

  // 2. Adopt it as a real workspace — the composer renders natively from now on.
  const workspace = await workspaces.create({ path })
  tempPending = { workspaceId: workspace.workspaceId, path }

  try {
    // 3. Session attached to that workspace.
    const sessionId = await sessions.create({ workspaceId: workspace.workspaceId })

    // 4. Open it — native InputBar / Lexical composer, chip shows a real title.
    await sessions.open(sessionId)

    // 5. Deferred cleanup: first message finalizes the folder (marker →
    //    removed), abandoning it removes the whole folder (marker → delete).
    armCleanup(sessions, workspaces, workspace.workspaceId, path, sessionId)
  } catch (err) {
    // Session create/open failed — roll the abandoned scaffold back fully.
    const pending = tempPending
    tempPending = null
    if (pending !== null) {
      hostRemoveDir(pending.path)
      workspaces.delete(pending.workspaceId).catch(() => {})
    }
    throw err
  }
}

/**
 * Host calls (fire-and-forget; failures only log — never block the UI).
 */
async function hostRemoveDir(path: string): Promise<void> {
  try {
    const res = await fetch(`/api/temp-cwd/remove-dir?p=${encodeURIComponent(path)}`, {
      method: 'POST',
    })
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { reason?: string }
      console.warn(`[temp-cwd] remove-dir refused (${res.status}):`, body.reason ?? res.status)
    }
  } catch (err) {
    console.warn('[temp-cwd] remove-dir request failed:', err)
  }
}

async function hostRemoveMarker(path: string): Promise<void> {
  try {
    const res = await fetch(`/api/temp-cwd/remove-marker?p=${encodeURIComponent(path)}`, {
      method: 'POST',
    })
    if (!res.ok) console.warn(`[temp-cwd] remove-marker failed (${res.status})`)
  } catch (err) {
    console.warn('[temp-cwd] remove-marker request failed:', err)
  }
}

/**
 * Subscribe to the session list model and finalize the temp workspace at the
 * first moment it is safe:
 *   - first message (`entry.blank === false`): real session — remove the
 *     marker (folder is kept) and delete the workspace (session → 未分组);
 *   - switch away / clear (`snap.current !== sessionId`): abandoned — remove
 *     the whole folder (marker authorizes it) and delete the workspace.
 */
function armCleanup(
  sessions: any,
  workspaces: any,
  workspaceId: string,
  path: string,
  sessionId: string,
): void {
  let done = false
  const dispose = sessions.list.subscribe(() => {
    if (done) return
    const snap = sessions.list.getSnapshot()
    // The session-list store is seeded as { ids, byId, current, phase, … }
    // and only gains `items` after the first projection; a transient reset
    // (e.g. sessions.clear()) can notify with `items` undefined. Never read
    // `.items` unguarded — a listener throw here would skip cleanup and leak
    // the temp workspace.
    const items = Array.isArray(snap?.items) ? snap.items : []
    const entry = items.find((item: any) => item.sessionId === sessionId)
    const firstMessage = entry !== undefined && entry.blank === false
    const abandoned = snap?.current !== sessionId
    if (!firstMessage && !abandoned) return

    done = true
    dispose()
    const pending = tempPending
    if (pending !== null && pending.workspaceId === workspaceId) tempPending = null

    // Finalize the folder first, then remove the sidebar workspace entry.
    if (firstMessage) {
      console.info('[temp-cwd] first message — keeping folder, removing marker', path)
      void hostRemoveMarker(path).then(() => {
        console.info('[temp-cwd] marker removed; deleting workspace', workspaceId)
        return workspaces.delete(workspaceId)
      })
    } else {
      console.info('[temp-cwd] abandoned — removing whole temp folder', path)
      void hostRemoveDir(path).then(() => {
        console.info('[temp-cwd] folder removed; deleting workspace', workspaceId)
        return workspaces.delete(workspaceId)
      })
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
