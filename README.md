# @yezack/dsh-temp-cwd

One-click temp session for dsh. Adds a 「新建临时对话」 chip right after the
host's 「选择工作区」 chip in the new-session hero row. Clicking it:

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

## Install

```bash
dsh plugin --profile desktop add github:yezack/dsh-temp-cwd
```

Restart the dsh desktop app, then click 「新建临时对话」 in the new-session
hero (it sits right after the workspace chip).

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
- `src/client.ts` — browser half: registers
  `conversation.hero.agentPreset` (single/root, `priority: 1`; the official
  agent-preset plugin uses the default `priority: 0`, so if it is ever
  enabled the official seat wins and our chip simply disappears). Click
  flow: mkdir → `workspaces.create` → `sessions.create({ workspaceId })` →
  `sessions.open` → cleanup after first message / switch away.

## Build

```bash
npm install
npm run build   # esbuild → dist/index.js + dist/client.js
```

The `dist/` artifacts are committed so `dsh plugin add github:...` works
without a prepare/build step.
