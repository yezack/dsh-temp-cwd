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

  // Module API bridge: ungrouped batch UI (imperative, outside the slot
  // tree) needs the controllers + root ctx (for the shared registry remote).
  api = { sessions, workspaces, ctx }

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
    if (tempPending !== null) {
      const pending = tempPending
      tempPending = null
      hostAbandon(pending.path, pending.sessionId)
    }
    stopUngroupedUi()
  })

  ensurePillStyle()
  ensureBatchStyle()
  ensureBatchOverlayStyle()
  ensureSettingsStyle()
  registerSettingsCard(ctx)
  startUngroupedUi()

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

/* ---- ungrouped batch management (UI enhancement, v15) ----
 *
 * 1. Pin the 「未分组」 group to the TOP of the sidebar list.
 * 2. The 「未分组」 header's trailing "+" (new-session-in-ungrouped, which
 *    does nothing useful) becomes a batch-manage button ("−").
 * 3. Clicking it opens a batch panel over the ungrouped sessions with
 *    归档 (official archiveSession) and 删除 (real delete via the shared
 *    `remote.workspaceRegistry.deleteSession` — disabled with a hint when
 *    @michengai/dsh-archive-manager is not installed).
 * 4. Delete asks for a second confirmation. Styling reuses the host tokens
 *    (same family as the official menus/dialogs).
 */
const MINUS_SVG =
  '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">' +
  '<path d="M3 8h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>'
const BATCH_CSS_ID = '@yezack/dsh-temp-cwd/batch.css'
const UNGROUPED_TITLE = '未分组'

let api: { sessions: any; workspaces: any; ctx: any } | null = null
let ungroupedTimer: number | null = null
let batchPanel: HTMLElement | null = null

function ensureBatchStyle(): void {
  if (typeof document === 'undefined') return
  if (document.querySelector(`style[data-plugin-css="${BATCH_CSS_ID}"]`) !== null) return
  const tag = document.createElement('style')
  tag.dataset.pluginCss = BATCH_CSS_ID
  tag.textContent = [
    // Panel surface — same visual family as official menus/dialogs.
    '.tcwd-batch{box-sizing:border-box;z-index:60;border:1px solid var(--dsw-alias-border-inverted);background:var(--dsw-specific-menu,var(--dsw-alias-bg-module-platform));border-radius:12px;box-shadow:var(--dsw-shadow-lv3);width:min(340px,calc(100vw - 24px));max-height:min(560px,calc(100vh - 120px));color:var(--dsw-alias-label-primary);font-size:13px;line-height:18px;display:flex;flex-direction:column;position:fixed;overflow:hidden}',
    '.tcwd-batchHead{box-sizing:border-box;flex:none;display:flex;align-items:center;gap:8px;min-height:40px;padding:8px 10px 8px 12px}',
    '.tcwd-batchTitle{flex:1;min-width:0;font-size:13px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.tcwd-batchClose{cursor:pointer;width:24px;height:24px;color:var(--dsw-alias-label-secondary);background:none;border:none;border-radius:7px;display:inline-flex;align-items:center;justify-content:center;flex:none}',
    '.tcwd-batchClose:hover{background:var(--dsw-alias-interactive-bg-hover)}',
    '.tcwd-batchFilter{box-sizing:border-box;flex:none;margin:0 10px 6px;height:28px;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary);padding:0 8px;font:inherit;outline:none}',
    '.tcwd-batchList{flex:1;min-height:0;overflow-y:auto;padding:0 6px 6px;--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2)}',
    '.tcwd-batchAll{flex:none;display:flex;align-items:center;gap:6px;margin:0 10px 6px;color:var(--dsw-alias-label-secondary);font-size:12px}',
    '.tcwd-batchRow{box-sizing:border-box;display:flex;align-items:center;gap:8px;min-height:30px;padding:2px 6px;border-radius:8px}',
    '.tcwd-batchRow:hover{background:var(--dsw-alias-interactive-bg-hover)}',
    '.tcwd-batchRow input[type="checkbox"],.tcwd-batchAll input[type="checkbox"]{accent-color:var(--dsw-alias-state-business-primary);width:14px;height:14px;flex:none;margin:0}',
    '.tcwd-batchName{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--dsw-alias-label-primary)}',
    '.tcwd-batchName.tcwd-blank{color:var(--dsw-alias-label-tertiary)}',
    '.tcwd-batchEmpty{padding:14px 12px;color:var(--dsw-alias-label-tertiary);text-align:center}',
    '.tcwd-batchFoot{box-sizing:border-box;flex:none;display:flex;align-items:center;gap:8px;min-height:46px;padding:8px 10px;border-top:1px solid var(--dsw-alias-border-l2)}',
    '.tcwd-batchCount{flex:1;min-width:0;color:var(--dsw-alias-label-tertiary);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.tcwd-batchBtn{border:none;border-radius:999px;padding:4px 14px;font:inherit;font-size:13px;font-weight:500;line-height:20px;cursor:pointer;flex:none}',
    '.tcwd-batchBtn:disabled{opacity:.45;cursor:default}',
    '.tcwd-batchArchive{background:var(--dsw-alias-button-ghost-active-fill,var(--dsw-alias-interactive-bg-hover));color:var(--dsw-alias-label-primary)}',
    '.tcwd-batchDelete{background:none;color:var(--dsw-alias-state-error-primary,var(--dsw-alias-danger,#f56c6c));border:1px solid transparent}',
    '.tcwd-batchDelete:not(:disabled):hover{background:var(--dsw-alias-interactive-bg-hover-danger,var(--dsw-alias-interactive-bg-hover));border-color:var(--dsw-alias-border-l2)}',
    '.tcwd-batchHint{flex:none;color:var(--dsw-alias-label-tertiary);font-size:11px;max-width:130px;white-space:normal;line-height:15px}',
    '.tcwd-batchStatus{margin:0 10px 8px;color:var(--dsw-alias-state-error-primary,var(--dsw-alias-danger,#f56c6c));font-size:12px}',
    // Second-confirm overlay.
    '.tcwd-confirm{box-sizing:border-box;z-index:70;border:1px solid var(--dsw-alias-border-inverted);background:var(--dsw-specific-menu,var(--dsw-alias-bg-module-platform));border-radius:12px;box-shadow:var(--dsw-shadow-lv3);width:min(340px,calc(100vw - 24px));color:var(--dsw-alias-label-primary);padding:14px;font-size:13px;line-height:20px;position:fixed}',
    '.tcwd-confirmTitle{font-weight:500;margin-bottom:6px}',
    '.tcwd-confirmDesc{color:var(--dsw-alias-label-secondary);margin-bottom:12px;white-space:pre-line}',
    '.tcwd-confirmActions{display:flex;justify-content:flex-end;gap:8px}',
  ].join('\n')
  document.head.appendChild(tag)
}

/**
 * Centered-dialog layer on top of the base styles: a scrim (like the host's
 * modal dimming) and the cards positioned in the flex center — matching the
 * current UI's dialog look instead of an anchored popover.
 */
function ensureBatchOverlayStyle(): void {
  if (typeof document === 'undefined') return
  if (document.querySelector(`style[data-plugin-css="${BATCH_CSS_ID}/overlay"]`) !== null) return
  const tag = document.createElement('style')
  tag.dataset.pluginCss = `${BATCH_CSS_ID}/overlay`
  tag.textContent = [
    '.tcwd-scrim{position:fixed;inset:0;z-index:55;background:var(--dsw-overlay-bg,rgba(8,10,14,.45));display:flex;align-items:center;justify-content:center;animation:tcwd-fade .12s var(--ds-ease-in-out, ease-out)}',
    '.tcwd-scrimTop{z-index:70}',
    '@keyframes tcwd-fade{from{opacity:0}}',
    // Neutralize the old anchored-popover geometry; center in the scrim.
    '.tcwd-batch{position:relative!important;left:auto!important;top:auto!important;transform:none!important;width:min(480px,calc(100vw - 32px))!important;max-height:min(620px,calc(100vh - 96px))!important;border-radius:14px}',
    '.tcwd-confirm{position:relative!important;left:auto!important;top:auto!important;transform:none!important;width:min(400px,calc(100vw - 32px))!important;border-radius:14px;box-shadow:var(--dsw-shadow-lv3)}',
    '.tcwd-batchHead{min-height:48px;padding:10px 12px 8px 16px}',
    '.tcwd-batchTitle{font-size:14px;font-weight:600;line-height:22px}',
    '.tcwd-batchClose{width:26px;height:26px;border-radius:8px}',
    '.tcwd-batchAll,.tcwd-batchFilter{margin-left:14px;margin-right:14px}',
    '.tcwd-batchFilter{height:30px;border-radius:8px}',
    '.tcwd-batchList{padding:2px 8px 8px}',
    '.tcwd-batchRow{min-height:34px;padding:2px 8px;gap:10px}',
    '.tcwd-batchName{font-size:13px;line-height:20px}',
    '.tcwd-batchFoot{min-height:52px;padding:10px 14px;gap:10px}',
    '.tcwd-batchBtn{min-height:28px;padding:2px 16px;border-radius:999px;font-size:13px;line-height:20px}',
    '.tcwd-confirmTitle{font-size:14px;font-weight:600}',
  ].join('\n')
  document.head.appendChild(tag)
}

function findUngroupedRow(): HTMLElement | null {
  const rows = Array.from(
    document.querySelectorAll('div[role="treeitem"][class*="projectRow"]'),
  )
  const row = rows.find((el) => {
    const title = el.querySelector('span[class*="projectText"]')
    return title !== null && (title.textContent ?? '').trim() === UNGROUPED_TITLE
  })
  return (row as HTMLElement | null)
}

/**
 * The tree-list child section that contains the ungrouped header row.
 * Structure-agnostic: some builds wrap each row in a SPAN, others put the
 * row straight into its groupSection — so find the `[role=tree]` container
 * and return whichever child actually contains the row.
 */
function ungroupedSection(row: HTMLElement): HTMLElement | null {
  const list = row.closest('[role="tree"]')
  if (list === null) return null
  const child = [...list.children].find((c) => c.contains(row))
  return (child as HTMLElement | null) ?? null
}

function ungroupedBatchButton(row: HTMLElement): HTMLButtonElement | null {
  const label = '未分组'
  const btn = [...row.querySelectorAll('button')].find(
    (b) =>
      (b.getAttribute('aria-label') ?? '').includes(`"${label}"`) ||
      (b.getAttribute('aria-label') ?? '').includes('“未分组”') ||
      (b.getAttribute('aria-label') ?? '').includes('在“未分组”中新建会话'),
  )
  return (btn as HTMLButtonElement | null) ?? null
}

/**
 * 1. Keep the 未分组 section pinned at the top of the sidebar tree.
 * 2. Turn its trailing "+" (new session in ungrouped) into the batch button.
 */
function syncUngroupedUi(): void {
  if (api === null || typeof document === 'undefined') return
  const row = findUngroupedRow()
  if (row === null) return

  const section = ungroupedSection(row)
  if (section !== null && section.parentElement !== null) {
    const list = section.parentElement
    if (section !== list.firstElementChild) {
      list.insertBefore(section, list.firstElementChild)
    }
  }

  const btn = ungroupedBatchButton(row)
  if (btn === null) return
  if (!btn.dataset.tempcwdBatch) {
    btn.dataset.tempcwdBatch = '1'
    const guard = (event: Event) => {
      event.preventDefault()
      event.stopPropagation()
      openBatchPanel()
    }
    btn.addEventListener('click', guard, true)
    btn.__tempCwdBatchGuard = guard
  }
  btn.setAttribute('aria-label', '批量管理未分组')
  btn.title = '批量管理未分组（归档 / 删除）'
  if (!btn.innerHTML.includes('M3 8h10')) btn.innerHTML = MINUS_SVG
}

function startUngroupedUi(): void {
  stopUngroupedUi()
  ungroupedTimer = window.setInterval(() => {
    syncUngroupedUi()
    // Close the batch panel if its anchor group disappears.
    if (batchPanel !== null && findUngroupedRow() === null) closeBatchPanel()
  }, 1200)
}

function stopUngroupedUi(): void {
  if (ungroupedTimer !== null) {
    window.clearInterval(ungroupedTimer)
    ungroupedTimer = null
  }
  closeBatchPanel()
  // Restore any patched buttons we touched.
  for (const el of document.querySelectorAll('[data-tempcwd-batch]')) {
    const btn = el as HTMLElement
    delete btn.dataset.tempcwdBatch
    if (btn.__tempCwdBatchGuard !== undefined) {
      btn.removeEventListener('click', btn.__tempCwdBatchGuard, true)
      btn.__tempCwdBatchGuard = undefined
    }
  }
}

/* ---- batch panel ---- */

interface UngroupedEntry {
  sessionId: string
  title: string
  blank: boolean
}

function ungroupedEntries(): UngroupedEntry[] {
  if (api === null) return []
  const { sessions, workspaces } = api
  const wsSnap = workspaces.list.getSnapshot()
  const sesSnap = sessions.list.getSnapshot()
  const archived = new Set(Array.isArray(wsSnap?.archivedSessionIds) ? wsSnap.archivedSessionIds : [])
  const inWorkspace = new Set<string>()
  for (const w of Array.isArray(wsSnap?.items) ? wsSnap.items : []) {
    for (const id of Array.isArray(w.sessionIds) ? w.sessionIds : []) inWorkspace.add(id)
  }
  const byId = sesSnap?.byId !== void 0 && sesSnap.byId !== null ? sesSnap.byId : {}
  const out: UngroupedEntry[] = []
  for (const id of Object.keys(byId)) {
    const entry = byId[id]
    if (archived.has(id)) continue
    if (inWorkspace.has(id)) continue
    out.push({
      sessionId: id,
      title: entry?.displayTitle ?? entry?.title ?? id,
      blank: entry?.blank === true,
    })
  }
  out.sort((a, b) => String(a.title).localeCompare(String(b.title), 'zh'))
  return out
}

function hasDeleteChannel(): boolean {
  try {
    const registry = api?.ctx?.get?.('remote.workspaceRegistry')
    return registry !== undefined && typeof registry.deleteSession === 'function'
  } catch {
    return false
  }
}

async function refreshSessionList(): Promise<void> {
  try {
    const sessions = api?.sessions
    if (sessions !== undefined && typeof sessions.refresh === 'function') {
      await sessions.refresh()
    }
  } catch (err) {
    console.warn('[temp-cwd] batch: session list refresh failed:', err)
  }
}

function displayTitle(entry: UngroupedEntry): string {
  return entry.blank ? `（空白）${entry.title}` : entry.title
}

function openBatchPanel(): void {
  if (api === null) return
  closeBatchPanel()
  const panel = document.createElement('div')
  panel.className = 'tcwd-batch'
  batchPanel = panel

  const entries = ungroupedEntries()
  const selected = new Set<string>()
  let busy = false
  let filter = ''

  const render = () => {
    panel.textContent = ''
    const head = document.createElement('div')
    head.className = 'tcwd-batchHead'
    const title = document.createElement('div')
    title.className = 'tcwd-batchTitle'
    title.textContent = `未分组 · 批量管理（${entries.length}）`
    const close = document.createElement('button')
    close.type = 'button'
    close.className = 'tcwd-batchClose'
    close.textContent = '✕'
    close.setAttribute('aria-label', '关闭')
    close.addEventListener('click', closeBatchPanel)
    head.append(title, close)

    const filterBox = document.createElement('input')
    filterBox.className = 'tcwd-batchFilter'
    filterBox.type = 'text'
    filterBox.placeholder = '筛选会话…'
    filterBox.value = filter
    filterBox.addEventListener('input', () => {
      filter = filterBox.value.trim().toLowerCase()
      render()
    })

    const visible = entries.filter((e) =>
      filter.length === 0 || displayTitle(e).toLowerCase().includes(filter),
    )

    const list = document.createElement('div')
    list.className = 'tcwd-batchList'

    const allRow = document.createElement('label')
    allRow.className = 'tcwd-batchAll'
    const allBox = document.createElement('input')
    allBox.type = 'checkbox'
    allBox.checked = visible.length > 0 && visible.every((e) => selected.has(e.sessionId))
    allBox.addEventListener('change', () => {
      for (const e of visible) {
        if (allBox.checked) selected.add(e.sessionId)
        else selected.delete(e.sessionId)
      }
      render()
    })
    const allText = document.createElement('span')
    allText.textContent = '全选'
    allRow.append(allBox, allText)

    if (visible.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'tcwd-batchEmpty'
      empty.textContent = entries.length === 0 ? '没有未分组会话' : '没有匹配的会话'
      list.append(empty)
    } else {
      for (const entry of visible) {
        const rowEl = document.createElement('label')
        rowEl.className = 'tcwd-batchRow'
        const box = document.createElement('input')
        box.type = 'checkbox'
        box.checked = selected.has(entry.sessionId)
        box.addEventListener('change', () => {
          if (box.checked) selected.add(entry.sessionId)
          else selected.delete(entry.sessionId)
          render()
        })
        const name = document.createElement('span')
        name.className = entry.blank ? 'tcwd-batchName tcwd-blank' : 'tcwd-batchName'
        name.textContent = displayTitle(entry)
        rowEl.append(box, name)
        list.append(rowEl)
      }
    }

    const foot = document.createElement('div')
    foot.className = 'tcwd-batchFoot'
    const count = document.createElement('div')
    count.className = 'tcwd-batchCount'
    count.textContent = `已选 ${selected.size}`
    const archiveBtn = document.createElement('button')
    archiveBtn.type = 'button'
    archiveBtn.className = 'tcwd-batchBtn tcwd-batchArchive'
    archiveBtn.textContent = selected.size > 0 ? `归档 ${selected.size}` : '归档'
    archiveBtn.disabled = busy || selected.size === 0
    archiveBtn.addEventListener('click', () => runBatch('archive', [...selected]))
    const deleteBtn = document.createElement('button')
    deleteBtn.type = 'button'
    deleteBtn.className = 'tcwd-batchBtn tcwd-batchDelete'
    deleteBtn.textContent = selected.size > 0 ? `删除 ${selected.size}` : '删除'
    deleteBtn.disabled = busy || selected.size === 0 || !hasDeleteChannel()
    const hint = document.createElement('div')
    hint.className = 'tcwd-batchHint'
    hint.textContent = hasDeleteChannel() ? '' : '删除依赖 archive-manager 插件'
    if (hasDeleteChannel()) hint.style.display = 'none'
    foot.append(count, hint, archiveBtn, deleteBtn)
    deleteBtn.addEventListener('click', () => confirmDelete([...selected]))

    const status = document.createElement('div')
    status.className = 'tcwd-batchStatus'
    status.style.display = 'none'

    panel.append(head, allRow, filterBox, list, foot, status)
  }

  const setStatus = (message: string | null) => {
    const status = panel.querySelector('.tcwd-batchStatus') as HTMLElement | null
    if (status === null) return
    if (message === null) status.style.display = 'none'
    else {
      status.textContent = message
      status.style.display = 'block'
    }
  }

  const runBatch = async (kind: 'archive' | 'delete', ids: string[]) => {
    if (busy || ids.length === 0) return
    busy = true
    render()
    setStatus(kind === 'archive' ? '归档中…' : '删除中…')
    const failures: string[] = []
    for (const sessionId of ids) {
      try {
        if (kind === 'archive') {
          await api!.workspaces.archiveSession(sessionId)
        } else {
          const registry = api!.ctx.get('remote.workspaceRegistry')
          const result = await registry.deleteSession(sessionId)
          if (result !== undefined && result !== null && result.ok === false) {
            throw new Error(result.error?.message ?? 'delete failed')
          }
        }
      } catch (err) {
        failures.push(`${sessionId.slice(0, 8)}…: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    await refreshSessionList()
    busy = false
    if (failures.length > 0) {
      setStatus(`完成，${failures.length} 个失败（${failures[0]}）`)
    } else {
      closeBatchPanel()
    }
  }

  const confirmDelete = (ids: string[]) => {
    if (ids.length === 0) return
    const scrim = document.createElement('div')
    scrim.className = 'tcwd-scrim tcwd-scrimTop'
    const card = document.createElement('div')
    card.className = 'tcwd-confirm'
    const title = document.createElement('div')
    title.className = 'tcwd-confirmTitle'
    title.textContent = '确认删除会话？'
    const desc = document.createElement('div')
    desc.className = 'tcwd-confirmDesc'
    desc.textContent =
      `将永久删除 ${ids.length} 个未分组会话及其全部记录，此操作无法撤销。`
    const actions = document.createElement('div')
    actions.className = 'tcwd-confirmActions'
    const cancel = document.createElement('button')
    cancel.type = 'button'
    cancel.className = 'tcwd-batchBtn tcwd-batchArchive'
    cancel.textContent = '取消'
    const confirm = document.createElement('button')
    confirm.type = 'button'
    confirm.className = 'tcwd-batchBtn tcwd-batchDelete'
    confirm.textContent = '确认删除'
    cancel.addEventListener('click', () => scrim.remove())
    confirm.addEventListener('click', () => {
      scrim.remove()
      void runBatch('delete', ids)
    })
    actions.append(cancel, confirm)
    card.append(title, desc, actions)
    scrim.append(card)
    scrim.addEventListener('click', (e) => {
      if (e.target === scrim) scrim.remove()
    })
    document.body.appendChild(scrim)
  }

  // Centered modal on a scrim, matching the current UI's dialog pattern.
  const scrim = document.createElement('div')
  scrim.className = 'tcwd-scrim'
  scrim.addEventListener('click', (e) => {
    if (e.target === scrim) closeBatchPanel()
  })
  scrim.appendChild(panel)
  document.body.appendChild(scrim)
  render()
}

function closeBatchPanel(): void {
  if (batchPanel !== null) {
    batchPanel.remove()
    batchPanel = null
  }
  for (const el of document.querySelectorAll('.tcwd-scrim, .tcwd-confirm')) el.remove()
}

/* ---- settings card: temp conversation save location (dsh-rewind style) ---- */
const SETTINGS_NS = '@yezack/dsh-temp-cwd/settings'
const SETTINGS_CSS_ID = '@yezack/dsh-temp-cwd/settings.css'

function ensureSettingsStyle(): void {
  if (typeof document === 'undefined') return
  if (document.querySelector(`style[data-plugin-css="${SETTINGS_CSS_ID}"]`) !== null) return
  const tag = document.createElement('style')
  tag.dataset.pluginCss = SETTINGS_CSS_ID
  tag.textContent = [
    '.dsh-temp-settings-card{list-style:none;margin:0}',
    '.dsh-temp-settings-header{box-sizing:border-box;display:flex;align-items:center;gap:10px;width:100%;color:var(--dsw-alias-label-primary);background:none;border:none;padding:6px 2px;cursor:pointer;text-align:left;font:inherit}',
    '.dsh-temp-settings-head-text{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}',
    '.dsh-temp-settings-name{font-size:14px;font-weight:600;line-height:20px}',
    '.dsh-temp-settings-desc{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}',
    '.dsh-temp-settings-chevron{flex:none;transition:transform .15s var(--ds-ease-in-out,ease)}',
    '.dsh-temp-settings-chevron-open{transform:rotate(180deg)}',
    '.dsh-temp-settings-body{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:12px;display:flex;flex-direction:column;gap:10px;margin-bottom:8px}',
    '.dsh-temp-settings-label{color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}',
    '.dsh-temp-settings-row{display:flex;align-items:center;gap:8px}',
    '.dsh-temp-settings-input{flex:1;min-width:0;box-sizing:border-box;height:30px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary);padding:0 10px;font:inherit;font-size:13px;outline:none}',
    '.dsh-temp-settings-input:focus{border-color:var(--dsw-alias-state-business-primary)}',
    '.dsh-temp-settings-btn{border:1px solid var(--dsw-alias-border-l2);background:none;color:var(--dsw-alias-label-secondary);border-radius:999px;padding:2px 12px;font:inherit;font-size:13px;cursor:pointer;flex:none}',
    '.dsh-temp-settings-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}',
    '.dsh-temp-settings-btn:disabled{opacity:.5;cursor:default}',
    '.dsh-temp-settings-primary{background:var(--dsw-alias-button-ghost-active-fill,var(--dsw-alias-interactive-bg-hover));border-color:transparent;color:var(--dsw-alias-label-primary)}',
    '.dsh-temp-settings-hint{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}',
    '.dsh-temp-settings-error{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}',
  ].join('\n')
  document.head.appendChild(tag)
}

/** React card rendered by the settings.plugin.item seat (no JSX). */
function SettingsRootCard(props: { api: any }): any {
  const { api } = props
  const [open, setOpen] = React.useState(false)
  const [draft, setDraft] = React.useState(() => api.read())
  const [baseline, setBaseline] = React.useState(() => api.read())
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    const dispose = api.subscribe(() => {
      const next = api.read()
      setBaseline(next)
      setDraft(next)
      setError(null)
    })
    return dispose
  }, [api])

  const dirty = draft.rootDirectory !== baseline.rootDirectory
  const writable = api.writable()

  const save = async () => {
    if (busy || !writable || !dirty) return
    setBusy(true)
    setError(null)
    try {
      await api.save({ rootDirectory: draft.rootDirectory.trim() })
      setBaseline({ rootDirectory: draft.rootDirectory.trim() })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const pickDirectory = async () => {
    setError(null)
    try {
      const picker = api.picker
      if (picker === null) {
        setError('当前环境没有可用的目录选择器，请手动输入路径')
        return
      }
      const result = await picker.pick()
      const value = result?.value ?? result ?? {}
      const path =
        typeof value.path === 'string' ? value.path : typeof value.directoryPath === 'string' ? value.directoryPath : typeof result === 'string' ? result : ''
      if (path.length > 0) setDraft({ rootDirectory: path })
      else setError('未获得目录路径')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const body = open
    ? React.createElement(
        'div',
        { className: 'dsh-temp-settings-body' },
        React.createElement('div', { className: 'dsh-temp-settings-label' }, '临时对话保存位置（目录）'),
        React.createElement(
          'div',
          { className: 'dsh-temp-settings-row' },
          React.createElement('input', {
            className: 'dsh-temp-settings-input',
            type: 'text',
            value: draft.rootDirectory,
            placeholder: '默认 ~/Documents/dsh-workspaces',
            disabled: busy || !writable,
            spellCheck: false,
            onChange: (event: any) => {
              setDraft({ rootDirectory: event.target.value })
              setError(null)
            },
          }),
          React.createElement(
            'button',
            { type: 'button', className: 'dsh-temp-settings-btn', onClick: () => void pickDirectory(), disabled: busy || !writable },
            '选择…',
          ),
        ),
        React.createElement(
          'div',
          { className: 'dsh-temp-settings-hint' },
          '留空使用默认位置；新临时对话将从保存位置读取。保存后需重启应用完全生效。',
        ),
        error !== null ? React.createElement('div', { className: 'dsh-temp-settings-error' }, error) : null,
        React.createElement(
          'div',
          { className: 'dsh-temp-settings-row', style: { justifyContent: 'flex-end' } },
          React.createElement(
            'button',
            {
              type: 'button',
              className: 'dsh-temp-settings-btn dsh-temp-settings-primary',
              onClick: () => void save(),
              disabled: busy || !writable || !dirty,
            },
            busy ? '保存中…' : '保存',
          ),
          React.createElement(
            'button',
            {
              type: 'button',
              className: 'dsh-temp-settings-btn',
              onClick: () => {
                setDraft(baseline)
                setError(null)
              },
              disabled: busy || !dirty,
            },
            '放弃修改',
          ),
        ),
      )
    : null

  return React.createElement(
    'li',
    { className: 'dsh-temp-settings-card' },
    React.createElement(
      'button',
      {
        type: 'button',
        className: 'dsh-temp-settings-header',
        'aria-expanded': open,
        onClick: () => setOpen(!open),
      },
      React.createElement(
        'span',
        { className: 'dsh-temp-settings-head-text' },
        React.createElement('span', { className: 'dsh-temp-settings-name' }, '临时对话保存位置'),
        React.createElement('span', { className: 'dsh-temp-settings-desc' }, draft.rootDirectory || '默认 ~/Documents/dsh-workspaces'),
      ),
      React.createElement(
        'svg',
        { className: `dsh-temp-settings-chevron${open ? ' dsh-temp-settings-chevron-open' : ''}`, width: 14, height: 14, viewBox: '0 0 16 16', 'aria-hidden': 'true' },
        React.createElement('path', { d: 'M4 6l4 4 4-4', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' }),
      ),
    ),
    body,
  )
}

/**
 * Register the settings card (mirrors dsh-rewind's cleanup card): bind the
 * plugin settings namespace through `settingsScope`, then contribute a keyed
 * card on `settings.plugin.item`.
 */
function registerSettingsCard(ctx: any): void {
  try {
    const clientCtx = ctx
    const inject = typeof clientCtx.inject === 'function' ? clientCtx.inject.bind(clientCtx) : null
    if (inject === null) return
    inject(['settingsScope'], (scoped: any) => {
      try {
        const scope = scoped.settingsScope.bind({ namespace: SETTINGS_NS })
        const read = () => {
          const snapshot = scope.getSnapshot()
          const value = snapshot?.value ?? {}
          return {
            rootDirectory:
              typeof value.rootDirectory === 'string' ? value.rootDirectory : '',
          }
        }
        let pickerApi: any = null
        try {
          const picker = clientCtx.get?.('directoryPicker')
          if (picker !== void 0 && typeof picker.pick === 'function') pickerApi = picker
        } catch {
          pickerApi = null
        }
        const api = {
          read,
          writable: () => scope.getSnapshot()?.writable === true,
          save: async (next: { rootDirectory: string }) => {
            await scope.set('rootDirectory', next.rootDirectory)
          },
          subscribe: (cb: () => void) => scope.subscribe(cb),
          picker: pickerApi,
        }
        scoped.slots.inject('settings.plugin.item', () =>
          scoped.slots.register(
            {
              name: 'settings.plugin.item',
              key: SETTINGS_NS,
              inject: () => ({ api }),
            },
            SettingsRootCard,
          ),
        )
      } catch (err) {
        console.warn('[temp-cwd] settings card register failed:', err)
      }
    })
  } catch (err) {
    console.warn('[temp-cwd] settingsScope unavailable:', err)
  }
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
    __tempCwdBatchGuard?: (event: Event) => void
  }
}
