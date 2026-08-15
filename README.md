# DSH Launcher

> 最方便的 DSH 启动器兼第三方插件管理:一键式安装、客户端界面、快捷的启动与重启。

DSH Launcher 是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的桌面启动器(Electron + React + Tailwind,界面风格参考 CC Switch)。把「安装运行环境、启动、重启、观察日志、管理第三方插件」这些操作收敛到一个本地客户端里,启动失败(比如依赖缺失)也能直接在界面里看到原因并一键修复。

[English README](README.en.md)

## 界面截图

![控制台](screenshots/dashboard.png)

## 功能特性

- **一键式安装 / 快速离线部署** —— 无需安装 Node.js、无需源码,一键部署便携 Node + dsh 运行环境,部署完即可直接使用,全程离线可用。
- **客户端界面** —— 所有操作都在本地桌面应用内完成;DSH Web 界面可直接嵌入应用内使用(支持中文输入法),无需跳转浏览器。
- **快捷的启动与重启** —— 一键启动 / 停止 / 重启 dsh,就绪后自动进入 DSH 界面;自动检测外部实例,避免端口冲突。
- **第三方插件管理** —— 浏览本地插件、安装 / 卸载 / 启用禁用、从 GitHub 一键下载;更新内置 dsh 不会覆盖你的第三方插件与 `cordis.patch.yml`。
- **余额小部件** —— 主界面直接查看 DeepSeek 账户余额;API 密钥只在本地读取,不落盘、不上传。
- **启动日志可视化** —— 启动失败(如依赖缺失)时直接在界面看到原因,一键修复。

## 运行模式

| 模式 | 说明 |
| --- | --- |
| 内置版(推荐) | 「快速离线部署」一键安装便携 Node + dsh,目标机器无需任何前置环境 |
| 源码版 | 需要本机 Node.js + pnpm,可调试 / 修改 Harness 源码 |

## 开发与构建

```bash
pnpm install
pnpm dev        # 开发模式
pnpm build      # 构建
```

## 隐私说明

- DeepSeek API 密钥仅在主进程本地读取(优先取设置中填写的密钥,否则从 `~/.dsh/.credentials.yaml` 读取),不会写入日志或上传到任何地方。

## License

MIT
