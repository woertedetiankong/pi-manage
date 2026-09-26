import { parseLanguage, systemLanguage, type WebLanguage } from "./hub.ts";

export type Lang = WebLanguage;

const MESSAGES = {
  zh: {
    notFound: "找不到这个插件，可能已被卸载，请刷新列表",
    emptySource: "请填写插件来源，例如 npm:pi-foo 或 git:github.com/user/repo",
    badSource: "插件来源不能包含换行",
    notTrusted: "当前项目还没有被信任，不能管理项目级插件",
    self: "不能在页面上停用或卸载插件管理器本身，请在终端用 pi remove 卸载",
    busy: "还有操作在进行中，请等它完成",
    agentBusy: "pi 正在工作，等它空闲后再重新加载",
    switching: "pi 正在切换会话，请稍后再试",
    commandFailed: (code: string) => `命令失败（${code}）`,
    searchFailed: (why: string) => `搜索失败：${why}`,
    localNoUpdate: "本地路径的插件不需要更新，改动会在重新加载后生效",
  },
  en: {
    notFound: "That package is no longer configured; refresh the list",
    emptySource: "Enter a package source, e.g. npm:pi-foo or git:github.com/user/repo",
    badSource: "A package source cannot contain line breaks",
    notTrusted: "This project is not trusted, so its packages cannot be managed",
    self: "The package manager cannot disable or uninstall itself from the page; run pi remove in a terminal",
    busy: "Another operation is still running; wait for it to finish",
    agentBusy: "pi is working; reload once it is idle",
    switching: "pi is switching sessions, try again in a moment",
    commandFailed: (code: string) => `Command failed (${code})`,
    searchFailed: (why: string) => `Search failed: ${why}`,
    localNoUpdate: "Local packages need no update; edits apply after a reload",
  },
} as const;

export type MessageKey = keyof typeof MESSAGES.zh;

/** An error whose message is translated into the page's language when it reaches the browser. */
export class ManageError extends Error {
  readonly key: MessageKey;
  readonly args: unknown[];
  readonly status: number;
  constructor(key: MessageKey, args: unknown[] = [], status = 400) {
    super(key);
    this.key = key; this.args = args; this.status = status;
  }
}

export function text(lang: Lang, key: MessageKey, ...args: unknown[]): string {
  const m = MESSAGES[lang][key] as string | ((...a: unknown[]) => string);
  return typeof m === "function" ? m(...args) : m;
}

export function localize(e: unknown, lang: Lang): string {
  if (e instanceof ManageError) return text(lang, e.key, ...e.args);
  return e instanceof Error ? e.message : String(e);
}

/** The page sends its language as x-lang; anything else falls back to Chinese. */
export function requestLang(header: string | string[] | undefined): Lang {
  return (Array.isArray(header) ? header[0] : header) === "en" ? "en" : "zh";
}

export function terminalLang(): Lang {
  return parseLanguage(process.env.PI_MANAGE_LANG) ?? systemLanguage();
}

export const TERMINAL = {
  zh: {
    opened: (url: string) => `已在浏览器打开插件管理页面：${url}`,
    url: (url: string) => `插件管理页面地址：${url}`,
    stopped: "网页服务已停止",
    failed: (why: string) => `插件管理失败：${why}`,
    empty: "还没有安装任何插件",
    listHead: (n: number) => `已配置 ${n} 个插件：`,
    status: { on: "启用", off: "停用", missing: "未安装" } as Record<string, string>,
    scope: { user: "全局", project: "项目" } as Record<string, string>,
  },
  en: {
    opened: (url: string) => `Opened the package manager: ${url}`,
    url: (url: string) => `Package manager: ${url}`,
    stopped: "Web server stopped",
    failed: (why: string) => `Package manager failed: ${why}`,
    empty: "No packages installed yet",
    listHead: (n: number) => `${n} configured packages:`,
    status: { on: "enabled", off: "disabled", missing: "missing" } as Record<string, string>,
    scope: { user: "global", project: "project" } as Record<string, string>,
  },
};
