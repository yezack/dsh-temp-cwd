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
var tempPending = null;
var HERO_ROW_SELECTOR = '[class*="heroWorkspaceRow"]';
var PILL_CSS_ID = "@yezack/dsh-temp-cwd/pill.css";
var PILL_TITLE = "创建临时工作区并直接开始对话（发送首条消息后自动归入未分组）";
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
    if (tempPending === null) return;
    const pending = tempPending;
    tempPending = null;
    hostRemoveDir(pending.path);
    workspaces.delete(pending.workspaceId).catch((err) => {
      console.error("[temp-cwd] dispose cleanup failed:", err);
    });
  });
  ensurePillStyle();
  ctx.slots.inject(
    "sidebar.footer.action",
    () => ctx.slots.register(
      {
        name: "sidebar.footer.action",
        id: "temp-cwd",
        inject: () => ({
          hooks: {
            /** Workspace model: subscribe/getSnapshot → { items, phase, … }. */
            workspaceList: workspaces.list,
            /** Session list model: subscribe/getSnapshot → { items, current, … }. */
            sessionList: sessions.list
          },
          onStartTemp: () => createTempSession(sessions, workspaces)
        })
      },
      TempCwdHost
    )
  );
}
async function createTempSession(sessions, workspaces) {
  const res = await fetch("/api/temp-cwd/mkdir", { method: "POST" });
  if (!res.ok) throw new Error(`mkdir failed: ${res.status}`);
  const { path } = await res.json();
  const workspace = await workspaces.create({ path });
  tempPending = { workspaceId: workspace.workspaceId, path };
  try {
    const sessionId = await sessions.create({ workspaceId: workspace.workspaceId });
    await sessions.open(sessionId);
    armCleanup(sessions, workspaces, workspace.workspaceId, path, sessionId);
  } catch (err) {
    const pending = tempPending;
    tempPending = null;
    if (pending !== null) {
      hostRemoveDir(pending.path);
      workspaces.delete(pending.workspaceId).catch(() => {
      });
    }
    throw err;
  }
}
async function hostRemoveDir(path) {
  try {
    const res = await fetch(`/api/temp-cwd/remove-dir?p=${encodeURIComponent(path)}`, {
      method: "POST"
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      console.warn(`[temp-cwd] remove-dir refused (${res.status}):`, body.reason ?? res.status);
    }
  } catch (err) {
    console.warn("[temp-cwd] remove-dir request failed:", err);
  }
}
async function hostRemoveMarker(path) {
  try {
    const res = await fetch(`/api/temp-cwd/remove-marker?p=${encodeURIComponent(path)}`, {
      method: "POST"
    });
    if (!res.ok) console.warn(`[temp-cwd] remove-marker failed (${res.status})`);
  } catch (err) {
    console.warn("[temp-cwd] remove-marker request failed:", err);
  }
}
function armCleanup(sessions, workspaces, workspaceId, path, sessionId) {
  let done = false;
  const dispose = sessions.list.subscribe(() => {
    if (done) return;
    const snap = sessions.list.getSnapshot();
    const items = Array.isArray(snap?.items) ? snap.items : [];
    const entry = items.find((item) => item.sessionId === sessionId);
    const firstMessage = entry !== void 0 && entry.blank === false;
    const abandoned = snap?.current !== sessionId;
    if (!firstMessage && !abandoned) return;
    done = true;
    dispose();
    const pending = tempPending;
    if (pending !== null && pending.workspaceId === workspaceId) tempPending = null;
    if (firstMessage) {
      console.info("[temp-cwd] first message — keeping folder, removing marker", path);
      void hostRemoveMarker(path).then(() => {
        console.info("[temp-cwd] marker removed; deleting workspace", workspaceId);
        return workspaces.delete(workspaceId);
      });
    } else {
      console.info("[temp-cwd] abandoned — removing whole temp folder", path);
      void hostRemoveDir(path).then(() => {
        console.info("[temp-cwd] folder removed; deleting workspace", workspaceId);
        return workspaces.delete(workspaceId);
      });
    }
  });
}
function TempCwdHost(props) {
  const { useWorkspaceList, useSessionList, onStartTemp } = props;
  const wsItems = useWorkspaceList((snapshot) => snapshot.items);
  const currentSessionId = useSessionList((snapshot) => snapshot.current);
  const bound = currentSessionId !== void 0 && wsItems.some((w) => w.sessionIds.includes(currentSessionId));
  const [row, setRow] = React.useState(null);
  const pillRef = React.useRef(null);
  const rowRef = React.useRef(null);
  const boundRef = React.useRef(false);
  rowRef.current = row;
  boundRef.current = bound;
  React.useEffect(() => {
    setRow(findHeroRow());
  }, [currentSessionId, bound]);
  React.useEffect(() => {
    removePill(pillRef);
    if (row === null || bound) return;
    pillRef.current = mountPill(row, onStartTemp);
    return () => removePill(pillRef);
  }, [row, bound, onStartTemp]);
  React.useEffect(() => {
    const id = window.setInterval(() => {
      const el = findHeroRow();
      if (el !== rowRef.current) {
        setRow(el);
        return;
      }
      const pill = pillRef.current;
      const shouldMount = el !== null && !boundRef.current;
      if (shouldMount && (pill === null || !el.contains(pill))) {
        removePill(pillRef);
        pillRef.current = mountPill(el, onStartTemp);
      } else if (!shouldMount && pill !== null) {
        removePill(pillRef);
      }
    }, 1200);
    return () => window.clearInterval(id);
  }, []);
  return null;
}
function ensurePillStyle() {
  if (typeof document === "undefined") return;
  if (document.querySelector(`style[data-plugin-css="${PILL_CSS_ID}"]`) !== null) return;
  const tag = document.createElement("style");
  tag.dataset.pluginCss = PILL_CSS_ID;
  tag.textContent = [
    // Exact chip look: same tokens as the official `…_workspace` chip
    // (radius 16, min-height 28, 13px/500, label-primary, hover bg).
    "button[data-temp-cwd]{display:inline-flex;align-items:center;gap:4px;min-height:28px;max-width:min(100%,360px);box-sizing:border-box;border-radius:16px;padding:0 8px;border:none;background:transparent;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:13px;font-weight:500;line-height:20px;cursor:pointer}",
    "button[data-temp-cwd]:hover{background:var(--dsw-alias-interactive-bg-hover)}",
    'button[data-temp-cwd][data-temp-cwd-state="busy"]{opacity:.65;cursor:wait}',
    "button[data-temp-cwd] svg{flex-shrink:0}",
    "button[data-temp-cwd] span{white-space:nowrap}"
  ].join("\n");
  document.head.appendChild(tag);
}
function findHeroRow() {
  const nodes = Array.from(document.querySelectorAll(HERO_ROW_SELECTOR));
  const visible = nodes.find(
    (el) => el instanceof HTMLElement && el.getClientRects().length > 0 && el.offsetParent !== null
  );
  return visible ?? nodes[0] ?? null;
}
function removePill(pillRef) {
  const pill = pillRef.current;
  pillRef.current = null;
  if (pill !== null && pill.isConnected) pill.remove();
}
function mountPill(row, onStart) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.setAttribute("data-temp-cwd", "");
  btn.setAttribute("data-temp-cwd-state", "idle");
  btn.title = PILL_TITLE;
  btn.innerHTML = `${PLUS_SVG}<span>开始临时对话</span>`;
  const label = btn.querySelector("span");
  let busy = false;
  let revertTimer = 0;
  const setBusy = () => {
    if (!btn.isConnected) return;
    btn.setAttribute("data-temp-cwd-state", "busy");
    if (label !== null) label.textContent = "创建中…";
  };
  const setIdle = () => {
    if (!btn.isConnected) return;
    btn.setAttribute("data-temp-cwd-state", "idle");
    if (label !== null) {
      label.textContent = "开始临时对话";
      label.style.color = "";
    }
    btn.title = PILL_TITLE;
  };
  const showError = (message) => {
    if (!btn.isConnected) return;
    btn.setAttribute("data-temp-cwd-state", "idle");
    if (label !== null) {
      label.textContent = "创建失败";
      label.style.color = "var(--dsw-alias-danger, #f56c6c)";
    }
    btn.title = message;
  };
  btn.addEventListener("click", () => {
    if (busy || !btn.isConnected) return;
    busy = true;
    window.clearTimeout(revertTimer);
    setBusy();
    onStart().catch((err) => {
      console.error("[temp-cwd] failed to open temp session:", err);
      const message = err instanceof Error ? err.message : String(err);
      showError(message);
      revertTimer = window.setTimeout(setIdle, 3e3);
    }).finally(() => {
      busy = false;
      if (btn.isConnected && btn.getAttribute("data-temp-cwd-state") !== "idle") {
        setIdle();
      }
    });
  });
  const chip = row.querySelector("button");
  if (chip !== null) chip.after(btn);
  else row.appendChild(btn);
  return btn;
}
var PLUS_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="M12 5v14"/></svg>';

		return module.exports;
	}
});
