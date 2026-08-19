// Audit: which linked plugins in the plugin library (pluginDir) could fail to
// resolve their server-side bare imports at boot? Mirrors Node's real resolution
// from each plugin file's real path (walking up DSH-Plugin/node_modules → the
// harness fallback junction → C:\Users\Marco\node_modules → …). Does NOT execute
// plugin code — only probes resolve() for every bare specifier found in its JS.
//
// Usage: node scripts/audit-link-resolve.mjs
import { readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { createRequire } from 'node:module'

const pluginDir = process.env.DSH_PLUGIN_DIR || 'C:/Users/Marco/DSH-Plugin'
const JS = /\.(m?js|cjs)$/
const BARE = /(?:import|export)\s+(?:type\s+)?[^'"]*?\bfrom\s*['"]([^'"]+)['"]|(?:^|[;\s])import\s*['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\)|import\(\s*['"]([^'"]+)['"]\s*\)/gm

const isBare = (s) =>
  s && !s.startsWith('.') && !s.startsWith('/') && !s.startsWith('node:')
  && !/^[A-Za-z]:[\\/]/.test(s) && !/^(file|http|https|data):/.test(s)

function listJs(root, base = []) {
  const out = []
  let entries
  try { entries = readdirSync(join(root, ...base), { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name === '.pnpm') continue
    const p = [...base, e.name]
    if (e.isDirectory()) out.push(...listJs(root, p))
    else if (JS.test(e.name)) out.push(p.join('/'))
  }
  return out
}

/** nearest ancestor dir holding a package.json → its name field */
function nearestPackage(dir) {
  let d = dir
  for (;;) {
    try {
      const p = JSON.parse(readFileSync(join(d, 'package.json'), 'utf8'))
      if (p && p.name) return { root: d, name: p.name, inject: new Set((p.dsh?.client?.inject ?? []).map(String)) }
    } catch { /* no manifest here */ }
    const up = dirname(d)
    if (up === d) return { root: dir, name: dir, inject: new Set() }
    d = up
  }
}

const files = listJs(pluginDir)
const failures = []
const byPlugin = new Map()
let specs = 0

for (const rel of files) {
  const abs = join(pluginDir, rel)
  let src = ''
  try { src = readFileSync(abs, 'utf8') } catch { continue }
  const pkg = nearestPackage(dirname(abs))
  const requireFrom = createRequire(abs)
  const seen = new Set()
  let m
  BARE.lastIndex = 0
  while ((m = BARE.exec(src)) !== null) {
    const spec = m[1] || m[2] || m[3] || m[4]
    if (!isBare(spec) || seen.has(spec)) continue
    seen.add(spec)
    specs++
    let ok = false
    try { requireFrom.resolve(spec); ok = true } catch { ok = false }
    if (!ok) {
      if (!byPlugin.has(pkg.name)) byPlugin.set(pkg.name, new Set())
      byPlugin.get(pkg.name).add(spec)
      failures.push({ plugin: pkg.name, file: rel, spec, clientInject: pkg.inject.has(spec) })
    }
  }
}

console.log(`audited ${files.length} js files, ${specs} bare imports across ${byPlugin.size ? 'multiple' : 'no'} failing plugins`)
console.log(`\nfailing plugins: ${byPlugin.size}\n`)
for (const [plugin, specs] of [...byPlugin.entries()].sort()) {
  console.log(`▶ ${plugin}`)
  for (const spec of [...specs].sort()) console.log(`    ${spec}`)
}
console.log('\n=== failure detail ===')
for (const f of failures) {
  console.log(`${f.plugin} :: ${f.file} :: ${f.spec}${f.clientInject ? '  [client-inject]' : ''}`)
}
