// README rendering for the plugin market modal. Uses `marked` (full GFM +
// raw HTML passthrough — many READMEs are HTML, not Markdown) and sanitizes
// the output with DOMPurify before it is injected. Relative image/link URLs
// are resolved against the repository's raw / blob bases.

import { marked } from 'marked'
import DOMPurify from 'dompurify'

marked.setOptions({ gfm: true, breaks: true })

/** Bases for resolving relative URLs in a repository README. */
export interface ReadmeBase {
  /** https://raw.githubusercontent.com/<owner>/<repo>/<branch>/ */
  raw: string
  /** https://github.com/<owner>/<repo>/blob/<branch>/ */
  blob: string
}

/** GitHub-style heading slug, so `#my-section` anchor links resolve in-page. */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[ -⁯⸀-⹿\\'!"#$%&()*+,./:;<=>?@[\]^`{|}~]/g, '')
    .replace(/\s+/g, '-')
}

export function renderMarkdown(md: string, base?: ReadmeBase): string {
  const html = marked.parse(md, { async: false }) as string
  const clean = DOMPurify.sanitize(html)
  const doc = new DOMParser().parseFromString(clean, 'text/html')
  const raw = base?.raw ?? ''
  const blob = base?.blob ?? ''

  // Resolve relative URLs inside the sanitized DOM so in-repo screenshots and
  // links actually work (marked leaves them as bare paths).
  doc.querySelectorAll('img').forEach((img) => {
    const src = img.getAttribute('src')
    if (src && !/^(https?:|data:|blob:|#)/i.test(src)) {
      img.setAttribute('src', raw + src.replace(/^\.\//, ''))
    }
  })
  doc.querySelectorAll('a').forEach((a) => {
    const href = a.getAttribute('href')
    if (href && !/^(https?:|mailto:|#)/i.test(href)) {
      a.setAttribute('href', blob + href.replace(/^\.\//, ''))
    }
    // Every click is routed through the modal's own handler (confirm dialog +
    // system browser / in-page scroll), so never let the browser open a new
    // window or the launcher window navigate.
    a.removeAttribute('target')
    a.removeAttribute('rel')
  })

  // Give headings GitHub-style ids so `#foo` anchors scroll in-page instead of
  // falling back to the confirm-dialog / window-navigation path.
  const used = new Map<string, number>()
  doc.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach((h) => {
    if (h.getAttribute('id')) return
    const base = slugify(h.textContent ?? '')
    if (!base) return
    const n = used.get(base) ?? 0
    used.set(base, n + 1)
    h.setAttribute('id', n === 0 ? base : `${base}-${n}`)
  })

  return doc.body.innerHTML
}
