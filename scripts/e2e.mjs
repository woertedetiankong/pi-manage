// End-to-end check inside a real pi process (RPC mode), with a throwaway agent dir:
// /manage url → install through the page → Reload button → the new package is loaded.
// Usage: npm run e2e  (uses `pi` from PATH, or PI_BIN=/path/to/cli.js)
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const dir = realpathSync(mkdtempSync(join(tmpdir(), "pi-manage-e2e-")));
const agentDir = join(dir, "agent"), cwd = join(dir, "project"), probe = join(dir, "probe");
for (const d of [agentDir, cwd, probe]) mkdirSync(d, { recursive: true });
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [root], enableInstallTelemetry: false }));
// A package that announces itself when pi loads it.
writeFileSync(join(probe, "package.json"), JSON.stringify({ name: "probe", version: "1.0.0", pi: { extensions: ["./probe.ts"] } }));
writeFileSync(join(probe, "probe.ts"), `export default function (pi) { pi.on("session_start", (e, ctx) => ctx.ui.notify("probe loaded (" + e.reason + ")", "info")); }\n`);

const [cmd, ...pre] = process.env.PI_BIN ? [process.execPath, process.env.PI_BIN] : ["pi"];
const pi = spawn(cmd, [...pre, "--mode", "rpc", "--no-session"], {
  cwd, stdio: ["pipe", "pipe", "inherit"],
  env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_TELEMETRY: "0", PI_MANAGE_LANG: "en" },
});
const notes = [];
let buf = "", waiters = [];
pi.stdout.on("data", chunk => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).replace(/\r$/, ""); buf = buf.slice(i + 1);
    let rec; try { rec = JSON.parse(line); } catch { continue; }
    if (rec.type === "extension_ui_request" && rec.method === "notify") { notes.push(rec.message); console.log("  notify:", rec.message); }
    waiters = waiters.filter(w => !w());
  }
});
const until = (test, what, ms = 20_000) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms);
  const check = () => { const v = test(); if (v) { clearTimeout(t); resolve(v); return true; } return false; };
  if (!check()) waiters.push(check);
});
const poll = async (test, what, ms = 30_000) => {
  const end = Date.now() + ms;
  for (;;) {
    try { const v = await test(); if (v) return v; } catch {}
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise(r => setTimeout(r, 200));
  }
};
const send = rec => pi.stdin.write(JSON.stringify(rec) + "\n");
const step = s => console.log(`• ${s}`);

let failed = false;
try {
  step("/manage url");
  send({ id: "1", type: "prompt", message: "/manage url" });
  const url = new URL(await until(() => notes.map(n => /(http:\S+)/.exec(n)?.[1]).find(Boolean), "the page url"));
  const token = /token=([a-f0-9]+)/.exec(url.hash)[1], api = `${url.origin}/api/manage`;
  const call = async (path, body) => {
    const res = await fetch(api + path, body === undefined ? { headers: { "x-token": token, "x-lang": "en" } }
      : { method: "POST", headers: { "x-token": token, "x-lang": "en", "content-type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json();
    if (!res.ok) throw new Error(`${path}: ${data.error}`);
    return data;
  };

  let status = await call("/status");
  if (status.pendingReload) throw new Error("pending reload right after start");
  const self = (await call("/packages")).packages.find(p => p.self);
  if (!self) throw new Error("pi-manage does not recognise itself");

  step("install through the page (runs the pi CLI found automatically)");
  const { job } = await call("/install", { source: probe });
  const done = await poll(async () => { const j = await call(`/job?id=${job.id}`); return j.state === "done" || j.state === "error" ? j : undefined; }, "the install");
  console.log("  " + done.log.join("\n  "));
  if (done.state !== "done") throw new Error(`install failed: ${done.error}`);
  const listed = (await call("/packages")).packages.find(p => p.name === "probe");
  if (!listed || listed.pending !== "added") throw new Error(`probe should be pending "added": ${JSON.stringify(listed)}`);
  if (notes.some(n => n.startsWith("probe loaded"))) throw new Error("probe loaded before the reload");
  if (!(await call("/status")).pendingReload) throw new Error("no pending reload after install");

  step("disable pi-manage itself is refused");
  const selfOff = await fetch(api + "/disable", { method: "POST", headers: { "x-token": token, "content-type": "application/json" }, body: JSON.stringify({ scope: "user", source: self.source }) });
  if (selfOff.status !== 409) throw new Error(`disabling itself returned ${selfOff.status}`);

  step("uninstall, then Undo");
  const job2 = (await call("/remove", { scope: "user", source: listed.source })).job;
  const removed = await poll(async () => { const j = await call(`/job?id=${job2.id}`); return j.state === "done" || j.state === "error" ? j : undefined; }, "the uninstall");
  if (removed.state !== "done" || !removed.undoable) throw new Error(`uninstall: ${JSON.stringify(removed)}`);
  const undo = (await call("/undo", { id: removed.undoId })).job;
  const undone = await poll(async () => { const j = await call(`/job?id=${undo.id}`); return j.state === "done" || j.state === "error" ? j : undefined; }, "the undo");
  if (undone.state !== "done") throw new Error(`undo failed: ${undone.error}`);
  const again = (await call("/packages")).packages.find(p => p.name === "probe");
  if (!again || again.pending !== "added") throw new Error(`probe should be back and pending: ${JSON.stringify(again)}`);

  step("Reload while a job runs: it waits, then reloads by itself");
  await call("/install", { source: join(dir, "does-not-exist") });
  const queued = await call("/reload", {});
  if (!queued.queued) throw new Error("reload should wait for the running job");
  await until(() => notes.find(n => n === "probe loaded (reload)"), "the probe to load after reload");
  status = await poll(async () => { const s = await call("/status"); return s.pendingReload ? undefined : s; }, "the page to settle after reload");
  const after = (await call("/packages")).packages.find(p => p.name === "probe");
  if (after.pending) throw new Error(`probe still pending after reload: ${after.pending}`);

  step("untick one resource: the row says it changes on reload");
  await call("/resource", { scope: "user", source: after.source, type: "extensions", path: "probe.ts", enabled: false });
  const ticked = (await call("/packages")).packages.find(p => p.name === "probe");
  if (ticked.pending !== "changed" || ticked.resources.extensions[0].enabled) throw new Error(`resource toggle: ${JSON.stringify(ticked)}`);
  await call("/resource", { scope: "user", source: after.source, type: "extensions", path: "probe.ts", enabled: true });

  step("uninstall, reload, then Undo still works");
  const job3 = (await call("/remove", { scope: "user", source: after.source })).job;
  await poll(async () => { const j = await call(`/job?id=${job3.id}`); return j.state === "done" ? j : undefined; }, "the uninstall");
  await call("/reload", {});
  await poll(async () => { const s = await call("/status"); return !s.pendingReload && !s.jobs.length ? s : undefined; }, "the reload");
  const record = (await call("/packages")).undo.find(u => u.name === "probe");
  if (!record) throw new Error("Undo was lost with the reload");
  const job4 = (await call("/undo", { id: record.id })).job;
  const back = await poll(async () => { const j = await call(`/job?id=${job4.id}`); return j.state === "done" || j.state === "error" ? j : undefined; }, "the undo");
  if (back.state !== "done") throw new Error(`undo after reload failed: ${back.error}`);
  if (!(await call("/packages")).packages.some(p => p.name === "probe")) throw new Error("probe did not come back");
  console.log("\n✔ reload works end to end inside pi");
} catch (e) {
  failed = true;
  console.error("\n✘", e.message);
} finally {
  // Wait for pi to exit so it never writes into a closed pipe.
  await new Promise(r => { pi.once("exit", r); pi.kill(); setTimeout(r, 5000); });
  rmSync(dir, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}
