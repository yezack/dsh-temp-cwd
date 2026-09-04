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
  api = { sessions, workspaces, ctx };
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
    if (tempPending !== null) {
      const pending = tempPending;
      tempPending = null;
      hostAbandon(pending.path, pending.sessionId);
    }
    stopUngroupedUi();
  });
  ensurePillStyle();
  ensureBatchStyle();
  ensureBatchOverlayStyle();
  startUngroupedUi();
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
var MINUS_SVG = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M3 8h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
var BATCH_CSS_ID = "@yezack/dsh-temp-cwd/batch.css";
var UNGROUPED_TITLE = "未分组";
var api = null;
var ungroupedTimer = null;
var batchPanel = null;
function ensureBatchStyle() {
  if (typeof document === "undefined") return;
  if (document.querySelector(`style[data-plugin-css="${BATCH_CSS_ID}"]`) !== null) return;
  const tag = document.createElement("style");
  tag.dataset.pluginCss = BATCH_CSS_ID;
  tag.textContent = [
    // Panel surface — same visual family as official menus/dialogs.
    ".tcwd-batch{box-sizing:border-box;z-index:60;border:1px solid var(--dsw-alias-border-inverted);background:var(--dsw-specific-menu,var(--dsw-alias-bg-module-platform));border-radius:12px;box-shadow:var(--dsw-shadow-lv3);width:min(340px,calc(100vw - 24px));max-height:min(560px,calc(100vh - 120px));color:var(--dsw-alias-label-primary);font-size:13px;line-height:18px;display:flex;flex-direction:column;position:fixed;overflow:hidden}",
    ".tcwd-batchHead{box-sizing:border-box;flex:none;display:flex;align-items:center;gap:8px;min-height:40px;padding:8px 10px 8px 12px}",
    ".tcwd-batchTitle{flex:1;min-width:0;font-size:13px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
    ".tcwd-batchClose{cursor:pointer;width:24px;height:24px;color:var(--dsw-alias-label-secondary);background:none;border:none;border-radius:7px;display:inline-flex;align-items:center;justify-content:center;flex:none}",
    ".tcwd-batchClose:hover{background:var(--dsw-alias-interactive-bg-hover)}",
    ".tcwd-batchFilter{box-sizing:border-box;flex:none;margin:0 10px 6px;height:28px;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary);padding:0 8px;font:inherit;outline:none}",
    ".tcwd-batchList{flex:1;min-height:0;overflow-y:auto;padding:0 6px 6px;--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2)}",
    ".tcwd-batchAll{flex:none;display:flex;align-items:center;gap:6px;margin:0 10px 6px;color:var(--dsw-alias-label-secondary);font-size:12px}",
    ".tcwd-batchRow{box-sizing:border-box;display:flex;align-items:center;gap:8px;min-height:30px;padding:2px 6px;border-radius:8px}",
    ".tcwd-batchRow:hover{background:var(--dsw-alias-interactive-bg-hover)}",
    '.tcwd-batchRow input[type="checkbox"],.tcwd-batchAll input[type="checkbox"]{accent-color:var(--dsw-alias-state-business-primary);width:14px;height:14px;flex:none;margin:0}',
    ".tcwd-batchName{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--dsw-alias-label-primary)}",
    ".tcwd-batchName.tcwd-blank{color:var(--dsw-alias-label-tertiary)}",
    ".tcwd-batchEmpty{padding:14px 12px;color:var(--dsw-alias-label-tertiary);text-align:center}",
    ".tcwd-batchFoot{box-sizing:border-box;flex:none;display:flex;align-items:center;gap:8px;min-height:46px;padding:8px 10px;border-top:1px solid var(--dsw-alias-border-l2)}",
    ".tcwd-batchCount{flex:1;min-width:0;color:var(--dsw-alias-label-tertiary);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
    ".tcwd-batchBtn{border:none;border-radius:999px;padding:4px 14px;font:inherit;font-size:13px;font-weight:500;line-height:20px;cursor:pointer;flex:none}",
    ".tcwd-batchBtn:disabled{opacity:.45;cursor:default}",
    ".tcwd-batchArchive{background:var(--dsw-alias-button-ghost-active-fill,var(--dsw-alias-interactive-bg-hover));color:var(--dsw-alias-label-primary)}",
    ".tcwd-batchDelete{background:none;color:var(--dsw-alias-state-error-primary,var(--dsw-alias-danger,#f56c6c));border:1px solid transparent}",
    ".tcwd-batchDelete:not(:disabled):hover{background:var(--dsw-alias-interactive-bg-hover-danger,var(--dsw-alias-interactive-bg-hover));border-color:var(--dsw-alias-border-l2)}",
    ".tcwd-batchHint{flex:none;color:var(--dsw-alias-label-tertiary);font-size:11px;max-width:130px;white-space:normal;line-height:15px}",
    ".tcwd-batchStatus{margin:0 10px 8px;color:var(--dsw-alias-state-error-primary,var(--dsw-alias-danger,#f56c6c));font-size:12px}",
    // Second-confirm overlay.
    ".tcwd-confirm{box-sizing:border-box;z-index:70;border:1px solid var(--dsw-alias-border-inverted);background:var(--dsw-specific-menu,var(--dsw-alias-bg-module-platform));border-radius:12px;box-shadow:var(--dsw-shadow-lv3);width:min(340px,calc(100vw - 24px));color:var(--dsw-alias-label-primary);padding:14px;font-size:13px;line-height:20px;position:fixed}",
    ".tcwd-confirmTitle{font-weight:500;margin-bottom:6px}",
    ".tcwd-confirmDesc{color:var(--dsw-alias-label-secondary);margin-bottom:12px;white-space:pre-line}",
    ".tcwd-confirmActions{display:flex;justify-content:flex-end;gap:8px}"
  ].join("\n");
  document.head.appendChild(tag);
}
function ensureBatchOverlayStyle() {
  if (typeof document === "undefined") return;
  if (document.querySelector(`style[data-plugin-css="${BATCH_CSS_ID}/overlay"]`) !== null) return;
  const tag = document.createElement("style");
  tag.dataset.pluginCss = `${BATCH_CSS_ID}/overlay`;
  tag.textContent = [
    ".tcwd-scrim{position:fixed;inset:0;z-index:55;background:var(--dsw-overlay-bg,rgba(8,10,14,.45));display:flex;align-items:center;justify-content:center;animation:tcwd-fade .12s var(--ds-ease-in-out, ease-out)}",
    ".tcwd-scrimTop{z-index:70}",
    "@keyframes tcwd-fade{from{opacity:0}}",
    // Neutralize the old anchored-popover geometry; center in the scrim.
    ".tcwd-batch{position:relative!important;left:auto!important;top:auto!important;transform:none!important;width:min(480px,calc(100vw - 32px))!important;max-height:min(620px,calc(100vh - 96px))!important;border-radius:14px}",
    ".tcwd-confirm{position:relative!important;left:auto!important;top:auto!important;transform:none!important;width:min(400px,calc(100vw - 32px))!important;border-radius:14px;box-shadow:var(--dsw-shadow-lv3)}",
    ".tcwd-batchHead{min-height:48px;padding:10px 12px 8px 16px}",
    ".tcwd-batchTitle{font-size:14px;font-weight:600;line-height:22px}",
    ".tcwd-batchClose{width:26px;height:26px;border-radius:8px}",
    ".tcwd-batchAll,.tcwd-batchFilter{margin-left:14px;margin-right:14px}",
    ".tcwd-batchFilter{height:30px;border-radius:8px}",
    ".tcwd-batchList{padding:2px 8px 8px}",
    ".tcwd-batchRow{min-height:34px;padding:2px 8px;gap:10px}",
    ".tcwd-batchName{font-size:13px;line-height:20px}",
    ".tcwd-batchFoot{min-height:52px;padding:10px 14px;gap:10px}",
    ".tcwd-batchBtn{min-height:28px;padding:2px 16px;border-radius:999px;font-size:13px;line-height:20px}",
    ".tcwd-confirmTitle{font-size:14px;font-weight:600}"
  ].join("\n");
  document.head.appendChild(tag);
}
function findUngroupedRow() {
  const rows = Array.from(
    document.querySelectorAll('div[role="treeitem"][class*="projectRow"]')
  );
  const row = rows.find((el) => {
    const title = el.querySelector('span[class*="projectText"]');
    return title !== null && (title.textContent ?? "").trim() === UNGROUPED_TITLE;
  });
  return row;
}
function ungroupedSection(row) {
  const list = row.closest('[role="tree"]');
  if (list === null) return null;
  const child = [...list.children].find((c) => c.contains(row));
  return child ?? null;
}
function ungroupedBatchButton(row) {
  const label = "未分组";
  const btn = [...row.querySelectorAll("button")].find(
    (b) => (b.getAttribute("aria-label") ?? "").includes(`"${label}"`) || (b.getAttribute("aria-label") ?? "").includes("“未分组”") || (b.getAttribute("aria-label") ?? "").includes("在“未分组”中新建会话")
  );
  return btn ?? null;
}
function syncUngroupedUi() {
  if (api === null || typeof document === "undefined") return;
  const row = findUngroupedRow();
  if (row === null) return;
  const section = ungroupedSection(row);
  if (section !== null && section.parentElement !== null) {
    const list = section.parentElement;
    if (section !== list.firstElementChild) {
      list.insertBefore(section, list.firstElementChild);
    }
  }
  const btn = ungroupedBatchButton(row);
  if (btn === null) return;
  if (!btn.dataset.tempcwdBatch) {
    btn.dataset.tempcwdBatch = "1";
    const guard = (event) => {
      event.preventDefault();
      event.stopPropagation();
      openBatchPanel();
    };
    btn.addEventListener("click", guard, true);
    btn.__tempCwdBatchGuard = guard;
  }
  btn.setAttribute("aria-label", "批量管理未分组");
  btn.title = "批量管理未分组（归档 / 删除）";
  if (!btn.innerHTML.includes("M3 8h10")) btn.innerHTML = MINUS_SVG;
}
function startUngroupedUi() {
  stopUngroupedUi();
  ungroupedTimer = window.setInterval(() => {
    syncUngroupedUi();
    if (batchPanel !== null && findUngroupedRow() === null) closeBatchPanel();
  }, 1200);
}
function stopUngroupedUi() {
  if (ungroupedTimer !== null) {
    window.clearInterval(ungroupedTimer);
    ungroupedTimer = null;
  }
  closeBatchPanel();
  for (const el of document.querySelectorAll("[data-tempcwd-batch]")) {
    const btn = el;
    delete btn.dataset.tempcwdBatch;
    if (btn.__tempCwdBatchGuard !== void 0) {
      btn.removeEventListener("click", btn.__tempCwdBatchGuard, true);
      btn.__tempCwdBatchGuard = void 0;
    }
  }
}
function ungroupedEntries() {
  if (api === null) return [];
  const { sessions, workspaces } = api;
  const wsSnap = workspaces.list.getSnapshot();
  const sesSnap = sessions.list.getSnapshot();
  const archived = new Set(Array.isArray(wsSnap?.archivedSessionIds) ? wsSnap.archivedSessionIds : []);
  const inWorkspace = /* @__PURE__ */ new Set();
  for (const w of Array.isArray(wsSnap?.items) ? wsSnap.items : []) {
    for (const id of Array.isArray(w.sessionIds) ? w.sessionIds : []) inWorkspace.add(id);
  }
  const byId = sesSnap?.byId !== void 0 && sesSnap.byId !== null ? sesSnap.byId : {};
  const out = [];
  for (const id of Object.keys(byId)) {
    const entry = byId[id];
    if (archived.has(id)) continue;
    if (inWorkspace.has(id)) continue;
    out.push({
      sessionId: id,
      title: entry?.displayTitle ?? entry?.title ?? id,
      blank: entry?.blank === true
    });
  }
  out.sort((a, b) => String(a.title).localeCompare(String(b.title), "zh"));
  return out;
}
function hasDeleteChannel() {
  try {
    const registry = api?.ctx?.get?.("remote.workspaceRegistry");
    return registry !== void 0 && typeof registry.deleteSession === "function";
  } catch {
    return false;
  }
}
async function refreshSessionList() {
  try {
    const sessions = api?.sessions;
    if (sessions !== void 0 && typeof sessions.refresh === "function") {
      await sessions.refresh();
    }
  } catch (err) {
    console.warn("[temp-cwd] batch: session list refresh failed:", err);
  }
}
function displayTitle(entry) {
  return entry.blank ? `（空白）${entry.title}` : entry.title;
}
function openBatchPanel() {
  if (api === null) return;
  closeBatchPanel();
  const panel = document.createElement("div");
  panel.className = "tcwd-batch";
  batchPanel = panel;
  const entries = ungroupedEntries();
  const selected = /* @__PURE__ */ new Set();
  let busy = false;
  let filter = "";
  const render = () => {
    panel.textContent = "";
    const head = document.createElement("div");
    head.className = "tcwd-batchHead";
    const title = document.createElement("div");
    title.className = "tcwd-batchTitle";
    title.textContent = `未分组 · 批量管理（${entries.length}）`;
    const close = document.createElement("button");
    close.type = "button";
    close.className = "tcwd-batchClose";
    close.textContent = "✕";
    close.setAttribute("aria-label", "关闭");
    close.addEventListener("click", closeBatchPanel);
    head.append(title, close);
    const filterBox = document.createElement("input");
    filterBox.className = "tcwd-batchFilter";
    filterBox.type = "text";
    filterBox.placeholder = "筛选会话…";
    filterBox.value = filter;
    filterBox.addEventListener("input", () => {
      filter = filterBox.value.trim().toLowerCase();
      render();
    });
    const visible = entries.filter(
      (e) => filter.length === 0 || displayTitle(e).toLowerCase().includes(filter)
    );
    const list = document.createElement("div");
    list.className = "tcwd-batchList";
    const allRow = document.createElement("label");
    allRow.className = "tcwd-batchAll";
    const allBox = document.createElement("input");
    allBox.type = "checkbox";
    allBox.checked = visible.length > 0 && visible.every((e) => selected.has(e.sessionId));
    allBox.addEventListener("change", () => {
      for (const e of visible) {
        if (allBox.checked) selected.add(e.sessionId);
        else selected.delete(e.sessionId);
      }
      render();
    });
    const allText = document.createElement("span");
    allText.textContent = "全选";
    allRow.append(allBox, allText);
    if (visible.length === 0) {
      const empty = document.createElement("div");
      empty.className = "tcwd-batchEmpty";
      empty.textContent = entries.length === 0 ? "没有未分组会话" : "没有匹配的会话";
      list.append(empty);
    } else {
      for (const entry of visible) {
        const rowEl = document.createElement("label");
        rowEl.className = "tcwd-batchRow";
        const box = document.createElement("input");
        box.type = "checkbox";
        box.checked = selected.has(entry.sessionId);
        box.addEventListener("change", () => {
          if (box.checked) selected.add(entry.sessionId);
          else selected.delete(entry.sessionId);
          render();
        });
        const name2 = document.createElement("span");
        name2.className = entry.blank ? "tcwd-batchName tcwd-blank" : "tcwd-batchName";
        name2.textContent = displayTitle(entry);
        rowEl.append(box, name2);
        list.append(rowEl);
      }
    }
    const foot = document.createElement("div");
    foot.className = "tcwd-batchFoot";
    const count = document.createElement("div");
    count.className = "tcwd-batchCount";
    count.textContent = `已选 ${selected.size}`;
    const archiveBtn = document.createElement("button");
    archiveBtn.type = "button";
    archiveBtn.className = "tcwd-batchBtn tcwd-batchArchive";
    archiveBtn.textContent = selected.size > 0 ? `归档 ${selected.size}` : "归档";
    archiveBtn.disabled = busy || selected.size === 0;
    archiveBtn.addEventListener("click", () => runBatch("archive", [...selected]));
    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "tcwd-batchBtn tcwd-batchDelete";
    deleteBtn.textContent = selected.size > 0 ? `删除 ${selected.size}` : "删除";
    deleteBtn.disabled = busy || selected.size === 0 || !hasDeleteChannel();
    const hint = document.createElement("div");
    hint.className = "tcwd-batchHint";
    hint.textContent = hasDeleteChannel() ? "" : "删除依赖 archive-manager 插件";
    if (hasDeleteChannel()) hint.style.display = "none";
    foot.append(count, hint, archiveBtn, deleteBtn);
    deleteBtn.addEventListener("click", () => confirmDelete([...selected]));
    const status = document.createElement("div");
    status.className = "tcwd-batchStatus";
    status.style.display = "none";
    panel.append(head, allRow, filterBox, list, foot, status);
  };
  const setStatus = (message) => {
    const status = panel.querySelector(".tcwd-batchStatus");
    if (status === null) return;
    if (message === null) status.style.display = "none";
    else {
      status.textContent = message;
      status.style.display = "block";
    }
  };
  const runBatch = async (kind, ids) => {
    if (busy || ids.length === 0) return;
    busy = true;
    render();
    setStatus(kind === "archive" ? "归档中…" : "删除中…");
    const failures = [];
    for (const sessionId of ids) {
      try {
        if (kind === "archive") {
          await api.workspaces.archiveSession(sessionId);
        } else {
          const registry = api.ctx.get("remote.workspaceRegistry");
          const result = await registry.deleteSession(sessionId);
          if (result !== void 0 && result !== null && result.ok === false) {
            throw new Error(result.error?.message ?? "delete failed");
          }
        }
      } catch (err) {
        failures.push(`${sessionId.slice(0, 8)}…: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    await refreshSessionList();
    busy = false;
    if (failures.length > 0) {
      setStatus(`完成，${failures.length} 个失败（${failures[0]}）`);
    } else {
      closeBatchPanel();
    }
  };
  const confirmDelete = (ids) => {
    if (ids.length === 0) return;
    const scrim2 = document.createElement("div");
    scrim2.className = "tcwd-scrim tcwd-scrimTop";
    const card = document.createElement("div");
    card.className = "tcwd-confirm";
    const title = document.createElement("div");
    title.className = "tcwd-confirmTitle";
    title.textContent = "确认删除会话？";
    const desc = document.createElement("div");
    desc.className = "tcwd-confirmDesc";
    desc.textContent = `将永久删除 ${ids.length} 个未分组会话及其全部记录，此操作无法撤销。`;
    const actions = document.createElement("div");
    actions.className = "tcwd-confirmActions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "tcwd-batchBtn tcwd-batchArchive";
    cancel.textContent = "取消";
    const confirm = document.createElement("button");
    confirm.type = "button";
    confirm.className = "tcwd-batchBtn tcwd-batchDelete";
    confirm.textContent = "确认删除";
    cancel.addEventListener("click", () => scrim2.remove());
    confirm.addEventListener("click", () => {
      scrim2.remove();
      void runBatch("delete", ids);
    });
    actions.append(cancel, confirm);
    card.append(title, desc, actions);
    scrim2.append(card);
    scrim2.addEventListener("click", (e) => {
      if (e.target === scrim2) scrim2.remove();
    });
    document.body.appendChild(scrim2);
  };
  const scrim = document.createElement("div");
  scrim.className = "tcwd-scrim";
  scrim.addEventListener("click", (e) => {
    if (e.target === scrim) closeBatchPanel();
  });
  scrim.appendChild(panel);
  document.body.appendChild(scrim);
  render();
}
function closeBatchPanel() {
  if (batchPanel !== null) {
    batchPanel.remove();
    batchPanel = null;
  }
  for (const el of document.querySelectorAll(".tcwd-scrim, .tcwd-confirm")) el.remove();
}
var EMPTY_ITEMS = [];
var EMPTY_BY_ID = {};
var PLUS_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="M12 5v14"/></svg>';

		return module.exports;
	}
});
