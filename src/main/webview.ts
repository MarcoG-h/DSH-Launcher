// Embedded DSH view wiring. Each guest page (a WebContentsView, or a legacy
// <webview>) is its own WebContents, so we hook web-contents-created once and
// forward window.open / target=_blank links to the external browser. The DSH
// Web UI's own right-click menu is left untouched — no custom context menu.

import { app, shell } from 'electron'

/** Register once at startup: open external links in the system browser. */
export function registerEmbeddedView(): void {
  app.on('web-contents-created', (_event, contents) => {
    const type = contents.getType()
    // WebContentsView reports 'browserView' (BrowserView was unified into it).
    if (type !== 'webview' && type !== 'browserView') return
    contents.setWindowOpenHandler(({ url }) => {
      void shell.openExternal(url)
      return { action: 'deny' }
    })
  })
}
