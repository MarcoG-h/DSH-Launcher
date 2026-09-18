// 内嵌 dsh 页面的外链处理。
//
// dsh 的 Web UI(以及插件往里塞的按钮)里有大量 `target="_blank"` / `window.open`
// 的链接(例如充值页 `platform.deepseek.com/usage`)。不处理的话 Electron 会按默认行为
// **新建一个裸 Electron 窗口**把它装进去 —— 用户要的是系统浏览器的新标签页。
//
// 历史坑:`app.on('web-contents-created')` 里按 `contents.getType()` 过滤
// (`'webview'` / `'browserView'`)。Electron 43 起 `new WebContentsView(...)` 的
// getType() 返回 **`'window'`**(不再是 `'browserView'`),于是那个全局钩子把每个内嵌
// 视图都过滤掉了 —— 等于从未生效。所以现在改成**在每个创建点显式调用**本函数;
// 新增任何承载 dsh 页面 / 插件的 WebContentsView 或 BrowserWindow 时,记得调它。

import { shell, type WebContents } from 'electron'

/**
 * 让这个页面里的 `window.open` / `target="_blank"` 走系统浏览器(新标签页),
 * 而不是新建 Electron 窗口。只放行 http(s):`javascript:` / `file:` / `mailto:`
 * 之类一律拒绝(交给系统 shell 打开等于把任意协议交给操作系统)。
 */
export function openExternalLinks(contents: WebContents): void {
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
}
