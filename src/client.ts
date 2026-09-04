/**
 * dsh-temp-cwd — browser half (v10).
 *
 * v10 redesign (user: "这个插件现在没有任何作用，重新设计一下", then
 * confirmed the overlay direction: "替换掉整个 [选择工作区] 换成
 * 选择工作区+开始临时对话，新的选择工作区点击逻辑和原来完全保持一致").
 *
 * Why v7/v8/v9 could not put the button next to the host's 「选择工作区」 chip:
 * the chip row (`heroWorkspaceRow`, hardcoded JSX inside ui-conversation's
 * ConversationRoot) has NO injectable seat. The two hero seats
 * (`conversation.hero.workspace` / `conversation.hero.agentPreset`) are both
 * single/root and claimed at priority 0 by official packages; the slots
 * kernel renders only the lowest-priority winner, so a pure-slot button
 * cannot coexist there (v7 was shadowed, v8 shadowed the official picker and
 * broke 「选择工作区」). v9 retreated to `sidebar.footer.action`, but the
 * button "did nothing" from the user's perspective and the design was
 * scrapped.
 *
 * v10 approach — DOM-overlay pill appended INTO the official hero chip row
 * (documented in lib/client.js, ConversationRoot, ~line 14191):
 *
 *   heroWorkspaceRow = <div class="…heroWorkspaceRow">   // flex, gap 2, pl 20
 *     <button WorkspaceChip …/>                          // 选择工作区 (native)
 *     <span Menu root/>                                  // empty 0×0 when closed
 *   </div>
 *
 * The row only renders while the conversation is in the blank/hero phase
 * (no session, or a blank session not attached to a workspace). Once a
 * session binds a workspace the row unmounts entirely — the pill disappears
 * with it, no extra logic needed. Verified facts about this profile:
 *
 *   - The workspace picker Menu renders with `portal: true` (ui-primitives
 *     Menu) → an EMPTY inline span in the row, real list portals to body,
 *     anchored at the chip's rect. So the native chip + menu keep 100% of
 *     their behavior; we never touch them.
 *   - No package registers `conversation.hero.agentPreset` in this profile
 *     (no 「模式选择」 chip) → steady-state row is chip + empty span.
 *
 * Implementation: a headless host (registered on `sidebar.footer.action`,
 * renders nothing) tracks the row element by DOM query
 * `[class*="heroWorkspaceRow"]` — the CSS-module class keeps the readable
 * `…heroWorkspaceRow` suffix across hash changes — and imperatively appends
 * a third pill button `[开始临时对话]` (CSS `order: 2`, chip-styled, zero
 * react-dom). Clicking it runs the v6+ flow unchanged: host mkdir →
 * workspaces.create → sessions.create({ workspaceId }) → sessions.open →
 * deferred cleanup after first message / switch away. The official chip
 * stays untouched: clicking it still toggles pickerOpen and opens the native
 * picker at its (unchanged, order-1) position.
 *
 * Robustness notes:
 *   - The appended node is a foreign child inside a React-owned container.
 *     React generally leaves unknown children alone, but a future package
 *     that renders extra in-flow children into the row could collide on
 *     index-based reconciliation; a 1.2 s interval self-heal re-appends the
 *     pill whenever the row exists without one. No MutationObserver.
 *   - If the folder-picker (directoryFlow) package is ever installed and a
 *     directory flow renders IN the row while open, the pill may get
 *     disturbed — the interval re-appends it right after. Acceptable.
 *   - Visibility rule (inherited from v9): pill mounts only while the row
 *     exists AND the current session is not attached to any workspace
 *     (belt & braces — normally the row is already gone in that state).
 */

import * as React from 'react'

/** Stable cordis plugin name (browser half). */
export const name = 'temp-cwd-client'

/** Services required before the slot entry can mount. */
export const inject = ['slots', 'sessions', 'workspaces', 'uiWorkspace']

/**
 * Module-level pending temp workspace id. While set, the dispose hook and the
 * flow own it; it is cleared as soon as the cleanup fires.
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

  ensurePillStyle()

  // Headless host. `sidebar.footer.action` is a LIST seat (kind: list) where
  // our entry coexists with the official cordis-panel entry; the component
  // renders nothing visible — it only runs the row-scan + pill lifecycle.
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
 * Headless host — renders nothing. Subscribes to the workspace + session list
 * stores (any blank↔active transition touches them), finds the official hero
 * chip row, and appends/removes the 「开始临时对话」 pill.
 */
function TempCwdHost(props: any) {
  const { sessions, workspaces, sessionsList } = props

  // Reactive workspace list snapshot (stable reference between invalidations).
  const wsSnap = React.useSyncExternalStore(
    (listener: () => void) => workspaces.subscribe(listener),
    () => workspaces.getSnapshot(),
  )
  // Reactive session list snapshot — `current` = active session id.
  const sesSnap = React.useSyncExternalStore(
    (listener: () => void) => sessionsList.subscribe(listener),
    () => sessionsList.getSnapshot(),
  )

  const [row, setRow] = React.useState<HTMLElement | null>(null)
  const pillRef = React.useRef<HTMLButtonElement | null>(null)
  const rowRef = React.useRef<HTMLElement | null>(null)
  const boundRef = React.useRef<boolean>(false)

  const currentSessionId = sesSnap.current as string | undefined
  const boundWorkspace =
    currentSessionId === undefined
      ? undefined
      : wsSnap.items.find((w: any) => w.sessionIds.includes(currentSessionId))

  // Keep refs in sync so the interval tick can read current values.
  rowRef.current = row
  boundRef.current = boundWorkspace !== undefined

  // Store-driven rescan: session/workspace transitions remount/unmount the
  // hero row, so re-locate it every time the state we care about changes.
  React.useEffect(() => {
    setRow(findHeroRow())
  }, [currentSessionId, boundWorkspace?.workspaceId])

  // Mount effect: attach the pill to the current row (if any) whenever the
  // row element or the bound-state changes; remove it otherwise.
  React.useEffect(() => {
    removePill(pillRef)
    if (row === null || boundWorkspace !== undefined) return
    pillRef.current = mountPill(row, sessions, workspaces)
    return () => removePill(pillRef)
  }, [row, boundWorkspace?.workspaceId, sessions, workspaces])

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
        pillRef.current = mountPill(el, sessions, workspaces)
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
    'button[data-temp-cwd]{display:inline-flex;align-items:center;gap:4px;min-height:28px;max-width:min(100%,360px);box-sizing:border-box;border-radius:16px;padding:0 8px;border:none;background:transparent;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:13px;font-weight:500;line-height:20px;cursor:pointer;order:2}',
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
function mountPill(row: HTMLElement, sessions: any, workspaces: any): HTMLButtonElement {
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
    createTempSession(sessions, workspaces)
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

  row.appendChild(btn)
  return btn
}

/* ---- helpers ---- */

/** 14px plus glyph (lucide-style), matching the host's stroke aesthetics. */
const PLUS_SVG =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
  'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M5 12h14"/><path d="M12 5v14"/></svg>'
