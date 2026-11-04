// Skool embeds Vimeo. The vimeo.com website asks for a Vimeo login.
// The player page, requested as an embed from Skool, carries the file address.

export function vimeoPlayerUrl(url: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (!/(^|\.)vimeo\.com$/i.test(parsed.hostname)) return null
  const m = parsed.pathname.match(/\/(?:video\/)?(\d+)(?:\/([\da-f]{10}))?/i)
  if (!m) return null
  const player = new URL(`https://player.vimeo.com/video/${m[1]}`)
  const hash = m[2] || parsed.searchParams.get('h') || ''
  if (/^[\da-f]{10}$/i.test(hash)) player.searchParams.set('h', hash)
  return player.toString()
}

function sliceObject(s: string, start: number): string | null {
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < s.length; i++) {
    const c = s[i]
    if (inStr) {
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') inStr = true
    else if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) return s.slice(start, i + 1)
    }
  }
  return null
}

function configFromHtml(html: string): any | null {
  const at = html.search(/playerConfig\s*=/)
  const start = at >= 0 ? html.indexOf('{', at) : -1
  if (start < 0) return null
  const raw = sliceObject(html, start)
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function fromFiles(files: any, maxHeight: number): string | null {
  const progressive = Array.isArray(files?.progressive) ? files.progressive : []
  const ranked = progressive
    .filter((f: any) => typeof f?.url === 'string' && (!maxHeight || !f.height || f.height <= maxHeight))
    .sort((a: any, b: any) => (b.height || 0) - (a.height || 0))
  if (ranked[0]) return ranked[0].url
  const cdns = files?.hls?.cdns
  if (cdns && typeof cdns === 'object') {
    for (const cdn of Object.values(cdns) as any[]) {
      if (typeof cdn?.url === 'string') return cdn.url
    }
  }
  return null
}

/** Best direct file inside a Vimeo player page, or null when the page has no player config. */
export function vimeoStreamFromHtml(html: string, maxHeight = 0): string | null {
  const config = configFromHtml(html)
  if (config) {
    const hit = fromFiles(config.request?.files, maxHeight) || fromFiles(config.video?.files, maxHeight)
    if (hit) return hit
  }
  const loose = html.match(/https?:\\?\/\\?\/[^"'\\\s]+?\.m3u8[^"'\\\s]*/)
  return loose ? loose[0].replace(/\\\//g, '/') : null
}
