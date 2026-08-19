// One-off repair for a profile poisoned by an older launcher (non-bundle
// plugin names written into dsh.profile.bundles → boot fails loud). Mirrors
// src/main/plugins.ts::repairProfile exactly: same insert-id derivation, same
// !!js schema, same YAML serialization, so the result matches what the launcher
// would produce.
//
// Usage: node scripts/repair-profile.mjs <profile>
import * as yaml from 'js-yaml'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const profile = process.argv[2]
if (!profile) { console.error('usage: node scripts/repair-profile.mjs <profile>'); process.exit(2) }
const home = process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME, '.dsh')
const dir = join(home, 'profiles', profile)

const isJsExpr = (data) => typeof data === 'object' && data !== null && '__jsExpr' in data
const JsExpr = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  resolve: (d) => typeof d === 'string',
  construct: (d) => ({ __jsExpr: d }),
  predicate: isJsExpr,
  represent: (d) => d.__jsExpr,
})
const SCHEMA = yaml.JSON_SCHEMA.extend(JsExpr)
const readJson = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')) } catch { return null } }
const pluginInsertId = (name) => name.replace(/^@/, '').replace(/[^a-zA-Z0-9-]/g, '-').replace(/-+/g, '-')

const manifestPath = join(dir, 'package.json')
const manifest = readJson(manifestPath)
if (!manifest) { console.error(`no manifest at ${manifestPath}`); process.exit(1) }
const deps = manifest.dependencies ?? {}

function pluginManifest(name) {
  const spec = String(deps[name] ?? '')
  const local = spec.match(/^(?:file|link):(.+)$/)
  if (local) {
    const pkg = readJson(join(resolve(dir, local[1]), 'package.json'))
    if (pkg) return pkg
  }
  return readJson(join(dir, 'node_modules', name, 'package.json'))
}
const isBundle = (name) => Boolean(pluginManifest(name)?.dsh?.bundle)
const hasDsh = (name) => Boolean(pluginManifest(name)?.dsh)

// Read existing patch layer.
const patchPath = join(dir, 'cordis.patch.yml')
let patches = []
try { const p = yaml.load(readFileSync(patchPath, 'utf8'), { schema: SCHEMA }); if (Array.isArray(p)) patches = p } catch { /* broken → rebuild from scratch */ }
const insNames = new Set(), insIds = new Set()
for (const patch of patches) {
  if (typeof patch !== 'object' || patch === null) continue
  const insert = patch.insert
  if (!Array.isArray(insert)) continue
  for (const e of insert) {
    if (typeof e !== 'object' || e === null) continue
    if (typeof e.name === 'string') insNames.add(e.name)
    if (typeof e.id === 'string') insIds.add(e.id)
  }
}

// Correct bundles: shipped template first, then bundle-declaring deps.
const bundles = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']
for (const name of Object.keys(deps)) if (isBundle(name) && !bundles.includes(name)) bundles.push(name)

// Client-only plugin deps → patch-layer insert.
for (const name of Object.keys(deps)) {
  if (isBundle(name) || !hasDsh(name)) continue
  if (insNames.has(name) || insIds.has(pluginInsertId(name))) continue
  patches.push({ insert: [{ id: pluginInsertId(name), name }] })
}

manifest.dsh = { ...(manifest.dsh ?? {}), profile: { ...(manifest.dsh?.profile ?? {}), bundles } }
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
const header = '# Your patch layer for this dsh profile, applied after every bundle layer:\n# a top-level YAML array of loader patch entries (id-targeted config\n# overrides, disables, and insert lists; `!!js` expressions allowed).\n'
writeFileSync(patchPath, header + yaml.dump(patches, { schema: SCHEMA, noRefs: true }) + '\n')

console.log(`repaired ${profile}`)
console.log('bundles:', JSON.stringify(bundles))
console.log('inserts:', JSON.stringify(patches))
