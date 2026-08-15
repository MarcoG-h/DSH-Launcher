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

export function renderMarkdown(md: string, base?: ReadmeBase): string {
  const html = marked.parse(md, { async: false }) as string
  const clean = DOMPurify.sanitize(html)

  if (!base) return clean

  // Resolve relative URLs inside the sanitized DOM so in-repo screenshots and
  // links actually work (marked leaves them as bare paths).
  const doc = new DOMParser().parseFromString(clean, 'text/html')
  doc.querySelectorAll('img').forEach((img) => {
    const src = img.getAttribute('src')
    if (src && !/^(https?:|data:|blob:|#)/i.test(src)) {
      img.setAttribute('src', base.raw + src.replace(/^\.\//, ''))
    }
  })
  doc.querySelectorAll('a').forEach((a) => {
    const href = a.getAttribute('href')
    if (href && !/^(https?:|mailto:|#)/i.test(href)) {
      a.setAttribute('href', base.blob + href.replace(/^\.\//, ''))
    }
  })
  return doc.body.innerHTML
}
