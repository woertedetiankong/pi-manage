import { DefaultPackageManager, type PackageSource, SettingsManager } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
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

  /** Changes whenever a package is added, removed or filtered; compared to know when pi needs a reload. */
  signature(): string {
    const { settings, trusted } = this.managers();
    return JSON.stringify(this.entries(settings, trusted));
  }

  private isSelf(path: string | undefined): boolean {
    return !!path && !!this.opts.selfDir && real(path) === real(this.opts.selfDir);
  }

  async list(): Promise<{ packages: PackageInfo[]; cwd: string; trusted: boolean }> {
    const { settings, pm, cwd, trusted } = this.managers();
    // "skip": listing must never install what is missing.
    const resolved = await pm.resolve(async () => "skip").catch(() => undefined);
    const packages = this.entries(settings, trusted).map(({ scope, entry }): PackageInfo => {
      const source = sourceOf(entry);
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
  private async readStash(): Promise<Record<string, PackageSource>> {
    try { return JSON.parse(await readFile(this.stashFile(), "utf8")); } catch { return {}; }
  }
  private async writeStash(stash: Record<string, PackageSource>): Promise<void> {
    const file = this.stashFile(), tmp = `${file}.${process.pid}.tmp`;
    await mkdir(dirname(file), { recursive: true });
    await writeFile(tmp, JSON.stringify(stash, null, 2));
    await rename(tmp, file);
  }

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
