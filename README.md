# @yezack/dsh-temp-cwd

One-click temp session for dsh. Adds a 「临时会话」 button to the new-session
hero (workspace picker area): it creates a timestamped directory under a
configurable root (default `~/Documents/dsh-workspaces/<YYYYMMDDHHmmss>`)
and opens a **workspace-less session** whose cwd points at that directory.

Uses only public dsh APIs — the native `session/create` accepts `cwd`
without `workspaceId`, so no UI takeover or monkey-patching is involved.

## Install

```bash
dsh plugin --profile desktop add github:yezack/dsh-temp-cwd
```

Restart the dsh desktop app, then click 「临时会话」 in the new-session hero.

## Config

The root directory can be overridden in the plugin config
(`dsh.settings` → plugin config):

```yaml
# e.g. via settings section / cordis.patch.yml config block
rootDirectory: 'D:/scratch/dsh-temp'
```

## Layout

- `src/index.ts` — host half: `POST /api/temp-cwd/mkdir` route
  (path-traversal guarded).
- `src/client.ts` — browser half: `sidebar.footer.action` slot button that
  calls mkdir, then `ctx.sessions.create({ cwd })` + `ctx.sessions.open(id)`.

## Build

```bash
npm install
npm run build   # esbuild → dist/index.js + dist/client.js
```

The `dist/` artifacts are committed so `dsh plugin add github:...` works
without a prepare/build step.
