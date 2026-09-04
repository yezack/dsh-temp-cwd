/**
 * dsh-temp-cwd — browser half (v13.2).
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
 * `useSessionList` from the inject `hooks` compartment
 * (`workspaceList: ctx.workspaces.list`, `sessionList: ctx.sessions.list`).
 * NOTE (0.1.2-alpha.1): ctx.sessions.list projects { ids, byId, current,
 * phase, … } — there is NO `items` array; session entries live in `byId`
 * keyed by session id (fields id/blank/running/title).
 *
 * Temp-folder lifecycle (v12+, marker-based): host mkdir scaffolds
 * <root>/<timestamp> with a `.TEMP_WORKSPACE` marker; first message removes
 * the marker and keeps the folder; abandoning before the first message
 * removes the whole folder.
 *
 * Transient UI (v13+, user requirements):
 *  - The adopted workspace is renamed to 「临时会话」 (+ numeric suffix on
 *    name conflict) so the official hero chip shows that label.
 *  - While the temp session is still blank the hero chip is frozen
 *    (capture-phase click guard + pointer-events none) — the workspace
 *    picker cannot open.
 *  - The temp workspace row and its blank child sessions are hidden from the
 *    sidebar tree. Only after the first message does the real conversation
 *    surface — the workspace is deleted and the session appears under
 *    「未分组」.
 *  - Reload / re-open resilience: an already-existing temp workspace whose
 *    blank session is current is re-adopted (tempPending + armCleanup) so
 *    first-message finalization still works; temp workspaces with NO session
 *    left behind by interrupted runs are swept (folder + workspace).
 *  - All transient DOM state is idempotent and re-applied by the 1.2 s
 *    self-heal tick, so React re-renders cannot strand a frozen chip or a
 *    hidden row.
 */

import * as React from 'react'

/** Stable cordis plugin name (browser half). */
export const name = 'temp-cwd-client'

/** Services required before the plugin can mount. */
export const inject = ['slots', 'sessions', 'workspaces', 'uiWorkspace']

/**
 * The pending temp workspace (created, not yet finalized by first message or
 * by abandon cleanup). Cleared when cleanup fires; the dispose hook and the
 * reload re-adoption logic use it as a safety net.
 */
let tempPending: { workspaceId: string; path: string } | null = null

/** Workspace ids already swept this session (store churn must not double-fire). */
const sweptOrphans = new Set<string>()

/** Display title prefix while a temp workspace is still blank. */
const TEMP_WS_TITLE = '临时会话'

/** The official hero chip row carries this CSS-module suffix (hash-prefixed). */
const HERO_ROW_SELECTOR = '[class*="heroWorkspaceRow"]'

/** css tag id for the pill stylesheet (official style-injection pattern). */
const PILL_CSS_ID = '@yezack/dsh-temp-cwd/pill.css'

/** Pill tooltip (also restored after an error revert). */
const PILL_TITLE = '创建临时工作区并直接开始对话（发送首条消息后自动归入未分组）'

/** True when a workspace title belongs to a transient temp workspace. */
function isTempTitle(title: unknown): boolean {
  return typeof title === 'string' && title.startsWith(TEMP_WS_TITLE)
}

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
  // temp-session actions kept in the apply closure.
  ctx.slots.inject('sidebar.footer.action', () =>
    ctx.slots.register(
      {
        name: 'sidebar.footer.action',
        id: 'temp-cwd',
        inject: () => ({
          hooks: {
            /** Workspace model: subscribe/getSnapshot → { items, phase, … }. */
            workspaceList: workspaces.list,
            /** Session list model: subscribe/getSnapshot → { byId, current, … }. */
            sessionList: sessions.list,
          },
          onStartTemp: () => createTempSession(sessions, workspaces),
          /** Re-arm cleanup for a temp workspace resumed after a reload. */
          onResumeArmCleanup: (workspaceId: string, path: string, sessionId: string) => {
            armCleanup(sessions, workspaces, workspaceId, path, sessionId)
          },
          /** Sweep a leftover temp workspace that has no sessions at all. */
          onForgetOrphan: (workspaceId: string, path: string) => {
            hostRemoveDir(path)
            workspaces.delete(workspaceId).catch((err: any) => {
              console.warn('[temp-cwd] orphan workspace delete failed:', err)
            })
          },
        }),
      },
      TempCwdHost,
    ),
  )
}

/**
 * Rename the adopted workspace to the transient title, appending a numeric
 * suffix while a stale temp workspace of the same name still exists (host
 * enforces unique workspace names). Best-effort: failures just warn.
 */
async function renameTempWorkspace(workspaces: any, workspaceId: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const title = attempt === 0 ? TEMP_WS_TITLE : `${TEMP_WS_TITLE} ${attempt + 1}`
    try {
      await workspaces.rename(workspaceId, title)
      return
    } catch (err: any) {
      const conflict = String(err?.message ?? err).includes('workspace-name-conflict')
      if (!conflict) {
        console.warn('[temp-cwd] rename to 临时会话 failed:', err)
        return
      }
      // Name taken — try the next suffix.
    }
  }
  console.warn('[temp-cwd] rename to 临时会话 failed: too many name conflicts')
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

  // 2. Adopt it as a real workspace — the composer renders natively from now
  //    on. (Do NOT rename yet: an extra round-trip before the session exists
  //    can let the host drop the session-less workspace, failing
  //    sessions.create with workspace-not-found.)
  const workspace = await workspaces.create({ path })
  tempPending = { workspaceId: workspace.workspaceId, path }

  try {
    // 3. Session attached to that workspace.
    const sessionId = await sessions.create({ workspaceId: workspace.workspaceId })

    // 4. Open it — native InputBar / Lexical composer.
    await sessions.open(sessionId)

    // 5. Now (cosmetically) rename to the transient title so the official
    //    hero chip reads 「临时会话」; the transient UI engages via the next
    //    store update.
    await renameTempWorkspace(workspaces, workspace.workspaceId)

    // 6. Deferred cleanup: first message finalizes the folder (marker →
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
 *   - first message (`byId[sessionId].blank === false`): real session —
 *     remove the marker (folder is kept) and delete the workspace;
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
    // ctx.sessions.list projects { ids, byId, current, phase, … } — entries
    // live in `byId` keyed by session id; there is NO `items` array. Never
    // assume the store is projected yet — a listener throw would skip
    // cleanup and leak the temp workspace.
    const byId = snap?.byId !== void 0 && snap.byId !== null ? snap.byId : {}
    const entry = byId[sessionId]
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
 * same way official slot components do, then drives the pill AND the
 * transient temp-session UI (frozen chip + hidden sidebar rows).
 */
function TempCwdHost(props: {
  /** Renderer-bound selector hook over ctx.workspaces.list. */
  useWorkspaceList: <T>(selector: (snapshot: any) => T) => T
  /** Renderer-bound selector hook over ctx.sessions.list. */
  useSessionList: <T>(selector: (snapshot: any) => T) => T
  /** Temp-session action (closure in apply). */
  onStartTemp: () => Promise<void>
  /** Re-arm cleanup for a temp workspace resumed after a reload. */
  onResumeArmCleanup: (workspaceId: string, path: string, sessionId: string) => void
  /** Sweep a leftover temp workspace that has no sessions at all. */
  onForgetOrphan: (workspaceId: string, path: string) => void
}) {
  const { useWorkspaceList, useSessionList, onStartTemp, onResumeArmCleanup, onForgetOrphan } = props

  // Workspace items (reference-stable between invalidations) — each carries
  // `sessionIds`; the official ui-conversation / ui-workspace code resolves
  // a session's workspace exactly this way.
  const wsItems = useWorkspaceList((snapshot) =>
    Array.isArray(snapshot?.items) ? snapshot.items : EMPTY_ITEMS,
  )
  // Current session id (undefined while no session is selected).
  const currentSessionId = useSessionList((snapshot) => snapshot.current)
  // Session registry: ctx.sessions.list projects { ids, byId, current, … }
  // (NO `items` array); entries live in byId keyed by session id and carry
  // id/blank/running/title. Stable fallback, never a fresh object per call.
  const sessionById = useSessionList((snapshot) =>
    snapshot?.byId !== void 0 && snapshot.byId !== null ? snapshot.byId : EMPTY_BY_ID,
  )

  const boundWs =
    currentSessionId === undefined
      ? undefined
      : wsItems.find((w: any) => w.sessionIds.includes(currentSessionId))
  const bound = boundWs !== undefined
  const currentEntry =
    currentSessionId === undefined ? undefined : sessionById[currentSessionId]
  // Transient: bound to a temp workspace whose blank conversation has NOT
  // started yet (first message flips blank → false and finalizes it).
  const transient =
    boundWs !== undefined &&
    isTempTitle(boundWs.title) &&
    currentEntry !== undefined &&
    currentEntry.blank !== false

  const [row, setRow] = React.useState<HTMLElement | null>(null)
  const pillRef = React.useRef<HTMLButtonElement | null>(null)
  const rowRef = React.useRef<HTMLElement | null>(null)
  const boundRef = React.useRef<boolean>(false)
  const transientRef = React.useRef<boolean>(false)
  const resumedRef = React.useRef<boolean>(false)

  // Keep refs in sync so the interval tick can read current values.
  rowRef.current = row
  boundRef.current = bound
  transientRef.current = transient

  // Store-driven rescan: session/workspace transitions remount/unmount the
  // hero row, so re-locate it every time the state we care about changes.
  React.useEffect(() => {
    setRow(findHeroRow())
  }, [currentSessionId, bound, transient])

  // Mount effect: attach the pill to the current row (if any) whenever the
  // row element or the bound-state changes; remove it otherwise.
  React.useEffect(() => {
    removePill(pillRef)
    if (row === null || bound) return
    pillRef.current = mountPill(row, onStartTemp)
    return () => removePill(pillRef)
  }, [row, bound, onStartTemp])

  // Transient UI effect: freeze the chip + hide the sidebar rows while a temp
  // session is still blank; restore everything as soon as it finalizes.
  React.useEffect(() => {
    syncTransientUI(transient)
    return () => syncTransientUI(false)
  }, [transient])

  // Reload resilience: if a temp workspace with a still-blank session is
  // current after (re)mount, re-arm cleanup so first-message finalization
  // and abandon cleanup still run for it.
  React.useEffect(() => {
    if (resumedRef.current || currentSessionId === undefined) return
    const resumed = wsItems.find(
      (w: any) =>
        isTempTitle(w.title) &&
        Array.isArray(w.sessionIds) &&
        w.sessionIds.includes(currentSessionId) &&
        sessionById[currentSessionId] !== undefined,
    )
    if (resumed === undefined) return
    const entry = sessionById[currentSessionId]
    if (entry === undefined || entry.blank === false) return
    const alreadyPending = tempPending !== null && tempPending.workspaceId === resumed.workspaceId
    if (alreadyPending) return
    resumedRef.current = true
    tempPending = { workspaceId: resumed.workspaceId, path: resumed.path }
    console.info('[temp-cwd] resumed blank temp session; re-arming cleanup', resumed.workspaceId)
    onResumeArmCleanup(resumed.workspaceId, resumed.path, currentSessionId)
  }, [wsItems, sessionById, currentSessionId, onResumeArmCleanup])

  // Sweep: temp workspaces left behind by interrupted runs (no sessions at
  // all) never show in the list and are removed on the next load. Never
  // sweep while a temp workspace is being created (it has no session yet for
  // a brief moment) and remember swept ids so store churn cannot double-fire.
  React.useEffect(() => {
    if (tempPending !== null) return
    for (const w of wsItems) {
      if (!isTempTitle(w.title)) continue
      const sessionsInside = Array.isArray(w.sessionIds) ? w.sessionIds : []
      if (sessionsInside.length > 0) continue
      if (sweptOrphans.has(w.workspaceId)) continue
      sweptOrphans.add(w.workspaceId)
      console.info('[temp-cwd] sweeping session-less temp workspace', w.workspaceId)
      onForgetOrphan(w.workspaceId, w.path)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsItems])

  // Self-heal tick: catch row remounts that never touch the stores and any
  // React reconciliation that disturbed the appended pill or the transient
  // DOM state (re-apply within ~1.2 s).
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
      // Re-assert transient DOM state idempotently (React may have swapped
      // the chip button or the sidebar row nodes since the last tick).
      syncTransientUI(transientRef.current)
    }, 1200)
    return () => window.clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Headless: nothing visible from this seat.
  return null
}

/* ---- transient temp-session UI (frozen chip + hidden sidebar rows) ---- */

/** The temp workspace's sidebar rows: its projectRow + following sessionRows. */
function tempRowRegion(): HTMLElement[] {
  const rows = Array.from(
    document.querySelectorAll('div[role="treeitem"][class*="projectRow"]'),
  )
  const out: HTMLElement[] = []
  for (const row of rows) {
    const title = row.querySelector('span[class*="projectText"]')
    const text = title?.textContent ?? ''
    if (!isTempTitle(text.trim())) continue
    const el = row as HTMLElement
    out.push(el)
    const parent = el.parentElement
    if (parent === null) continue
    const kids = Array.from(parent.children)
    const index = kids.indexOf(el)
    for (let i = index + 1; i < kids.length; i += 1) {
      const sibling = kids[i] as HTMLElement
      if (sibling.matches('div[role="treeitem"][class*="projectRow"]')) break
      if (sibling.matches('div[role="treeitem"][class*="sessionRow"]')) out.push(sibling)
    }
  }
  return out
}

/**
 * Apply or remove the transient presentation:
 *   - chip freeze: the official hero chip keeps its own React label (the
 *     workspace is renamed to 「临时会话»), but pointer events are disabled
 *     and a capture-phase click guard stops the workspace picker;
 *   - sidebar: every temp workspace `projectRow` and its blank `sessionRow`s
 *     are hidden while transient, and the SAME region is unhidden again when
 *     the transient state ends (region-based, so even rows whose dataset
 *     markers were lost to a React re-render get restored).
 * Idempotent; safe to call on every tick.
 */
function syncTransientUI(active: boolean): void {
  const region = tempRowRegion()

  if (!active) {
    // Un-hide the temp region rows (and any stragglers still tagged).
    for (const el of region) {
      delete el.style.display
      delete el.dataset.tempcwdHidden
    }
    for (const el of document.querySelectorAll('[data-tempcwd-hidden]')) {
      const node = el as HTMLElement
      delete node.style.display
      delete node.dataset.tempcwdHidden
    }
    for (const el of document.querySelectorAll('[data-tempcwd-freeze]')) {
      const chip = el as HTMLElement
      delete chip.style.pointerEvents
      if (chip.__tempCwdGuard !== undefined) {
        chip.removeEventListener('click', chip.__tempCwdGuard, true)
        chip.__tempCwdGuard = undefined
      }
      delete chip.dataset.tempcwdFreeze
    }
    return
  }

  // Freeze the official hero workspace chip (first <button> in the hero row;
  // the pill is not mounted while bound, so that IS the workspace chip).
  const hero = findHeroRow()
  const chip = hero === null ? null : hero.querySelector('button')
  if (chip !== null && !(chip as HTMLElement).dataset.tempcwdFreeze) {
    const el = chip as HTMLElement
    el.dataset.tempcwdFreeze = '1'
    el.style.pointerEvents = 'none'
    const guard = (event: Event) => {
      // Keep the official picker closed while the temp session is blank.
      event.preventDefault()
      event.stopPropagation()
    }
    el.__tempCwdGuard = guard
    el.addEventListener('click', guard, true)
  }

  // Hide every temp workspace row + its blank child sessions.
  for (const el of region) {
    el.dataset.tempcwdHidden = '1'
    el.style.display = 'none'
  }
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

/** Stable empty list shared by the workspace selector (never a fresh [] per call). */
const EMPTY_ITEMS: any[] = []

/** Stable empty registry shared by the session selector (never a fresh {} per call). */
const EMPTY_BY_ID: Record<string, any> = {}

/** 14px plus glyph (lucide-style), matching the host's stroke aesthetics. */
const PLUS_SVG =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
  'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M5 12h14"/><path d="M12 5v14"/></svg>'

// TS: annotate the ad-hoc capture-guard field used on the chip element.
declare global {
  interface HTMLElement {
    __tempCwdGuard?: (event: Event) => void
  }
}
