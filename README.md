# DSH Launcher

DeepSeek Harness 的桌面启动器(Electron + React + Tailwind,界面风格参考 CC Switch)。

把「启动 / 重启 / 观察启动日志 / 管理外部插件」这些繁琐操作收敛到一个应用里,启动失败(比如依赖缺失)也能直接在界面里看到原因并一键修复。

## 功能

- **一键启动 / 停止 / 重启** Harness 的 profile(默认 `web`),并实时显示进程日志
- **启动前检测端口占用**,避免与已有实例冲突卡死
- **就绪后自动打开** Web UI(`http://127.0.0.1:3080`),也可手动点击
- **启动超时保护**(默认 90s,可配置),不会一直卡在「启动中」
- **插件管理**:
  - 列出当前 profile 已安装的插件(名称 / 版本 / 是否启用)
  - 扫描本地插件目录(`~/DSH-Plugin`)列出可用插件,一键安装
  - 启用 / 停用 / 卸载,底层走 `dsh plugin`(转发给 pnpm 并自动 reconcile bundles)
- **维护动作**:`修复依赖`(harness 仓库 `pnpm install`,可解决 `zod` 缺失这类启动报错)与 `重新构建`(`pnpm run build`)
- 路径 / 端口 / profile / 启动命令均可配置,持久化到 `%APPDATA%/dsh-launcher/launcher-config.json`

## 环境要求

- Node.js ≥ 20(建议 22+)
- pnpm(插件安装与修复依赖会调用)
- DeepSeek Harness 源码仓库(默认 `C:\Users\Marco\deepseek-harness`,可在设置里改)

## 运行

```sh
pnpm install        # 首次需要下载 Electron,网络慢时可在 .npmrc 配置 electron_mirror
pnpm dev            # 开发模式(HMR)
pnpm build          # 构建 main / preload / renderer 到 out/
```

启动后界面分三页:

- **控制台**:状态、启动/停止/重启、打开 Web UI、实时日志
- **插件**:已安装插件 + 本地可用插件 + 按路径/包名安装
- **设置**:路径与启动参数、自动打开开关、修复依赖 / 重新构建

## 工作原理

- 主进程用 `node apps/cli/lib/bin.js <profile>`(cwd = harness 仓库)拉起 dsh,
  Windows 上通过 `taskkill /F /T` 杀掉整棵进程树实现停止。
- 端口就绪探测基于 `net` 轮询;启动前先探测一次端口,被占用则拒绝启动并提示。
- 插件操作调用 `node apps/cli/lib/bin.js plugin --profile <p> add|remove <spec>`,
  由 dsh 内部转发给 pnpm 并在成功后把 `dsh.bundle` 插件写进
  `$DSH_HOME/profiles/<p>/package.json#dsh.profile.bundles`;
  「启用 / 停用」直接增删该 `bundles` 数组,不卸载依赖。

## 故障排查

- **启动报 `Cannot find package 'zod'` 之类** → 设置页点「修复依赖」,再「重新构建」,最后启动。
- **提示端口被占用** → 说明已有一个 dsh 实例在跑,先在别处停掉它(启动器只管自己拉起的进程)。
- **插件安装后未出现在已启用列表** → 装的是声明了 `dsh.bundle` 的包才会自动成为 profile 层;
  普通库会被安装但标记「无 bundle」。

## License

MIT
