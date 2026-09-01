window.__ModuleLoader__.load({
	id: "@yezack/dsh-temp-cwd",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name2 in all)
    __defProp(target, name2, { get: all[name2], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client.ts
var client_exports = {};
__export(client_exports, {
  apply: () => apply,
  inject: () => inject,
  name: () => name
});
module.exports = __toCommonJS(client_exports);
var React = __toESM(require("react"), 1);
var name = "temp-cwd-client";
var inject = ["slots", "sessions", "workspaces", "uiWorkspace"];
var tempWorkspaceId = null;
function apply(ctx) {
  const workspaces = ctx.workspaces;
  const sessions = ctx.sessions;
  const uiWorkspace = ctx.uiWorkspace;
  const originalStartSession = uiWorkspace.startSession.bind(uiWorkspace);
  uiWorkspace.startSession = (workspaceId) => {
    if (workspaceId === void 0) {
      sessions.clear();
      return;
    }
    originalStartSession(workspaceId);
  };
  ctx.on("dispose", () => {
    if (tempWorkspaceId !== null) {
      const id = tempWorkspaceId;
      tempWorkspaceId = null;
      workspaces.delete(id).catch((err) => {
        console.error("[temp-cwd] dispose cleanup failed:", err);
      });
    }
  });
  ctx.slots.inject(
    "sidebar.footer.action",
    () => ctx.slots.register(
      {
        name: "sidebar.footer.action",
        id: "temp-cwd",
        inject: () => ({
          /** Official session controller: create({ workspaceId }) / open(id). */
          sessions,
          /** Official workspace controller: create({ path }) / delete(id). */
          workspaces,
          /** Session list projection model: subscribe / getSnapshot (items carry `blank`). */
          sessionsList: sessions.list
        })
      },
      TempSessionButton
    )
  );
}
async function createTempSession(sessions, workspaces) {
  const res = await fetch("/api/temp-cwd/mkdir", { method: "POST" });
  if (!res.ok) throw new Error(`mkdir failed: ${res.status}`);
  const { path } = await res.json();
  const workspace = await workspaces.create({ path });
  tempWorkspaceId = workspace.workspaceId;
  try {
    const sessionId = await sessions.create({ workspaceId: workspace.workspaceId });
    await sessions.open(sessionId);
    armCleanup(sessions, workspaces, workspace.workspaceId, sessionId);
  } catch (err) {
    if (tempWorkspaceId === workspace.workspaceId) tempWorkspaceId = null;
    workspaces.delete(workspace.workspaceId).catch(() => {
    });
    throw err;
  }
}
function armCleanup(sessions, workspaces, workspaceId, sessionId) {
  let done = false;
  const dispose = sessions.list.subscribe(() => {
    if (done) return;
    const snap = sessions.list.getSnapshot();
    const entry = snap.items.find((item) => item.sessionId === sessionId);
    if (snap.current !== sessionId || entry && entry.blank === false) {
      done = true;
      dispose();
      if (tempWorkspaceId === workspaceId) tempWorkspaceId = null;
      workspaces.delete(workspaceId).catch((err) => {
        console.error("[temp-cwd] workspace cleanup failed:", err);
      });
    }
  });
}
function TempSessionButton(props) {
  const { sessions, workspaces } = props;
  const [busy, setBusy] = React.useState(false);
  const [hovered, setHovered] = React.useState(false);
  const [error, setError] = React.useState(null);
  const handle = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await createTempSession(sessions, workspaces);
    } catch (err) {
      console.error("[temp-cwd] failed to open temp session:", err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return React.createElement(
    React.Fragment,
    null,
    React.createElement(
      "button",
      {
        type: "button",
        disabled: busy,
        onClick: handle,
        onMouseEnter: () => setHovered(true),
        onMouseLeave: () => setHovered(false),
        title: "\u521B\u5EFA\u4E34\u65F6\u5DE5\u4F5C\u533A\u5E76\u76F4\u63A5\u5F00\u59CB\u5BF9\u8BDD\uFF08\u53D1\u51FA\u7B2C\u4E00\u6761\u6D88\u606F\u540E\u81EA\u52A8\u8FDB\u5165\u672A\u5206\u7EC4\uFF09",
        style: {
          ...actionButtonStyle,
          background: hovered ? "var(--dsw-alias-interactive-bg-hover)" : "transparent",
          opacity: busy ? 0.65 : 1,
          cursor: busy ? "wait" : "pointer"
        }
      },
      plusIcon(),
      busy ? "\u521B\u5EFA\u4E2D\u2026" : "\u65B0\u5EFA\u4E34\u65F6\u5BF9\u8BDD"
    ),
    error ? React.createElement("div", { role: "alert", style: errorStyle }, error) : null
  );
}
function plusIcon() {
  return React.createElement(
    "svg",
    {
      width: 14,
      height: 14,
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: 2,
      strokeLinecap: "round",
      strokeLinejoin: "round",
      style: { flexShrink: 0 }
    },
    React.createElement("path", { d: "M5 12h14" }),
    React.createElement("path", { d: "M12 5v14" })
  );
}
var actionButtonStyle = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  width: "100%",
  boxSizing: "border-box",
  minWidth: 0,
  padding: "6px 8px",
  borderRadius: 8,
  border: "none",
  color: "var(--dsw-alias-label-secondary)",
  fontSize: 13,
  fontWeight: 500,
  lineHeight: "20px",
  textAlign: "left",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis"
};
var errorStyle = {
  color: "var(--dsw-alias-danger, #f56c6c)",
  fontSize: 12,
  lineHeight: "16px",
  padding: "2px 8px 4px"
};

		return module.exports;
	}
});
