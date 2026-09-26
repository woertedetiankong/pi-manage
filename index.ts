import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { sharedHub } from "./src/hub.ts";
import { localize, TERMINAL, terminalLang } from "./src/i18n.ts";
import { type ManageContext, PackageService } from "./src/packages.ts";
import { ManageApp } from "./src/server.ts";

export default function piManage(pi: ExtensionAPI): void {
  const hub = () => sharedHub(getAgentDir());
  // Until a session starts, manage what pi was launched in.
  let context: ManageContext = { cwd: process.cwd(), trusted: false };
  let app: ManageApp | undefined;
  const manageApp = () => app ??= new ManageApp({
    hub: hub(),
    service: new PackageService({ agentDir: getAgentDir(), context: () => context, selfDir: dirname(fileURLToPath(import.meta.url)) }),
    webFile: fileURLToPath(new URL("./web/manage.html", import.meta.url)),
  });

  pi.on("session_start", (_event, ctx) => {
    context = { cwd: ctx.cwd, trusted: ctx.isProjectTrusted() };
    const manage = manageApp();
    manage.loaded();
    manage.session = {
      idle: () => ctx.isIdle(),
      // Only command handlers may reload, so the page goes through /manage reload. Reloading stops the web
      // server, so start it only after the page has its answer.
      reload: () => { setTimeout(() => pi.sendUserMessage("/manage reload", { expandPromptTemplates: true }), 100); },
    };
    // Mount early (no server yet) so the other pi-web pages link here.
    hub().mount(manage);
  });

  pi.on("session_shutdown", async event => {
    if (!app) return;
    app.session = undefined;
    // Reload brings new code: leave the shared hub (it stops once every app has left) and remount on session_start.
    if (event.reason === "quit" || event.reason === "reload") { await hub().unmount(app.id); app = undefined; }
  });

  pi.registerCommand("manage", {
    description: "Manage pi packages: install, uninstall, enable, disable / 管理 pi 插件: [url | list | reload | stop]",
    getArgumentCompletions: prefix => ["url", "list", "reload", "stop"].filter(s => s.startsWith(prefix)).map(s => ({ value: s, label: s })),
    handler: async (args, ctx) => {
      const command = args.trim(), lang = terminalLang(), m = TERMINAL[lang];
      try {
        if (command === "stop") {
          // The page is shared with other pi-web apps: stop listening, keep everything mounted for the next open.
          await hub().close();
          ctx.ui.notify(m.stopped, "info");
          return;
        }
        if (command === "reload") {
          // Code after reload runs in the old runtime: nothing may follow.
          await ctx.reload();
          return;
        }
        context = { cwd: ctx.cwd, trusted: ctx.isProjectTrusted() };
        const manage = manageApp();
        if (command === "list") {
          const { packages } = await manage.service.list();
          if (!packages.length) { ctx.ui.notify(m.empty, "info"); return; }
          const lines = packages.map(p => {
            const state = !p.installed ? m.status.missing : p.enabled ? m.status.on : m.status.off;
            return `${p.enabled && p.installed ? "●" : "○"} ${p.name}${p.version ? ` ${p.version}` : ""}  [${m.scope[p.scope]} · ${state}]  ${p.source}`;
          });
          ctx.ui.notify([m.listHead(packages.length), ...lines].join("\n"), "info");
          return;
        }
        hub().mount(manage);
        await hub().start();
        const url = hub().url(manage.id) ?? "";
        if (command === "url") { ctx.ui.notify(m.url(url), "info"); return; }
        const [cmd, ...cmdArgs] = process.platform === "darwin" ? ["open"] : process.platform === "win32" ? ["cmd", "/c", "start", ""] : ["xdg-open"];
        await pi.exec(cmd!, [...cmdArgs, url]).catch(() => undefined);
        ctx.ui.notify(m.opened(url.replace(/#.*/, "")), "info");
      } catch (e) {
        ctx.ui.notify(m.failed(localize(e, lang)), "error");
      }
    },
  });
}
