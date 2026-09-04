# @yezack/dsh-temp-cwd

One-click temp session for dsh. Adds a 「开始临时对话」 pill **into the official
hero chip row** — the row that shows `[选择工作区 ▾]` while a conversation is in
the blank / ungrouped state. Clicking the pill:

1. creates a timestamped directory under a configurable root
   (default `~/Documents/dsh-workspaces/<YYYYMMDDHHmmss>`) **with a
   `.TEMP_WORKSPACE` marker file inside**,
2. adopts it as a real workspace (`workspaces.create({ path })`),
3. creates a session attached to it (`sessions.create({ workspaceId })`) and
   opens it — so the composer is 100% native, zero input hacks,
4. finalizes on the first message: the marker is removed (the folder is now
   the session's home and is kept), the workspace is deleted, and the session
   falls into 「未分组」 automatically.

**No accumulation of empty dirs**: if the temp session is abandoned before the
first message (user switches away, clicks "new session", or the app closes),
the folder still carries `.TEMP_WORKSPACE`, which authorizes the host to
delete the **whole directory** — empty scaffolds never pile up.

All flow APIs are official dsh client APIs. The only DOM touch is appending one
plain `<button>` into the hero chip row; the official 「选择工作区」 chip and its
picker are never modified — clicking it still opens the native workspace
picker exactly as before.

## How the pill gets there (v11+)

The chip row (`heroWorkspaceRow`, hardcoded JSX in ui-conversation) has **no
injectable seat** — both hero seats (`conversation.hero.workspace` /
`conversation.hero.agentPreset`) are single/root and claimed at priority 0 by
official packages, so a pure-slot button cannot coexist there (v7 was
shadowed, v8 shadowed the official picker and broke 「选择工作区」, v9 retreated
to the sidebar footer but was effectively invisible to the user). The pill
therefore works at the DOM level:

- a **headless host** (renders nothing) registers on the
  `sidebar.footer.action` LIST seat (id `temp-cwd`) — purely for lifecycle;
- it finds the row with `[class*="heroWorkspaceRow"]` and inserts one plain
  `<button data-temp-cwd>` **immediately after the official 「选择工作区」
  chip** (chip-first-button anchor — the row may also contain a mode /
  agent-preset chip such as 「CTF解题模式」, so flex `order` cannot position
  it). Steady state: `[选择工作区 ▾][开始临时对话][CTF解题模式]`;
- the pill is chip-styled with the host's own tokens and uses **zero
  react-dom**;
- **store consumption is official**: the headless component reads the
  workspace / session models through the slot renderer's inject-`hooks`
  compartment (`workspaceList: ctx.workspaces.list`,
  `sessionList: ctx.sessions.list`), surfaced as `useWorkspaceList` /
  `useSessionList` selector props. v10 crashed with
  `workspaces.getSnapshot is not a function` because it called
  `subscribe`/`getSnapshot` on the *controller* — those live on the model
  exposed as `ctx.workspaces.list`;
- a store-driven rescan re-locates the row on blank↔active transitions, plus
  a 1.2 s interval self-heal re-appends the pill if React reconciliation
  ever disturbs the appended foreign child.

Visibility: the pill mounts only while the row exists **and** the current
session is not attached to any workspace (`workspace.sessionIds` lookup — the
same binding check the official ui-workspace / ui-conversation code uses).

## Temp folder lifecycle (marker-based)

The host places a `.TEMP_WORKSPACE` marker inside every scaffolded directory.
The marker is the plugin's permission token:

| Event | Action |
|---|---|
| Pill clicked | `mkdir` → folder + marker, adopted as workspace, blank session opens |
| First message sent | `remove-marker` → folder is kept forever; `workspaces.delete` → session moves to 未分组 |
| Switched away / 新建会话 / app close before first message | `remove-dir` (marker present → whole folder deleted recursively); `workspaces.delete` |
| `remove-dir` called on a folder without marker | refused (409) — never touches real data |

Folder created before the marker scheme (or by hand) has no marker and is
never deleted by the plugin.

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

- `src/index.ts` — host half. Routes (all path-traversal guarded to direct
  children of `rootDirectory` with a bare 14-digit timestamp basename):
  `POST /api/temp-cwd/mkdir` (folder + marker), `POST
  /api/temp-cwd/remove-dir?p=…` (delete folder only while marker present),
  `POST /api/temp-cwd/remove-marker?p=…` (drop marker once used).
- `src/client.ts` — browser half: headless host on `sidebar.footer.action`
  (renders nothing) + pure-DOM pill appended after the official
  `heroWorkspaceRow` chip, driven by official inject-`hooks` store props.
  Click flow: mkdir → `workspaces.create` → `sessions.create({ workspaceId })`
  → `sessions.open` → first-message finalization (keep folder) or abandon
  cleanup (remove folder). Also patches `uiWorkspace.startSession` so an
  un-argued "new session" never re-attaches the current workspace (Bug A fix).

## Build

```bash
npm install
npm run build   # esbuild → dist/index.js + dist/client.js (charset utf8)
npm run verify  # scripts/verify-client.cjs — 26 string-level contract checks
```

The `dist/` artifacts are committed so `dsh plugin add github:...` works
without a prepare/build step.
