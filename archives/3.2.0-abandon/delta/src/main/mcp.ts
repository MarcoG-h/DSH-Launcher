// MCP server management: a canonical *library* plus per-instance patch rows.
//
// dsh mounts one MCP server per `@deepseek-ai/dsh-mcp-client` loader row, and
// those rows live in an `insert:` list of `<home>/profiles/<profile>/cordis.patch.yml`
// — the same patch file the plugin system writes (this instance's profile). Each
// row is `{ id, name: '@deepseek-ai/dsh-mcp-client', config: {...}, disabled? }`
// and exposes tools as `mcp__<serverName>__*`. A row-level `disabled: true`
// disables that server; changes take effect on the instance's next start.
//
// Saving rewrites only the MCP rows: every other patch entry — plugin inserts,
// id-targeted overrides, disables and `!!js` scalars — is preserved through the
// same js-yaml schema the plugin layer uses, so the two writers never diverge.
//
// Since 2026-09 MCP follows the plugin "library + matrix" model: the canonical
// configs live in `<runtimeRoot>/mcp-library.json` (unique by `serverName`) and
// are *assigned* to instances by writing a loader row into that instance's patch
// layer. Editing a library record re-syncs every assigned instance's row (keeping
// its enabled flag); deleting one removes the row from every instance.

import * as yaml from 'js-yaml'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { ensureInstanceHome, getInstance, getInstances, instanceDshHome } from './instances'
import { getConfig } from './config'
import { t } from './i18n'
import type { McpKv, McpServer, McpTransport } from '../shared/types'

const MCP_CLIENT_MODULE = '@deepseek-ai/dsh-mcp-client'
/** serverName budget mirrored from dsh-mcp-client (`[A-Za-z0-9_-]{1,32}`). */
const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/
/** Config keys the form owns; every other key is preserved as-is across saves. */
const MANAGED_CONFIG_KEYS = new Set(['serverName', 'transport', 'url', 'headers', 'command', 'args', 'env', 'cwd'])

/** Same patch-layer YAML dialect as plugins.ts (`!!js` expression nodes survive). */
const isJsExpr = (data: unknown): data is { __jsExpr: string } =>
  typeof data === 'object' && data !== null && '__jsExpr' in data
const JsExpr = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  resolve: (data: unknown) => typeof data === 'string',
  construct: (data: string) => ({ __jsExpr: data }),
  predicate: isJsExpr,
  represent: (data: object) => (data as { __jsExpr: string }).__jsExpr
})
const ENTRY_LIST_SCHEMA = yaml.JSON_SCHEMA.extend(JsExpr)
const PATCH_HEADER = '# Your patch layer for this dsh profile, applied after every bundle layer:\n'
  + '# a top-level YAML array of loader patch entries (id-targeted config\n'
  + '# overrides, disables, and insert lists; `!!js` expressions allowed).\n'

// --- path helpers ---

function scopeOf(instanceId: string): { home: string; profile: string } {
  const inst = getInstance(instanceId)
  if (!inst) throw new Error(t(`实例不存在: ${instanceId}`, `Unknown instance: ${instanceId}`))
  ensureInstanceHome(inst)
  return { home: instanceDshHome(inst), profile: inst.profile }
}

function patchFile(home: string, profile: string): string {
  return join(home, 'profiles', profile, 'cordis.patch.yml')
}

/** Read the profile patch layer as a parsed array; missing/broken file is `[]`. */
function readPatches(home: string, profile: string): unknown[] {
  try {
    const parsed = yaml.load(readFileSync(patchFile(home, profile), 'utf8'), { schema: ENTRY_LIST_SCHEMA })
    return Array.isArray(parsed) ? (parsed as unknown[]) : []
  } catch {
    return []
  }
}

/**
 * Write the profile patch layer, keeping the stock header comment. The previous
 * content is kept as `<file>.bak` (rolling backup) and the write is atomic
 * (temp file + rename) so a crash mid-save can never corrupt the file dsh boots.
 */
function writePatches(home: string, profile: string, patches: unknown[]): void {
  const file = patchFile(home, profile)
  const dir = join(home, 'profiles', profile)
  mkdirSync(dir, { recursive: true })
  try {
    copyFileSync(file, `${file}.bak`)
  } catch {
    /* no previous file — nothing to back up */
  }
  const tmp = join(dir, `.cordis.patch.yml.tmp-${process.pid}`)
  writeFileSync(tmp, PATCH_HEADER + yaml.dump(patches, { schema: ENTRY_LIST_SCHEMA, noRefs: true }) + '\n')
  renameSync(tmp, file)
}

// --- YAML value helpers ---

function scalarString(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

function kvRows(value: unknown): McpKv[] {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return Object.entries(value as Record<string, unknown>).map(([k, v]) => ({ key: k, value: scalarString(v) }))
  }
  return []
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map(scalarString) : []
}

/** A config mapping minus the managed keys, projected to plain JSON for the wire. */
function extraConfig(config: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (!config) return out
  for (const [key, value] of Object.entries(config)) {
    if (MANAGED_CONFIG_KEYS.has(key)) continue
    out[key] = value
  }
  return out
}

// --- reading ---

function serverFromRow(row: Record<string, unknown>): McpServer {
  const config = (typeof row.config === 'object' && row.config !== null && !Array.isArray(row.config))
    ? (row.config as Record<string, unknown>)
    : undefined
  const transport: McpTransport = scalarString(config?.transport) === 'streamable-http' ? 'streamable-http' : 'stdio'
  return {
    id: scalarString(row.id),
    serverName: scalarString(config?.serverName),
    transport,
    url: scalarString(config?.url),
    headers: kvRows(config?.headers),
    command: scalarString(config?.command),
    args: stringList(config?.args),
    env: kvRows(config?.env),
    cwd: scalarString(config?.cwd),
    enabled: row.disabled !== true,
    extra: extraConfig(config)
  }
}

/** Every `dsh-mcp-client` row of the profile patch layer, in file order. */
function parseServers(patches: unknown[]): McpServer[] {
  const out: McpServer[] = []
  for (const patch of patches) {
    if (typeof patch !== 'object' || patch === null) continue
    const insert = (patch as Record<string, unknown>).insert
    if (!Array.isArray(insert)) continue
    for (const entry of insert) {
      if (typeof entry !== 'object' || entry === null) continue
      const row = entry as Record<string, unknown>
      if (scalarString(row.name) === MCP_CLIENT_MODULE) out.push(serverFromRow(row))
    }
  }
  return out
}

/** Whether an insert row is a dsh-mcp-client loader row. */
function isMcpRow(row: Record<string, unknown>): boolean {
  return scalarString(row.name) === MCP_CLIENT_MODULE
}

/** Drop every MCP row from the patch array; every other entry is untouched. */
function stripMcpRows(patches: unknown[]): unknown[] {
  const next: unknown[] = []
  for (const patch of patches) {
    if (typeof patch !== 'object' || patch === null) {
      next.push(patch)
      continue
    }
    const record = { ...(patch as Record<string, unknown>) }
    const insert = record.insert
    if (!Array.isArray(insert)) {
      next.push(record)
      continue
    }
    const kept = insert.filter(e => !(typeof e === 'object' && e !== null && isMcpRow(e as Record<string, unknown>)))
    if (kept.length === insert.length) {
      next.push(record)
      continue
    }
    if (kept.length > 0) next.push({ ...record, insert: kept })
    // An insert entry left with no rows disappears with them.
  }
  return next
}

// --- validation ---

const isServerName = (s: string): boolean => SERVER_NAME_PATTERN.test(s)
const isHeaderKey = (s: string): boolean => /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(s)
const isEnvKey = (s: string): boolean => /^[A-Za-z_][A-Za-z0-9_]*$/.test(s)
const isHttpUrl = (s: string): boolean => {
  if (!/^https?:\/\//.test(s)) return false
  if (/[\s]/.test(s)) return false
  const authority = s.replace(/^https?:\/\//, '').split(/[/?#]/)[0]
  return authority.trim() !== ''
}

function checkKv(rows: McpKv[], label: string, valid: (k: string) => boolean): void {
  const seen = new Set<string>()
  for (const row of rows) {
    if (!valid(row.key)) throw new Error(t(`非法的${label}名: ${row.key}`, `Invalid ${label} name: ${row.key}`))
    if (seen.has(row.key)) throw new Error(t(`${label}名重复: ${row.key}`, `Duplicate ${label} name: ${row.key}`))
    seen.add(row.key)
  }
}

function validateServer(server: McpServer, others: McpServer[]): void {
  const name = server.serverName.trim()
  if (!name) throw new Error(t('请填写服务器名称', 'Please enter a server name'))
  if (!isServerName(name)) throw new Error(t('服务器名称需匹配 [A-Za-z0-9_-] 且不超过 32 字符', 'Server name must match [A-Za-z0-9_-] within 32 chars'))
  if (others.some(o => o.serverName === name)) throw new Error(t(`服务器名称「${name}」已存在`, `Server name "${name}" already exists`))
  if (server.transport === 'streamable-http') {
    if (!server.url.trim()) throw new Error(t('请填写 URL', 'Please enter a URL'))
    if (!isHttpUrl(server.url.trim())) throw new Error(t('URL 需为 http(s):// 开头的合法地址', 'URL must be a valid http(s):// address'))
    checkKv(server.headers, '请求头', isHeaderKey)
  } else {
    if (!server.command.trim()) throw new Error(t('请填写启动命令', 'Please enter a start command'))
    if (server.args.some(a => !a.trim())) throw new Error(t('参数不能为空', 'Arguments cannot be empty'))
    checkKv(server.env, '环境变量', isEnvKey)
  }
}

function normalize(server: McpServer): void {
  server.serverName = server.serverName.trim()
  server.url = server.url.trim()
  server.command = server.command.trim()
  server.cwd = server.cwd.trim()
  server.args = server.args.map(a => a.trim()).filter(Boolean)
  server.headers = server.headers.filter(h => h.key.trim() !== '').map(h => ({ key: h.key.trim(), value: h.value }))
  server.env = server.env.filter(e => e.key.trim() !== '').map(e => ({ key: e.key.trim(), value: e.value }))
  if (server.transport === 'stdio') {
    server.url = ''
    server.headers = []
  } else {
    server.command = ''
    server.cwd = ''
    server.args = []
    server.env = []
  }
}

function stableId(serverName: string, taken: Set<string>): string {
  const base = `mcp-${serverName}`
  let id = base
  let n = 2
  while (taken.has(id)) id = `${base}-${n++}`
  return id
}

// --- serialization ---

function kvMapping(rows: McpKv[]): Record<string, unknown> {
  const map: Record<string, unknown> = {}
  for (const row of rows) map[row.key] = row.value
  return map
}

function rowValue(server: McpServer): Record<string, unknown> {
  const config: Record<string, unknown> = { serverName: server.serverName }
  if (server.transport === 'stdio') {
    config.transport = 'stdio'
    config.command = server.command
    config.args = [...server.args]
    config.env = kvMapping(server.env)
    config.cwd = server.cwd
  } else {
    config.transport = 'streamable-http'
    config.url = server.url
    config.headers = kvMapping(server.headers)
  }
  for (const [key, value] of Object.entries(server.extra)) {
    if (!MANAGED_CONFIG_KEYS.has(key)) config[key] = value
  }
  const row: Record<string, unknown> = { id: server.id, name: MCP_CLIENT_MODULE, config }
  if (!server.enabled) row.disabled = true
  return row
}

function renderServers(patches: unknown[], servers: McpServer[]): unknown[] {
  const next = stripMcpRows(patches)
  if (servers.length === 0) return next
  const rows = servers.map(s => rowValue(s))
  next.push({ insert: rows })
  return next
}

// --- public operations (instance-level, backing the matrix cells) ---

export function listMcpServers(instanceId: string): McpServer[] {
  const { home, profile } = scopeOf(instanceId)
  return parseServers(readPatches(home, profile))
}

/** Create or update one instance MCP server row; validation failures return before any write. */
export function saveMcpServer(instanceId: string, input: McpServer, originalId?: string): McpServer[] {
  const { home, profile } = scopeOf(instanceId)
  const raw = readPatches(home, profile)
  const servers = parseServers(raw)

  const index = originalId && originalId.trim()
    ? servers.findIndex(s => s.id === originalId)
    : -1
  if (originalId && originalId.trim() && index < 0) {
    throw new Error(t(`找不到要编辑的 MCP 服务器「${originalId}」`, `MCP server "${originalId}" not found`))
  }
  const others = servers.filter((_, i) => i !== index)
  const server: McpServer = JSON.parse(JSON.stringify(input)) as McpServer
  normalize(server)
  validateServer(server, others)

  // Carry over unmanaged keys of the row being replaced.
  if (index >= 0) for (const [k, v] of Object.entries(servers[index].extra)) {
    if (!(k in server.extra)) server.extra[k] = v
  }
  const taken = new Set(others.map(s => s.id).filter(Boolean))
  server.id = stableId(server.serverName, taken)

  const nextServers = [...servers]
  if (index >= 0) nextServers[index] = server
  else nextServers.push(server)
  writePatches(home, profile, renderServers(raw, nextServers))
  return parseServers(readPatches(home, profile))
}

/**
 * Whether the `@deepseek-ai/dsh-mcp-client` loader resolves inside the instance's
 * profile. MCP rows only take effect when this package is installed there; a
 * missing loader makes the instance fail to boot on its next start.
 */
export function isMcpLoaderInstalled(instanceId: string): boolean {
  const inst = getInstance(instanceId)
  if (!inst) return false
  const profileDir = join(instanceDshHome(inst), 'profiles', inst.profile)
  try {
    const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8').replace(/^﻿/, '')) as {
      dependencies?: Record<string, string>
    }
    const spec = manifest.dependencies?.[MCP_CLIENT_MODULE]
    if (typeof spec === 'string' && (spec.startsWith('file:') || spec.startsWith('link:'))) {
      const target = join(profileDir, spec.slice(spec.indexOf(':') + 1))
      return existsSync(join(target, 'package.json'))
    }
  } catch {
    /* missing/broken manifest — fall through to node_modules check */
  }
  // `@deepseek-ai/dsh-mcp-client` contains a slash → resolves to a nested folder.
  return existsSync(join(profileDir, 'node_modules', ...MCP_CLIENT_MODULE.split('/'), 'package.json'))
}

// --- MCP library (canonical store: `<runtimeRoot>/mcp-library.json`) ---

const MCP_LIBRARY_FILE = 'mcp-library.json'

function mcpLibraryFile(): string {
  return join(getConfig().runtimeRoot, MCP_LIBRARY_FILE)
}

function readMcpLibrary(): McpServer[] {
  try {
    const parsed = JSON.parse(readFileSync(mcpLibraryFile(), 'utf8'))
    return Array.isArray(parsed) ? (parsed as McpServer[]) : []
  } catch {
    return []
  }
}

/** Write the MCP library with a `.bak` rolling backup + atomic rename. */
function writeMcpLibrary(servers: McpServer[]): void {
  const file = mcpLibraryFile()
  const dir = dirname(file)
  mkdirSync(dir, { recursive: true })
  try {
    copyFileSync(file, `${file}.bak`)
  } catch {
    /* no previous file — nothing to back up */
  }
  const tmp = join(dir, `.mcp-library.json.tmp-${process.pid}`)
  writeFileSync(tmp, JSON.stringify(servers, null, 2), 'utf8')
  renameSync(tmp, file)
}

/** Resolve an instance's home/profile for patch reads without creating anything. */
function homeProfile(instanceId: string): { home: string; profile: string } | null {
  const inst = getInstance(instanceId)
  return inst ? { home: instanceDshHome(inst), profile: inst.profile } : null
}

/** Instance-level patch write reused by the library sync (keeps each row's enabled flag). */
function syncInstanceRowToServer(instanceId: string, server: McpServer, originalName?: string): boolean {
  const hp = homeProfile(instanceId)
  if (!hp) return false
  const { home, profile } = hp
  const raw = readPatches(home, profile)
  const servers = parseServers(raw)
  const old = (originalName && originalName.trim()) || server.serverName
  let changed = false
  const nextServers = servers.map(s => {
    if (s.serverName === old || s.serverName === server.serverName) {
      changed = true
      return { ...server, enabled: s.enabled }
    }
    return s
  })
  if (!changed) return false
  writePatches(home, profile, renderServers(raw, nextServers))
  return true
}

/** Instance-level row removal reused by the library delete. */
function removeServerNameFromInstance(instanceId: string, name: string): boolean {
  const hp = homeProfile(instanceId)
  if (!hp) return false
  const { home, profile } = hp
  const raw = readPatches(home, profile)
  const servers = parseServers(raw)
  const nextServers = servers.filter(s => s.serverName !== name)
  if (nextServers.length === servers.length) return false
  writePatches(home, profile, renderServers(raw, nextServers))
  return true
}

/** Instance ids whose patch currently carries a row for the given server name. */
export function instancesUsingMcpServer(name: string): string[] {
  const out: string[] = []
  for (const inst of getInstances()) {
    try {
      const hp = homeProfile(inst.id)
      if (hp && parseServers(readPatches(hp.home, hp.profile)).some(s => s.serverName === name)) out.push(inst.id)
    } catch {
      /* skip broken instance */
    }
  }
  return out
}

// --- public operations (library) ---

/** List the MCP library (canonical configs, unique by `serverName`). */
export function listMcpLibrary(): McpServer[] {
  return readMcpLibrary()
}

/**
 * Save a library server (create or edit). Editing re-syncs every assigned
 * instance's row to the new config, preserving each row's enabled flag.
 * `originalName` names the record being edited (for renames).
 */
export function saveMcpLibrary(input: McpServer, originalName?: string): McpServer[] {
  const lib = readMcpLibrary()
  const orig = (originalName && originalName.trim()) || undefined
  const server: McpServer = JSON.parse(JSON.stringify(input)) as McpServer
  normalize(server)
  const index = orig ? lib.findIndex(s => s.serverName === orig) : -1
  if (orig && index < 0) {
    throw new Error(t(`找不到要编辑的 MCP 服务器「${orig}」`, `MCP server "${orig}" not found`))
  }
  const others = lib.filter((_, i) => i !== index)
  validateServer(server, others)
  // Carry over unmanaged keys of the library record being replaced.
  if (index >= 0) for (const [k, v] of Object.entries(lib[index].extra)) {
    if (!(k in server.extra)) server.extra[k] = v
  }
  server.id = `mcp-${server.serverName}`
  server.enabled = true // enablement is per instance; the library record is canonical config.
  const next = [...lib]
  if (index >= 0) next[index] = server
  else next.push(server)
  writeMcpLibrary(next)
  for (const inst of getInstances()) {
    try {
      syncInstanceRowToServer(inst.id, server, orig)
    } catch {
      /* skip broken instance */
    }
  }
  return readMcpLibrary()
}

/** Delete a library server; every instance's row for that server name is removed too. */
export function deleteMcpLibrary(name: string): McpServer[] {
  const clean = name.trim()
  const next = readMcpLibrary().filter(s => s.serverName !== clean)
  writeMcpLibrary(next)
  for (const inst of getInstances()) {
    try {
      removeServerNameFromInstance(inst.id, clean)
    } catch {
      /* skip broken instance */
    }
  }
  return next
}
