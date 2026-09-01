# @yezack/dsh-temp-cwd

One-click temp session for dsh. Adds a 「新建临时对话」 button to the sidebar
footer (below the session list, alongside the official cordis-panel entry).
Clicking it:

1. creates a timestamped directory under a configurable root
   (default `~/Documents/dsh-workspaces/<YYYYMMDDHHmmss>`),
2. adopts it as a real workspace (`workspaces.create({ path })`),
3. creates a session attached to it (`sessions.create({ workspaceId })`) and
   opens it — so the composer is 100% native, zero UI hacks,
4. deletes the workspace once the first message is sent (or the user
   switches away) — the folder and session record stay, and the session
   falls into 「未分组」 (ungrouped) automatically.

All official dsh APIs — no UI takeover, no monkey-patching, no DOM
intervention (v6 removed every DOM/fiber hack from v4/v5).

Visibility rule (v9): the button only renders while the **current** session is
not attached to any workspace — i.e. the no-session / ungrouped hero state.
Once a session has a workspace, the button hides; it comes back when you
return to an ungrouped session. Reactive via
`useSyncExternalStore(workspaces.subscribe)` + `sessions.list`.

## Install

```bash
dsh plugin --profile desktop add github:yezack/dsh-temp-cwd
```

Restart the dsh desktop app, then click 「新建临时对话」 in the sidebar footer.

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
- `src/client.ts` — browser half: registers `sidebar.footer.action`
  (`kind: list`, so it coexists with the official cordis-panel entry —
  unlike the hero row's single seats, which are claimed by official
  packages at priority 0; v7 tried `conversation.hero.agentPreset` and was
  silently shadowed, v8 tried `conversation.hero.workspace` with
  `priority: -1` and shadowed the official WorkspacePicker menu, breaking
  「选择工作区」). Click flow: mkdir → `workspaces.create` →
  `sessions.create({ workspaceId })` → `sessions.open` → cleanup after
  first message / switch away.

## Build

```bash
npm install
npm run build   # esbuild → dist/index.js + dist/client.js
npm run verify  # scripts/verify-client.cjs — string-level contract checks
```

The `dist/` artifacts are committed so `dsh plugin add github:...` works
without a prepare/build step.
