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
var sweptOrphans = /* @__PURE__ */ new Set();
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
            /** Session list model: subscribe/getSnapshot → { byId, current, … }. */
            sessionList: sessions.list
          },
          onStartTemp: () => createTempSession(sessions, workspaces),
          /** Re-arm cleanup for a temp workspace resumed after a reload. */
          onResumeArmCleanup: (workspaceId, path, sessionId) => {
            armCleanup(sessions, workspaces, workspaceId, path, sessionId);
          },
          /**
           * Purge one stale temp workspace: archive every remaining session
           * (so no lonely rows can appear), remove the folder (marker), then
           * delete the workspace.
           */
          onPurgeStale: (workspace) => purgeTempWorkspace(workspaces, workspace)
        })
      },
      TempCwdHost
    )
  );
}
async function renameTempWorkspace(workspaces, workspaceId) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const title = attempt === 0 ? TEMP_WS_TITLE : `${TEMP_WS_TITLE} ${attempt + 1}`;
    try {
      await workspaces.rename(workspaceId, title);
      return;
    } catch (err) {
      const conflict = String(err?.message ?? err).includes("workspace-name-conflict");
      if (!conflict) {
        console.warn("[temp-cwd] rename to 临时会话 failed:", err);
        return;
      }
    }
  }
  console.warn("[temp-cwd] rename to 临时会话 failed: too many name conflicts");
}
async function createTempSession(sessions, workspaces) {
  userRequestedClear = false;
  await purgeStaleBeforeCreate(sessions, workspaces);
  const res = await fetch("/api/temp-cwd/mkdir", { method: "POST" });
  if (!res.ok) throw new Error(`mkdir failed: ${res.status}`);
  const { path } = await res.json();
  const workspace = await workspaces.create({ path });
  tempPending = { workspaceId: workspace.workspaceId, path };
  try {
    const sessionId = await sessions.create({ workspaceId: workspace.workspaceId });
    await sessions.open(sessionId);
    await renameTempWorkspace(workspaces, workspace.workspaceId);
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
async function purgeTempWorkspace(workspaces, workspace) {
  const sessionIds = Array.isArray(workspace?.sessionIds) ? workspace.sessionIds : [];
  for (const sessionId of sessionIds) {
    try {
      await workspaces.archiveSession(sessionId);
    } catch (err) {
      console.warn("[temp-cwd] purge: archive session failed (ignored):", err);
    }
  }
  await hostRemoveDir(workspace?.path);
  try {
    await workspaces.delete(workspace.workspaceId);
    console.info("[temp-cwd] purged stale temp workspace", workspace.workspaceId);
  } catch (err) {
    if (!String(err?.message ?? err).includes("workspace-not-found")) {
      console.warn("[temp-cwd] purge: workspace delete failed:", err);
    }
  }
}
async function purgeStaleBeforeCreate(sessions, workspaces) {
  const wsSnap = workspaces.list.getSnapshot();
  const sesSnap = sessions.list.getSnapshot();
  const items = Array.isArray(wsSnap?.items) ? wsSnap.items : [];
  const current = sesSnap?.current;
  const stale = items.filter(
    (w) => isTempTitle(w.title) && !(current !== void 0 && Array.isArray(w.sessionIds) && w.sessionIds.includes(current))
  );
  if (stale.length === 0) return;
  console.info("[temp-cwd] purging stale temp workspace(s) before create:", stale.length);
  for (const w of stale) {
    sweptOrphans.add(w.workspaceId);
    await purgeTempWorkspace(workspaces, w);
  }
}
function armCleanup(sessions, workspaces, workspaceId, path, sessionId) {
  let done = false;
  let abandonCandidate = false;
  let abandonTimer = 0;
  let reopenedOnce = false;
  const finalizeAbandon = () => {
    if (done) return;
    done = true;
    dispose();
    const pending = tempPending;
    if (pending !== null && pending.workspaceId === workspaceId) tempPending = null;
    console.info("[temp-cwd] abandoned — removing folder + archiving session", path);
    void hostRemoveDir(path).then(() => workspaces.archiveSession(sessionId)).then(
      () => {
        console.info("[temp-cwd] archived session; deleting workspace", workspaceId);
        return workspaces.delete(workspaceId);
      },
      (err) => {
        console.warn("[temp-cwd] archive failed, deleting workspace anyway:", err);
        return workspaces.delete(workspaceId);
      }
    ).catch((err) => {
      if (!String(err?.message ?? err).includes("workspace-not-found")) {
        console.warn("[temp-cwd] abandon cleanup failed:", err);
      }
    });
  };
  const dispose = sessions.list.subscribe(() => {
    if (done) return;
    const snap = sessions.list.getSnapshot();
    const byId = snap?.byId !== void 0 && snap.byId !== null ? snap.byId : {};
    const entry = byId[sessionId];
    const firstMessage = entry !== void 0 && entry.blank === false;
    if (firstMessage) {
      done = true;
      dispose();
      window.clearTimeout(abandonTimer);
      const pending = tempPending;
      if (pending !== null && pending.workspaceId === workspaceId) tempPending = null;
      console.info("[temp-cwd] first message — keeping folder, removing marker", path);
      void hostRemoveMarker(path).then(() => {
        console.info("[temp-cwd] marker removed; deleting workspace", workspaceId);
        return workspaces.delete(workspaceId);
      }).catch((err) => {
        console.warn("[temp-cwd] first-message cleanup failed:", err);
      });
      return;
    }
    const abandoned = snap?.current !== sessionId;
    if (!abandoned) {
      abandonCandidate = false;
      window.clearTimeout(abandonTimer);
      return;
    }
    if (userRequestedClear) {
      userRequestedClear = false;
      finalizeAbandon();
      return;
    }
    if (abandonCandidate) return;
    abandonCandidate = true;
    abandonTimer = window.setTimeout(() => {
      const snap2 = sessions.list.getSnapshot();
      const current2 = snap2?.current;
      if (done) return;
      if (current2 === sessionId) {
        abandonCandidate = false;
        return;
      }
      if (current2 === void 0 && !reopenedOnce && tempPending !== null && !userRequestedClear) {
        reopenedOnce = true;
        abandonCandidate = false;
        console.info("[temp-cwd] reopening temp session after watcher stole selection");
        try {
          sessions.open(sessionId);
        } catch (err) {
          console.warn("[temp-cwd] reopen failed:", err);
        }
        return;
      }
      finalizeAbandon();
    }, 2e3);
  });
}
function TempCwdHost(props) {
  const { useWorkspaceList, useSessionList, onStartTemp, onResumeArmCleanup, onPurgeStale } = props;
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
  const resumedRef = React.useRef(false);
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
    if (resumedRef.current || currentSessionId === void 0) return;
    const resumed = wsItems.find(
      (w) => isTempTitle(w.title) && Array.isArray(w.sessionIds) && w.sessionIds.includes(currentSessionId) && sessionById[currentSessionId] !== void 0
    );
    if (resumed === void 0) return;
    const entry = sessionById[currentSessionId];
    if (entry === void 0 || entry.blank === false) return;
    const alreadyPending = tempPending !== null && tempPending.workspaceId === resumed.workspaceId;
    if (alreadyPending) return;
    resumedRef.current = true;
    tempPending = { workspaceId: resumed.workspaceId, path: resumed.path };
    console.info("[temp-cwd] resumed blank temp session; re-arming cleanup", resumed.workspaceId);
    onResumeArmCleanup(resumed.workspaceId, resumed.path, currentSessionId);
  }, [wsItems, sessionById, currentSessionId, onResumeArmCleanup]);
  React.useEffect(() => {
    if (tempPending !== null) return;
    for (const w of wsItems) {
      if (!isTempTitle(w.title)) continue;
      const sessionsInside = Array.isArray(w.sessionIds) ? w.sessionIds : [];
      if (currentSessionId !== void 0 && sessionsInside.includes(currentSessionId)) {
        continue;
      }
      if (sweptOrphans.has(w.workspaceId)) continue;
      sweptOrphans.add(w.workspaceId);
      console.info("[temp-cwd] purging stale temp workspace on load", w.workspaceId);
      void onPurgeStale(w);
    }
  }, [wsItems]);
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
      const inside = sibling.querySelector(
        'div[role="treeitem"][class*="projectRow"]'
      );
      if (inside !== null) break;
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
var EMPTY_ITEMS = [];
var EMPTY_BY_ID = {};
var PLUS_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="M12 5v14"/></svg>';

		return module.exports;
	}
});
