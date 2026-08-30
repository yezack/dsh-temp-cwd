// String-level contract verification for dist/client.js (the sandbox eval
// path is unreliable under Node 22 type-stripping; browser runtime differs).
const fs = require('node:fs')
const path = require('node:path')

const code = fs.readFileSync(path.join(__dirname, '..', 'dist', 'client.js'), 'utf8')

const checks = [
  ['ModuleLoader load wrapper', () => code.trimStart().startsWith('window.__ModuleLoader__.load({')],
  ['id equals package name', () => code.includes('id: "dsh-temp-cwd"')],
  ['factory(require) signature', () => code.includes('factory: (require) => {')],
  ['module/exports shim', () => code.includes('var module = { exports: {} };') && code.includes('var exports = module.exports;')],
  ['returns module.exports', () => code.includes('return module.exports;')],
  ['plugin name export', () => code.includes('var name = "temp-cwd-client"')],
  ['inject slots+sessions', () => code.includes('var inject = ["slots", "sessions"]')],
  ['inject sessions', () => code.includes('sessions')],
  ['apply exported', () => /function apply\(ctx\)/.test(code) && code.includes('apply: () => apply')],
  ['slots.inject usage', () => code.includes('slots.inject')],
  ['sessions.create cwd', () => code.includes('sessions.create') && code.includes('cwd')],
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
