import type { ScanSection } from './types'

/** Sections and lessons in the same order the downloader walks. An empty title means no section. */
export function outlineOf(tree: any): ScanSection[] {
  const out: ScanSection[] = []
  const loose = () => {
    const last = out[out.length - 1]
    if (last && !last.title) return last
    const section: ScanSection = { title: '', lessons: [] }
    out.push(section)
    return section
  }
  const walk = (node: any) => {
    for (const ch of node?.children || []) {
      const u = ch.course || {}
      if (u.unitType === 'set') {
        const lessons: ScanSection['lessons'] = []
        const collect = (n: any) => {
          for (const c of n?.children || []) {
            const cu = c.course || {}
            if (cu.unitType === 'module') lessons.push({ id: cu.id, title: cu.metadata?.title || 'Lesson' })
            else if (cu.unitType === 'set' || c.children?.length) collect(c)
          }
        }
        collect(ch)
        if (lessons.length) out.push({ title: u.metadata?.title || 'Section', lessons })
      } else if (u.unitType === 'module') {
        loose().lessons.push({ id: u.id, title: u.metadata?.title || 'Lesson' })
      } else if (ch.children?.length) walk(ch)
    }
  }
  walk(tree)
  return out.filter((s) => s.lessons.length)
}
