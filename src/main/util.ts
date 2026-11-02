// Small JSON helpers shared by the scraper and the rich-text converter (no Electron imports).

/** Walk any JSON value (including JSON-encoded strings) and yield [key, value, parent]. */
export function* deepFind(obj: any, keys: Set<string>): Generator<[string, any, any]> {
  const stack: any[] = [obj]
  const seen = new Set<any>()
  while (stack.length) {
    const o = stack.pop()
    if (!o || typeof o !== 'object' || seen.has(o)) continue
    seen.add(o)
    if (Array.isArray(o)) {
      for (const x of o) if (x && typeof x === 'object') stack.push(x)
      continue
    }
    for (const [k, v] of Object.entries(o)) {
      if (keys.has(k)) yield [k, v, o]
      if (v && typeof v === 'object') stack.push(v)
      else if (typeof v === 'string' && (v[0] === '{' || v[0] === '[')) {
        const p = parseJson(v)
        if (p && typeof p === 'object') stack.push(p)
      }
    }
  }
}

export function parseJson<T = any>(v: any, fallback: T | null = null): T | null {
  if (v && typeof v === 'object') return v
  if (typeof v !== 'string' || !v.trim()) return fallback
  try {
    return JSON.parse(v)
  } catch {
    return fallback
  }
}
