window.__ModuleLoader__.load({
	id: "dsh-temp-cwd",
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
var inject = ["slots", "sessions"];
function apply(ctx) {
  ctx.slots.inject(
    "sidebar.footer.action",
    () => ctx.slots.register(
      {
        name: "sidebar.footer.action",
        id: "temp-cwd",
        order: 10
      },
      function TempCwdButton() {
        const [busy, setBusy] = React.useState(false);
        return React.createElement(
          "button",
          {
            type: "button",
            disabled: busy,
            onClick: async () => {
              setBusy(true);
              try {
                const res = await fetch("/api/temp-cwd/mkdir", { method: "POST" });
                if (!res.ok) throw new Error(`mkdir failed: ${res.status}`);
                const { path } = await res.json();
                const sessionId = await ctx.sessions.create({ cwd: path });
                await ctx.sessions.open(sessionId);
              } catch (err) {
                console.error("[temp-cwd] failed to open temp session:", err);
              } finally {
                setBusy(false);
              }
            }
          },
          "\u4E34\u65F6\u4F1A\u8BDD"
        );
      }
    )
  );
}

		return module.exports;
	}
});
