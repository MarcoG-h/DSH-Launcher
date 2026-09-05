import type { CSSProperties, JSX } from 'react'
import { useI18n } from '../i18n'
import type { McpTransport } from '../lib/api'

// 预置卡片自适应网格:抽屉窄(默认开 ~460px)1 列、中等 2 列、全展开(内容区 ~900–1100px)恰好 3 列。
const CARD_GRID: CSSProperties = {
  display: 'grid',
  gap: 10,
  gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))'
}

/**
 * MCP「一键使用」预置源(curated & 安全)。
 *
 * 字段即 McpServer 需要的字段;env 中 value 为空的项是「待用户补全的密钥」,
 * 点「添加」后会把整条预填进 MCP 新建 Modal,用户补上 secret 再保存。
 */
export interface McpPreset {
  serverName: string
  titleZh: string
  titleEn: string
  descZh: string
  descEn: string
  transport: McpTransport
  command: string
  args: string[]
  env: { key: string; value: string }[]
  cwd: string
  url: string
  headers: { key: string; value: string }[]
}

export const MCP_PRESETS: McpPreset[] = [
  {
    serverName: 'github',
    titleZh: 'GitHub',
    titleEn: 'GitHub',
    descZh: '官方 GitHub MCP:仓库 / Issue / PR / Gist 的查询与操作。需填入 GITHUB_PERSONAL_ACCESS_TOKEN。',
    descEn: 'Official GitHub MCP: repos, issues, PRs and gists. Fill in GITHUB_PERSONAL_ACCESS_TOKEN.',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    env: [{ key: 'GITHUB_PERSONAL_ACCESS_TOKEN', value: '' }],
    cwd: '',
    url: '',
    headers: []
  },
  {
    serverName: 'fetch',
    titleZh: 'Fetch 网页抓取',
    titleEn: 'Fetch',
    descZh: '官方网页抓取:把 URL 内容转成 markdown 供模型阅读。无需密钥(可选 FETCH_MCP_HEADERS)。',
    descEn: 'Official web fetcher: turns a URL into markdown for the model. No secret required (optional FETCH_MCP_HEADERS).',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-fetch'],
    env: [],
    cwd: '',
    url: '',
    headers: []
  },
  {
    serverName: 'playwright',
    titleZh: 'Playwright 浏览器',
    titleEn: 'Playwright',
    descZh: '官方浏览器自动化:打开网页、点击、填写表单、截图。首次运行会自动下载浏览器内核。',
    descEn: 'Official browser automation: navigate, click, fill forms and screenshot. First run downloads a browser.',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-playwright'],
    env: [],
    cwd: '',
    url: '',
    headers: []
  },
  {
    serverName: 'sequential-thinking',
    titleZh: '顺序思维',
    titleEn: 'Sequential Thinking',
    descZh: '官方顺序思维工具:把复杂问题拆成可追踪、可回溯的思考步骤。无需密钥。',
    descEn: 'Official sequential thinking tool: breaks hard problems into trackable, revisitable steps. No secret.',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
    env: [],
    cwd: '',
    url: '',
    headers: []
  },
  {
    serverName: 'memory',
    titleZh: 'Memory 知识图谱',
    titleEn: 'Memory (KG)',
    descZh: '官方持久化记忆:以知识图谱保存 / 检索实体关系,提供跨会话记忆。无需密钥。',
    descEn: 'Official knowledge-graph memory: store/retrieve entities & relations for cross-session memory. No secret.',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-memory'],
    env: [],
    cwd: '',
    url: '',
    headers: []
  },
  {
    serverName: 'filesystem',
    titleZh: 'Filesystem 文件系统',
    titleEn: 'Filesystem',
    descZh: '官方文件系统访问:在指定目录内读写文件。把 args 里的路径改成你允许访问的目录。',
    descEn: 'Official filesystem access: read/write files under an allowed directory. Replace the path in args.',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '/path/to/allowed/dir'],
    env: [],
    cwd: '',
    url: '',
    headers: []
  }
]

/** 「一键使用」源列表 — 显示在右侧市场抽屉的 MCP 类目下。 */
export function McpPresetPanel({ onUse }: { onUse: (p: McpPreset) => void }): JSX.Element {
  const { lang } = useI18n()
  const L = (zh: string, en: string): string => (lang === 'en' ? en : zh)
  const needsEnv = (p: McpPreset): string[] => p.env.filter((e) => !e.value).map((e) => e.key)

  return (
    <div className="space-y-2">
      <p className="text-[12px] leading-relaxed" style={{ color: 'var(--muted)' }}>
        {L(
          '点击「添加」把预置服务器填进 MCP 新建弹窗,补全密钥后保存进 MCP 库,再到主矩阵点实例格分配。',
          'Click "Add" to prefill this preset into the MCP create dialog, fill in secrets and save to the MCP library, then assign it to instances from the matrix.'
        )}
      </p>
      <div style={CARD_GRID}>
        {MCP_PRESETS.map((p) => {
          const missing = needsEnv(p)
          return (
            <div
              key={p.serverName}
              className="flex flex-col rounded-lg border p-2.5"
              style={{ borderColor: 'var(--border)', background: 'var(--card)' }}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="mono min-w-0 truncate text-[12.5px] font-semibold" style={{ color: 'var(--text)' }}>
                  {lang === 'en' ? p.titleEn : p.titleZh}
                </span>
                <button className="btn btn-primary btn-sm shrink-0" onClick={() => onUse(p)}>
                  {L('添加', 'Add')}
                </button>
              </div>
              <p className="mt-1 line-clamp-2 text-[11.5px] leading-relaxed" style={{ color: 'var(--muted)' }}>
                {lang === 'en' ? p.descEn : p.descZh}
              </p>
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                <span className="badge !px-1.5 text-[10px]" style={{ color: 'var(--accent)', background: 'var(--accent-soft)' }}>
                  {p.transport}
                </span>
                <span className="badge !px-1.5 text-[10px] mono" style={{ color: 'var(--muted)', background: 'var(--bg-soft)' }}>
                  {p.command}
                </span>
                {p.args.length > 0 && (
                  <span className="max-w-[220px] truncate mono text-[10px]" style={{ color: 'var(--muted)' }}>
                    {p.args.join(' ')}
                  </span>
                )}
              </div>
              {missing.length > 0 && (
                <div className="mt-1.5 text-[11px]" style={{ color: 'var(--warn)' }}>
                  {L('需补全:', 'needs:')} {missing.join(', ')}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
