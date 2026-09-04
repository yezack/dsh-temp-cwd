# @yezack/dsh-temp-cwd

One-click temp session for dsh. Adds a 「开始临时对话」 pill **into the official
hero chip row** — the row that shows `[选择工作区 ▾]` while a conversation is in
the blank / ungrouped state. Clicking the pill:

1. creates a timestamped directory under a configurable root
   (default `~/Documents/dsh-workspaces/<YYYYMMDDHHmmss>`),
2. adopts it as a real workspace (`workspaces.create({ path })`),
3. creates a session attached to it (`sessions.create({ workspaceId })`) and
   opens it — so the composer is 100% native, zero UI hacks,
4. deletes the workspace once the first message is sent (or the user
   switches away) — the folder and session record stay, and the session
   falls into 「未分组」 (ungrouped) automatically.

All official dsh APIs. The only DOM touch is appending one plain
`<button>` into the hero chip row; the official 「选择工作区」 chip and its
picker are never modified — clicking it still opens the native workspace
picker exactly as before.

## How the pill gets there (v10)

The chip row (`heroWorkspaceRow`, hardcoded JSX in ui-conversation) has **no
injectable seat** — both hero seats (`conversation.hero.workspace` /
`agentPreset`) are single/root and claimed at priority 0 by official
packages, so a pure-slot button cannot coexist there (v7 was shadowed, v8
shadowed the official picker and broke 「选择工作区」, v9 retreated to the
sidebar footer but was effectively invisible to the user). v10 therefore
works at the DOM level instead:

- a **headless host** (renders nothing) registers on the
  `sidebar.footer.action` list seat — purely for lifecycle management;
- it finds the row with `[class*="heroWorkspaceRow"]` (the CSS-module class
  keeps the readable `heroWorkspaceRow` suffix across hash changes) and
  imperatively appends a plain `<button data-temp-cwd>` (CSS `order: 2`,
  so it always sits right after the official chip — steady state visual:
  `[选择工作区 ▾][开始临时对话]`);
- the pill is chip-styled with the host's own tokens (radius 16 / min-height
  28 / 13px 500 / label-primary / hover bg) and uses **zero react-dom** —
  the host renders no React into the row, and the pill lifecycle is pure
  DOM (`mountPill` / `removePill`);
- store-driven rescan (`useSyncExternalStore` over workspaces + session
  list) re-locates the row on blank↔active transitions, plus a 1.2 s
  interval self-heal re-appends the pill if React reconciliation ever
  disturbs it.

Visibility: the pill mounts only while the row exists **and** the current
session is not attached to any workspace. Since the row itself unmounts once
a session binds a workspace, the pill disappears with it — and comes back
when you return to an ungrouped/blank conversation.

## Install

```bash
dsh plugin --profile desktop add github:yezack/dsh-temp-cwd
```

Restart the dsh desktop app, then look at a fresh conversation (no
workspace attached): the hero row shows `[选择工作区 ▾][开始临时对话]`.

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
- `src/client.ts` — browser half: headless host on `sidebar.footer.action`
  (renders nothing) + pure-DOM pill appended into the official
  `heroWorkspaceRow`. Click flow: mkdir → `workspaces.create` →
  `sessions.create({ workspaceId })` → `sessions.open` → cleanup after
  first message / switch away. Also patches `uiWorkspace.startSession` so an
  un-argued "new session" never re-attaches the current workspace
  (Bug A fix).

## Build

```bash
npm install
npm run build   # esbuild → dist/index.js + dist/client.js (charset utf8)
npm run verify  # scripts/verify-client.cjs — 21 string-level contract checks
```

The `dist/` artifacts are committed so `dsh plugin add github:...` works
without a prepare/build step.
