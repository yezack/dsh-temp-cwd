// String-level contract verification for dist/client.js (the sandbox eval
// path is unreliable under Node 22 type-stripping; browser runtime differs).
const fs = require('node:fs')
const path = require('node:path')

const code = fs.readFileSync(path.join(__dirname, '..', 'dist', 'client.js'), 'utf8')

const checks = [
  ['ModuleLoader load wrapper', () => code.trimStart().startsWith('window.__ModuleLoader__.load({')],
  ['id equals package name', () => code.includes('id: "@yezack/dsh-temp-cwd"')],
  ['factory(require) signature', () => code.includes('factory: (require) => {')],
  ['module/exports shim', () => code.includes('var module = { exports: {} };') && code.includes('var exports = module.exports;')],
  ['returns module.exports', () => code.includes('return module.exports;')],
  ['plugin name export', () => code.includes('var name = "temp-cwd-client"')],
  ['inject slots+sessions+workspaces+uiWorkspace', () => code.includes('var inject = ["slots", "sessions", "workspaces", "uiWorkspace"]')],
  ['apply exported', () => /function apply\(ctx\)/.test(code) && code.includes('apply: () => apply')],
  ['slots.inject usage', () => code.includes('slots.inject')],
  ['sidebar.footer.action seat + temp-cwd id (headless host)', () =>
    /slots\.inject\(\s*["']sidebar\.footer\.action["']/.test(code) &&
    /id:\s*["']temp-cwd["']/.test(code)],
  ['official store consumption via inject hooks compartment', () =>
    code.includes('workspaceList: workspaces.list') &&
    code.includes('sessionList: sessions.list')],
  ['renderer-bound selector props; no direct useSyncExternalStore', () =>
    code.includes('useWorkspaceList') &&
    code.includes('useSessionList') &&
    !code.includes('useSyncExternalStore')],
  ['sessionIds binding check (official ui lookup)', () => code.includes('sessionIds.includes')],
  ['host intents only (v14): start/register/finalize/abandon', () =>
    code.includes('/api/temp-cwd/start') &&
    code.includes('/api/temp-cwd/register?p=') &&
    code.includes('/api/temp-cwd/finalize?p=') &&
    code.includes('/api/temp-cwd/abandon?p=') &&
    code.includes('hostRegister') &&
    code.includes('hostFinalize') &&
    code.includes('hostAbandon')],
  ['no client-side workspace delete (host temp cleanup); batch archive ok (v15)', () =>
    !code.includes('workspaces.delete(') &&
    !code.includes('hostRemoveDir') &&
    !code.includes('remove-dir?p=') &&
    code.includes('workspaces.archiveSession(sessionId)') &&
    code.includes('deleteSession')],
  ['tempPending tracks path + sessionId', () =>
    code.includes('tempPending') &&
    /\btempPending = \{ path, sessionId \}/.test(code)],
  ['user new-session sends host abandon', () =>
    code.includes('userRequestedClear') &&
    code.includes('sessions.clear()') &&
    code.includes('hostAbandon(pending.path, pending.sessionId)')],
  ['first-message watcher sends host finalize (byId registry)', () =>
    code.includes('byId[sessionId]') &&
    code.includes('entry.blank !== false') &&
    code.includes('hostFinalize(path)')],
  ['startSession wrapper (Bug A)', () =>
    code.includes('startSession = (workspaceId) => {') &&
    code.includes('sessions.clear()')],
  ['no hero seat shadowing', () =>
    !/slots\.inject\(["']conversation\.hero/.test(code) &&
    !code.includes('priority: -1') &&
    !code.includes('__reactFiber$') &&
    !code.includes('MutationObserver') &&
    !code.includes('setRootElement')],
  ['transient rename, conflict-safe', () =>
    code.includes('TEMP_WS_TITLE') &&
    code.includes('workspaces.rename(workspaceId, title)') &&
    code.includes('workspace-name-conflict')],
  ['transient UI freeze + sidebar hide', () =>
    code.includes('syncTransientUI') &&
    code.includes('tempcwdFreeze') &&
    code.includes('tempcwdHidden') &&
    code.includes('projectRow') &&
    code.includes('sessionRow')],
  ['zero react-dom (pure-DOM pill)', () =>
    !code.includes('react-dom') &&
    !code.includes('createPortal')],
  ['hero row finder', () => code.includes('[class*="heroWorkspaceRow"]')],
  ['imperative pill mount', () =>
    code.includes('data-temp-cwd') &&
    code.includes('mountPill') &&
    code.includes('ensurePillStyle') &&
    code.includes('开始临时对话')],
  ['row self-heal interval', () =>
    code.includes('setInterval') &&
    code.includes('el.contains(pill)')],
]

let failed = false
for (const [label, fn] of checks) {
  const ok = fn()
  if (!ok) failed = true
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`)
}
if (failed) {
  console.error('client contract check FAILED')
  process.exit(1)
}
console.log('client contract OK (string-level)')
