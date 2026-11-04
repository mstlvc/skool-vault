import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { resolveSkoolHref } from '../../../shared/links'
import type { Attachment, Course, Person, Post, VideoRef } from '../../../shared/types'
import { API, embedPosts, go, initials, media, rewriteHtml } from './lib'

// ---------------------------------------------------------------- icons
const P = (d: string) => <path d={d} />
const ICONS: Record<string, ReactNode> = {
  like: P('M7 10v11M2 11v9a1 1 0 0 0 1 1h14.3a2 2 0 0 0 2-1.6l1.4-7A2 2 0 0 0 18.7 10H14V5a3 3 0 0 0-3-3l-4 8'),
  comment: P('M21 12a8 8 0 0 1-11.6 7.1L3 21l1.9-6.4A8 8 0 1 1 21 12z'),
  pin: P('M12 17v5M9 3h6l-1 6 4 3v2H6v-2l4-3z'),
  file: P('M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6'),
  link: P('M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1'),
  check: P('M5 12l5 5 9-10'),
  chevron: P('M9 6l6 6-6 6'),
  down: P('M6 9l6 6 6-6'),
  search: P('M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM21 21l-4.3-4.3'),
  close: P('M6 6l12 12M18 6L6 18'),
  left: P('M15 18l-6-6 6-6'),
  right: P('M9 6l6 6-6 6'),
  moon: P('M21 13A9 9 0 1 1 11 3a7 7 0 0 0 10 10z'),
  sun: P('M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4'),
  play: P('M7 4l13 8-13 8z'),
  download: P('M12 3v12M7 10l5 5 5-5M5 21h14'),
  external: P('M14 4h6v6M10 14L20 4M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5'),
  users: P('M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8'),
  book: P('M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5zM4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5'),
  home: P('M3 11l9-8 9 8M5 10v10h14V10'),
  lock: P('M6 11h12v10H6zM8 11V7a4 4 0 0 1 8 0v4')
}
export function Icon({ name, size = 18, className = '' }: { name: string; size?: number; className?: string }) {
  return (
    <svg className={'icon ' + className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {ICONS[name]}
    </svg>
  )
}

// ---------------------------------------------------------------- avatar
const hue = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7)
export function Avatar({ slug, person, size = 40 }: { slug: string; person?: Person | null; size?: number }) {
  const [broken, setBroken] = useState(false)
  const name = person?.name || '?'
  const style = { width: size, height: size, fontSize: size * 0.38 }
  if (person?.avatar && !broken)
    return <img className="avatar" style={style} src={media(slug, person.avatar)} alt={name} onError={() => setBroken(true)} loading="lazy" />
  return (
    <span className="avatar avatar-fallback" style={{ ...style, background: `hsl(${hue(name)} 45% 55%)` }}>
      {initials(name)}
    </span>
  )
}

// ---------------------------------------------------------------- lightbox
type LB = (images: string[], index: number) => void
const LightboxCtx = createContext<LB>(() => {})
export const useLightbox = () => useContext(LightboxCtx)

export function LightboxProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{ images: string[]; i: number } | null>(null)
  const open = useCallback<LB>((images, i) => setState({ images, i }), [])
  useEffect(() => {
    if (!state) return
    const on = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setState(null)
      if (e.key === 'ArrowRight') setState((s) => s && { ...s, i: (s.i + 1) % s.images.length })
      if (e.key === 'ArrowLeft') setState((s) => s && { ...s, i: (s.i - 1 + s.images.length) % s.images.length })
    }
    addEventListener('keydown', on)
    return () => removeEventListener('keydown', on)
  }, [state])
  return (
    <LightboxCtx.Provider value={open}>
      {children}
      {state && (
        <div className="lightbox" onClick={() => setState(null)}>
          <img src={state.images[state.i]} alt="" onClick={(e) => e.stopPropagation()} />
          <button className="lb-close" aria-label="Close">
            <Icon name="close" size={22} />
          </button>
          {state.images.length > 1 && (
            <>
              <button className="lb-nav lb-prev" aria-label="Previous" onClick={(e) => (e.stopPropagation(), setState({ ...state, i: (state.i - 1 + state.images.length) % state.images.length }))}>
                <Icon name="left" size={26} />
              </button>
              <button className="lb-nav lb-next" aria-label="Next" onClick={(e) => (e.stopPropagation(), setState({ ...state, i: (state.i + 1) % state.images.length }))}>
                <Icon name="right" size={26} />
              </button>
              <div className="lb-count">
                {state.i + 1} / {state.images.length}
              </div>
            </>
          )}
        </div>
      )}
    </LightboxCtx.Provider>
  )
}

// ---------------------------------------------------------------- rich html
export function Rich({
  slug, html, className = '', posts, courses
}: {
  slug: string
  html: string
  className?: string
  posts?: Post[]
  courses?: Course[]
}) {
  const lightbox = useLightbox()
  const out = useMemo(
    () => embedPosts(rewriteHtml(slug, html || ''), slug, posts || [], courses || []),
    [slug, html, posts, courses]
  )
  const onClick = (e: React.MouseEvent) => {
    const t = e.target as HTMLElement
    const embed = t.closest('[data-post]') as HTMLElement | null
    if (embed) return go(`g/${slug}/post/${embed.dataset.post}`)
    if (t.tagName === 'IMG') {
      const imgs = [...(e.currentTarget as HTMLElement).querySelectorAll('img')].map((i) => i.src)
      lightbox(imgs, imgs.indexOf((t as HTMLImageElement).src))
    }
  }
  if (!html) return null
  return <div className={'rich ' + className} onClick={onClick} dangerouslySetInnerHTML={{ __html: out }} />
}

export function ImageGrid({ slug, images }: { slug: string; images: string[] }) {
  const lightbox = useLightbox()
  if (!images.length) return null
  const urls = images.map((i) => media(slug, i))
  return (
    <div className={`image-grid n${Math.min(urls.length, 4)}`}>
      {urls.slice(0, 4).map((u, i) => (
        <button key={u} className="image-cell" onClick={() => lightbox(urls, i)}>
          <img src={u} alt="" loading="lazy" />
          {i === 3 && urls.length > 4 && <span className="more">+{urls.length - 4}</span>}
        </button>
      ))}
    </div>
  )
}

export function Attachments({ slug, items, posts, courses }: { slug: string; items: Attachment[]; posts?: Post[]; courses?: Course[] }) {
  if (!items.length) return null
  return (
    <div className="attachments">
      {items.map((a, i) => {
        const local = a.file ? media(slug, a.file) : null
        const jumped = !local && a.href ? resolveSkoolHref(a.href, slug, posts || [], courses || []) : null
        const href = local || jumped?.hash || a.href || undefined
        return (
          <a key={i} className="attachment" href={href} target={local || jumped ? undefined : '_blank'} rel={local || jumped ? undefined : 'noopener'} download={local ? '' : undefined}>
            <Icon name={a.file ? 'file' : 'link'} />
            <span className="att-name">{a.name}</span>
            {local ? <Icon name="download" size={16} className="muted" /> : jumped ? null : <Icon name="external" size={16} className="muted" />}
          </a>
        )
      })}
    </div>
  )
}

// ---------------------------------------------------------------- video
const SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2]

export function VideoPlayer({ slug, video, storeKey, onEnded }: { slug: string; video: VideoRef; storeKey: string; onEnded?: () => void }) {
  const ref = useRef<HTMLVideoElement>(null)
  const [speed, setSpeed] = useState(() => Number(localStorage.getItem('sv:speed')) || 1)
  const posKey = `sv:pos:${slug}:${storeKey}`

  useEffect(() => {
    if (ref.current) ref.current.playbackRate = speed
    localStorage.setItem('sv:speed', String(speed))
  }, [speed, video.file])

  if (!video.file) {
    return (
      <div className="video-missing">
        {video.thumb && <img src={media(slug, video.thumb)} alt="" />}
        <div className="video-missing-body">
          <Icon name="play" size={28} />
          <div>This video wasn't downloaded{video.error ? ` (${video.error})` : ''}.</div>
          {/^https?:/.test(video.source) && !/stream\.mux\.com/.test(video.source) && (
            <a href={video.source} target="_blank" rel="noopener">
              Open original <Icon name="external" size={14} />
            </a>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="video-wrap">
      <video
        key={video.file}
        ref={ref}
        className="video"
        src={media(slug, video.file)}
        poster={video.thumb ? media(slug, video.thumb) : undefined}
        controls
        crossOrigin={API ? 'anonymous' : undefined}
        preload="metadata"
        playsInline
        onLoadedMetadata={(e) => {
          const v = e.currentTarget
          v.playbackRate = speed
          const t = Number(localStorage.getItem(posKey))
          if (t > 5 && t < v.duration - 5) v.currentTime = t
        }}
        onTimeUpdate={(e) => {
          const v = e.currentTarget
          if (Math.floor(v.currentTime) % 3 === 0) localStorage.setItem(posKey, String(v.currentTime))
        }}
        onEnded={() => {
          localStorage.removeItem(posKey)
          onEnded?.()
        }}
      >
        {video.captions && <track kind="subtitles" src={media(slug, video.captions)} srcLang="en" label="English" />}
      </video>
      <div className="video-bar">
        <span className="muted small">Speed</span>
        {SPEEDS.map((s) => (
          <button key={s} className={'chip small' + (s === speed ? ' active' : '')} onClick={() => setSpeed(s)}>
            {s}×
          </button>
        ))}
        <span className="spacer" />
        <a className="chip small" href={media(slug, video.file)} download>
          <Icon name="download" size={14} /> MP4
        </a>
      </div>
    </div>
  )
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-title">{title}</div>
      {children && <div className="muted">{children}</div>}
    </div>
  )
}
