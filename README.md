<div align="center">

<p><a href="#dsh-launcher">中文</a> | <a href="https://github.com/MarcoG-h/DSH-Launcher/blob/main/README.en.md">English</a></p>

<h1>DSH Launcher — 即装即用</h1>

<p>
<a href="https://github.com/MarcoG-h/DSH-Launcher"><img src="https://img.shields.io/github/stars/MarcoG-h/DSH-Launcher?style=flat&label=%E2%AD%90&color=08C" alt="GitHub stars"></a>
<a href="https://github.com/MarcoG-h/DSH-Launcher/releases"><img src="https://img.shields.io/badge/Windows-10%2F11-4493F8?style=flat" alt="Windows"></a>
<a href="https://github.com/MarcoG-h/DSH-Launcher/releases"><img src="https://img.shields.io/badge/Desktop-App-47848F?style=flat" alt="Desktop App"></a>
<a href="https://github.com/MarcoG-h/DSH-Launcher/releases/tag/v2.0.3"><img src="https://img.shields.io/badge/v2.0.3-Release-2EA44F?style=flat" alt="v2.0.3"></a>
<a href="https://github.com/MarcoG-h/DSH-Launcher/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-2EA44F?style=flat" alt="MIT License"></a>
</p>

<p>Windows 桌面启动器</strong>:无需安装 Node.js、无需源码,一键部署便携运行环境;
DSH Web 直接内嵌在客户端窗口里,启动 / 重启 / 插件市场 / 余额 / 多厂商 API 切换,一步到位。</p>

<table>
<tr>
<td align="center"><a href="screenshots/main-ui-1.png"><img src="screenshots/main-ui-1.png" alt="DSH Launcher 新版本主界面"></a><br><sub>启动界面</sub></td>
<td align="center"><a href="screenshots/main-ui-2.png"><img src="screenshots/main-ui-2.png" alt="DSH Launcher 新版本主界面 2"></a><br><sub>对话预览</sub></td>
</tr>
</table>

</div>

---

## DSH-Launcher 功能亮点

| 亮点 | 说明 |
| --- | --- |
| **免装 Node 一键部署** | 内置独立 Node + npm + pnpm + dsh,无需准备,全程一键 |
| **客户端内嵌界面** | DSH Web 直接内嵌在原生窗口里,不跳转浏览器 |
| **一键启动 / 停止 / 重启** | 快捷进行常用操作 |
| **快捷 API 切换** | 任意厂商预设一键切换，API Key 启动时自动注入 |
| **插件市场 & 插件管理** | GitHub 关键词搜索一键安装,自动识别仓库子包,插件自动归档存库 |
| **余额小部件** | 主界面实时查看账户余额 |
| **桌面体验** | 系统托盘常驻 + 托盘三态状态灯 + 悬浮球 + 开屏动画 |
| **扩展性** | 几乎支持一切适配DSHweb的插件，兼容全系插件生态 |

> 内核零改动: 内部原生DSH Launcher，一切皆插件！

---

## 下载安装(部署方式)

### GitHub Releases(推荐)

| 文件 | 说明 | 大小 |
| --- | --- | --- |
| [安装版 exe](https://github.com/MarcoG-h/DSH-Launcher/releases/download/v2.0.3/DSH.Launcher.Setup.2.0.3.exe) | NSIS 安装到系统,自动创建桌面 / 开始菜单快捷方式 | ~100 MB |

更多版本见 [Releases 页面](https://github.com/MarcoG-h/DSH-Launcher/releases)。

📺 快速上手视频教程:[BiliBili](https://www.bilibili.com/video/BV1BMbR64EoQ/?vd_source=ed1422074bd9beff1e11e3fba3c0fff8)


**首次使用**:

1. 双击安装,安装完成后启动 DSH Launcher,显示开屏动画。
2. 进入「设置 → 快速离线部署」点击**「快速离线部署」**,自动安装便携 Node + pnpm + dsh 运行环境(全程离线可用),部署完成自动切换为内置模式并回填路径。
3. 回到「控制台」点击**「启动」**,就绪后自动进入 DSH 界面,即可开始使用。
4. 如尚未配置 API Key,在「设置 → API」添加厂商预设或填写密钥即可(与命令行 dsh 完全一致)。

### 升级部署

- **覆盖安装新版安装包即可**,数据不会丢失;安装器会自动结束运行中的旧进程。
- **「更新内置 dsh」** 只升级内置配套插件,不会覆盖 `~\.dsh` 里的第三方插件与 `cordis.patch.yml` 手动条目。

---

## 功能一览

### 开箱即用

- **免装 Node 一键部署**
- **依赖版本与官方严格一致**
- **内置 dsh CLI**
- **与 CLI 共享配置**

![开箱即用](screenshots/功能一览-开箱即用.png)

### 桌面体验

- **单窗口内嵌 DSH**(可搭配"更好的右键"插件拓展右键功能)
- **托盘三态状态灯**
- **全屏沉浸+悬浮球**
- **炫酷开屏动画**(后续版本将考虑开放自定义动画)

![桌面体验](screenshots/功能一览-桌面体验.png)

### 配置与效率

- **快捷 API 切换**
- **余额小部件**
- **第三方插件市场&插件管理**
- **实时日志与故障可视化**
- **中英界面可切换**

![配置与效率](screenshots/功能一览-配置与效率.png)

如果您有任何想要的新功能，欢迎来找我交流！QQ交流群：957159489

[QQ 交流群二维码](screenshots/交流群.jpg)

---

## 系统要求

- Windows 10/11(x64)
- 内置版无需预装 Node.js 或任何其他运行时
- 4GB+ 内存(推荐)

## 扩展性

- 为了不限制用户的自定义程度，本启动器没有预装或内置任何插件功能
- 用户可以根据自己的喜好安装一切适配DSHweb端的插件，一切皆插件！

---

## 从源码构建

```bash
pnpm install        # 首次需要下载 Electron,网络慢时可在 .npmrc 配置 electron_mirror
pnpm dev            # 开发模式(HMR)
pnpm build          # 构建 main / preload / renderer 到 out/
pnpm dist           # electron-vite build + electron-builder --win → release/
```

> 网络受限时:Electron 镜像 `$env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'`。

## 架构

```
┌──────────────────────────────────────────────────┐
│  Electron 壳(main process)                       │
│  · 单实例锁 / 窗口 / 托盘 / 悬浮球 / 快捷方式维护   │
│  · harness 生命周期(启动/停止/重启/超时保护)       │
│  · 余额 / 插件市场 / API 注入 / WS 状态灯          │
└──────────────┬───────────────────────────────────┘
               │  spawn node dsh/lib/bin.js <profile>
               ▼
       内置 node.exe + @deepseek-ai/dsh
       输出 "dsh web: http://127.0.0.1:<port>"
               │  就绪探测(HTTP 200)后加载
               ▼
       WebContentsView 内嵌 DSH UI(单窗口,仅本机回环)
```

## 目录结构

```
dsh-launcher/
├── src/
│   ├── main/                  # Electron 主进程
│   │   ├── harness.ts         # dsh 生命周期(启动/停止/重启,进程树清理)
│   │   ├── runtime.ts         # 一键部署:便携 Node + pnpm + dsh(pnpm 安装,依赖与官方一致)
│   │   ├── plugins.ts         # 插件管理 / 市场安装(归档、子包)
│   │   ├── balance.ts         # 余额查询(本地模型预设跳过)
│   │   ├── dsh-status.ts      # WS 订阅 dsh 状态 → 托盘三态灯
│   │   ├── config.ts          # 配置持久化(%APPDATA%/dsh-launcher)
│   │   ├── shortcuts.ts       # 桌面 / 开始菜单快捷方式自动维护
│   │   └── i18n.ts            # 主进程日志 / 报错双语
│   ├── renderer/              # React + Tailwind 界面(控制台/插件/设置)
│   └── shared/                # 主进程 / 渲染进程共享类型
├── resources/                 # 图标、内嵌资源
├── screenshots/               # README 截图
├── build/                     # electron-builder 打包配置
└── release/                   # 构建产物(不入库,发布到 Releases)
```

## 贡献

- [@MarcoG-h](https://github.com/MarcoG-h) — 项目发起者与维护者
- [@baihejiangnan](https://github.com/baihejiangnan) — 提供了"更好的右键"插件

## License

MIT。基于 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)(MIT)。
