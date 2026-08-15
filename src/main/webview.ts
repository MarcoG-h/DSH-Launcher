// Right-click context menu for the embedded DSH view (a WebContentsView, or a
// legacy <webview>). Each is its own WebContents, so we hook
// web-contents-created and attach a menu there — copy/paste etc. so DSH plugin
// pages can be used comfortably in-window.

import { app, BrowserWindow, Menu, clipboard, shell, type ContextMenuParams, type WebContents } from 'electron'

function showContextMenu(wc: WebContents, params: ContextMenuParams): void {
  const template: Electron.MenuItemConstructorOptions[] = []

  if (wc.canGoBack() || wc.canGoForward()) {
    template.push(
      { label: '后退', enabled: wc.canGoBack(), click: () => wc.goBack() },
      { label: '前进', enabled: wc.canGoForward(), click: () => wc.goForward() },
      { type: 'separator' }
    )
  }
  if (params.linkURL) {
    template.push(
      { label: '复制链接地址', click: () => clipboard.writeText(params.linkURL) },
      { type: 'separator' }
    )
  }

  const editable = params.isEditable
  const hasText = params.selectionText.trim().length > 0
  template.push(
    { label: '剪切', enabled: editable && hasText, role: 'cut' },
    { label: '复制', enabled: hasText, role: 'copy' },
    { label: '粘贴', enabled: editable, role: 'paste' },
    { label: '全选', role: 'selectAll' },
    { type: 'separator' },
    { label: '刷新', click: () => wc.reload() },
    { label: '在浏览器中打开', click: () => void shell.openExternal(wc.getURL()) },
    { label: '开发者工具', click: () => wc.toggleDevTools() }
  )

  const win = BrowserWindow.fromWebContents(wc) ?? BrowserWindow.getAllWindows()[0]
  const menu = Menu.buildFromTemplate(template)
  if (win) menu.popup({ window: win })
  else menu.popup()
}

/** Register once at startup: attach the context menu to embedded guest pages. */
export function registerEmbeddedContextMenu(): void {
  app.on('web-contents-created', (_event, contents) => {
    const type = contents.getType()
    // WebContentsView reports 'browserView' (BrowserView was unified into it).
    if (type !== 'webview' && type !== 'browserView') return
    contents.on('context-menu', (_ev, params) => showContextMenu(contents, params))
    // Open target=_blank / window.open links in the external browser.
    contents.setWindowOpenHandler(({ url }) => {
      void shell.openExternal(url)
      return { action: 'deny' }
    })
  })
}
