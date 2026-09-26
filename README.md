# pi-manage

在网页上管理 [pi](https://pi.dev/) 插件：一键**安装、卸载、启用、停用、更新**。插件装多了以后，不用再记 `pi install / pi remove / pi config` 的各种写法。

它和 [pi-sessions](https://github.com/woertedetiankong/pi-newsession)（会话）、pi-kb（知识库）、[pi-learn](https://github.com/woertedetiankong/pi-learn)（学习）共用同一个本地网页：页面顶部可以在「会话 / 知识库 / 学习 / 插件」之间切换，访问令牌也是同一个。

## 功能

1. **已安装列表**：全局（`~/.pi/agent/settings.json`）和当前项目（`.pi/settings.json`，项目被信任时）的所有插件，显示名称、版本、描述、来源（npm / git / 本地）、状态，以及每个插件里有哪些扩展、技能、提示模板、主题（点「查看文件」展开）。展开后可以**单独勾选**每一项，比如一个插件里只用其中几个扩展；写入的设置和 `pi config` 完全相同。可以按名称筛选，按「已启用 / 已停用 / 可更新」过滤。
2. **一键启用 / 停用**：停用只是让 pi 不加载它，文件还在磁盘上。停用前如果你用 `pi config` 给它设过资源筛选（只加载一部分），会先存到 `~/.pi/agent/pi-manage/disabled.json`，重新启用时原样恢复。
3. **一键安装**：填 `npm:pi-foo`、`git:github.com/user/repo`、`https://github.com/user/repo` 或本地路径；直接粘贴包名会自动当作 npm，`github.com/user/repo` 会自动当作 git。可以选装到全局或当前项目。
4. **一键卸载 / 更新**：单个操作，或勾选多个后批量启用、停用、更新、卸载。卸载前的对话框会先建议「改为停用」；卸载后可以**撤销**（提示条、操作记录或列表下方的「最近卸载」），会重新安装并原样恢复它的设置（包括停用状态和资源筛选）。撤销信息保存在 `~/.pi/agent/pi-manage/undo.json`，重新加载或重启 pi 后仍然有效，保留最近 10 次。「检查更新」列出有新版本的插件，「全部更新」一次更新完。
5. **发现插件**：搜索 npm 上带 `pi-package` 关键字的包（和 [pi.dev/packages](https://pi.dev/packages) 同一个来源），点「安装」即可。
6. **操作记录**：安装、卸载、更新会显示实时输出，失败时能看到 npm / git 的原始报错。
7. **重新加载**：改动在 pi 重新加载后才生效。每个插件旁会标出重新加载后会发生什么（例如「重新加载后停用」），页面顶部点「重新加载」即可；pi 正在工作或还有安装在进行时，会等它们结束后自动重新加载，也可以取消。也可以在 pi 里输入 `/reload`。

插件管理器不能在页面上停用或卸载它自己，需要时在终端运行 `pi remove`。

## 安装

```bash
pi install git:github.com/woertedetiankong/pi-mange     # 或本地路径：pi install /path/to/pi-manage
```

## 使用

| 命令 | 作用 |
| --- | --- |
| `/manage` | 在浏览器打开插件管理页面 |
| `/manage url` | 只显示页面地址 |
| `/manage list` | 在终端列出已配置的插件和状态 |
| `/manage reload` | 重新加载 pi，让插件改动生效 |
| `/manage stop` | 停止网页服务（会话、知识库、学习页面共用，也会一起停止） |

链接：`/manage/?tab=discover&q=<关键字>` 直接打开发现页并搜索。

终端提示的语言跟随系统，可用 `PI_MANAGE_LANG=zh|en` 指定。

## 实现说明

- **读取**：每次都重新读取设置文件，用 pi 自带的 `SettingsManager` 和 `DefaultPackageManager.resolve()`（遇到未安装的插件跳过，不会自动安装），所以终端里 `pi install`、`pi config` 做的改动会直接反映在页面上。
- **启用 / 停用**：和 `pi config` 一样改设置文件，停用写成 `{ source, extensions: [], skills: [], prompts: [], themes: [] }`，即 pi 文档里「用 `[]` 不加载这一类资源」。
- **安装 / 卸载 / 更新**：在子进程里运行 pi 自己的命令行（`pi install | remove | update`），输出显示在页面上。不在 pi 进程里直接调用安装，是因为 pi 的安装器会让 npm / git 直接写终端，会把正在运行的 pi 界面弄乱。所有改动排队依次执行，避免同时写同一个设置文件。
- 项目级插件只在当前项目被信任时显示和修改，子进程带 `--approve`；否则带 `--no-approve`。

## 和另外几个插件怎么配合

几个插件各自带一份相同的 `src/hub.ts`，在进程里通过 `globalThis.__piWebHub` 共用一个本地 HTTP 服务：

- `/manage/` 页面、`/api/manage/...` 接口由本插件提供；
- 在切换栏里排在最后（`order = 90`）。

`src/hub.ts` 必须和另外几个插件里的保持一字不差（见文件开头的说明）。

## 开发

```bash
npm install
npm run check   # tsc
npm test        # node --test，用 devDependencies 里的 pi 命令行和临时目录，不联网、不碰你的设置
npm run e2e     # 在真实的 pi（RPC 模式、临时目录）里走一遍：/manage url → 页面安装 → 点「重新加载」→ 新插件生效
```

## License

MIT
