// Resolve the bundled preload script path. Both the launcher window and the
// floating orb's WebContentsView load the same preload — it exposes the shared
// `window.dshLauncher` bridge (orb pages only ever run our own bundle).
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

export function preloadPath(): string {
  const base = join(here, '../preload')
  for (const name of ['index.mjs', 'index.js']) {
    const p = join(base, name)
    if (existsSync(p)) return p
  }
  return join(base, 'index.mjs')
}
