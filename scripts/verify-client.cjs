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
  ['inject sessions', () => code.includes('sessions')],
  ['apply exported', () => /function apply\(ctx\)/.test(code) && code.includes('apply: () => apply')],
  ['slots.inject usage', () => code.includes('slots.inject')],
  ['sidebar.footer.action seat + temp-cwd id (headless host)', () =>
    /slots\.inject\(\s*["']sidebar\.footer\.action["']/.test(code) &&
    /id:\s*["']temp-cwd["']/.test(code)],
  ['workspaces.create + delete', () => code.includes('workspaces.create({ path })') && code.includes('workspaces.delete(workspace.workspaceId)')],
  ['sessions.create workspaceId', () => code.includes('sessions.create({ workspaceId: workspace.workspaceId })')],
  ['blank-first-message cleanup (defensive items read)', () => code.includes('sessions.list.subscribe') && code.includes('entry.blank === false') && /snap\??\.current !== sessionId/.test(code) && code.includes('Array.isArray(snap')],
  ['startSession wrapper', () => code.includes('startSession = (workspaceId) => {') && code.includes('sessions.clear()')],
  ['no hero seat shadowing', () =>
    !/slots\.inject\(["']conversation\.hero/.test(code) &&
    !code.includes('priority: -1') &&
    !code.includes('__reactFiber$') &&
    !code.includes('MutationObserver') &&
    !code.includes('setRootElement')],
  ['official store consumption via inject hooks compartment (v11)', () =>
    code.includes('workspaceList: workspaces.list') &&
    code.includes('sessionList: sessions.list')],
  ['renderer-bound selector props; no direct useSyncExternalStore (v11)', () =>
    code.includes('useWorkspaceList') &&
    code.includes('useSessionList') &&
    !code.includes('useSyncExternalStore')],
  ['sessionIds binding check (official ui lookup)', () => code.includes('sessionIds.includes')],
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
