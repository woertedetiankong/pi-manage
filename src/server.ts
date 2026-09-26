import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import type { WebApp, WebHub, WebLanguage, WebRequest } from "./hub.ts";
import { type Lang, localize, ManageError, requestLang } from "./i18n.ts";
import { isDisabled, normalizeSource, type PackageInfo, packageKey, type PackageService, type PackageSource, type Scope } from "./packages.ts";

export interface ManageOptions {
  hub: WebHub;
  service: PackageService;
  webFile: string;
}

/** What the page can do with the live pi session; absent while pi switches sessions. */
export interface SessionHooks {
  idle(): boolean;
  /** Reload extensions so configuration changes take effect. */
  reload(): void;
}

export type JobAction = "install" | "remove" | "update" | "updateAll";

export interface Job {
  id: number;
  action: JobAction;
  source?: string;
  scope?: Scope;
  state: "queued" | "running" | "done" | "error";
  log: string[];
  error?: string;
  started: string;
  finished?: string;
}

const MAX_JOBS = 30, MAX_LOG = 400;

/** How a package differs from what the running pi loaded; applies after a reload. */
export type Pending = "added" | "enabled" | "disabled" | "changed" | "updated";

/** The package manager page and API, mounted on the shared pi-web hub at /manage/ and /api/manage/. */
export class ManageApp implements WebApp {
  readonly id = "manage";
  readonly order = 90;
  readonly title: Record<WebLanguage, string> = { zh: "插件", en: "Packages" };
  readonly languages: WebLanguage[] = ["zh", "en"];
  session?: SessionHooks;
  readonly service: PackageService;

  private readonly opts: ManageOptions;
  /** Package configuration when this runtime loaded; any difference means pi needs a reload. */
  private baseline: Record<string, PackageSource>;
  /** Packages updated since then: new code, same configuration. */
  private updated = new Set<string>();
  private jobs: Job[] = [];
  private nextId = 1;
  /** Every change to packages runs here, one at a time: the pi CLI and this page edit the same settings file. */
  private queue: Promise<unknown> = Promise.resolve();
  private updates?: { keys: string[]; checked: string };

  constructor(opts: ManageOptions) {
    this.opts = opts;
    this.service = opts.service;
    this.baseline = this.safeSnapshot();
  }

  private safeSnapshot(): Record<string, PackageSource> { try { return this.service.snapshot(); } catch { return {}; } }

  /** A new runtime has loaded whatever is configured now. */
  loaded(): void { this.baseline = this.safeSnapshot(); this.updated.clear(); }

  private pendingFor(key: string, entry: PackageSource | undefined): Pending | undefined {
    const was = this.baseline[key];
    if (entry === undefined) return undefined;
    if (was === undefined) return "added";
    if (JSON.stringify(was) !== JSON.stringify(entry)) return isDisabled(was) === isDisabled(entry) ? "changed" : isDisabled(entry) ? "disabled" : "enabled";
    return this.updated.has(key) ? "updated" : undefined;
  }

  /** Per package changes, plus packages removed from settings that pi still has loaded. */
  private pending(now = this.safeSnapshot()): { byKey: Map<string, Pending>; removed: { scope: Scope; source: string }[] } {
    const byKey = new Map<string, Pending>();
    for (const [key, entry] of Object.entries(now)) { const p = this.pendingFor(key, entry); if (p) byKey.set(key, p); }
    const removed = Object.keys(this.baseline).filter(k => !(k in now)).map(k => {
      const [scope, ...rest] = k.split("\n");
      return { scope: scope as Scope, source: rest.join("\n") };
    });
    return { byKey, removed };
  }

  pendingReload(): boolean { const p = this.pending(); return p.byKey.size > 0 || p.removed.length > 0; }

  busy(): boolean { return this.jobs.some(j => j.state === "queued" || j.state === "running"); }

  page(): Promise<string> { return readFile(this.opts.webFile, "utf8"); }

  async handle(req: WebRequest): Promise<unknown> {
    const lang = requestLang(req.headers["x-lang"]);
    try {
      return await this.route(req, req.method === "POST" ? await req.json() : {}, lang);
    } catch (e) {
      const status = e instanceof ManageError ? e.status : typeof (e as { status?: unknown }).status === "number" ? (e as { status: number }).status : 500;
      throw Object.assign(new Error(localize(e, lang)), { status });
    }
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.catch(() => {}).then(fn);
    this.queue = run;
    return run;
  }

  /** Queues a pi CLI run and returns at once; the page follows it through /status. */
  enqueue(action: JobAction, scope: Scope, source: string | undefined, lang: Lang): Job {
    const args = this.service.args(action === "updateAll" ? "update" : action, source, scope);
    const job: Job = { id: this.nextId++, action, source, scope, state: "queued", log: [], started: new Date().toISOString() };
    this.jobs.push(job);
    // Finished jobs make room first; running and queued ones are never dropped.
    while (this.jobs.length > MAX_JOBS) {
      const i = this.jobs.findIndex(j => j.state === "done" || j.state === "error");
      if (i < 0) break;
      this.jobs.splice(i, 1);
    }
    void this.serial(async () => {
      job.state = "running";
      job.log.push(`$ pi ${args.join(" ")}`);
      try {
        await this.service.runPi(args, line => { job.log.push(line); if (job.log.length > MAX_LOG) job.log.splice(1, job.log.length - MAX_LOG); });
        job.state = "done";
        if (action === "update") this.updated.add(packageKey(scope, source!));
        if (action === "updateAll") for (const k of Object.keys(this.safeSnapshot())) this.updated.add(k);
        if (this.updates && action !== "install") {
          this.updates.keys = action === "updateAll" ? [] : this.updates.keys.filter(k => !k.endsWith(`\n${source}`));
        }
      } catch (e) {
        job.state = "error";
        job.error = localize(e, lang);
      } finally {
        job.finished = new Date().toISOString();
      }
    });
    return job;
  }

  private status() {
    return {
      busy: this.busy(), pendingReload: this.pendingReload(), canReload: !!this.session,
      jobs: this.jobs.map(j => ({ ...j, log: j.log.slice(-60) })),
    };
  }

  private async route(req: WebRequest, body: any, lang: Lang): Promise<unknown> {
    const scope: Scope = body.scope === "project" ? "project" : "user";
    const source = typeof body.source === "string" ? body.source : "";
    switch (`${req.method} ${req.path}`) {
      case "GET /status": return this.status();
      case "GET /packages": {
        const list = await this.service.list(), { byKey, removed } = this.pending();
        const packages: (PackageInfo & { pending?: Pending })[] = list.packages.map(p => ({ ...p, pending: byKey.get(packageKey(p.scope, p.source)) }));
        return { ...list, packages, removed, updates: this.updates, pendingReload: byKey.size > 0 || removed.length > 0, busy: this.busy() };
      }
      case "GET /job": {
        const job = this.jobs.find(j => j.id === Number(req.query.get("id")));
        if (!job) throw Object.assign(new Error("not found"), { status: 404 });
        return job;
      }
      case "POST /enable":
      case "POST /disable":
        await this.serial(() => this.service.setEnabled(scope, source, req.path === "/enable"));
        return { ok: true, pendingReload: this.pendingReload() };
      case "POST /install": return { job: this.enqueue("install", scope, normalizeSource(body.source), lang) };
      case "POST /remove":
        this.service.assertRemovable(scope, source);
        return { job: this.enqueue("remove", scope, source, lang) };
      case "POST /update":
        if (body.all) return { job: this.enqueue("updateAll", "user", undefined, lang) };
        if (!/^(npm:|git:|git@|https?:\/\/|ssh:\/\/)/.test(source)) throw new ManageError("localNoUpdate");
        return { job: this.enqueue("update", scope, source, lang) };
      case "POST /check-updates": {
        this.updates = { keys: await this.service.checkUpdates(), checked: new Date().toISOString() };
        return this.updates;
      }
      case "POST /jobs/clear":
        this.jobs = this.jobs.filter(j => j.state === "queued" || j.state === "running");
        return this.status();
      case "GET /search": return { results: await this.service.search(req.query.get("q") ?? "", req.signal) };
      case "POST /reload": {
        if (this.busy()) throw new ManageError("busy", [], 409);
        if (!this.session) throw new ManageError("switching", [], 503);
        if (!this.session.idle()) throw new ManageError("agentBusy", [], 409);
        this.session.reload();
        return { ok: true };
      }
      case "POST /open": {
        const pkg = (await this.service.list()).packages.find(p => packageKey(p.scope, p.source) === packageKey(scope, source));
        if (!pkg?.path) throw new ManageError("notFound", [], 404);
        openPath(pkg.path);
        return { ok: true };
      }
      default: throw Object.assign(new Error("not found"), { status: 404 });
    }
  }
}

/** Shows a file or folder in the system file manager. */
export function openPath(path: string): void {
  const [cmd, ...args] = process.platform === "darwin" ? ["open", "-R"] : process.platform === "win32" ? ["explorer", "/select,"] : ["xdg-open"];
  const target = process.platform === "linux" || process.platform === "freebsd" ? path.replace(/[\\/][^\\/]*\.[cm]?[jt]s$/, "") : path;
  try { spawn(cmd!, [...args, target], { detached: true, stdio: "ignore" }).on("error", () => {}).unref(); } catch {}
}
