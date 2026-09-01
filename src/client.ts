/**
 * dsh-temp-cwd — browser half (v5).
 *
 * Shadows the hero workspace slot `conversation.hero.workspace` at priority -1
 * (single slots render the lowest-priority entry), placing this row in the New
 * Session screen between the hardcoded workspace chip and the agent-preset
 * seat.
 *
 * 「临时会话」 click flow (v5 — the composer stays 100% NATIVE, no custom
 * input box):
 *   1. POST /api/temp-cwd/mkdir   → host creates <root>/<timestamp>
 *   2. workspaces.create({ path }) → adopt the temp dir as a REAL workspace
 *                                    (official path — the hero chip gets a
 *                                    title, so the composer renders exactly
 *                                    like a normal workspace session)
 *   3. sessions.create({ workspaceId }) → session attached to that workspace
 *   4. sessions.open(sessionId)    → native InputBar / Lexical composer
 *   5. workspaces.delete(workspaceId) → the host keeps the files and the
 *                                    session records but moves the session
 *                                    into 「未分组」 (official behavior:
 *                                    "文件夹与会话记录会保留，其会话将显示在
 *                                    '未分组' 下")
 *   6. unlockComposer() fallback  → after the workspace is gone,
 *                                    sessionWorkspace becomes undefined and,
 *                                    while the session is still blank, the
 *                                    host re-locks the bar (chipTitle →
 *                                    undefined → inert). We re-enable it with
 *                                    the host's OWN editor (never a custom
 *                                    input): fiber-walk from the input div to
 *                                    the InputBar fiber, take
 *                                    keyboard.editor, setRootElement +
 *                                    setEditable(true).
 *
 * v5 replaces the v4 cwd-only session flow: creating a cwd-only session made
 * the host render the composer in "workspace trigger" mode (editor: null),
 * which we then had to unlock by hand — the unlocked bar looked different
 * from a normal session's. Creating a real workspace + session first means
 * the composer the user sees IS the native one.
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
 * Module-level temp cwd, shared with the global unlocker so the fallback
 * keeps working even after the hero row unmounts (e.g. once the session
 * opens and the shell leaves the hero view).
 */
let tempCwd: string | null = null

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

  // Global fallback unlocker (v5 step 6): after the temp workspace is deleted
  // the session still being blank makes the host re-lock the composer bar.
  // This observer lives for the whole plugin lifetime so the fallback works
  // no matter what mounts/unmounts around it.
  const mo = new MutationObserver(() => {
    if (tempCwd !== null) unlockComposer()
  })
  mo.observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['contenteditable', 'class'],
  })
  // Scan once in case a bar was already locked before we started observing.
  if (tempCwd !== null) unlockComposer()
  ctx.on('dispose', () => mo.disconnect())

  ctx.slots.inject('conversation.hero.workspace', () =>
    ctx.slots.register(
      {
        name: 'conversation.hero.workspace',
        priority: -1,
        inject: () => ({
          /** Official session controller: create({ workspaceId }) / open(id). */
          sessions,
          /** Official workspace controller: create({ path }) / delete(id). */
          workspaces,
          /** Workspace projection model: subscribe / getSnapshot / items / phase. */
          workspacesModel: workspaces.list,
        }),
      },
      TempWorkspaceRow,
    ),
  )
}

/**
 * Fallback unlock of the host's own composer after the temp workspace is
 * deleted (v5 step 6).
 *
 * Why: with the workspace gone, `sessionWorkspace` is undefined and, while
 * the session is still blank (no messages yet), the host computes
 * `inert = hero && chipTitle === void 0` → the composer bar renders in
 * "workspace trigger" mode: `editor: null` is passed to
 * ComposerContentEditable (no Lexical binding at all) and the "choose a
 * workspace" placeholder overlay is shown. There is NO __lexicalEditor to
 * flip — the old v3 DOM unlock can never fire.
 *
 * The escape hatch: the host's *own* editor variable in InputBar is
 * `keyboard?.editor ?? null` — a fully functional Lexical instance whose
 * keymap is already registered — it is only the *child* prop that is
 * nulled. So we walk the React fiber chain from div[data-composer-input]
 * up to the InputBar fiber and take `memoizedProps.keyboard.editor`, then
 * do what ComposerContentEditable would have done:
 *   - editor.setRootElement(el)   → bind the live editor to the div
 *   - editor.setEditable(true)    → host Bc() restores contentEditable +
 *                                   __lexicalEditor; the host's layout
 *                                   effect ([editor, editable] deps never
 *                                   change) does not re-lock
 * plus DOM-level guards:
 *   - hide the [data-composer-placeholder] overlay ("choose a workspace")
 *   - capture-phase stopPropagation on the INPUT itself (never the card —
 *     that would swallow every child's clicks, e.g. the send button) so
 *     clicking the input focuses typing instead of opening the picker
 *   - a bubble-phase keydown listener on the input (registered AFTER
 *     Lexical's own listener, which runs first) that stops propagation so
 *     React's synthetic onKeyDown (workspace-trigger Enter/Space → open
 *     picker) never fires, while Lexical still handles Enter/submit.
 * All guards gate on the host still being in workspace-trigger mode
 * (the div carries onKeyDown only then), so once the host takes over
 * they become inert automatically.
 */
function unlockComposer(): void {
  if (tempCwd === null) return
  const el = document.querySelector('[data-composer-input]') as HTMLElement | null
  if (!el) return

  // The host passes onKeyDown to this div ONLY in the workspace-trigger
  // mode (workspaceTrigger → onWorkspaceKeyDown). Once the shell leaves
  // blank/hero the prop disappears — that is our signal that the host has
  // taken over and we must stop interfering.
  const hostOnKeyDown = () => {
    const fiberKey = Object.keys(el).find((k) => k.startsWith('__reactFiber$'))
    const hostFiber = fiberKey ? (el as any)[fiberKey] : null
    return !!(hostFiber && hostFiber.memoizedProps && hostFiber.memoizedProps.onKeyDown)
  }

  // 1. InputBar fiber → keyboard.editor (never null once the session is
  //    open, even though the child prop was nulled by the host).
  let editor: any = null
  const fiberKey = Object.keys(el).find((k) => k.startsWith('__reactFiber$'))
  let node = fiberKey ? (el as any)[fiberKey] : null
  while (node && !editor) {
    const mp = node.memoizedProps
    if (mp && mp.keyboard && mp.keyboard.editor) editor = mp.keyboard.editor
    node = node.return
  }
  if (!editor || !hostOnKeyDown()) return // not in trigger mode / not booted — observer retries

  // 2. Bind the live editor to the div (idempotent).
  if (editor.getRootElement?.() !== el) editor.setRootElement(el)

  // 3. Unlock. The host's Bc() restores contentEditable + __lexicalEditor;
  //    its layout effect does not re-run (deps unchanged).
  try {
    if (editor.isEditable?.() !== true) editor.setEditable(true)
  } catch {
    /* Lexical not fully booted yet — the observer will retry. */
  }
  if (el.contentEditable !== 'true') el.contentEditable = 'true'

  // 4. Hide the "choose a workspace" placeholder overlay (sibling of the
  //    input inside the grow container). React removes it once a draft
  //    exists, so this is only needed while the user is about to type.
  const ph = el.parentElement?.querySelector('[data-composer-placeholder]') as HTMLElement | null
  if (ph && ph.style.display !== 'none') ph.style.display = 'none'

  // 5. Click on the input must focus typing, not open the workspace picker.
  //    Capture-phase stopPropagation on the INPUT itself (never the card —
  //    that would swallow every child's clicks, e.g. the send button). It
  //    only blocks while the host is still in workspace-trigger mode.
  if (!(el as any).__tempCwdClickGuarded) {
    ;(el as any).__tempCwdClickGuarded = true
    el.addEventListener(
      'click',
      (e: Event) => {
        if (hostOnKeyDown()) e.stopPropagation()
      },
      true,
    )
  }

  // 6. Keydown: Lexical's own listener (registered at setRootElement,
  //    step 2 — before this one) runs first and handles Enter/submit and
  //    text input; our bubble-phase listener then stops propagation so the
  //    host's synthetic onKeyDown (workspace-trigger Enter/Space → open
  //    picker) cannot fire. Only active while WE hold the unlock.
  if (!(el as any).__tempCwdKeyGuarded) {
    ;(el as any).__tempCwdKeyGuarded = true
    el.addEventListener('keydown', (e: KeyboardEvent) => {
      if (hostOnKeyDown()) e.stopPropagation()
    })
  }
}

function TempWorkspaceRow(props: any) {
  const { open, anchorRef, onPick, onClose, workspacesModel, selectedId, sessions, workspaces } = props
  const [busy, setBusy] = React.useState(false)
  const [hovered, setHovered] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [rect, setRect] = React.useState<{ top: number; left: number } | null>(null)
  const panelRef = React.useRef<HTMLDivElement | null>(null)
  const btnRef = React.useRef<HTMLButtonElement | null>(null)

  // Mirrors the module-level `tempCwd` so the chip can re-render. Seeded from
  // the module value so re-mounts (e.g. returning to the hero) restore it.
  const [tempCwdState, setTempCwdState] = React.useState<string | null>(() => tempCwd)
  const selectedIdRef = React.useRef(selectedId)
  selectedIdRef.current = selectedId

  // Empty hero: no pending workspace and no session workspace yet. The host
  // hardcodes a WorkspaceChip into heroWorkspaceRow (outside any slot), whose
  // placeholder state is "选择工作区". anchorRef IS that chip's DOM node, so
  // we hide it while empty — the workspace area stays blank until the user
  // actually picks/creates one (e.g. via 临时会话). After 临时会话 the temp
  // workspace exists while the session opens, then is deleted — selectedId
  // goes back to undefined and the host chip hides again.
  const isEmpty = selectedId === void 0
  React.useEffect(() => {
    const chip = anchorRef?.current as HTMLElement | null
    if (!chip) return
    chip.style.display = isEmpty ? 'none' : ''
    return () => {
      // Never leave the host chip hidden if this entry ever unmounts.
      if (chip) chip.style.display = ''
    }
  }, [isEmpty, anchorRef])

  // Reactive workspace projection from the injected model.
  const snapshot = React.useSyncExternalStore(
    (cb) => workspacesModel.subscribe(cb),
    () => workspacesModel.getSnapshot(),
  )
  const workspacesList = snapshot?.items ?? []

  // Position the popover under the chip once the host opens it. When the chip
  // is hidden (empty hero) fall back to our own button rect.
  React.useEffect(() => {
    if (!open) return
    const host = anchorRef?.current
    const el = host && host.getBoundingClientRect().width > 0 ? host : btnRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    setRect({ top: r.bottom + 4, left: r.left })
  }, [open, anchorRef])

  // Close on outside click / Escape while open.
  React.useEffect(() => {
    if (!open) return
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Node
      if (panelRef.current?.contains(target)) return
      if (anchorRef?.current?.contains(target)) return
      onClose?.()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose?.()
    }
    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, onClose, anchorRef])

  const handleTemp = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/temp-cwd/mkdir', { method: 'POST' })
      if (!res.ok) throw new Error(`mkdir failed: ${res.status}`)
      const { path } = (await res.json()) as { path: string }

      // 1. Adopt the temp directory as a REAL workspace (official path) —
      //    from this moment on the composer renders natively, identical to
      //    any normal workspace session.
      const workspace = await workspaces.create({ path })

      // 2. Create a session attached to that workspace.
      const sessionId = await sessions.create({ workspaceId: workspace.workspaceId })
      tempCwd = path
      setTempCwdState(path)

      // 3. Open it — native InputBar / Lexical composer.
      await sessions.open(sessionId)

      // 4. Remove the workspace. The host keeps the files and the session
      //    records and moves the session into 「未分组」 (official behavior).
      await workspaces.delete(workspace.workspaceId)

      onClose?.()

      // 5. Fallback: the session is still blank and sessionWorkspace is gone,
      //    so the host re-locks the bar (chipTitle → undefined). Unlock it
      //    with the host's own editor. The global observer also covers this.
      unlockComposer()
    } catch (err) {
      console.error('[temp-cwd] failed to open temp session:', err)
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  // "Temp session" chip: renders the temp directory label while the session
  // is ungrouped (temp workspace deleted → selectedId is void 0). The host's
  // own chip stays hidden, so this is the only chip in the row and the UI
  // reads as "a temp directory is selected".
  const showTempChip = tempCwdState !== null && selectedId === void 0 && !busy

  return React.createElement(
    React.Fragment,
    null,
    React.createElement(
      'button',
      {
        ref: btnRef,
        type: 'button',
        disabled: busy,
        onClick: handleTemp,
        onMouseEnter: () => setHovered(true),
        onMouseLeave: () => setHovered(false),
        title: '创建临时目录并直接开始对话（会话进入未分组）',
        style: {
          ...chipStyle,
          background: hovered ? 'var(--dsw-alias-interactive-bg-hover)' : 'transparent',
          opacity: busy ? 0.65 : 1,
          cursor: busy ? 'wait' : 'pointer',
        },
      },
      busy ? '创建中…' : '临时会话',
    ),
    showTempChip
      ? React.createElement(
          'div',
          { style: selectedChipStyle, title: tempCwdState ?? void 0 },
          folderIcon(),
          React.createElement(
            'span',
            { style: { overflow: 'hidden', textOverflow: 'ellipsis' } },
            dirLabel(tempCwdState ?? ''),
          ),
        )
      : null,
    error
      ? React.createElement('div', { role: 'alert', style: errorStyle }, error)
      : null,
    open && rect
      ? React.createElement(
          'div',
          { ref: panelRef, style: { ...panelStyle, top: rect.top, left: rect.left } },
          React.createElement('div', { style: panelTitleStyle }, '工作区'),
          workspacesList.length === 0
            ? React.createElement('div', { style: emptyStyle }, '暂无工作区')
            : workspacesList.map((workspace: any) =>
                React.createElement(
                  'button',
                  {
                    key: workspace.workspaceId,
                    type: 'button',
                    style: itemStyle,
                    onClick: () => {
                      onPick?.(workspace.workspaceId)
                      onClose?.()
                    },
                  },
                  workspace.title ?? workspace.path ?? workspace.workspaceId,
                ),
              ),
        )
      : null,
  )
}

/* ---- helpers ---- */

/** Last path segment of a temp cwd, e.g. "20260901-162336". */
function dirLabel(path: string): string {
  const parts = path.split(/[\\/]/)
  return parts[parts.length - 1] || path
}

/** Minimal lucide-style folder icon, matching the host WorkspaceChip glyph. */
function folderIcon() {
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
    React.createElement('path', { d: 'M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z' }),
  )
}

/* ---- inline styles (aligned with the host WorkspaceChip / design tokens) ---- */

const chipStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  minHeight: 28,
  padding: '0 8px',
  borderRadius: 16,
  border: 'none',
  color: 'var(--dsw-alias-label-secondary)',
  fontSize: 13,
  fontWeight: 500,
  lineHeight: '20px',
  whiteSpace: 'nowrap',
}

/** Selected-state chip: subtle fill + border so it reads as an active pick. */
const selectedChipStyle = {
  ...chipStyle,
  maxWidth: 220,
  color: 'var(--dsw-alias-label-primary)',
  background: 'var(--dsw-alias-interactive-bg-hover)',
  border: '1px solid var(--dsw-alias-border-l2)',
  cursor: 'default',
}

const errorStyle = {
  color: 'var(--dsw-alias-danger, #f56c6c)',
  fontSize: 12,
  lineHeight: '16px',
  padding: '0 8px',
}

const panelStyle = {
  position: 'fixed',
  zIndex: 1000,
  minWidth: 220,
  maxWidth: 320,
  maxHeight: 280,
  overflowY: 'auto',
  padding: 4,
  borderRadius: 12,
  background: 'var(--dsw-alias-bg-module-platform)',
  border: '1px solid var(--dsw-alias-border-l2)',
  boxShadow: '0 8px 24px rgba(0, 0, 0, 0.35)',
}

const panelTitleStyle = {
  padding: '4px 8px 6px',
  color: 'var(--dsw-alias-label-tertiary)',
  fontSize: 12,
  lineHeight: '16px',
}

const itemStyle = {
  display: 'block',
  width: '100%',
  boxSizing: 'border-box',
  padding: '6px 8px',
  borderRadius: 8,
  border: 'none',
  background: 'transparent',
  color: 'var(--dsw-alias-label-primary)',
  fontSize: 13,
  lineHeight: '20px',
  textAlign: 'left',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  cursor: 'pointer',
}

const emptyStyle = {
  padding: '8px',
  color: 'var(--dsw-alias-label-tertiary)',
  fontSize: 13,
  lineHeight: '20px',
}
