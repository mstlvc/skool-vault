import { useEffect, useState } from 'react'
import { localizeHtml } from '../../../shared/links'
import type { Course, GroupArchive, LibraryEntry, Lesson, Post, Section } from '../../../shared/types'

// In dev the viewer runs on the vite server and talks to the app's server via ?server=
export const API = new URLSearchParams(location.search).get('server') || ''

export const media = (slug: string, p?: string | null) =>
  !p ? '' : /^(https?:|data:|blob:)/.test(p) ? p : `${API}/archive/${encodeURIComponent(slug)}/${p.split('/').map(encodeURIComponent).join('/')}`

/** Point relative src/href attributes in archived HTML at the archive. */
export const rewriteHtml = (slug: string, html: string) =>
  html.replace(/\s(src|href)="(?!https?:|data:|mailto:|#)([^"]+)"/g, (_, a, p) => ` ${a}="${media(slug, p.replace(/&amp;/g, '&'))}"`)

const escHtml = (s: any) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

/** Same-group links open the downloaded lesson, course, or post. A paragraph that is only a post link becomes a card. */
export function embedPosts(html: string, slug: string, posts: Post[], courses: Course[] = []) {
  const card = (postId: string) => {
    const p = posts.find((x) => x.id === postId)
    if (!p) return ''
    const av = p.author.avatar ? `<img class="avatar" src="${escHtml(media(slug, p.author.avatar))}" width="36" height="36" alt="">` : ''
    return `<div class="post-embed" data-post="${escHtml(p.id)}">
      <div class="post-head">${av}<div><div class="author">${escHtml(p.author.name)}</div><div class="meta">${escHtml(timeAgo(p.createdAt))}</div></div></div>
      <div class="pe-title">${escHtml(p.title)}</div>
      <div class="pe-text">${escHtml(p.text.slice(0, 300))}</div>
      <div class="post-foot"><span>👍 ${p.upvotes}</span><span>💬 ${p.commentCount}</span>${p.attachments.length ? `<span>📎 ${p.attachments.length}</span>` : ''}</div>
    </div>`
  }
  return localizeHtml(html, slug, posts, courses, card)
}

export async function getJson<T>(path: string): Promise<T> {
  const r = await fetch(API + path)
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return r.json()
}

export function useLibrary() {
  const [lib, setLib] = useState<LibraryEntry[] | null>(null)
  const [err, setErr] = useState('')
  useEffect(() => {
    getJson<LibraryEntry[]>('/api/library').then(setLib, (e) => setErr(e.message))
  }, [])
  return { lib, err }
}

const groupCache = new Map<string, GroupArchive>()
export function useGroup(slug?: string) {
  const [g, setG] = useState<GroupArchive | null>(slug ? groupCache.get(slug) || null : null)
  const [err, setErr] = useState('')
  useEffect(() => {
    if (!slug) return
    if (groupCache.has(slug)) return setG(groupCache.get(slug)!)
    setG(null)
    getJson<GroupArchive>(`/api/group/${encodeURIComponent(slug)}`).then(
      (d) => {
        groupCache.set(slug, d)
        setG(d)
      },
      (e) => setErr(e.message)
    )
  }, [slug])
  return { g, err }
}

// ---- hash router
export function useRoute(): string[] {
  const read = () => decodeURI(location.hash.replace(/^#\/?/, '')).split('/').filter(Boolean)
  const [r, setR] = useState(read)
  useEffect(() => {
    const on = () => {
      setR(read())
    }
    addEventListener('hashchange', on)
    return () => removeEventListener('hashchange', on)
  }, [])
  return r
}
export const go = (path: string) => {
  location.hash = '#/' + path.replace(/^\//, '')
}

// ---- persistent local state (progress, completion, theme)
export function useStored<T>(key: string, initial: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    try {
      const s = localStorage.getItem(key)
      return s ? JSON.parse(s) : initial
    } catch {
      return initial
    }
  })
  const set = (nv: T) => {
    setV(nv)
    localStorage.setItem(key, JSON.stringify(nv))
  }
  return [v, set]
}

export const lessonsOf = (items: (Section | Lesson)[]): Lesson[] => items.flatMap((i) => (i.type === 'set' ? i.items : [i]))

export function timeAgo(iso?: string) {
  if (!iso) return ''
  const d = new Date(iso)
  const s = (Date.now() - d.getTime()) / 1000
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d`
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' })
}

export const fmtDuration = (ms?: number | null) => {
  if (!ms) return ''
  const s = Math.round(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`
}

export const initials = (name: string) =>
  name
    .split(/\s+/)
    .map((w) => w[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase()
