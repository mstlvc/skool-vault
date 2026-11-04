// Posts pinned on a lesson are stored in that lesson's saved page. The community
// file often does not have them yet, and the viewer would otherwise open Skool.
import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'
import type { Attachment, ClassroomArchive, CommunityArchive, Person, Post, VideoRef } from '../shared/types'
import { toHtml, toText } from './richtext'
import { parseJson } from './util'

function personOf(u: any): Person {
  u = u || {}
  const m = u.metadata || {}
  const name =
    [u.firstName || u.first_name, u.lastName || u.last_name].filter(Boolean).join(' ') ||
    m.displayName ||
    m.display_name ||
    u.name ||
    'Member'
  const avatar = m.pictureBubble || m.picture_bubble || m.pictureProfile || m.picture_profile || null
  return { id: u.id || '', name, handle: u.name, avatar: typeof avatar === 'string' ? avatar : null }
}

function partsOf(meta: any): { images: string[]; attachments: Attachment[]; videos: VideoRef[] } {
  const list = parseJson<any>(meta.attachmentsData || meta.attachments_data, []) || []
  const images: string[] = []
  const attachments: Attachment[] = []
  for (const a of Array.isArray(list) ? list : []) {
    const m = a?.metadata || {}
    const url = String(m.read_url || m.url || a.read_url || a.url || '')
    const name = String(m.file_name || a.file_name || a.title || 'file')
    const type = String(m.content_type || a.content_type || a.type || '')
    const image = type.startsWith('image') || /\.(png|jpe?g|gif|webp|avif)$/i.test(name)
    if (image && /^https?:/i.test(url)) images.push(url)
    else attachments.push({ name, href: /^https?:/i.test(url) ? url : null, type })
  }
  const preview = meta.imagePreview || meta.image_preview
  if (typeof preview === 'string' && /^https?:/i.test(preview)) images.unshift(preview)
  const videos: VideoRef[] = []
  const vlist = parseJson<any>(meta.videoLinksData || meta.video_links_data, []) || []
  for (const v of Array.isArray(vlist) ? vlist : []) {
    const url = v?.url || v?.link
    if (typeof url === 'string' && /^https?:/i.test(url))
      videos.push({ source: url, thumb: v.thumbnail || v.thumbnail_url || null })
  }
  return { images: [...new Set(images)], attachments, videos }
}

/** A community post object as Skool embeds it on a lesson page. */
export function postFromPinned(node: any): Post | null {
  const p = node?.post?.id ? node.post : node
  if (!p?.id || !p?.name) return null
  const meta = p.metadata || {}
  const { images, attachments, videos } = partsOf(meta)
  return {
    id: String(p.id),
    slug: String(p.name),
    title: meta.title || '',
    html: toHtml(meta.content || ''),
    text: toText(meta.content || '').slice(0, 2000),
    author: personOf(p.user),
    createdAt: p.createdAt || p.created_at || '',
    updatedAt: p.updatedAt || p.updated_at,
    upvotes: Number(meta.upvotes || 0),
    commentCount: Number(meta.comments || 0),
    pinned: !!Number(meta.pinned || 0),
    category: meta.labels || null,
    images,
    videos,
    attachments,
    comments: []
  }
}

function lessonFiles(dir: string): Map<string, string> {
  const root = join(dir, 'raw', 'classroom')
  const out = new Map<string, string>()
  if (!existsSync(root)) return out
  const walk = (folder: string) => {
    for (const name of readdirSync(folder)) {
      const p = join(folder, name)
      if (statSync(p).isDirectory()) walk(p)
      else {
        const m = /_([0-9a-f]{16,})\.json$/i.exec(name)
        if (m) out.set(m[1].toLowerCase(), p)
      }
    }
  }
  walk(root)
  return out
}

function takePinned(node: any, want: Set<string>, found: Map<string, Post>) {
  if (!node || typeof node !== 'object' || found.size === want.size) return
  if (Array.isArray(node)) {
    for (const x of node) takePinned(x, want, found)
    return
  }
  if (Array.isArray(node.pinnedPosts)) {
    for (const item of node.pinnedPosts) {
      const post = postFromPinned(item)
      const key = post?.slug.toLowerCase()
      if (post && key && want.has(key) && !found.has(key)) found.set(key, post)
    }
  }
  for (const v of Object.values(node)) if (v && typeof v === 'object') takePinned(v, want, found)
}

/**
 * Posts a saved lesson links to, read back from that lesson's page when the
 * community archive does not have them yet. `want` is lesson id -> post slugs.
 */
export function savedPinnedPosts(dir: string, want: { id: string; posts: string[] }[]): Post[] {
  const slugs = new Set<string>()
  const ids = new Set<string>()
  for (const lesson of want) {
    if (!lesson.posts.length) continue
    ids.add(lesson.id.toLowerCase())
    for (const s of lesson.posts) slugs.add(s.toLowerCase())
  }
  if (!slugs.size) return []
  const files = lessonFiles(dir)
  const found = new Map<string, Post>()
  for (const id of ids) {
    if (found.size === slugs.size) break
    const file = files.get(id)
    if (!file) continue
    let text = ''
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    if (!text.includes('"pinnedPosts"')) continue
    try {
      takePinned(JSON.parse(text), slugs, found)
    } catch {
      /* a half-written page */
    }
  }
  return [...found.values()]
}

function rawStamp(dir: string): string {
  const root = join(dir, 'raw', 'classroom')
  if (!existsSync(root)) return '0'
  let n = 0
  let bytes = 0
  let newest = 0
  const walk = (folder: string) => {
    for (const name of readdirSync(folder)) {
      const p = join(folder, name)
      const st = statSync(p)
      if (st.isDirectory()) walk(p)
      else {
        n++
        bytes += st.size
        if (st.mtimeMs > newest) newest = st.mtimeMs
      }
    }
  }
  walk(root)
  return `${n}:${bytes}:${newest}`
}

function copyPost(p: Post): Post {
  return {
    ...p,
    author: { ...p.author },
    images: p.images.slice(),
    videos: p.videos.map((v) => ({ ...v })),
    attachments: p.attachments.map((a) => ({ ...a })),
    comments: []
  }
}

const pinCache = new Map<string, { stamp: string; key: string; posts: Post[] }>()

/**
 * Community object the viewer should see. Posts pinned on a lesson are already
 * in that lesson's saved page; they are added here until a download stores them
 * in the community file. Nothing is written.
 */
export function withLessonPosts(dir: string, classroom: ClassroomArchive, community: CommunityArchive): CommunityArchive {
  const posts = community.posts || []
  const have = new Set<string>()
  for (const p of posts) {
    if (p.slug) have.add(p.slug.toLowerCase())
    if (p.id) have.add(p.id.toLowerCase())
  }
  const want = missingLessonPins(classroom, have)
  if (!want.length) return community
  const key = want.map((w) => w.id + '=' + w.posts.join(',')).join('|')
  const stamp = rawStamp(dir)
  let hit = pinCache.get(dir)
  if (!hit || hit.stamp !== stamp || hit.key !== key) {
    hit = { stamp, key, posts: savedPinnedPosts(dir, want) }
    pinCache.set(dir, hit)
  }
  const extra = hit.posts.filter((p) => !have.has(p.slug.toLowerCase()) && !have.has(p.id.toLowerCase()))
  if (!extra.length) return community
  return { categories: community.categories, posts: posts.concat(extra.map(copyPost)) }
}

/** Lesson id + the post slugs it shows, for ones the community file does not already contain. */
export function missingLessonPins(classroom: ClassroomArchive, have: Set<string>): { id: string; posts: string[] }[] {
  const out: { id: string; posts: string[] }[] = []
  const walk = (items: { type?: string; id?: string; posts?: string[]; items?: any[] }[]) => {
    for (const it of items || []) {
      if (it.type === 'set') walk(it.items || [])
      else if (it.posts?.length) {
        const posts = it.posts.filter((s) => !have.has(s.toLowerCase()))
        if (posts.length && it.id) out.push({ id: it.id, posts })
      }
    }
  }
  for (const c of classroom.courses) walk(c.items)
  return out
}
