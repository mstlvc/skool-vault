// Turn saved skool.com links into viewer routes when the target was downloaded.
import type { Course, Lesson, Post } from './types'

const RESERVED = new Set([
  'classroom', 'about', 'members', 'leaderboards', 'calendar', 'map', 'settings', '-', 'admin', 'chat', 'notifications'
])

export interface LocalLink {
  hash: string
  /** Set when the link opens a downloaded community post. */
  postId?: string
}

const lessonsOf = (course: Course): Lesson[] => course.items.flatMap((i) => (i.type === 'set' ? i.items : [i]))

const decodeHref = (href: string) =>
  href.replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;/g, "'").replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')

/**
 * A same-group link to a downloaded lesson, course, post, or the about page.
 * Other communities, profiles, and pages we don't archive stay null so they keep opening Skool.
 */
export function resolveSkoolHref(
  href: string,
  slug: string,
  posts: Pick<Post, 'id' | 'slug'>[],
  courses: Course[]
): LocalLink | null {
  let url: URL
  try {
    url = new URL(decodeHref(href))
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (!/(^|\.)skool\.com$/i.test(url.hostname)) return null
  const parts = url.pathname.split('/').filter(Boolean).map((p) => {
    try {
      return decodeURIComponent(p)
    } catch {
      return p
    }
  })
  if (!parts.length || parts[0].toLowerCase() !== slug.toLowerCase()) return null

  const home = `#/g/${slug}`
  const rest = parts.slice(1)
  if (!rest.length) return { hash: home }

  const head = rest[0].toLowerCase()
  if (head === 'classroom') {
    if (rest.length < 2) return { hash: `${home}/classroom` }
    const key = rest[1].toLowerCase()
    const course = courses.find((c) => c.slug.toLowerCase() === key || c.id.toLowerCase() === key)
    if (!course) return null
    const md = url.searchParams.get('md')
    if (md) {
      const lesson = lessonsOf(course).find((l) => l.id.toLowerCase() === md.toLowerCase())
      if (!lesson) return null
      return { hash: `${home}/classroom/${course.id}/${lesson.id}` }
    }
    return { hash: `${home}/classroom/${course.id}` }
  }
  if (head === 'about') return { hash: `${home}/about` }
  if (RESERVED.has(head) || rest.length !== 1) return null
  const post = posts.find((p) => p.slug.toLowerCase() === head || p.id.toLowerCase() === head)
  if (!post) return null
  return { hash: `${home}/post/${post.id}`, postId: post.id }
}

const hrefOf = (attrs: string) => {
  const m = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attrs)
  return m ? m[1] ?? m[2] : null
}

/** Drop the new-tab attributes so an in-app hash link is not handed to the system browser. */
const internalAnchor = (attrs: string, hash: string) => {
  let next = attrs.replace(/\s+target\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '').replace(/\s+rel\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
  if (/\bhref\s*=/i.test(next)) next = next.replace(/\bhref\s*=\s*(?:"[^"]*"|'[^']*')/i, `href="${hash}"`)
  else next += ` href="${hash}"`
  return `<a${next}>`
}

/**
 * Rewrite same-group links. `card` replaces a paragraph that is only a link to a downloaded post.
 * Anything that does not resolve is left unchanged, including its target="_blank".
 */
export function localizeHtml(html: string, slug: string, posts: Post[], courses: Course[], card: (postId: string) => string): string {
  html = html.replace(/<p>(\s*)<a\b([^>]*)>([\s\S]*?)<\/a>(\s*)<\/p>/gi, (m, _pre, attrs, inner) => {
    if (/<[a-z]/i.test(inner)) return m
    const href = hrefOf(attrs)
    if (!href) return m
    const target = resolveSkoolHref(href, slug, posts, courses)
    return target?.postId ? card(target.postId) : m
  })
  return html.replace(/<a\b([^>]*)>/gi, (m, attrs) => {
    const href = hrefOf(attrs)
    if (!href) return m
    const target = resolveSkoolHref(href, slug, posts, courses)
    return target ? internalAnchor(attrs, target.hash) : m
  })
}
