// Parse GitHub repository references into a canonical owner/repo + clone URL.
// Accepts:
//   https://github.com/owner/repo
//   https://github.com/owner/repo.git
//   https://github.com/owner/repo/tree/<ref>  (or /blob/<ref>)
//   github:owner/repo
//   git@github.com:owner/repo.git
export interface GitHubRef {
  owner: string
  repo: string
  ref?: string
  cloneUrl: string
}

export function parseGitHubUrl(input: string): GitHubRef | null {
  const s = input.trim()
  if (!s) return null

  // https://github.com/owner/repo[...]
  let m = s.match(/^https?:\/\/(?:www\.)?github\.com\/([^/\s#?]+)\/([^/\s#?]+)/i)
  if (m) {
    const owner = m[1]
    const repo = m[2].replace(/\.git$/, '')
    const ref = s.slice(m[0].length).match(/^\/(?:tree|blob)\/([^/\s#?]+)/)?.[1]
    return { owner, repo, ref, cloneUrl: `https://github.com/${owner}/${repo}.git` }
  }

  // github:owner/repo
  m = s.match(/^github:([^/\s#?]+)\/([^#\s]+)/i)
  if (m) {
    const owner = m[1]
    const repo = m[2].replace(/\.git$/, '')
    return { owner, repo, cloneUrl: `https://github.com/${owner}/${repo}.git` }
  }

  // git@github.com:owner/repo.git
  m = s.match(/^git@github\.com:([^/\s]+)\/([^#\s]+?)(?:\.git)?$/i)
  if (m) {
    const repo = m[2].replace(/\.git$/, '')
    return { owner: m[1], repo, cloneUrl: `https://github.com/${m[1]}/${repo}.git` }
  }

  return null
}
