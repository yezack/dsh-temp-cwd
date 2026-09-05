// src/index.ts
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import z from "schemastery";
var name = "temp-cwd";
var inject = ["webServer", "workspaceRegistry"];
var MARKER_FILE = ".TEMP_WORKSPACE";
var SETTINGS_NS = "@yezack/dsh-temp-cwd/settings";
var SettingsSchema = z.object({
  rootDirectory: z.string().default("")
});
var ABANDON_DEBOUNCE_MS = 2e3;
var SWEEP_AGE_MS = 6e4;
var SWEEP_INTERVAL_MS = 3e4;
var Config = z.object({
  /** Root directory holding the timestamped temp workspaces. */
  rootDirectory: z.string().default(join(homedir(), "Documents", "dsh-workspaces"))
});
function timestamp() {
  const d = /* @__PURE__ */ new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}
function isTempDir(root, candidate) {
  const base = basename(candidate);
  const rootSep = root.endsWith(sep) ? root : root + sep;
  return candidate.startsWith(rootSep) && candidate.slice(rootSep.length).split(sep).length === 1 && /^\d{14}$/.test(base);
}
function queryParam(req, key) {
  try {
    const url = new URL(req.url ?? "", "http://localhost");
    const value = url.searchParams.get(key);
    return typeof value === "string" && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}
function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
function hasMarker(dir) {
  try {
    return statSync(join(dir, MARKER_FILE)).isFile();
  } catch {
    return false;
  }
}
function markerMtime(dir) {
  try {
    return statSync(join(dir, MARKER_FILE)).mtimeMs;
  } catch {
    return 0;
  }
}
function removeDirIfMarkered(dir) {
  if (!hasMarker(dir)) return false;
  rmSync(dir, { recursive: true, force: true });
  return true;
}
function dropMarker(dir) {
  try {
    rmSync(join(dir, MARKER_FILE), { force: true });
  } catch {
  }
}
function apply(ctx, config) {
  let root = resolve(config.rootDirectory);
  const registry = ctx.workspaceRegistry;
  try {
    ctx.inject(["settings"], (settingsCtx) => {
      const scope = settingsCtx.settings.register(SETTINGS_NS, SettingsSchema, {
        base: { rootDirectory: "" }
      });
      const applyOverride = () => {
        const value = scope.getSnapshot?.().value ?? scope.getSnapshot?.();
        const dir = value?.rootDirectory;
        if (typeof dir === "string" && dir.trim().length > 0) {
          root = resolve(dir.trim());
          console.info("[temp-cwd] [host] temp root directory =", root);
        } else if (value !== void 0) {
          root = resolve(config.rootDirectory);
        }
      };
      applyOverride();
      if (typeof scope.on === "function") scope.on("update", applyOverride);
      else if (typeof scope.subscribe === "function") scope.subscribe(applyOverride);
    });
  } catch (err) {
    console.warn("[temp-cwd] [host] settings scope unavailable, using Config default:", err);
  }
  const ledger = /* @__PURE__ */ new Map();
  const finalizeNow = (dir, entry) => {
    if (entry?.abandonTimer !== null && entry?.abandonTimer !== void 0) {
      clearTimeout(entry.abandonTimer);
      entry.abandonTimer = null;
    }
    ledger.delete(dir);
    dropMarker(dir);
    const workspaceId = entry?.workspaceId;
    if (workspaceId !== null && workspaceId !== void 0) {
      registry.delete(workspaceId).catch((err) => {
        if (!String(err?.message ?? err).includes("unknown")) {
          console.warn("[temp-cwd] finalize: workspace delete failed:", err);
        }
      });
    }
    console.info("[temp-cwd] [host] finalized (folder kept, workspace removed)", dir);
  };
  const abandonNow = (dir, entry) => {
    if (entry?.abandonTimer !== null && entry?.abandonTimer !== void 0) {
      clearTimeout(entry.abandonTimer);
      entry.abandonTimer = null;
    }
    ledger.delete(dir);
    console.info("[temp-cwd] [host] abandon executing", dir);
    const job = async () => {
      const sessionId = entry?.sessionId;
      if (sessionId !== null && sessionId !== void 0) {
        try {
          if (await registry.sessionKnown(sessionId)) {
            await registry.archiveSession(sessionId);
          }
        } catch (err) {
          console.warn("[temp-cwd] [host] abandon archive failed (ignored):", err);
        }
      }
      const workspaceId = entry?.workspaceId;
      if (workspaceId !== null && workspaceId !== void 0) {
        try {
          await registry.delete(workspaceId);
        } catch (err) {
          if (!String(err?.message ?? err).includes("unknown")) {
            console.warn("[temp-cwd] [host] abandon workspace delete failed:", err);
          }
        }
      }
      removeDirIfMarkered(dir);
    };
    void job();
  };
  const scheduleAbandon = (dir, entry) => {
    if (entry.abandonTimer !== null) {
      clearTimeout(entry.abandonTimer);
    }
    entry.abandonTimer = setTimeout(() => {
      entry.abandonTimer = null;
      abandonNow(dir, ledger.get(dir));
    }, ABANDON_DEBOUNCE_MS);
  };
  const sweep = () => {
    const now = Date.now();
    for (const [dir, entry] of [...ledger.entries()]) {
      if (entry.abandonTimer !== null && entry.abandonTimer !== void 0) continue;
      if (now - markerMtime(dir) < SWEEP_AGE_MS) continue;
      console.info("[temp-cwd] [host] sweep cleaning stale temp", dir);
      abandonNow(dir, entry);
    }
  };
  ctx.effect(
    () => ctx.webServer.register({
      kind: "exact",
      path: "/api/temp-cwd/start",
      handler: (_req, res) => {
        const seg = timestamp();
        const dir = join(root, seg);
        if (!isTempDir(root, dir)) {
          json(res, 400, { error: "invalid path" });
          return;
        }
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, MARKER_FILE), (/* @__PURE__ */ new Date()).toISOString(), "utf8");
        json(res, 200, { path: dir });
      }
    }),
    "temp-cwd: start route"
  );
  ctx.effect(
    () => ctx.webServer.register({
      kind: "exact",
      path: "/api/temp-cwd/register",
      handler: (req, res) => {
        const dir = queryParam(req, "p");
        if (dir === null || !isTempDir(root, dir) || !hasMarker(dir)) {
          json(res, 400, { error: "invalid path or missing marker" });
          return;
        }
        const workspaceId = queryParam(req, "w");
        const sessionId = queryParam(req, "s");
        if (workspaceId === null || sessionId === null) {
          json(res, 400, { error: "workspaceId and sessionId required" });
          return;
        }
        const existing = ledger.get(dir);
        if (existing !== void 0) {
          existing.workspaceId = workspaceId;
          existing.sessionId = sessionId;
          if (existing.abandonTimer !== null && existing.abandonTimer !== void 0) {
            clearTimeout(existing.abandonTimer);
            existing.abandonTimer = null;
          }
        } else {
          ledger.set(dir, {
            workspaceId,
            sessionId,
            createdAt: Date.now(),
            abandonTimer: null
          });
        }
        console.info("[temp-cwd] [host] registered", { dir, workspaceId, sessionId });
        json(res, 200, { ok: true });
      }
    }),
    "temp-cwd: register route"
  );
  ctx.effect(
    () => ctx.webServer.register({
      kind: "exact",
      path: "/api/temp-cwd/finalize",
      handler: (req, res) => {
        const dir = queryParam(req, "p");
        if (dir === null || !isTempDir(root, dir)) {
          json(res, 400, { error: "invalid path" });
          return;
        }
        finalizeNow(dir, ledger.get(dir));
        json(res, 200, { ok: true });
      }
    }),
    "temp-cwd: finalize route"
  );
  ctx.effect(
    () => ctx.webServer.register({
      kind: "exact",
      path: "/api/temp-cwd/abandon",
      handler: (req, res) => {
        const dir = queryParam(req, "p");
        if (dir === null || !isTempDir(root, dir)) {
          json(res, 400, { error: "invalid path" });
          return;
        }
        const sessionId = queryParam(req, "s");
        const existing = ledger.get(dir);
        if (existing === void 0) {
          json(res, 200, { ok: true });
          return;
        }
        if (sessionId !== null) existing.sessionId = sessionId;
        scheduleAbandon(dir, existing);
        json(res, 200, { ok: true, debouncedMs: ABANDON_DEBOUNCE_MS });
      }
    }),
    "temp-cwd: abandon route"
  );
  try {
    for (const child of readdirSync(root)) {
      const dir = join(root, child);
      if (!isTempDir(root, dir)) continue;
      if (markerMtime(dir) > 0 && Date.now() - markerMtime(dir) > 24 * 60 * 60 * 1e3) {
        removeDirIfMarkered(dir);
      }
    }
  } catch {
  }
  const sweepTimer = setInterval(sweep, SWEEP_INTERVAL_MS);
  ctx.effect(
    () => () => {
      clearInterval(sweepTimer);
      for (const [, entry] of ledger) {
        if (entry.abandonTimer !== null && entry.abandonTimer !== void 0) {
          clearTimeout(entry.abandonTimer);
        }
      }
    },
    "temp-cwd: sweep timer"
  );
}
export {
  Config,
  MARKER_FILE,
  SETTINGS_NS,
  SettingsSchema,
  apply,
  inject,
  name
};
