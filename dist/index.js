// src/index.ts
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import z from "schemastery";
var name = "temp-cwd";
var inject = ["webServer"];
var Config = z.object({
  /** Root directory holding the timestamped temp workspaces. */
  rootDirectory: z.string().default(join(homedir(), "Documents", "dsh-workspaces"))
});
function timestamp() {
  const d = /* @__PURE__ */ new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
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
        if (dir.split(sep).slice(0, -1).join(sep) !== root) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "invalid path" }));
          return;
        }
        mkdirSync(dir, { recursive: true });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ path: dir }));
      }
    }),
    "temp-cwd: mkdir route"
  );
}
export {
  Config,
  apply,
  inject,
  name
};
