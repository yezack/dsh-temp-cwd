/**
 * Build script for dsh-temp-cwd.
 *
 * - dist/index.js  — host half: ESM bundle for the node side (schemastery
 *                    kept external, provided by the host's own install).
 * - dist/client.js — browser half: CJS core with react externals, wrapped in
 *                    the host loader protocol (classic-script safe):
 *                    window.__ModuleLoader__.load({ id, factory }).
 */

import { build } from 'esbuild'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'

mkdirSync('dist', { recursive: true })

await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  external: ['schemastery'],
  outfile: 'dist/index.js',
})

await build({
  entryPoints: ['src/client.ts'],
  bundle: true,
  platform: 'browser',
  format: 'cjs',
  target: 'es2020',
  external: ['react', 'react-dom', 'react/jsx-runtime'],
  outfile: 'dist/client-core.js',
})

const core = readFileSync('dist/client-core.js', 'utf8')
const wrapped = `window.__ModuleLoader__.load({
\tid: "dsh-temp-cwd",
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
${core}
\t\treturn module.exports;
\t}
});
`
writeFileSync('dist/client.js', wrapped)
rmSync('dist/client-core.js')

console.log('[build] dist/index.js  (host, esm)')
console.log('[build] dist/client.js  (browser, ModuleLoader-wrapped)')
