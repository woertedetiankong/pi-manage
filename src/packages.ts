import { DefaultPackageManager, type PackageSource, SettingsManager } from "@earendil-works/pi-coding-agent";

export type { PackageSource };
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { ManageError } from "./i18n.ts";

export type Scope = "user" | "project";
export type Kind = "npm" | "git" | "local";
export const RESOURCE_TYPES = ["extensions", "skills", "prompts", "themes"] as const;
export type ResourceType = typeof RESOURCE_TYPES[number];

export interface Resource { path: string; enabled: boolean }

export interface PackageInfo {
  source: string;
  scope: Scope;
  kind: Kind;
  /** package.json name, or the file / folder name. */
  name: string;
  version?: string;
  description?: string;
  homepage?: string;
  /** Where the package lives on disk; absent when it is configured but not installed. */
  path?: string;
  installed: boolean;
  /** False when every resource type is filtered to [] (what disable writes). */
  enabled: boolean;
  /** Custom resource filters other than a full disable, e.g. from `pi config`. */
  filtered: boolean;
  /** The package manager itself. */
  self: boolean;
  /** A global entry that pi skips because this project configures the same package. */
  overridden: boolean;
  /** A project entry that replaces the global entry for the same package. */
  overrides: boolean;
  resources: Record<ResourceType, Resource[]>;
}

export interface ManageContext { cwd: string; trusted: boolean }

export interface PackageServiceOptions {
  agentDir: string;
  /** The live session's working directory and project trust. */
  context: () => ManageContext;
  /** This package's root, so it never disables or removes itself. */
  selfDir?: string;
  /** How to run the pi CLI; defaults to the running pi. */
  piCommand?: string[];
  registry?: string;
}

export interface SearchResult {
  name: string; version: string; description: string; date?: string;
  npm?: string; repository?: string; homepage?: string; publisher?: string;
}

export const sourceOf = (p: PackageSource) => typeof p === "string" ? p : p.source;
/** A package with every resource type filtered to [] loads nothing: that is how it is disabled. */
export const isDisabled = (p: PackageSource) => typeof p === "object" && RESOURCE_TYPES.every(t => Array.isArray(p[t]) && p[t]!.length === 0);

export function kindOf(source: string): Kind {
  if (source.startsWith("npm:")) return "npm";
  if (/^(git:|git@|https?:\/\/|ssh:\/\/)/.test(source)) return "git";
  return "local";
}

/**
 * Accepts what people paste: "pi-foo" or "@scope/pi-foo@1.2" become npm sources,
 * "github.com/user/repo" becomes a git source; paths and explicit sources pass through.
 */
export function normalizeSource(input: unknown): string {
  const s = typeof input === "string" ? input.trim() : "";
  if (!s) throw new ManageError("emptySource");
  if (/[\r\n]/.test(s)) throw new ManageError("badSource");
  if (/^(npm:|git:|git@|https?:\/\/|ssh:\/\/)/.test(s)) return s;
  if (/^(github\.com|gitlab\.com|bitbucket\.org|codeberg\.org)\//i.test(s)) return `git:${s}`;
  if (/^[.~/\\]/.test(s) || /^[A-Za-z]:[\\/]/.test(s)) return s;
  if (/^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(@[\w.^~<>=*-]+)?$/i.test(s)) return `npm:${s}`;
  return s;
}

const real = (p: string) => { try { return realpathSync(p); } catch { return resolve(p); } };
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

function manifest(path: string | undefined): { name?: string; version?: string; description?: string; homepage?: string } {
  if (!path) return {};
  try {
    const dir = statSync(path).isDirectory() ? path : dirname(path);
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    const repo = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url;
    const homepage = typeof pkg.homepage === "string" ? pkg.homepage
      : typeof repo === "string" ? repo.replace(/^git\+/, "").replace(/\.git$/, "").replace(/^git@github\.com:/, "https://github.com/") : undefined;
    return {
      name: typeof pkg.name === "string" ? pkg.name : undefined,
      version: typeof pkg.version === "string" ? pkg.version : undefined,
      description: typeof pkg.description === "string" ? pkg.description : undefined,
      homepage: homepage?.startsWith("http") ? homepage : undefined,
    };
  } catch { return {}; }
}

/** The command that runs this pi: its own script under node, or `pi` from PATH. */
function defaultPiCommand(): string[] {
  const script = process.argv[1];
  if (script && /[\\/](cli|pi)(\.[cm]?js)?$/.test(script) && existsSync(script)) return [process.execPath, script];
  return ["pi"];
}

/**
 * Reads and changes pi's package configuration. Listing and enable / disable work on the settings
 * files directly; install, remove and update run the pi CLI in a child process, because pi's own
 * installer lets npm and git write to the terminal, which would scribble over the running TUI.
 */
export class PackageService {
  private readonly opts: PackageServiceOptions;
  constructor(opts: PackageServiceOptions) { this.opts = opts; }

  get agentDir(): string { return this.opts.agentDir; }

  private managers() {
    const { cwd, trusted } = this.opts.context();
    // Fresh each time: pi, `pi config` or another terminal may have changed the files since.
    const settings = SettingsManager.create(cwd, this.opts.agentDir, { projectTrusted: trusted });
    const pm = new DefaultPackageManager({ cwd, agentDir: this.opts.agentDir, settingsManager: settings });
    return { settings, pm, cwd, trusted };
  }

  private entries(settings: SettingsManager, trusted: boolean): { scope: Scope; entry: PackageSource }[] {
    return [
      ...(settings.getGlobalSettings().packages ?? []).map(entry => ({ scope: "user" as const, entry })),
      ...(trusted ? settings.getProjectSettings().packages ?? [] : []).map(entry => ({ scope: "project" as const, entry })),
    ];
  }

  /** Every configured entry by scope + source, to compare against what the running pi loaded. */
  snapshot(): Record<string, PackageSource> {
    const { settings, trusted } = this.managers();
    return Object.fromEntries(this.entries(settings, trusted).map(({ scope, entry }) => [packageKey(scope, sourceOf(entry)), entry]));
  }

  private isSelf(path: string | undefined): boolean {
    return !!path && !!this.opts.selfDir && real(path) === real(this.opts.selfDir);
  }

  async list(): Promise<{ packages: PackageInfo[]; cwd: string; trusted: boolean }> {
    const { settings, pm, cwd, trusted } = this.managers();
    // "skip": listing must never install what is missing.
    const resolved = await pm.resolve(async () => "skip").catch(() => undefined);
    const entries = this.entries(settings, trusted);
    // pi keeps one entry per package: a project entry replaces the global one, unless it is an autoload:false delta over it.
    const identity = (scope: Scope, source: string) => packageIdentity(pm, source, scope, this.opts.agentDir, this.opts.context().cwd);
    const replacing = new Set(entries.filter(e => e.scope === "project" && !(typeof e.entry === "object" && e.entry.autoload === false))
      .map(e => identity("project", sourceOf(e.entry))));
    const globalIds = new Set(entries.filter(e => e.scope === "user").map(e => identity("user", sourceOf(e.entry))));
    const packages = entries.map(({ scope, entry }): PackageInfo => {
      const source = sourceOf(entry), id = identity(scope, source);
      let path: string | undefined;
      try { path = pm.getInstalledPath(source, scope); } catch {}
      const meta = manifest(path);
      const resources = Object.fromEntries(RESOURCE_TYPES.map(t => [t, [] as Resource[]])) as Record<ResourceType, Resource[]>;
      for (const t of RESOURCE_TYPES) {
        for (const r of resolved?.[t] ?? []) {
          if (r.metadata.origin !== "package" || r.metadata.scope !== scope || r.metadata.source !== source) continue;
          const base = r.metadata.baseDir ?? path;
          const rel = base && (r.path === base || r.path.startsWith(base + sep)) ? relative(base, r.path) : "";
          resources[t].push({ path: rel || basename(r.path), enabled: r.enabled });
        }
      }
      return {
        source, scope, kind: kindOf(source),
        name: meta.name ?? (path ? basename(path) : source.replace(/^(npm:|git:)/, "").replace(/\/+$/, "").split("/").pop() || source),
        version: meta.version, description: meta.description, homepage: meta.homepage,
        path, installed: !!path, enabled: !isDisabled(entry), filtered: typeof entry === "object" && !isDisabled(entry),
        self: this.isSelf(path), resources,
        overridden: scope === "user" && replacing.has(id),
        overrides: scope === "project" && replacing.has(id) && globalIds.has(id),
      };
    });
    return { packages, cwd, trusted };
  }

  /** Scope + source of every package with a newer version (npm and unpinned git only). */
  async checkUpdates(): Promise<string[]> {
    const { pm } = this.managers();
    return (await pm.checkForAvailableUpdates()).map(u => packageKey(u.scope, u.source));
  }

  private stashFile(): string { return join(this.opts.agentDir, "pi-manage", "disabled.json"); }
  private stashKey(scope: Scope, source: string): string {
    return scope === "user" ? `user\n${source}` : `project\n${resolve(this.opts.context().cwd)}\n${source}`;
  }
  private readStash(): Promise<Record<string, PackageSource>> { return readJson(this.stashFile(), {}); }
  private writeStash(stash: Record<string, PackageSource>): Promise<void> { return writeJson(this.stashFile(), stash); }

  /**
   * Disable replaces the entry with one that loads no resources and keeps the old entry aside
   * (custom filters included); enable puts the old entry back. The package stays installed.
   */
  async setEnabled(scope: Scope, source: string, enabled: boolean): Promise<void> {
    const { settings, pm, trusted } = this.managers();
    if (scope === "project" && !trusted) throw new ManageError("notTrusted", [], 403);
    const packages = [...(scope === "project" ? settings.getProjectSettings() : settings.getGlobalSettings()).packages ?? []];
    const i = packages.findIndex(p => sourceOf(p) === source);
    if (i < 0) throw new ManageError("notFound", [], 404);
    const entry = packages[i]!, key = this.stashKey(scope, source), stash = await this.readStash();
    if (enabled === !isDisabled(entry)) return;
    if (!enabled) {
      if (this.isSelf(pm.getInstalledPath(source, scope))) throw new ManageError("self", [], 409);
      // Stash first: a crash in between leaves the package enabled, never its filters lost.
      stash[key] = entry;
      await this.writeStash(stash);
      packages[i] = { source, extensions: [], skills: [], prompts: [], themes: [] };
    } else {
      const saved = stash[key];
      packages[i] = saved && sourceOf(saved) === source && !isDisabled(saved) ? saved : source;
    }
    if (scope === "project") settings.setProjectPackages(packages); else settings.setPackages(packages);
    await settings.flush();
    if (enabled && key in stash) { delete stash[key]; await this.writeStash(stash); }
  }

  /** Arguments for `pi install | remove | update`; project scope passes the session's trust on. */
  args(action: "install" | "remove" | "update", source: string | undefined, scope: Scope): string[] {
    const { trusted } = this.opts.context();
    if (scope === "project" && !trusted) throw new ManageError("notTrusted", [], 403);
    const trust = trusted ? "--approve" : "--no-approve";
    if (action === "update") return source ? ["update", source, trust] : ["update", "--extensions", trust];
    return [action, source!, ...(scope === "project" ? ["--local"] : []), trust];
  }

  /**
   * What Undo needs after an uninstall: the settings entry as it was (filters, disabled state) and a source
   * `pi install` can fetch it from again. Local sources in settings are relative to the settings file, so
   * those reinstall from the resolved path.
   */
  undoInfo(scope: Scope, source: string): { entry: PackageSource; install: string; name: string } | undefined {
    const { settings, pm } = this.managers();
    const entry = (scope === "project" ? settings.getProjectSettings() : settings.getGlobalSettings()).packages?.find(p => sourceOf(p) === source);
    if (!entry) return undefined;
    let path: string | undefined;
    try { path = pm.getInstalledPath(source, scope); } catch {}
    if (kindOf(source) === "local" && !path) return undefined;
    const name = manifest(path).name ?? (path ? basename(path) : source);
    return { entry, install: kindOf(source) === "local" ? path! : source, name };
  }

  private undoFile(): string { return join(this.opts.agentDir, "pi-manage", "undo.json"); }

  /** Keeps what Undo needs on disk, so it survives the reload that usually follows an uninstall. */
  async addUndo(scope: Scope, source: string, info: { entry: PackageSource; install: string; name: string }): Promise<string> {
    const records = await readJson<UndoRecord[]>(this.undoFile(), []);
    const id = randomBytes(6).toString("hex");
    records.push({ id, scope, cwd: scope === "project" ? resolve(this.opts.context().cwd) : undefined, source, removedAt: new Date().toISOString(), ...info });
    await writeJson(this.undoFile(), records.slice(-MAX_UNDO));
    return id;
  }

  /** Uninstalls that can still be undone here: this project's or global ones, not configured again since. */
  async undoList(): Promise<UndoRecord[]> {
    const { settings, pm, cwd, trusted } = this.managers();
    const configured = new Set(this.entries(settings, trusted).map(e => `${e.scope}\n${packageIdentity(pm, sourceOf(e.entry), e.scope, this.opts.agentDir, cwd)}`));
    return (await readJson<UndoRecord[]>(this.undoFile(), [])).filter(r =>
      (r.scope === "user" || (trusted && r.cwd === resolve(cwd))) &&
      !configured.has(`${r.scope}\n${packageIdentity(pm, r.source, r.scope, this.opts.agentDir, cwd)}`));
  }

  async dropUndo(id: string): Promise<void> {
    const records = await readJson<UndoRecord[]>(this.undoFile(), []);
    await writeJson(this.undoFile(), records.filter(r => r.id !== id));
  }

  /**
   * Turns one resource of a package on or off, writing the same +path / -path patterns as `pi config`.
   * Only +/- patterns mean "everything else as usual", so turning a resource back on just drops its -path;
   * +path is added only when other include / exclude patterns would still leave it out, and a type set to
   * [] (none) becomes [path].
   */
  async setResource(scope: Scope, source: string, type: ResourceType, path: string, enabled: boolean): Promise<void> {
    const { settings, pm, trusted } = this.managers();
    if (scope === "project" && !trusted) throw new ManageError("notTrusted", [], 403);
    if (!RESOURCE_TYPES.includes(type) || !path || path.startsWith("/") || path.split(/[\\/]/).includes("..")) throw new ManageError("notFound", [], 404);
    const packages = [...(scope === "project" ? settings.getProjectSettings() : settings.getGlobalSettings()).packages ?? []];
    const i = packages.findIndex(p => sourceOf(p) === source);
    if (i < 0) throw new ManageError("notFound", [], 404);
    if (isDisabled(packages[i]!)) throw new ManageError("packageDisabled", [], 409);
    if (!enabled && this.isSelf(pm.getInstalledPath(source, scope))) throw new ManageError("self", [], 409);
    const entry = typeof packages[i] === "string" ? { source } : { ...(packages[i] as Exclude<PackageSource, string>) };
    const current = entry[type];
    if (current?.length === 0) {
      // [] loads none of this type: turning one on means loading just that one.
      if (enabled) entry[type] = [path];
    } else {
      let rest = (current ?? []).filter(p => !(/^[+-]/.test(p) && p.slice(1) === path));
      // A plain include of exactly this path (what turning one on in a [] type writes) is simply taken out.
      const included = rest.includes(path);
      if (!enabled && included) rest = rest.filter(p => p !== path);
      else if (!enabled) rest.push(`-${path}`);
      else if (rest.some(p => !/^[+-]/.test(p))) rest.push(`+${path}`);
      entry[type] = rest.length ? rest : !enabled && included ? [] : undefined;
    }
    const hasFilters = RESOURCE_TYPES.some(t => entry[t] !== undefined) || entry.autoload !== undefined;
    packages[i] = hasFilters ? entry : source;
    if (scope === "project") settings.setProjectPackages(packages); else settings.setPackages(packages);
    await settings.flush();
  }

  /** After Undo reinstalled a package, put its old settings entry back in place of the fresh one. */
  async restoreEntry(scope: Scope, original: PackageSource): Promise<void> {
    const { settings, pm, cwd } = this.managers();
    const packages = [...(scope === "project" ? settings.getProjectSettings() : settings.getGlobalSettings()).packages ?? []];
    const id = packageIdentity(pm, sourceOf(original), scope, this.opts.agentDir, cwd);
    const i = packages.findIndex(p => packageIdentity(pm, sourceOf(p), scope, this.opts.agentDir, cwd) === id);
    if (i < 0) return;
    packages[i] = original;
    if (scope === "project") settings.setProjectPackages(packages); else settings.setPackages(packages);
    await settings.flush();
  }

  /** Throws unless the package may be removed from the page. */
  assertRemovable(scope: Scope, source: string): void {
    const { pm } = this.managers();
    let path: string | undefined;
    try { path = pm.getInstalledPath(source, scope); } catch {}
    if (this.isSelf(path)) throw new ManageError("self", [], 409);
  }

  /** Runs the pi CLI, streaming its output line by line; rejects when it exits non-zero. */
  runPi(args: string[], onLine: (line: string) => void, signal?: AbortSignal): Promise<void> {
    const [cmd, ...pre] = this.opts.piCommand ?? defaultPiCommand();
    return new Promise((done, fail) => {
      const child = spawn(cmd!, [...pre, ...args], {
        cwd: this.opts.context().cwd, signal, stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, PI_CODING_AGENT_DIR: this.opts.agentDir, NO_COLOR: "1", FORCE_COLOR: "0" },
      });
      let tail = "";
      const feed = (chunk: Buffer) => {
        const lines = (tail + chunk.toString("utf8")).split(/\r\n|\r|\n/);
        tail = lines.pop() ?? "";
        for (const l of lines) { const clean = l.replace(ANSI, "").trimEnd(); if (clean) onLine(clean); }
      };
      child.stdout.on("data", feed);
      child.stderr.on("data", feed);
      child.on("error", fail);
      child.on("close", (code, sig) => {
        const rest = tail.replace(ANSI, "").trim();
        if (rest) onLine(rest);
        if (code === 0) done(); else fail(new ManageError("commandFailed", [sig ?? `exit ${code}`], 500));
      });
    });
  }

  /** npm packages tagged pi-package, the same set the pi.dev gallery lists. */
  async search(query: string, signal: AbortSignal): Promise<SearchResult[]> {
    const text = `keywords:pi-package ${query.slice(0, 100)}`.trim();
    const registry = (this.opts.registry ?? "https://registry.npmjs.org").replace(/\/+$/, "");
    let res: Response;
    try {
      res = await fetch(`${registry}/-/v1/search?text=${encodeURIComponent(text)}&size=50`, { signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) });
    } catch (e) { throw new ManageError("searchFailed", [(e as Error).message], 502); }
    if (!res.ok) throw new ManageError("searchFailed", [`HTTP ${res.status}`], 502);
    const data = await res.json() as { objects?: { package: any }[] };
    return (data.objects ?? []).map(({ package: p }) => ({
      name: String(p.name), version: String(p.version ?? ""), description: String(p.description ?? ""), date: p.date,
      npm: p.links?.npm, repository: p.links?.repository, homepage: p.links?.homepage, publisher: p.publisher?.username,
    }));
  }
}

export const packageKey = (scope: string, source: string) => `${scope}\n${source}`;

export interface UndoRecord {
  id: string; scope: Scope; source: string; name: string; removedAt: string;
  /** Project uninstalls only undo in the same project. */
  cwd?: string;
  entry: PackageSource; install: string;
}

const MAX_UNDO = 10;

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try { return JSON.parse(await readFile(file, "utf8")); } catch { return fallback; }
}

async function writeJson(file: string, data: unknown): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`;
  await mkdir(dirname(file), { recursive: true });
  await writeFile(tmp, JSON.stringify(data, null, 2));
  await rename(tmp, file);
}

/**
 * The identity pi dedupes packages by: npm name, git host/path, or resolved local path.
 * Uses pi's own (private) method when it is there, so the page agrees with what pi loads.
 */
export function packageIdentity(pm: DefaultPackageManager, source: string, scope: Scope, agentDir: string, cwd: string): string {
  const own = (pm as unknown as { getPackageIdentity?: (s: string, sc: Scope) => string }).getPackageIdentity;
  if (typeof own === "function") { try { return own.call(pm, source, scope); } catch {} }
  const kind = kindOf(source);
  if (kind === "npm") return `npm:${source.slice(4).replace(/(.)@[^/]*$/, "$1")}`;
  if (kind === "git") {
    const url = source.replace(/^git:/, "").replace(/^[a-z]+:\/\//i, "").replace(/^[^@/]+@/, "").replace(":", "/");
    return `git:${url.replace(/@[^/]*$/, "").replace(/\.git$/, "").replace(/\/+$/, "").toLowerCase()}`;
  }
  const home = process.env.HOME ?? "";
  return `local:${resolve(scope === "user" ? agentDir : join(cwd, ".pi"), source.replace(/^~(?=$|[\\/])/, home))}`;
}
