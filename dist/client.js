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
var tempCwd = null;
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
  const mo = new MutationObserver(() => {
    if (tempCwd !== null) unlockComposer();
  });
  mo.observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["contenteditable", "class"]
  });
  if (tempCwd !== null) unlockComposer();
  ctx.on("dispose", () => mo.disconnect());
  ctx.slots.inject(
    "conversation.hero.workspace",
    () => ctx.slots.register(
      {
        name: "conversation.hero.workspace",
        priority: -1,
        inject: () => ({
          /** Official session controller: create({ workspaceId }) / open(id). */
          sessions,
          /** Official workspace controller: create({ path }) / delete(id). */
          workspaces,
          /** Workspace projection model: subscribe / getSnapshot / items / phase. */
          workspacesModel: workspaces.list
        })
      },
      TempWorkspaceRow
    )
  );
}
function unlockComposer() {
  if (tempCwd === null) return;
  const el = document.querySelector("[data-composer-input]");
  if (!el) return;
  const hostOnKeyDown = () => {
    const fiberKey2 = Object.keys(el).find((k) => k.startsWith("__reactFiber$"));
    const hostFiber = fiberKey2 ? el[fiberKey2] : null;
    return !!(hostFiber && hostFiber.memoizedProps && hostFiber.memoizedProps.onKeyDown);
  };
  let editor = null;
  const fiberKey = Object.keys(el).find((k) => k.startsWith("__reactFiber$"));
  let node = fiberKey ? el[fiberKey] : null;
  while (node && !editor) {
    const mp = node.memoizedProps;
    if (mp && mp.keyboard && mp.keyboard.editor) editor = mp.keyboard.editor;
    node = node.return;
  }
  if (!editor || !hostOnKeyDown()) return;
  if (editor.getRootElement?.() !== el) editor.setRootElement(el);
  try {
    if (editor.isEditable?.() !== true) editor.setEditable(true);
  } catch {
  }
  if (el.contentEditable !== "true") el.contentEditable = "true";
  const ph = el.parentElement?.querySelector("[data-composer-placeholder]");
  if (ph && ph.style.display !== "none") ph.style.display = "none";
  if (!el.__tempCwdClickGuarded) {
    ;
    el.__tempCwdClickGuarded = true;
    el.addEventListener(
      "click",
      (e) => {
        if (hostOnKeyDown()) e.stopPropagation();
      },
      true
    );
  }
  if (!el.__tempCwdKeyGuarded) {
    ;
    el.__tempCwdKeyGuarded = true;
    el.addEventListener("keydown", (e) => {
      if (hostOnKeyDown()) e.stopPropagation();
    });
  }
}
function TempWorkspaceRow(props) {
  const { open, anchorRef, onPick, onClose, workspacesModel, selectedId, sessions, workspaces } = props;
  const [busy, setBusy] = React.useState(false);
  const [hovered, setHovered] = React.useState(false);
  const [error, setError] = React.useState(null);
  const [rect, setRect] = React.useState(null);
  const panelRef = React.useRef(null);
  const btnRef = React.useRef(null);
  const [tempCwdState, setTempCwdState] = React.useState(() => tempCwd);
  const selectedIdRef = React.useRef(selectedId);
  selectedIdRef.current = selectedId;
  const isEmpty = selectedId === void 0;
  React.useEffect(() => {
    const chip = anchorRef?.current;
    if (!chip) return;
    chip.style.display = isEmpty ? "none" : "";
    return () => {
      if (chip) chip.style.display = "";
    };
  }, [isEmpty, anchorRef]);
  const snapshot = React.useSyncExternalStore(
    (cb) => workspacesModel.subscribe(cb),
    () => workspacesModel.getSnapshot()
  );
  const workspacesList = snapshot?.items ?? [];
  React.useEffect(() => {
    if (!open) return;
    const host = anchorRef?.current;
    const el = host && host.getBoundingClientRect().width > 0 ? host : btnRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setRect({ top: r.bottom + 4, left: r.left });
  }, [open, anchorRef]);
  React.useEffect(() => {
    if (!open) return;
    const onMouseDown = (e) => {
      const target = e.target;
      if (panelRef.current?.contains(target)) return;
      if (anchorRef?.current?.contains(target)) return;
      onClose?.();
    };
    const onKey = (e) => {
      if (e.key === "Escape") onClose?.();
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose, anchorRef]);
  const handleTemp = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/temp-cwd/mkdir", { method: "POST" });
      if (!res.ok) throw new Error(`mkdir failed: ${res.status}`);
      const { path } = await res.json();
      const workspace = await workspaces.create({ path });
      const sessionId = await sessions.create({ workspaceId: workspace.workspaceId });
      tempCwd = path;
      setTempCwdState(path);
      await sessions.open(sessionId);
      await workspaces.delete(workspace.workspaceId);
      onClose?.();
      unlockComposer();
    } catch (err) {
      console.error("[temp-cwd] failed to open temp session:", err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  const showTempChip = tempCwdState !== null && selectedId === void 0 && !busy;
  return React.createElement(
    React.Fragment,
    null,
    React.createElement(
      "button",
      {
        ref: btnRef,
        type: "button",
        disabled: busy,
        onClick: handleTemp,
        onMouseEnter: () => setHovered(true),
        onMouseLeave: () => setHovered(false),
        title: "\u521B\u5EFA\u4E34\u65F6\u76EE\u5F55\u5E76\u76F4\u63A5\u5F00\u59CB\u5BF9\u8BDD\uFF08\u4F1A\u8BDD\u8FDB\u5165\u672A\u5206\u7EC4\uFF09",
        style: {
          ...chipStyle,
          background: hovered ? "var(--dsw-alias-interactive-bg-hover)" : "transparent",
          opacity: busy ? 0.65 : 1,
          cursor: busy ? "wait" : "pointer"
        }
      },
      busy ? "\u521B\u5EFA\u4E2D\u2026" : "\u4E34\u65F6\u4F1A\u8BDD"
    ),
    showTempChip ? React.createElement(
      "div",
      { style: selectedChipStyle, title: tempCwdState ?? void 0 },
      folderIcon(),
      React.createElement(
        "span",
        { style: { overflow: "hidden", textOverflow: "ellipsis" } },
        dirLabel(tempCwdState ?? "")
      )
    ) : null,
    error ? React.createElement("div", { role: "alert", style: errorStyle }, error) : null,
    open && rect ? React.createElement(
      "div",
      { ref: panelRef, style: { ...panelStyle, top: rect.top, left: rect.left } },
      React.createElement("div", { style: panelTitleStyle }, "\u5DE5\u4F5C\u533A"),
      workspacesList.length === 0 ? React.createElement("div", { style: emptyStyle }, "\u6682\u65E0\u5DE5\u4F5C\u533A") : workspacesList.map(
        (workspace) => React.createElement(
          "button",
          {
            key: workspace.workspaceId,
            type: "button",
            style: itemStyle,
            onClick: () => {
              onPick?.(workspace.workspaceId);
              onClose?.();
            }
          },
          workspace.title ?? workspace.path ?? workspace.workspaceId
        )
      )
    ) : null
  );
}
function dirLabel(path) {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}
function folderIcon() {
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
    React.createElement("path", { d: "M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" })
  );
}
var chipStyle = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  minHeight: 28,
  padding: "0 8px",
  borderRadius: 16,
  border: "none",
  color: "var(--dsw-alias-label-secondary)",
  fontSize: 13,
  fontWeight: 500,
  lineHeight: "20px",
  whiteSpace: "nowrap"
};
var selectedChipStyle = {
  ...chipStyle,
  maxWidth: 220,
  color: "var(--dsw-alias-label-primary)",
  background: "var(--dsw-alias-interactive-bg-hover)",
  border: "1px solid var(--dsw-alias-border-l2)",
  cursor: "default"
};
var errorStyle = {
  color: "var(--dsw-alias-danger, #f56c6c)",
  fontSize: 12,
  lineHeight: "16px",
  padding: "0 8px"
};
var panelStyle = {
  position: "fixed",
  zIndex: 1e3,
  minWidth: 220,
  maxWidth: 320,
  maxHeight: 280,
  overflowY: "auto",
  padding: 4,
  borderRadius: 12,
  background: "var(--dsw-alias-bg-module-platform)",
  border: "1px solid var(--dsw-alias-border-l2)",
  boxShadow: "0 8px 24px rgba(0, 0, 0, 0.35)"
};
var panelTitleStyle = {
  padding: "4px 8px 6px",
  color: "var(--dsw-alias-label-tertiary)",
  fontSize: 12,
  lineHeight: "16px"
};
var itemStyle = {
  display: "block",
  width: "100%",
  boxSizing: "border-box",
  padding: "6px 8px",
  borderRadius: 8,
  border: "none",
  background: "transparent",
  color: "var(--dsw-alias-label-primary)",
  fontSize: 13,
  lineHeight: "20px",
  textAlign: "left",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
  cursor: "pointer"
};
var emptyStyle = {
  padding: "8px",
  color: "var(--dsw-alias-label-tertiary)",
  fontSize: 13,
  lineHeight: "20px"
};

		return module.exports;
	}
});
