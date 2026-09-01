/**
 * dsh-temp-cwd — browser half (v4).
 *
 * Shadows the hero workspace slot `conversation.hero.workspace` at priority -1
 * (single slots render the lowest-priority entry), placing this row in the New
 * Session screen between the hardcoded workspace chip and the agent-preset
 * seat.
 *
 * 「临时会话」 click flow — the session goes straight to the UNGROUPED list
 * (no workspace is created or adopted, no official package is touched):
 *   1. POST /api/temp-cwd/mkdir     → host creates <root>/<timestamp>
 *   2. sessions.create({ cwd })     → a cwd-only session (ungrouped)
 *   3. sessions.open(sessionId)
 *
 * v4 fixes (host ui-conversation client.js behavior):
 *
 * A. 「新会话」 defaulting to the last workspace — the host's
 *    uiWorkspace.startSession() resolves `target = workspaceId ??
 *    currentWorkspaceId ?? recentWorkspace(...)`, so the un-argued New-Session
 *    button (ui-sidebar) re-attaches the current/recent workspace. We wrap
 *    startSession on the service instance: an un-argued call goes straight to
 *    sessions.clear() — byte-for-byte the host's own `target === void 0`
 *    branch — leaving the hero in the empty (ungrouped) state.
 *
 * B. Composer staying locked after 临时会话 — a cwd-only session has no
 *    sessionWorkspace, so chipTitle === undefined and, while the shell is
 *    still blank (fresh session, summaryBlank), the host computes
 *    `inert = hero && chipTitle === void 0` → the composer bar renders in
 *    "workspace trigger" mode: `editor: null` is passed to
 *    ComposerContentEditable (no Lexical binding at all), the card opens the
 *    workspace picker on click, and the "choose a workspace" placeholder
 *    overlay is shown. There is NO __lexicalEditor to flip — the old v3 DOM
 *    unlock can never fire.
 *
 *    The escape hatch: the host's *own* editor variable in InputBar is
 *    `keyboard?.editor ?? null` — a fully functional Lexical instance whose
 *    keymap is already registered — it is only the *child* prop that is
 *    nulled. So we walk the React fiber chain from div[data-composer-input]
 *    up to the InputBar fiber and take `memoizedProps.keyboard.editor`, then
 *    do what ComposerContentEditable would have done:
 *      - editor.setRootElement(el)   → bind the live editor to the div
 *      - editor.setEditable(true)    → host Bc() restores contentEditable +
 *                                     __lexicalEditor; the host's layout
 *                                     effect ([editor, editable] deps never
 *                                     change) does not re-lock
 *    plus DOM-level guards:
 *      - hide the [data-composer-placeholder] overlay ("choose a workspace")
 *      - capture-phase stopPropagation on the INPUT itself (never the card —
 *        that would swallow every child's clicks, e.g. the send button) so
 *        clicking the input focuses typing instead of opening the picker
 *      - a bubble-phase keydown listener on the input (registered AFTER
 *        Lexical's own listener, which runs first) that stops propagation so
 *        React's synthetic onKeyDown (workspace-trigger Enter/Space → open
 *        picker) never fires, while Lexical still handles Enter/submit.
 *      All guards gate on the host still being in workspace-trigger mode
 *      (the div carries onKeyDown only then), so once the host takes over
 *      they become inert automatically.
 *    Once the first message is sent the shell leaves blank → hero → inert
 *    all resolve, the host renders the real composer and takes over; our
 *    guards become inert.
 *
 * The shadowed official picker is replaced with a lightweight workspace list
 * popover (open=true when the host chip is clicked), so workspace switching in
 * the hero keeps working.
 */

import * as React from 'react'

/** Stable cordis plugin name (browser half). */
export const name = 'temp-cwd-client'

/** Services required before the slot entry can mount. */
export const inject = ['slots', 'sessions', 'workspaces', 'uiWorkspace']

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

  ctx.slots.inject('conversation.hero.workspace', () =>
    ctx.slots.register(
      {
        name: 'conversation.hero.workspace',
        priority: -1,
        inject: () => ({
          /** Official session controller: create({ cwd }) / open(id). */
          sessions,
          /** Workspace projection model: subscribe / getSnapshot / items / phase. */
          workspacesModel: workspaces.list,
        }),
      },
      TempWorkspaceRow,
    ),
  )
}

function TempWorkspaceRow(props: any) {
  const { open, anchorRef, onPick, onClose, workspacesModel, selectedId, sessions } = props
  const [busy, setBusy] = React.useState(false)
  const [hovered, setHovered] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [rect, setRect] = React.useState<{ top: number; left: number } | null>(null)
  const panelRef = React.useRef<HTMLDivElement | null>(null)
  const btnRef = React.useRef<HTMLButtonElement | null>(null)

  // The cwd of the temp session we created. Lives in refs so the
  // MutationObserver callback never sees a stale closure.
  const tempCwdRef = React.useRef<string | null>(null)
  const selectedIdRef = React.useRef(selectedId)
  selectedIdRef.current = selectedId

  // Empty hero: no pending workspace and no session workspace yet. The host
  // hardcodes a WorkspaceChip into heroWorkspaceRow (outside any slot), whose
  // placeholder state is "选择工作区". anchorRef IS that chip's DOM node, so
  // we hide it while empty — the workspace area stays blank until the user
  // actually picks/creates one (e.g. via 临时会话).
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
  const workspaces = snapshot?.items ?? []

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

  // Unlock the composer for cwd-only (ungrouped) sessions created via
  // 临时会话.
  //
  // Why this is needed: while the fresh cwd-only session keeps the shell in
  // the blank/hero phase, the host renders the composer in "workspace trigger"
  // mode — `editor: null` is passed to ComposerContentEditable, so
  // el.__lexicalEditor does NOT exist and there is nothing to flip. The real
  // editor is alive on the InputBar fiber's own props (`keyboard.editor`,
  // keymap already registered), so we bind and enable it ourselves:
  //   1. walk the React fiber chain up from the div to the InputBar fiber;
  //   2. editor.setRootElement(el) — same call ComposerContentEditable makes;
  //   3. editor.setEditable(true) — the host's Bc() helper restores
  //      contentEditable="true" AND __lexicalEditor; the host's layout effect
  //      (deps [editor, editable] never change) does not re-lock.
  // Plus DOM guards so the workspace-trigger affordances cannot interfere:
  //   - the "choose a workspace" placeholder overlay is hidden;
  //   - capture-phase stopPropagation on the INPUT itself (never the card —
  //     that would swallow every child's clicks, e.g. the send button) so
  //     clicking the input focuses typing instead of opening the picker;
  //   - a bubble-phase keydown listener on the input is registered AFTER
  //     Lexical's own listener, so Lexical runs first (Enter submits, typing
  //     works) and our stopPropagation keeps React's synthetic onKeyDown
  //     (workspace-trigger Enter/Space → open picker) from firing.
  //   All guards gate on the host still being in workspace-trigger mode
  //   (the div carries onKeyDown only then), so once the host takes over
  //   they become inert automatically.
  const unlockComposer = () => {
    if (tempCwdRef.current === null) return
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

  React.useEffect(() => {
    // React may re-render the composer bar (node replacement, attribute
    // changes) after we unlock; re-apply every time anything relevant moves.
    const mo = new MutationObserver(() => {
      if (tempCwdRef.current !== null) unlockComposer()
    })
    mo.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['contenteditable', 'class'],
    })
    // Scan once in case the lock was applied before this observer mounted.
    unlockComposer()
    return () => mo.disconnect()
  }, [])

  const handleTemp = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/temp-cwd/mkdir', { method: 'POST' })
      if (!res.ok) throw new Error(`mkdir failed: ${res.status}`)
      const { path } = (await res.json()) as { path: string }
      const sessionId = await sessions.create({ cwd: path })
      tempCwdRef.current = path
      await sessions.open(sessionId)
      onClose?.()
      unlockComposer()
    } catch (err) {
      console.error('[temp-cwd] failed to open temp session:', err)
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  // "Workspace selected" chip: renders the temp directory label after 临时会话
  // created a cwd-only (ungrouped) session. The host's own chip stays hidden
  // (selectedId is still void 0 — no workspace exists), so this is the only
  // chip in the row and the UI reads as "a workspace is selected".
  const showTempChip = tempCwdRef.current !== null && selectedId === void 0 && !busy

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
          { style: selectedChipStyle, title: tempCwdRef.current ?? void 0 },
          folderIcon(),
          React.createElement(
            'span',
            { style: { overflow: 'hidden', textOverflow: 'ellipsis' } },
            dirLabel(tempCwdRef.current ?? ''),
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
          workspaces.length === 0
            ? React.createElement('div', { style: emptyStyle }, '暂无工作区')
            : workspaces.map((workspace: any) =>
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
