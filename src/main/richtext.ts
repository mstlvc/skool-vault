// Skool stores text either as "[v2]" + ProseMirror/TipTap JSON, or as plain
// text with light markdown. Both are converted to sanitized HTML here.
import { parseJson } from './util'

const esc = (s: any) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

const safeHref = (h: any) => {
  const s = String(h || '').trim()
  if (s.startsWith('obj://')) return '' // Skool internal mentions
  return /^(https?:|mailto:)/i.test(s) ? s : ''
}

type UrlMap = (url: string) => string

function asDoc(desc: any): any[] | null {
  let d = desc
  if (typeof d === 'string') {
    if (!d.startsWith('[v2]')) return null
    d = parseJson(d.slice(4), [])
  }
  if (!d || typeof d !== 'object') return null
  if (Array.isArray(d)) return d
  if (d.type === 'doc') return d.content || []
  return [d]
}

/** All image URLs referenced by a description (to download before rendering). */
export function imageUrls(desc: any): string[] {
  const out = new Set<string>()
  const doc = asDoc(desc)
  if (doc) {
    const walk = (n: any) => {
      if (!n || typeof n !== 'object') return
      if (n.type === 'image' && n.attrs?.src) out.add(n.attrs.src)
      ;(n.content || []).forEach(walk)
    }
    doc.forEach(walk)
  } else if (typeof desc === 'string') {
    for (const m of desc.matchAll(/!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/g)) out.add(m[1])
    for (const m of desc.matchAll(/https:\/\/assets\.skool\.com\/[^\s)"'<>\]]+\.(?:png|jpe?g|gif|webp)/gi)) out.add(m[0])
  }
  return [...out]
}

export function toHtml(desc: any, map: UrlMap = (u) => u): string {
  const doc = asDoc(desc)
  if (doc) return doc.map((n) => node(n, map)).join('')
  return markdownish(typeof desc === 'string' ? desc : '', map)
}

/** Plain text (for previews and search). */
/** A markdown backslash escape: \( \) \* \_ \# \. and friends. */
export const MD_ESCAPE = /\\([\\`*_{}\[\]()#+\-.!~|>])/g

export function toText(desc: any): string {
  const doc = asDoc(desc)
  if (!doc) {
    const kept: string[] = []
    return String(desc || '')
      .replace(MD_ESCAPE, (_, c) => `\u0000${kept.push(c) - 1}\u0000`) // keep escaped chars literal
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/[*_#>`]/g, '')
      .replace(/\u0000(\d+)\u0000/g, (_, i) => kept[Number(i)])
      .trim()
  }
  const parts: string[] = []
  const walk = (n: any) => {
    if (!n) return
    if (n.type === 'text') parts.push(n.text || '')
    ;(n.content || []).forEach(walk)
    if (['paragraph', 'heading', 'listItem'].includes(n.type)) parts.push('\n')
  }
  doc.forEach(walk)
  return parts.join('').replace(/\n{3,}/g, '\n\n').trim()
}

function node(n: any, map: UrlMap): string {
  if (!n || typeof n !== 'object') return ''
  const a = n.attrs || {}
  if (n.type === 'text') {
    let s = esc(n.text)
    for (const m of n.marks || []) {
      const ma = m.attrs || {}
      if (m.type === 'bold') s = `<strong>${s}</strong>`
      else if (m.type === 'italic') s = `<em>${s}</em>`
      else if (m.type === 'underline') s = `<u>${s}</u>`
      else if (m.type === 'strike') s = `<s>${s}</s>`
      else if (m.type === 'code') s = `<code>${s}</code>`
      else if (m.type === 'highlight') s = `<mark>${s}</mark>`
      else if (m.type === 'link') {
        const href = safeHref(ma.href)
        s = href ? `<a href="${esc(href)}" target="_blank" rel="noopener">${s}</a>` : `<span class="mention">${s}</span>`
      }
    }
    return s
  }
  const inner = (n.content || []).map((c: any) => node(c, map)).join('')
  switch (n.type) {
    case 'paragraph':
      return `<p>${inner || '<br>'}</p>`
    case 'heading': {
      const l = Math.min(Math.max(Number(a.level) || 2, 1), 6)
      return `<h${l}>${inner}</h${l}>`
    }
    case 'bulletList':
      return `<ul>${inner}</ul>`
    case 'orderedList':
      return `<ol start="${Number(a.start) || 1}">${inner}</ol>`
    case 'listItem':
      return `<li>${inner}</li>`
    case 'taskList':
      return `<ul class="tasks">${inner}</ul>`
    case 'taskItem':
      return `<li><input type="checkbox" disabled ${a.checked ? 'checked' : ''}> ${inner}</li>`
    case 'blockquote':
      return `<blockquote>${inner}</blockquote>`
    case 'codeBlock':
      return `<pre><code>${inner}</code></pre>`
    case 'hardBreak':
      return '<br>'
    case 'horizontalRule':
      return '<hr>'
    case 'image':
      return `<img src="${esc(map(a.src || ''))}" alt="${esc(a.alt || '')}" loading="lazy">`
    case 'table':
      return `<div class="table-wrap"><table>${inner}</table></div>`
    case 'tableRow':
      return `<tr>${inner}</tr>`
    case 'tableHeader':
      return `<th>${inner}</th>`
    case 'tableCell':
      return `<td>${inner}</td>`
    case 'mention':
      return `<span class="mention">@${esc(a.label || a.name || a.id || '')}</span>`
    case 'emoji':
      return esc(a.emoji || a.name || '')
    default: {
      const src = safeHref(a.src || a.url || a.href)
      if (src && /iframe|embed|video|youtube|vimeo|loom|wistia/i.test(n.type || ''))
        return `<p class="embed"><a href="${esc(src)}" target="_blank" rel="noopener">▶ ${esc(src)}</a></p>`
      return inner
    }
  }
}

function markdownish(text: string, map: UrlMap): string {
  const out: string[] = []
  let list: 'ul' | 'ol' | null = null
  for (const raw of text.replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.trimEnd()
    const ul = /^\s*[-*•]\s+(.*)/.exec(line)
    const ol = /^\s*\d+[.)]\s+(.*)/.exec(line)
    const kind = ul ? 'ul' : ol ? 'ol' : null
    if (list && kind !== list) {
      out.push(`</${list}>`)
      list = null
    }
    if (kind && !list) {
      out.push(`<${kind}>`)
      list = kind
    }
    if (kind) {
      out.push(`<li>${inline((ul || ol)![1], map)}</li>`)
      continue
    }
    const h = /^(#{1,6})\s+(.*)/.exec(line)
    if (h) out.push(`<h${h[1].length}>${inline(h[2], map)}</h${h[1].length}>`)
    else if (line.trim()) out.push(`<p>${inline(line, map)}</p>`)
  }
  if (list) out.push(`</${list}>`)
  return out.join('\n')
}

function inline(s: string, map: UrlMap): string {
  const tokens: string[] = []
  const keep = (html: string) => `\u0000${tokens.push(html) - 1}\u0000`
  // markdown escapes like \( or \* are just the character (Skool stores some posts this way)
  s = s.replace(MD_ESCAPE, (_, c) => keep(esc(c)))
  // images and links first, so their URLs aren't mangled by other rules
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, src) => keep(`<img src="${esc(map(src))}" alt="${esc(alt)}" loading="lazy">`))
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, href) => {
    const h = safeHref(href)
    return keep(
      h
        ? `<a href="${esc(h)}" target="_blank" rel="noopener">${esc(label)}</a>`
        : `<span class="mention">${esc(label.startsWith('@') ? label : label)}</span>`
    )
  })
  s = s.replace(/https?:\/\/[^\s<>"]+/g, (u) => keep(`<a href="${esc(u)}" target="_blank" rel="noopener">${esc(u)}</a>`))
  s = esc(s)
  s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  s = s.replace(/(^|[^\w*])\*(?!\s)(.+?)(?<!\s)\*(?![\w*])/g, '$1<em>$2</em>')
  s = s.replace(/(^|[^\w_])_(?!\s)(.+?)(?<!\s)_(?![\w_])/g, '$1<em>$2</em>')
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>')
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => tokens[Number(i)])
}
