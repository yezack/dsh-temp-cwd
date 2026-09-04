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
var userRequestedClear = false;
var TEMP_WS_TITLE = "临时会话";
var HERO_ROW_SELECTOR = '[class*="heroWorkspaceRow"]';
var PILL_CSS_ID = "@yezack/dsh-temp-cwd/pill.css";
var PILL_TITLE = "创建临时工作区并直接开始对话（发送首条消息后自动归入未分组）";
function isTempTitle(title) {
  return typeof title === "string" && title.startsWith(TEMP_WS_TITLE);
}
function apply(ctx) {
  const workspaces = ctx.workspaces;
  const sessions = ctx.sessions;
  const uiWorkspace = ctx.uiWorkspace;
  const originalStartSession = uiWorkspace.startSession.bind(uiWorkspace);
  uiWorkspace.startSession = (workspaceId) => {
    if (workspaceId === void 0) {
      userRequestedClear = true;
      sessions.clear();
      if (tempPending !== null) {
        const pending = tempPending;
        tempPending = null;
        hostAbandon(pending.path, pending.sessionId);
      }
      return;
    }
    originalStartSession(workspaceId);
  };
  ctx.on("dispose", () => {
    if (tempPending === null) return;
    const pending = tempPending;
    tempPending = null;
    hostAbandon(pending.path, pending.sessionId);
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
            /** Session list model: subscribe/getSnapshot → { byId, current, … }. */
            sessionList: sessions.list
          },
          onStartTemp: () => createTempSession(sessions, workspaces)
        })
      },
      TempCwdHost
    )
  );
}
async function hostStart() {
  const res = await fetch("/api/temp-cwd/start", { method: "POST" });
  if (!res.ok) throw new Error(`temp start failed: ${res.status}`);
  const { path } = await res.json();
  return path;
}
async function hostRegister(path, workspaceId, sessionId) {
  const res = await fetch(
    `/api/temp-cwd/register?p=${encodeURIComponent(path)}&w=${encodeURIComponent(
      workspaceId
    )}&s=${encodeURIComponent(sessionId)}`,
    { method: "POST" }
  );
  if (!res.ok) console.warn(`[temp-cwd] register failed (${res.status})`);
}
async function hostFinalize(path) {
  try {
    await fetch(`/api/temp-cwd/finalize?p=${encodeURIComponent(path)}`, { method: "POST" });
  } catch (err) {
    console.warn("[temp-cwd] finalize request failed:", err);
  }
}
async function hostAbandon(path, sessionId) {
  try {
    await fetch(
      `/api/temp-cwd/abandon?p=${encodeURIComponent(path)}&s=${encodeURIComponent(sessionId)}`,
      { method: "POST" }
    );
  } catch (err) {
    console.warn("[temp-cwd] abandon request failed:", err);
  }
}
async function renameTempWorkspace(workspaces, workspaceId) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const title = attempt === 0 ? TEMP_WS_TITLE : `${TEMP_WS_TITLE} ${attempt + 1}`;
    try {
      await workspaces.rename(workspaceId, title);
      return;
    } catch (err) {
      if (!String(err?.message ?? err).includes("workspace-name-conflict")) {
        console.warn("[temp-cwd] rename to 临时会话 failed:", err);
        return;
      }
    }
  }
  console.warn("[temp-cwd] rename to 临时会话 failed: too many name conflicts");
}
async function createTempSession(sessions, workspaces) {
  userRequestedClear = false;
  const path = await hostStart();
  const workspace = await workspaces.create({ path });
  try {
    const sessionId = await sessions.create({ workspaceId: workspace.workspaceId });
    await sessions.open(sessionId);
    await renameTempWorkspace(workspaces, workspace.workspaceId);
    tempPending = { path, sessionId };
    await hostRegister(path, workspace.workspaceId, sessionId);
    watchFirstMessage(sessions, path, sessionId);
  } catch (err) {
    if (tempPending !== null && tempPending.path === path) {
      const pending = tempPending;
      tempPending = null;
      hostAbandon(pending.path, pending.sessionId);
    } else {
      hostAbandon(path, "");
    }
    throw err;
  }
}
function watchFirstMessage(sessions, path, sessionId) {
  const dispose = sessions.list.subscribe(() => {
    const snap = sessions.list.getSnapshot();
    const byId = snap?.byId !== void 0 && snap.byId !== null ? snap.byId : {};
    const entry = byId[sessionId];
    if (entry === void 0 || entry.blank !== false) return;
    dispose();
    if (tempPending !== null && tempPending.sessionId === sessionId) tempPending = null;
    console.info("[temp-cwd] first message — host finalize (keep folder)", path);
    void hostFinalize(path);
  });
}
function TempCwdHost(props) {
  const { useWorkspaceList, useSessionList, onStartTemp } = props;
  const wsItems = useWorkspaceList(
    (snapshot) => Array.isArray(snapshot?.items) ? snapshot.items : EMPTY_ITEMS
  );
  const currentSessionId = useSessionList((snapshot) => snapshot.current);
  const sessionById = useSessionList(
    (snapshot) => snapshot?.byId !== void 0 && snapshot.byId !== null ? snapshot.byId : EMPTY_BY_ID
  );
  const boundWs = currentSessionId === void 0 ? void 0 : wsItems.find((w) => w.sessionIds.includes(currentSessionId));
  const bound = boundWs !== void 0;
  const currentEntry = currentSessionId === void 0 ? void 0 : sessionById[currentSessionId];
  const transient = boundWs !== void 0 && isTempTitle(boundWs.title) && currentEntry !== void 0 && currentEntry.blank !== false;
  const [row, setRow] = React.useState(null);
  const pillRef = React.useRef(null);
  const rowRef = React.useRef(null);
  const boundRef = React.useRef(false);
  const transientRef = React.useRef(false);
  rowRef.current = row;
  boundRef.current = bound;
  transientRef.current = transient;
  React.useEffect(() => {
    setRow(findHeroRow());
  }, [currentSessionId, bound, transient]);
  React.useEffect(() => {
    removePill(pillRef);
    if (row === null || bound) return;
    pillRef.current = mountPill(row, onStartTemp);
    return () => removePill(pillRef);
  }, [row, bound, onStartTemp]);
  React.useEffect(() => {
    syncTransientUI(transient);
    return () => syncTransientUI(false);
  }, [transient]);
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
      syncTransientUI(transientRef.current);
    }, 1200);
    return () => window.clearInterval(id);
  }, []);
  return null;
}
function tempRowRegion() {
  const rows = Array.from(
    document.querySelectorAll('div[role="treeitem"][class*="projectRow"]')
  );
  const out = [];
  for (const row of rows) {
    const title = row.querySelector('span[class*="projectText"]');
    const text = title?.textContent ?? "";
    if (!isTempTitle(text.trim())) continue;
    const el = row;
    const wrapper = el.parentElement;
    if (wrapper === null) {
      out.push(el);
      continue;
    }
    out.push(wrapper);
    const container = wrapper.parentElement;
    if (container === null) continue;
    const kids = Array.from(container.children);
    const index = kids.indexOf(wrapper);
    for (let i = index + 1; i < kids.length; i += 1) {
      const sibling = kids[i];
      if (sibling.querySelector('div[role="treeitem"][class*="projectRow"]') !== null) break;
      if (sibling.querySelector('div[role="treeitem"][class*="sessionRow"]') !== null) {
        out.push(sibling);
      }
    }
  }
  return out;
}
function syncTransientUI(active) {
  const region = tempRowRegion();
  if (!active) {
    for (const el of document.querySelectorAll("[data-tempcwd-freeze]")) {
      const chip = el;
      delete chip.style.pointerEvents;
      if (chip.__tempCwdGuard !== void 0) {
        chip.removeEventListener("click", chip.__tempCwdGuard, true);
        chip.__tempCwdGuard = void 0;
      }
      delete chip.dataset.tempcwdFreeze;
    }
  } else {
    const hero = findHeroRow();
    const chip = hero === null ? null : hero.querySelector("button");
    if (chip !== null && !chip.dataset.tempcwdFreeze) {
      const el = chip;
      el.dataset.tempcwdFreeze = "1";
      el.style.pointerEvents = "none";
      const guard = (event) => {
        event.preventDefault();
        event.stopPropagation();
      };
      el.__tempCwdGuard = guard;
      el.addEventListener("click", guard, true);
    }
  }
  for (const el of region) {
    el.dataset.tempcwdHidden = "1";
    el.style.display = "none";
  }
}
function ensurePillStyle() {
  if (typeof document === "undefined") return;
  if (document.querySelector(`style[data-plugin-css="${PILL_CSS_ID}"]`) !== null) return;
  const tag = document.createElement("style");
  tag.dataset.pluginCss = PILL_CSS_ID;
  tag.textContent = [
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
var EMPTY_ITEMS = [];
var EMPTY_BY_ID = {};
var PLUS_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="M12 5v14"/></svg>';

		return module.exports;
	}
});
