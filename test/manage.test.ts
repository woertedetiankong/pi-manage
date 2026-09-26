import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { createHub, type WebHub } from "../src/hub.ts";
import { isDisabled, normalizeSource, packageIdentity, PackageService, type ManageContext } from "../src/packages.ts";
import { ManageApp } from "../src/server.ts";

// The child pi CLI inherits these: no catalog refresh, no telemetry.
process.env.PI_OFFLINE = "1";
process.env.PI_TELEMETRY = "0";

const TOKEN = "c".repeat(32);
const CLI = fileURLToPath(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js", import.meta.url));
let dir: string, agentDir: string, cwd: string, hub: WebHub, app: ManageApp, base: string, registry: Server;
let context: ManageContext;
const reloads: number[] = [];
let idle = true;

function makePackage(name: string, files: Record<string, string>, pi?: object): string {
  const root = join(dir, "pkgs", name);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name, version: "1.2.3", description: `${name} description`, pi }));
  for (const [file, body] of Object.entries(files)) {
    mkdirSync(join(root, file, ".."), { recursive: true });
    writeFileSync(join(root, file), body);
  }
  return realpathSync(root);
}

const EXT = "export default function () {}\n";
let alpha: string, beta: string, self: string;

async function call(path: string, body?: unknown, lang = "zh") {
  const res = await fetch(base + path, body === undefined
    ? { headers: { "x-token": TOKEN, "x-lang": lang } }
    : { method: "POST", headers: { "x-token": TOKEN, "x-lang": lang, "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, data: await res.json() as any };
}

async function waitJob(id: number) {
  for (let i = 0; i < 300; i++) {
    const { data } = await call(`/job?id=${id}`);
    if (data.state === "done" || data.state === "error") return data;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error("job timed out");
}

const globalSettings = () => JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
const packages = async () => (await call("/packages")).data.packages as any[];
const byName = async (name: string) => (await packages()).find(p => p.name === name);

before(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "pi-manage-test-")));
  agentDir = join(dir, "agent"); cwd = join(dir, "project");
  mkdirSync(agentDir, { recursive: true }); mkdirSync(cwd, { recursive: true });
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [], enableInstallTelemetry: false }));
  alpha = makePackage("alpha", { "src/a.ts": EXT, "skills/tidy/SKILL.md": "---\nname: tidy\ndescription: Tidy up\n---\nTidy.\n" }, { extensions: ["./src/a.ts"], skills: ["./skills"] });
  beta = makePackage("beta", { "extensions/one.ts": EXT, "extensions/two.ts": EXT, "prompts/review.md": "Review this\n" });
  self = makePackage("pi-manage", { "index.ts": EXT }, { extensions: ["./index.ts"] });
  writeFileSync(join(dir, "manage.html"), "<p>manage</p>");

  registry = createServer((req, res) => {
    const url = new URL(req.url!, "http://x");
    assert.equal(url.pathname, "/-/v1/search");
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ objects: [{ package: {
      name: "pi-demo", version: "2.0.0", description: `demo for ${url.searchParams.get("text")}`, date: "2026-09-01T00:00:00Z",
      links: { npm: "https://www.npmjs.com/package/pi-demo", repository: "https://github.com/x/pi-demo" }, publisher: { username: "someone" },
    } }] }));
  });
  await new Promise<void>(r => registry.listen(0, "127.0.0.1", r));

  context = { cwd, trusted: false };
  hub = createHub({ agentDir, token: TOKEN, port: 0 });
  app = new ManageApp({
    hub,
    service: new PackageService({
      agentDir, context: () => context, selfDir: self, piCommand: [process.execPath, CLI],
      registry: `http://127.0.0.1:${(registry.address() as AddressInfo).port}`,
    }),
    webFile: join(dir, "manage.html"),
  });
  app.session = { idle: () => idle, reload: () => { reloads.push(Date.now()); } };
  hub.mount(app);
  await hub.start();
  base = new URL(hub.url("manage")!).origin + "/api/manage";
});

after(async () => {
  await hub.close();
  registry.close();
  rmSync(dir, { recursive: true, force: true });
});

test("normalizeSource accepts what people paste", () => {
  assert.equal(normalizeSource("pi-foo"), "npm:pi-foo");
  assert.equal(normalizeSource(" @scope/pi-foo@1.2.0 "), "npm:@scope/pi-foo@1.2.0");
  assert.equal(normalizeSource("github.com/user/repo"), "git:github.com/user/repo");
  assert.equal(normalizeSource("https://github.com/user/repo"), "https://github.com/user/repo");
  assert.equal(normalizeSource("git:github.com/user/repo@v1"), "git:github.com/user/repo@v1");
  assert.equal(normalizeSource("./local/pkg"), "./local/pkg");
  assert.equal(normalizeSource("/abs/pkg"), "/abs/pkg");
  assert.equal(normalizeSource("~/pkg"), "~/pkg");
  assert.throws(() => normalizeSource("  "), /emptySource/);
  assert.throws(() => normalizeSource("a\nb"), /badSource/);
});

test("the fallback package identity matches pi's rules", () => {
  const id = (source: string, scope: "user" | "project" = "user") => packageIdentity({} as any, source, scope, "/agent", "/work");
  assert.equal(id("npm:@scope/pi-foo@1.2.0"), "npm:@scope/pi-foo");
  assert.equal(id("npm:pi-foo"), "npm:pi-foo");
  assert.equal(id("git:github.com/User/Repo@v1"), "git:github.com/user/repo");
  assert.equal(id("https://github.com/user/repo.git"), "git:github.com/user/repo");
  assert.equal(id("git:git@github.com:user/repo"), "git:github.com/user/repo");
  assert.equal(id("ssh://git@github.com/user/repo"), "git:github.com/user/repo");
  assert.equal(id("../pkgs/beta"), "local:/pkgs/beta");
  assert.equal(id("./beta", "project"), "local:/work/.pi/beta");
});

test("the page is served and starts with nothing to reload", async () => {
  const page = await fetch(new URL(hub.url("manage")!).origin + "/manage/");
  assert.equal(await page.text(), "<p>manage</p>");
  const { data } = await call("/status");
  assert.deepEqual(data, { busy: false, pendingReload: false, canReload: true, reloadQueued: false, jobs: [] });
  assert.deepEqual(await packages(), []);
});

test("install runs the pi CLI, lists the package with its resources and asks for a reload", async () => {
  const { status, data } = await call("/install", { source: alpha });
  assert.equal(status, 200, data.error);
  assert.equal(data.job.action, "install");
  const job = await waitJob(data.job.id);
  assert.equal(job.state, "done", job.log.join("\n"));
  assert.match(job.log[0], /^\$ pi install .*alpha --no-approve$/);
  assert.equal(globalSettings().packages.length, 1);

  const p = await byName("alpha");
  assert.equal(p.version, "1.2.3");
  assert.equal(p.description, "alpha description");
  assert.equal(p.kind, "local");
  assert.equal(p.scope, "user");
  assert.equal(realpathSync(p.path), alpha);
  assert.deepEqual([p.installed, p.enabled, p.filtered, p.self], [true, true, false, false]);
  assert.deepEqual(p.resources.extensions, [{ path: join("src", "a.ts"), enabled: true }]);
  assert.equal(p.resources.skills.length, 1);
  assert.equal((await call("/status")).data.pendingReload, true);
});

test("each row says what changes on reload", async () => {
  // As if pi reloaded with alpha installed.
  app.loaded();
  assert.equal((await call("/status")).data.pendingReload, false);
  const p = await byName("alpha");
  assert.equal(p.pending, undefined);
  await call("/disable", { scope: "user", source: p.source });
  assert.equal((await byName("alpha")).pending, "disabled");
  assert.equal((await call("/status")).data.pendingReload, true);
  // Back to what pi loaded: nothing pending.
  await call("/enable", { scope: "user", source: p.source });
  assert.equal((await byName("alpha")).pending, undefined);
  assert.equal((await call("/status")).data.pendingReload, false);
});

test("a failed install reports the CLI output", async () => {
  const { data } = await call("/install", { source: join(dir, "does-not-exist") }, "en");
  const job = await waitJob(data.job.id);
  assert.equal(job.state, "error");
  assert.match(job.error, /^Command failed \(exit \d+\)$/);
  assert.ok(job.log.length > 1, "the CLI's own explanation is in the log");
  assert.equal((await call("/status")).data.pendingReload, false, "a failed install changes nothing pi has to reload");
});

test("disable keeps the package installed and restores custom filters on enable", async () => {
  const { data } = await call("/install", { source: beta });
  assert.equal((await waitJob(data.job.id)).state, "done");
  // A filter someone set with `pi config`: skip the prompt template.
  const settings = globalSettings();
  const i = settings.packages.findIndex((p: any) => (typeof p === "string" ? p : p.source).includes("beta"));
  const source = settings.packages[i];
  settings.packages[i] = { source, prompts: [] };
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify(settings));

  let p = await byName("beta");
  assert.deepEqual([p.enabled, p.filtered], [true, true]);
  assert.equal(p.resources.extensions.length, 2);

  assert.equal((await call("/disable", { scope: "user", source })).status, 200);
  const entry = globalSettings().packages.find((x: any) => x.source === source);
  assert.ok(isDisabled(entry), JSON.stringify(entry));
  p = await byName("beta");
  assert.deepEqual([p.installed, p.enabled, p.filtered], [true, false, false]);
  assert.ok(p.resources.extensions.every((r: any) => !r.enabled));
  // Disabling twice changes nothing.
  assert.equal((await call("/disable", { scope: "user", source })).status, 200);

  assert.equal((await call("/enable", { scope: "user", source })).status, 200);
  assert.deepEqual(globalSettings().packages.find((x: any) => (x.source ?? x) === source), { source, prompts: [] });
  const stash = JSON.parse(readFileSync(join(agentDir, "pi-manage", "disabled.json"), "utf8"));
  assert.deepEqual(stash, {});
});

test("a package disabled elsewhere (no stash) is enabled back to a plain entry", async () => {
  const settings = globalSettings();
  const i = settings.packages.findIndex((p: any) => (typeof p === "string" ? p : p.source).includes("alpha"));
  const source = typeof settings.packages[i] === "string" ? settings.packages[i] : settings.packages[i].source;
  settings.packages[i] = { source, extensions: [], skills: [], prompts: [], themes: [] };
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify(settings));
  assert.equal((await byName("alpha")).enabled, false);
  await call("/enable", { scope: "user", source });
  assert.equal(globalSettings().packages[i], source);
});

test("the manager never disables or removes itself", async () => {
  const settings = globalSettings();
  settings.packages.push(self);
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify(settings));
  const p = await byName("pi-manage");
  assert.equal(p.self, true);
  assert.equal(p.pending, "added");
  const off = await call("/disable", { scope: "user", source: self }, "en");
  assert.equal(off.status, 409);
  assert.match(off.data.error, /cannot disable or uninstall itself/);
  assert.equal((await call("/remove", { scope: "user", source: self })).status, 409);
  assert.ok(globalSettings().packages.includes(self));
});

test("remove drops the settings entry; local files stay", async () => {
  const p = await byName("alpha");
  const { data } = await call("/remove", { scope: "user", source: p.source });
  assert.equal((await waitJob(data.job.id)).state, "done");
  assert.equal(await byName("alpha"), undefined);
  assert.ok(readFileSync(join(alpha, "package.json")));
  // Still loaded in the running pi until it reloads.
  assert.deepEqual((await call("/packages")).data.removed, [{ scope: "user", source: p.source }]);
});

test("unknown packages, local updates and untrusted projects are refused", async () => {
  assert.equal((await call("/enable", { scope: "user", source: "npm:nope" })).status, 404);
  const local = await call("/update", { scope: "user", source: beta }, "en");
  assert.equal(local.status, 400);
  assert.match(local.data.error, /Local packages need no update/);
  const project = await call("/install", { scope: "project", source: alpha }, "en");
  assert.equal(project.status, 403);
  assert.match(project.data.error, /not trusted/);
});

test("trusted projects get their own packages", async () => {
  context = { cwd, trusted: true };
  try {
    const { data } = await call("/install", { scope: "project", source: alpha });
    const job = await waitJob(data.job.id);
    assert.equal(job.state, "done", job.log.join("\n"));
    assert.match(job.log[0], /--local --approve$/);
    const project = JSON.parse(readFileSync(join(cwd, ".pi", "settings.json"), "utf8"));
    assert.equal(project.packages.length, 1);
    const list = (await call("/packages")).data;
    assert.equal(list.trusted, true);
    const p = list.packages.find((x: any) => x.name === "alpha");
    assert.equal(p.scope, "project");
    await call("/disable", { scope: "project", source: p.source });
    assert.ok(isDisabled(JSON.parse(readFileSync(join(cwd, ".pi", "settings.json"), "utf8")).packages[0]));
    await call("/enable", { scope: "project", source: p.source });
    assert.equal(JSON.parse(readFileSync(join(cwd, ".pi", "settings.json"), "utf8")).packages[0], p.source);
  } finally { context = { cwd, trusted: false }; }
  // Untrusted again: project packages are neither listed nor editable.
  assert.equal((await packages()).some(p => p.scope === "project"), false);
});

test("a project copy of a global package is labelled on both sides", async () => {
  context = { cwd, trusted: true };
  const projectFile = join(cwd, ".pi", "settings.json");
  try {
    writeFileSync(projectFile, JSON.stringify({ packages: [beta] }));
    let list = (await call("/packages")).data.packages.filter((p: any) => p.name === "beta");
    const user = list.find((p: any) => p.scope === "user"), project = list.find((p: any) => p.scope === "project");
    assert.deepEqual([user.overridden, user.overrides], [true, false], "pi loads the project copy instead");
    assert.deepEqual([project.overridden, project.overrides], [false, true]);
    assert.equal(user.resources.extensions.length, 0);
    // autoload:false narrows the global entry instead of replacing it.
    writeFileSync(projectFile, JSON.stringify({ packages: [{ source: beta, autoload: false }] }));
    list = (await call("/packages")).data.packages.filter((p: any) => p.name === "beta");
    assert.ok(list.every((p: any) => !p.overridden && !p.overrides));
  } finally {
    writeFileSync(projectFile, JSON.stringify({ packages: [] }));
    context = { cwd, trusted: false };
  }
});

test("search asks the registry for pi-package", async () => {
  const { status, data } = await call("/search?q=robot");
  assert.equal(status, 200, data.error);
  assert.deepEqual(data.results, [{
    name: "pi-demo", version: "2.0.0", description: "demo for keywords:pi-package robot", date: "2026-09-01T00:00:00Z",
    npm: "https://www.npmjs.com/package/pi-demo", repository: "https://github.com/x/pi-demo", homepage: undefined, publisher: "someone",
  }].map(r => JSON.parse(JSON.stringify(r))));
});

test("undo after uninstall reinstalls and restores the exact settings entry", async () => {
  const p = await byName("beta");
  // Disabled, with a pi config filter kept aside: Undo must bring back exactly this.
  await call("/disable", { scope: "user", source: p.source });
  const before = globalSettings().packages.find((x: any) => (x.source ?? x) === p.source);
  app.loaded();

  const removed = (await call("/remove", { scope: "user", source: p.source })).data.job;
  const done = await waitJob(removed.id);
  assert.equal(done.state, "done");
  assert.equal(done.undoable, true);
  assert.equal(await byName("beta"), undefined);

  const { status, data } = await call("/undo", { id: removed.id });
  assert.equal(status, 200, data.error);
  assert.equal(data.job.action, "restore");
  const restored = await waitJob(data.job.id);
  assert.equal(restored.state, "done", restored.log.join("\n"));
  assert.match(restored.log[0], /^\$ pi install \/.*beta --no-approve$/, "local packages reinstall from their resolved path");
  assert.deepEqual(globalSettings().packages.find((x: any) => (x.source ?? x) === p.source), before);
  const back = await byName("beta");
  assert.deepEqual([back.enabled, back.pending], [false, undefined], "back to what pi has loaded: nothing to reload");
  assert.equal((await call(`/job?id=${removed.id}`)).data.undoable, false);
  assert.equal((await call("/undo", { id: removed.id }, "en")).status, 409, "an uninstall is undone once");
  // Enabling still brings back the filter from before the disable.
  await call("/enable", { scope: "user", source: p.source });
  assert.deepEqual(globalSettings().packages.find((x: any) => (x.source ?? x) === p.source), { source: p.source, prompts: [] });
});

test("reload waits until pi and the job queue are idle", async () => {
  reloads.length = 0;
  // pi is busy: the reload is queued, not refused.
  idle = false;
  let r = await call("/reload", {});
  assert.deepEqual(r.data, { queued: true });
  assert.equal((await call("/status")).data.reloadQueued, true);
  await new Promise(res => setTimeout(res, 1200));
  assert.equal(reloads.length, 0);
  idle = true;
  // agent_settled calls tryReload; the timer would get there within a second anyway.
  assert.equal(app.tryReload(), true);
  assert.equal(reloads.length, 1);
  assert.equal((await call("/status")).data.reloadQueued, false);

  // A running job holds the reload until it finishes.
  const job = (await call("/install", { source: join(dir, "missing-again") })).data.job;
  r = await call("/reload", {});
  assert.deepEqual(r.data, { queued: true });
  await waitJob(job.id);
  assert.equal(reloads.length, 2);

  // Cancel drops a queued reload.
  idle = false;
  await call("/reload", {});
  const cancelled = await call("/reload/cancel", {});
  assert.equal(cancelled.data.reloadQueued, false);
  idle = true;
  await new Promise(res => setTimeout(res, 1200));
  assert.equal(reloads.length, 2);

  // Idle now: reloads at once.
  assert.deepEqual((await call("/reload", {})).data, { queued: false });
  assert.equal(reloads.length, 3);
  app.loaded();
  assert.equal((await call("/status")).data.pendingReload, false);
  const saved = app.session;
  app.session = undefined;
  assert.equal((await call("/reload", {})).status, 503);
  app.session = saved;
});

test("clearing finished jobs keeps uninstalls that can still be undone", async () => {
  const { data } = await call("/jobs/clear", {});
  // alpha's uninstall was never undone.
  assert.deepEqual(data.jobs.map((j: any) => [j.action, j.undoable]), [["remove", true]]);
});
