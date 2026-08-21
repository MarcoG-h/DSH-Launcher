<div align="center">

<p><a href="https://github.com/MarcoG-h/DSH-Launcher/blob/main/README.md">中文</a> | <a href="#dsh-launcher">English</a></p>

<h1>DSH Launcher V3 — 鲸罗棋布</h1>

<p>
<a href="https://github.com/MarcoG-h/DSH-Launcher"><img src="https://img.shields.io/github/stars/MarcoG-h/DSH-Launcher?style=flat&label=%E2%AD%90&color=08C" alt="GitHub stars"></a>
<a href="https://github.com/MarcoG-h/DSH-Launcher/releases"><img src="https://img.shields.io/badge/Windows-10%2F11-4493F8?style=flat" alt="Windows"></a>
<a href="https://github.com/MarcoG-h/DSH-Launcher/releases"><img src="https://img.shields.io/badge/Desktop-App-47848F?style=flat" alt="Desktop App"></a>
<a href="https://github.com/MarcoG-h/DSH-Launcher/releases/tag/v3.0.4"><img src="https://img.shields.io/badge/v3.0.4-Release-2EA44F?style=flat" alt="v3.0.4"></a>
<a href="https://github.com/MarcoG-h/DSH-Launcher/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-2EA44F?style=flat" alt="MIT License"></a>
</p>

<p>No Node.js installation or source code needed — one-click deployment of a portable runtime;
the DSH Web UI is embedded directly inside the native client window.</p>

<p><strong>Evolved from a "launcher" into a "multi-instance management hub"</strong> — run multiple
independent DSH environments side by side in a single client, each freely mixing its own set of
plugins; together with one-click recommended bundles and a categorized plugin marketplace,
the flexibility of the plugin ecosystem becomes something every user can reach.</p>

<p>Special thanks to community author <a href="https://github.com/baihejiangnan">@baihejiangnan</a> for the great help</p>

<table>
<tr>
<td align="center"><a href="screenshots/main-ui.png"><img src="screenshots/main-ui.png" alt="DSH Launcher main UI"></a><br><sub>Main UI</sub></td>
<td align="center"><a href="screenshots/multi-instances.png"><img src="screenshots/multi-instances.png" alt="Multi-instance management"></a><br><sub>Multi-instance management</sub></td>
</tr>
</table>

</div>

---

## **V3** What's New

| Highlight | Description |
| --- | --- |
| **Parallel instances** | Run multiple DSH instances side by side, each freely configured with different plugin combinations |
| **Built-in bundles** | Ready-optimized plugin packs for beginners — get started right away |
| **Plugin marketplace update** | Category tags to find plugins fast; three built-in plugin sources |
| **Local plugin management** | Fully redesigned for multi-instance; avoids duplicate plugin downloads |
| **One-click deployment** | Built-in portable environment, fully offline, no prerequisites |
| **Native client UI** | DSH Web embedded in a native window; smoother multi-window experience |
| **Polished desktop experience** | System tray status light + floating ball + splash animation |

> Zero kernel changes: DSH Launcher runs the official dsh, preserving the "everything is a plugin" architecture and all official capabilities.
> The data directory (`DSH_HOME`) is fully compatible with the CLI: by default it shares your existing directory, so existing sessions / API keys keep working;
> you can also create a brand-new isolated directory per instance, keeping sessions, plugins, and credentials fully separated from the rest.

---

## Download & Install

### GitHub Releases (recommended)

| File | Description | Size |
| --- | --- | --- |
| [Installer exe](https://github.com/MarcoG-h/DSH-Launcher/releases/download/v3.0.4/DSH.Launcher.Setup.3.0.4.exe) | NSIS installer; creates desktop / Start menu shortcuts automatically | ~100 MB |
| [Simple exe](https://github.com/MarcoG-h/DSH-Launcher/releases/download/v2.0.3/DSH.Launcher.Setup.2.0.3.exe) | Minimal version without multi-instance, for users running a single DSH | ~100 MB |

More versions on the [Releases page](https://github.com/MarcoG-h/DSH-Launcher/releases).

📺 Quick-start video tutorial: [BiliBili](https://www.bilibili.com/video/BV1BMbR64EoQ/?vd_source=ed1422074bd9beff1e11e3fba3c0fff8)

> The installer stores its data under `%APPDATA%\dsh-launcher`; DSH session data defaults to `~\.dsh` (`DSH_HOME`).
> Want to force a different DSH config directory? Set the `DSH_HOME` environment variable before launching (same behavior as the dsh CLI).


**First use**:

1. Install and launch DSH Launcher — a splash animation plays on startup.
2. Go to "Settings → Quick offline deployment" and click **"Quick offline deployment"** — a portable Node + pnpm + dsh runtime is installed automatically, fully offline; the app switches to bundled mode and fills in the paths when done.
3. Back in "Console", click **"Start"** — once ready, the app enters the DSH UI automatically and you can start using it.
4. If you haven't configured an API key yet, enter it in the DSH UI.

**Upgrading**:

- Install the new build over the old one — data is not lost; the installer closes running old processes automatically.
- "Update built-in dsh" only upgrades the bundled companion plugins; it never overwrites third-party plugins in `~\.dsh` or manual `cordis.patch.yml` entries.

---

## **V3** Features

### Multi-instance system

- Run multiple isolated DSH instances side by side in one client; each instance has its own config and port
- Create one for "coding", "chatting", "testing" — switching instances switches the whole plugin environment
- New instance modes (see: [DSH_HOME isolation](https://github.com/baihejiangnan/dsh-home-isolation-guide)):
        
        "Shared" — reuse the existing data directory (shared sessions, presets, settings, etc.)
        
        "Isolated" — create a brand-new data directory (sessions, plugins, everything fully separated)

- Each instance can be controlled independently from the client
- Instances in "Shared" mode cannot work in the same session simultaneously

![Multi-instance management](screenshots/multi-instances.png)

### Recommended bundles

- No need to pick plugins yourself — two curated bundles are built in; one-click download, automatic instance creation, automatic plugin installation
- Progress bars while downloading; each plugin inside a bundle is downloaded independently and isolated from the others
- Third-party plugins often have compatibility issues with each other — the bundles include patches to fix them (see: [plugin packs](https://github.com/baihejiangnan/dsh-plugin-pack-web))

![Recommended bundles](screenshots/bundle.png)

### New plugin marketplace

- **Category tags**: find plugins by category fast; cards show their matching categories and clicking one filters the list
- **Multiple plugin sources**: GitHub, [Deepseek1024](https://deepseek1024.com/), [dshfind](https://dshfind.com/zh) — diversified download channels (Chinese plugin descriptions)
- Inline README preview; one-click install and archive into the local plugin library

![Plugin marketplace](screenshots/market.png)

### New local plugin management

- **Matrix view**: see at a glance which plugin is enabled in which instance; one-click management

![Plugin matrix](screenshots/matrix.png)

### Other features

- Balance widget
- Console: start / restart / stop
- System tray resident + tray status light, fullscreen immersive + floating ball, splash animation, close-to-tray

![Balance & logs](screenshots/console.png)

Want a new feature? Come talk to us! QQ group: 957159489

![QQ group](screenshots/group-qr.png)

---

## System requirements

- Windows 10/11 (x64)
- Bundled mode needs no pre-installed Node.js or any other runtime
- 4GB+ RAM (recommended)

---

## Building from source

```bash
pnpm install        # first install downloads Electron; configure electron_mirror in .npmrc if your network is slow
pnpm dev            # dev mode (HMR)
pnpm build          # build main / preload / renderer to out/
pnpm dist           # electron-vite build + electron-builder --win → release/
```

> Restricted network: Electron mirror `$env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'`.

## Architecture

```
┌──────────────────────────────────────────────────┐
│  Electron shell (main process)                   │
│  · single-instance lock / window / tray /        │
│    floating ball / shortcut maintenance          │
│  · multi-instance harness lifecycle              │
│    (start / stop / restart / timeout guard)      │
│  · bundle installation / plugin marketplace      │
│    (category filter) / balance                   │
└──────────────┬───────────────────────────────────┘
               │  spawn node dsh/lib/bin.js <profile>
               │  (DSH_HOME=<shared or isolated data dir>)
               ▼
        bundled node.exe + @deepseek-ai/dsh
        prints "dsh web: http://127.0.0.1:<port>"
               │  readiness probe (HTTP 200) then load
               ▼
        WebContentsView embeds DSH UI
        (single window, localhost loopback only)
```

## Contributing

- [@MarcoG-h](https://github.com/MarcoG-h) — project initiator & maintainer
- [@baihejiangnan](https://github.com/baihejiangnan) — recommended bundle contributor & maintainer

## License

MIT. Based on [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) (MIT).
