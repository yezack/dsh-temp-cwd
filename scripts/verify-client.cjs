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
  ['sidebar.footer.action slot + temp-cwd id (v9)', () =>
    /slots\.inject\(\s*["']sidebar\.footer\.action["']/.test(code) &&
    /id:\s*["']temp-cwd["']/.test(code)],
  ['workspaces.create + delete', () => code.includes('workspaces.create({ path })') && code.includes('workspaces.delete(workspace.workspaceId)')],
  ['sessions.create workspaceId', () => code.includes('sessions.create({ workspaceId: workspace.workspaceId })')],
  ['blank-first-message cleanup (v6)', () => code.includes('sessions.list.subscribe') && code.includes('entry.blank === false') && code.includes('snap.current !== sessionId')],
  ['startSession wrapper', () => code.includes('startSession = (workspaceId) => {') && code.includes('sessions.clear()')],
  ['no hero seat shadowing (v9)', () =>
    !/slots\.inject\(["']conversation\.hero/.test(code) &&
    !code.includes('priority: -1') &&
    !code.includes('__reactFiber$') &&
    !code.includes('MutationObserver') &&
    !code.includes('setRootElement')],
  ['reactive hide via useSyncExternalStore (v9)', () =>
    code.includes('useSyncExternalStore') &&
    code.includes('workspaces.subscribe') &&
    code.includes('sessionsList.subscribe') &&
    code.includes('sessionIds.includes')],
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
