import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { ClassroomArchive, CommunityArchive, GroupArchive, GroupInfo, LibraryEntry, Lesson, Section } from '../shared/types'
import { getSettings } from './settings'

export const groupDir = (slug: string) => join(getSettings().libraryDir, slug)

export function readJson<T>(path: string, fallback: T): T {
  try {
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : fallback
  } catch {
    return fallback
  }
}

/** Atomic write so a crash never leaves half a JSON file. */
export function writeJson(path: string, data: unknown) {
  mkdirSync(join(path, '..'), { recursive: true })
  const tmp = path + '.tmp'
  writeFileSync(tmp, JSON.stringify(data, null, 1))
  renameSync(tmp, path)
}

export function loadGroup(slug: string): GroupArchive | null {
  const dir = groupDir(slug)
  const group = readJson<GroupInfo | null>(join(dir, 'group.json'), null)
  if (!group) return null
  return {
    group,
    classroom: readJson<ClassroomArchive>(join(dir, 'classroom.json'), { courses: [] }),
    community: readJson<CommunityArchive>(join(dir, 'community.json'), { categories: [], posts: [] })
  }
}

export const lessonsOf = (items: (Section | Lesson)[]): Lesson[] =>
  items.flatMap((i) => (i.type === 'set' ? i.items : [i]))

export function listLibrary(): LibraryEntry[] {
  const root = getSettings().libraryDir
  if (!existsSync(root)) return []
  const out: LibraryEntry[] = []
  for (const d of readdirSync(root, { withFileTypes: true })) {
    if (!d.isDirectory()) continue
    const g = loadGroup(d.name)
    if (!g) continue
    const lessons = g.classroom.courses.flatMap((c) => lessonsOf(c.items))
    out.push({
      slug: g.group.slug,
      name: g.group.name,
      logo: g.group.logo,
      cover: g.group.cover,
      courses: g.classroom.courses.length,
      lessons: lessons.length,
      posts: g.community.posts.length,
      videos:
        lessons.filter((l) => l.video?.file).length +
        g.community.posts.reduce((n, p) => n + p.videos.filter((v) => v.file).length, 0),
      updatedAt: g.group.updatedAt
    })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}
