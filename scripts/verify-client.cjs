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
  ['hero agentPreset slot (v7)', () => code.includes('conversation.hero.agentPreset') && code.includes('priority: 1')],
  ['workspaces.create + delete', () => code.includes('workspaces.create({ path })') && code.includes('workspaces.delete(workspace.workspaceId)')],
  ['sessions.create workspaceId', () => code.includes('sessions.create({ workspaceId: workspace.workspaceId })')],
  ['blank-first-message cleanup (v6)', () => code.includes('sessions.list.subscribe') && code.includes('entry.blank === false') && code.includes('snap.current !== sessionId')],
  ['startSession wrapper', () => code.includes('startSession = (workspaceId) => {') && code.includes('sessions.clear()')],
  ['no UI intervention leftovers (v7)', () => !code.includes('__reactFiber$') && !code.includes('MutationObserver') && !code.includes('setRootElement') && !code.includes('inject("conversation.hero.workspace"') && !code.includes('inject("sidebar.footer.action"')],
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
