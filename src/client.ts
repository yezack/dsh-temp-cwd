/**
 * dsh-temp-cwd — browser half (v14, thin client / host-centric).
 *
 * Since v14 ALL temp-session lifecycle decisions live in the host process
 * (single authority, debounced, sweeped) — see src/index.ts. The browser
 * half is deliberately thin:
 *
 *   intents:   start → register → (finalize | abandon)  — plain host RPCs
 *   display:   the 「开始临时对话」 pill in the hero chip row, the frozen
 *              「临时会话」 chip while the blank temp session is open, and
 *              hiding every temp workspace row + blank child session from the
 *              sidebar tree. All display logic is idempotent and window-local,
 *              so multiple UI windows cannot race each other through it.
 *
 * The pill stays in `heroWorkspaceRow` (no injectable seat there — the two
 * hero slots are single/root and occupied by official packages), appended as
 * one plain DOM <button>. Store data is consumed through the official inject
 * `hooks` compartment (workspaceList / sessionList → useWorkspaceList /
 * useSessionList). ctx.sessions.list projects { ids, byId, current, phase,
 * … } — there is NO `items` array; entries live in `byId`.
 *
 * Workspace/session CREATION still goes through the official client
 * controllers (workspaces.create / sessions.create / sessions.open) so the
 * local stores and the current selection stay consistent with the host; the
 * host then registers the triple { path, workspaceId, sessionId } and owns
 * the folder + workspace cleanup.
 */

import * as React from 'react'

/** Stable cordis plugin name (browser half). */
export const name = 'temp-cwd-client'

/** Services required before the plugin can mount. */
export const inject = ['slots', 'sessions', 'workspaces', 'uiWorkspace']

/**
 * This window's open temp session (path + sessionId). Used only to send the
 * right host intents (finalize on first message, abandon on user clear /
 * dispose). Host owns all cleanup.
 */
let tempPending: { path: string; sessionId: string } | null = null

/**
 * True right after the USER asked for a fresh conversation (un-argued
 * startSession → our sessions.clear()). That is an explicit abandon of the
 * current blank temp session — send the host abandon intent immediately.
 */
let userRequestedClear = false

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
  // workspace (it would hide the pill). Host's own startSession clears when
  // target === undefined; replicate that. This is also the user's explicit
  // abandon signal for a blank temp session → tell the host right away.
  const originalStartSession = uiWorkspace.startSession.bind(uiWorkspace)
  uiWorkspace.startSession = (workspaceId?: string) => {
    if (workspaceId === void 0) {
      userRequestedClear = true
      sessions.clear()
      if (tempPending !== null) {
        const pending = tempPending
        tempPending = null
        hostAbandon(pending.path, pending.sessionId)
      }
      return
    }
    originalStartSession(workspaceId)
  }

  // Safety net: plugin disposed (app closing) with a pending blank temp
  // session → the host abandons it (debounced, idempotent).
  ctx.on('dispose', () => {
    if (tempPending === null) return
    const pending = tempPending
    tempPending = null
    hostAbandon(pending.path, pending.sessionId)
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
            /** Session list model: subscribe/getSnapshot → { byId, current, … }. */
            sessionList: sessions.list,
          },
          onStartTemp: () => createTempSession(sessions, workspaces),
        }),
      },
      TempCwdHost,
    ),
  )
}

/* ---- host intents (thin RPC; the host does the work) ---- */

async function hostStart(): Promise<string> {
  const res = await fetch('/api/temp-cwd/start', { method: 'POST' })
  if (!res.ok) throw new Error(`temp start failed: ${res.status}`)
  const { path } = (await res.json()) as { path: string }
  return path
}

async function hostRegister(path: string, workspaceId: string, sessionId: string): Promise<void> {
  const res = await fetch(
    `/api/temp-cwd/register?p=${encodeURIComponent(path)}&w=${encodeURIComponent(
      workspaceId,
    )}&s=${encodeURIComponent(sessionId)}`,
    { method: 'POST' },
  )
  if (!res.ok) console.warn(`[temp-cwd] register failed (${res.status})`)
}

async function hostFinalize(path: string): Promise<void> {
  try {
    await fetch(`/api/temp-cwd/finalize?p=${encodeURIComponent(path)}`, { method: 'POST' })
  } catch (err) {
    console.warn('[temp-cwd] finalize request failed:', err)
  }
}

async function hostAbandon(path: string, sessionId: string): Promise<void> {
  try {
    await fetch(
      `/api/temp-cwd/abandon?p=${encodeURIComponent(path)}&s=${encodeURIComponent(sessionId)}`,
      { method: 'POST' },
    )
  } catch (err) {
    console.warn('[temp-cwd] abandon request failed:', err)
  }
}

/* ---- create flow (client controllers for store sync + host register) ---- */

/**
 * Rename the adopted workspace to the transient title (display only),
 * appending a numeric suffix on host name conflicts.
 */
async function renameTempWorkspace(workspaces: any, workspaceId: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const title = attempt === 0 ? TEMP_WS_TITLE : `${TEMP_WS_TITLE} ${attempt + 1}`
    try {
      await workspaces.rename(workspaceId, title)
      return
    } catch (err: any) {
      if (!String(err?.message ?? err).includes('workspace-name-conflict')) {
        console.warn('[temp-cwd] rename to 临时会话 failed:', err)
        return
      }
    }
  }
  console.warn('[temp-cwd] rename to 临时会话 failed: too many name conflicts')
}

async function createTempSession(sessions: any, workspaces: any): Promise<void> {
  userRequestedClear = false

  // 1. Host scaffolds the folder + marker.
  const path = await hostStart()

  // 2. Adopt it as a real workspace (official client controller keeps the
  //    local store in sync). Do NOT rename yet — an extra round-trip before
  //    the session exists can let the host drop the session-less workspace.
  const workspace = await workspaces.create({ path })

  try {
    // 3. Session attached to that workspace, opened natively.
    const sessionId = await sessions.create({ workspaceId: workspace.workspaceId })
    await sessions.open(sessionId)

    // 4. Cosmetic rename so the official hero chip reads 「临时会话」.
    await renameTempWorkspace(workspaces, workspace.workspaceId)

    // 5. Hand the triple to the host — from here on the HOST owns cleanup.
    tempPending = { path, sessionId }
    await hostRegister(path, workspace.workspaceId, sessionId)

    // 6. Watch only for the host-shared truth: first message → finalize.
    watchFirstMessage(sessions, path, sessionId)
  } catch (err) {
    // Creation failed — tell the host to abandon the scaffold (idempotent).
    if (tempPending !== null && tempPending.path === path) {
      const pending = tempPending
      tempPending = null
      hostAbandon(pending.path, pending.sessionId)
    } else {
      hostAbandon(path, '')
    }
    throw err
  }
}

/** On the first message (blank → false), ask the host to finalize. */
function watchFirstMessage(sessions: any, path: string, sessionId: string): void {
  const dispose = sessions.list.subscribe(() => {
    const snap = sessions.list.getSnapshot()
    const byId = snap?.byId !== void 0 && snap.byId !== null ? snap.byId : {}
    const entry = byId[sessionId]
    if (entry === undefined || entry.blank !== false) return
    dispose()
    if (tempPending !== null && tempPending.sessionId === sessionId) tempPending = null
    console.info('[temp-cwd] first message — host finalize (keep folder)', path)
    void hostFinalize(path)
  })
}

/* ---- headless display host: pill + transient freeze/hide ---- */

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
  // session is still blank; restore the freeze when it ends. (Temp rows are
  // hidden unconditionally — stale temp rows never resurface either.)
  React.useEffect(() => {
    syncTransientUI(transient)
    return () => syncTransientUI(false)
  }, [transient])

  // Self-heal tick: catch row remounts and React reconciliation that
  // disturbed the appended pill or the transient DOM state (re-apply ~1.2 s).
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
      syncTransientUI(transientRef.current)
    }, 1200)
    return () => window.clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Headless: nothing visible from this seat.
  return null
}

/* ---- transient display (frozen chip + hidden sidebar rows) ---- */

/**
 * The temp workspace's sidebar rows, returned as the actual hide units.
 * DOM shape: each row div[role=treeitem] is wrapped in a SPAN (`_root_…`),
 * and one group section (`.groupSection`) holds the wrappers of a workspace
 * row followed by its session rows. Hiding the bare row div is not enough —
 * hide the WRAPPERS (temp workspace row + following session-row wrappers).
 */
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
    const wrapper = el.parentElement as HTMLElement | null
    if (wrapper === null) {
      out.push(el)
      continue
    }
    out.push(wrapper)
    const container = wrapper.parentElement
    if (container === null) continue
    const kids = Array.from(container.children)
    const index = kids.indexOf(wrapper)
    for (let i = index + 1; i < kids.length; i += 1) {
      const sibling = kids[i] as HTMLElement
      if (sibling.querySelector('div[role="treeitem"][class*="projectRow"]') !== null) break
      if (sibling.querySelector('div[role="treeitem"][class*="sessionRow"]') !== null) {
        out.push(sibling)
      }
    }
  }
  return out
}

function syncTransientUI(active: boolean): void {
  const region = tempRowRegion()

  if (!active) {
    // Chip freeze is transient-only. Temp ROWS are hidden unconditionally.
    for (const el of document.querySelectorAll('[data-tempcwd-freeze]')) {
      const chip = el as HTMLElement
      delete chip.style.pointerEvents
      if (chip.__tempCwdGuard !== undefined) {
        chip.removeEventListener('click', chip.__tempCwdGuard, true)
        chip.__tempCwdGuard = undefined
      }
      delete chip.dataset.tempcwdFreeze
    }
  } else {
    const hero = findHeroRow()
    const chip = hero === null ? null : hero.querySelector('button')
    if (chip !== null && !(chip as HTMLElement).dataset.tempcwdFreeze) {
      const el = chip as HTMLElement
      el.dataset.tempcwdFreeze = '1'
      el.style.pointerEvents = 'none'
      const guard = (event: Event) => {
        event.preventDefault()
        event.stopPropagation()
      }
      el.__tempCwdGuard = guard
      el.addEventListener('click', guard, true)
    }
  }

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

/** Append the pill right after the official 「选择工作区」 chip and wire it. */
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
        if (btn.isConnected && btn.getAttribute('data-temp-cwd-state') !== 'idle') {
          setIdle()
        }
      })
  })

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
