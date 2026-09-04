// src/index.ts
import { mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import z from "schemastery";
var name = "temp-cwd";
var inject = ["webServer"];
var MARKER_FILE = ".TEMP_WORKSPACE";
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
function pathParam(req) {
  try {
    const url = new URL(req.url ?? "", "http://localhost");
    const p = url.searchParams.get("p");
    return typeof p === "string" && p.length > 0 ? p : null;
  } catch {
    return null;
  }
}
function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
function apply(ctx, config) {
  const root = resolve(config.rootDirectory);
  ctx.effect(
    () => ctx.webServer.register({
      kind: "exact",
      path: "/api/temp-cwd/mkdir",
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
    "temp-cwd: mkdir route"
  );
  ctx.effect(
    () => ctx.webServer.register({
      kind: "exact",
      path: "/api/temp-cwd/remove-dir",
      handler: (req, res) => {
        const dir = pathParam(req);
        if (dir === null || !isTempDir(root, dir)) {
          json(res, 400, { error: "invalid path" });
          return;
        }
        const marker = join(dir, MARKER_FILE);
        let hasMarker = false;
        try {
          hasMarker = statSync(marker).isFile();
        } catch {
          hasMarker = false;
        }
        if (!hasMarker) {
          json(res, 409, { removed: false, reason: "no-marker" });
          return;
        }
        rmSync(dir, { recursive: true, force: true });
        json(res, 200, { removed: true });
      }
    }),
    "temp-cwd: remove-dir route"
  );
  ctx.effect(
    () => ctx.webServer.register({
      kind: "exact",
      path: "/api/temp-cwd/remove-marker",
      handler: (req, res) => {
        const dir = pathParam(req);
        if (dir === null || !isTempDir(root, dir)) {
          json(res, 400, { error: "invalid path" });
          return;
        }
        const marker = join(dir, MARKER_FILE);
        let removed = false;
        try {
          rmSync(marker, { force: true });
          removed = true;
        } catch {
          removed = false;
        }
        json(res, 200, { removed });
      }
    }),
    "temp-cwd: remove-marker route"
  );
}
export {
  Config,
  MARKER_FILE,
  apply,
  inject,
  name
};
