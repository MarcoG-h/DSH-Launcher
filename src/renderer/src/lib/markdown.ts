// Minimal, dependency-free Markdown → HTML for the plugin market README modal.
// All text is HTML-escaped before being wrapped in tags, so the output is safe
// to render via dangerouslySetInnerHTML; only http(s)/mailto/# links stay clickable.

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function inline(s: string): string {
  return s
    .replace(/`([^`]+)`/g, (_m, c: string) => `<code>${c}</code>`)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, text: string, href: string) =>
      /^(https?:|mailto:|#)/.test(href) ? `<a href="${href}" target="_blank" rel="noreferrer">${text}</a>` : text
    )
}

export function renderMarkdown(md: string): string {
  const out: string[] = []
  let para: string[] = []
  let inCode = false
  const codeLines: string[] = []

  const flushPara = (): void => {
    if (para.length) {
      out.push(`<p>${inline(para.join(' '))}</p>`)
      para = []
    }
  }
  const flushCode = (): void => {
    if (codeLines.length) {
      out.push(`<pre>${esc(codeLines.join('\n'))}</pre>`)
      codeLines.length = 0
    }
  }

  for (const raw of md.split('\n')) {
    if (/^```/.test(raw)) {
      if (inCode) {
        flushCode()
        inCode = false
      } else {
        flushPara()
        inCode = true
      }
      continue
    }
    if (inCode) {
      codeLines.push(raw)
      continue
    }

    const line = esc(raw.trim())
    if (!line) {
      flushPara()
      continue
    }
    const heading = /^#{1,4}\s+(.+)$/.exec(line)
    if (heading) {
      flushPara()
      out.push(`<h4>${inline(heading[1])}</h4>`)
      continue
    }
    if (/^[-*_]{3,}$/.test(line)) {
      flushPara()
      out.push('<hr>')
      continue
    }
    const li = /^[-*]\s+(.+)$/.exec(line) ?? /^\d+\.\s+(.+)$/.exec(line)
    if (li) {
      flushPara()
      out.push(`<div class="mli">• ${inline(li[1])}</div>`)
      continue
    }
    const quote = /^&gt;\s?(.*)$/.exec(line)
    if (quote) {
      flushPara()
      out.push(`<div class="mquote">${inline(quote[1])}</div>`)
      continue
    }
    para.push(line)
  }
  if (inCode) flushCode()
  flushPara()
  return out.join('\n')
}
