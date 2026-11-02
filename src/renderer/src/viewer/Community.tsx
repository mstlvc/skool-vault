import { useEffect, useMemo, useRef, useState } from 'react'
import type { Comment, GroupArchive, Post } from '../../../shared/types'
import { go, media, timeAgo } from './lib'
import { Attachments, Avatar, Empty, Icon, ImageGrid, Rich, VideoPlayer } from './ui'
import { GroupSidebar } from './Shell'

const PAGE = 25

export function Community({ data, postId, query }: { data: GroupArchive; postId?: string; query: string }) {
  const slug = data.group.slug
  const { posts, categories } = data.community
  const [cat, setCat] = useState<string>('')
  const [sort, setSort] = useState<'default' | 'new' | 'top'>('default')
  const [shown, setShown] = useState(PAGE)
  const sentinel = useRef<HTMLDivElement>(null)
  const catName = useMemo(() => new Map(categories.map((c) => [c.id, c.name])), [categories])

  const list = useMemo(() => {
    const q = query.trim().toLowerCase()
    let l = posts.filter((p) => (!cat || p.category === cat) && (!q || `${p.title} ${p.text} ${p.author.name}`.toLowerCase().includes(q)))
    if (sort === 'new') l = [...l].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    if (sort === 'top') l = [...l].sort((a, b) => b.upvotes - a.upvotes)
    return l
  }, [posts, cat, sort, query])

  useEffect(() => setShown(PAGE), [cat, sort, query])
  useEffect(() => {
    const el = sentinel.current
    if (!el) return
    const io = new IntersectionObserver((e) => e[0].isIntersecting && setShown((n) => n + PAGE), { rootMargin: '600px' })
    io.observe(el)
    return () => io.disconnect()
  }, [list.length])

  const open = posts.find((p) => p.id === postId || p.slug === postId)

  return (
    <div className="layout-2col">
      <div className="feed">
        {!posts.length ? (
          <Empty title="No community posts in this archive">Download the community from Skool Vault to see posts here.</Empty>
        ) : (
          <>
            <div className="feed-filters">
              <div className="chips">
                <button className={'chip' + (!cat ? ' active' : '')} onClick={() => setCat('')}>
                  All
                </button>
                {categories.map((c) => (
                  <button key={c.id} className={'chip' + (cat === c.id ? ' active' : '')} onClick={() => setCat(c.id)}>
                    {c.name}
                  </button>
                ))}
              </div>
              <select className="select" value={sort} onChange={(e) => setSort(e.target.value as any)}>
                <option value="default">Default</option>
                <option value="new">Newest</option>
                <option value="top">Top</option>
              </select>
            </div>
            {list.slice(0, shown).map((p) => (
              <PostCard key={p.id} slug={slug} post={p} category={catName.get(p.category || '')} />
            ))}
            {!list.length && <Empty title="No posts match" />}
            <div ref={sentinel} />
          </>
        )}
      </div>
      <GroupSidebar data={data} />
      {open && <PostModal slug={slug} post={open} posts={posts} category={catName.get(open.category || '')} />}
    </div>
  )
}

function PostCard({ slug, post, category }: { slug: string; post: Post; category?: string }) {
  const thumb = post.images[0] || post.videos[0]?.thumb
  return (
    <article className={'card post-card' + (post.pinned ? ' pinned' : '')} onClick={() => go(`g/${slug}/post/${post.id}`)}>
      <div className="post-head">
        <Avatar slug={slug} person={post.author} size={40} />
        <div>
          <div className="author">{post.author.name}</div>
          <div className="meta">
            {timeAgo(post.createdAt)}
            {category && <> · <span className="cat">{category}</span></>}
          </div>
        </div>
        {post.pinned && (
          <span className="pin-badge">
            <Icon name="pin" size={14} /> Pinned
          </span>
        )}
      </div>
      <div className="post-body">
        <div className="post-text">
          <h3 className="post-title">{post.title}</h3>
          <p className="post-preview">{post.text}</p>
        </div>
        {thumb && (
          <div className="post-thumb">
            <img src={media(slug, thumb)} alt="" loading="lazy" />
            {!post.images[0] && <Icon name="play" size={22} className="thumb-play" />}
          </div>
        )}
      </div>
      <div className="post-foot">
        <span>
          <Icon name="like" size={16} /> {post.upvotes}
        </span>
        <span>
          <Icon name="comment" size={16} /> {post.commentCount}
        </span>
        {post.attachments.length > 0 && (
          <span>
            <Icon name="file" size={16} /> {post.attachments.length}
          </span>
        )}
        <Commenters slug={slug} comments={post.comments} />
      </div>
    </article>
  )
}

/** Like Skool's card footer: the latest commenters' avatars and when the last comment was. */
function Commenters({ slug, comments }: { slug: string; comments: Comment[] }) {
  const { people, last } = useMemo(() => {
    const all: Comment[] = []
    const walk = (cs: Comment[]) => cs.forEach((c) => (all.push(c), walk(c.replies)))
    walk(comments)
    all.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    const seen = new Set<string>()
    const people = all.filter((c) => !seen.has(c.author.id || c.author.name) && seen.add(c.author.id || c.author.name)).slice(0, 5)
    return { people, last: all[0]?.createdAt }
  }, [comments])
  if (!people.length) return null
  return (
    <span className="commenters">
      <span className="commenter-avatars">
        {people.map((c) => (
          <Avatar key={c.id} slug={slug} person={c.author} size={24} />
        ))}
      </span>
      {last && <span className="last-comment">Last comment {timeAgo(last)} ago</span>}
    </span>
  )
}

function PostModal({ slug, post, posts, category }: { slug: string; post: Post; posts: Post[]; category?: string }) {
  // return to wherever the post was opened from (feed or a lesson)
  const close = () => (history.length > 1 ? history.back() : go(`g/${slug}`))
  useEffect(() => {
    const on = (e: KeyboardEvent) => e.key === 'Escape' && !document.querySelector('.lightbox') && close()
    addEventListener('keydown', on)
    document.body.style.overflow = 'hidden'
    return () => {
      removeEventListener('keydown', on)
      document.body.style.overflow = ''
    }
  }, [])
  return (
    <div className="modal-backdrop" onClick={close}>
      <div className="modal card" onClick={(e) => e.stopPropagation()} role="dialog">
        <button className="modal-close" onClick={close} aria-label="Close">
          <Icon name="close" />
        </button>
        <div className="post-head">
          <Avatar slug={slug} person={post.author} size={44} />
          <div>
            <div className="author">{post.author.name}</div>
            <div className="meta">
              {new Date(post.createdAt).toLocaleString()}
              {category && <> · <span className="cat">{category}</span></>}
            </div>
          </div>
        </div>
        <h2 className="modal-title">{post.title}</h2>
        <Rich slug={slug} html={post.html} posts={posts} />
        {post.videos.map((v, i) => (
          <div key={i} className="spaced">
            <VideoPlayer slug={slug} video={v} storeKey={`post-${post.id}-${i}`} />
          </div>
        ))}
        <ImageGrid slug={slug} images={post.images} />
        <Attachments slug={slug} items={post.attachments} />
        <div className="post-foot big">
          <span>
            <Icon name="like" size={18} /> {post.upvotes} likes
          </span>
          <span>
            <Icon name="comment" size={18} /> {post.commentCount} comments
          </span>
        </div>
        <div className="comments">
          {post.comments.map((c) => (
            <CommentView key={c.id} slug={slug} c={c} />
          ))}
          {!post.comments.length && post.commentCount > 0 && (
            <div className="muted small">Comments weren't included in this download.</div>
          )}
        </div>
      </div>
    </div>
  )
}

function CommentView({ slug, c, depth = 0 }: { slug: string; c: Comment; depth?: number }) {
  return (
    <div className="comment">
      <Avatar slug={slug} person={c.author} size={depth ? 28 : 34} />
      <div className="comment-main">
        <div className="bubble">
          <div className="comment-head">
            <span className="author">{c.author.name}</span>
            <span className="meta"> · {timeAgo(c.createdAt)}</span>
          </div>
          <Rich slug={slug} html={c.html} className="compact" />
          <ImageGrid slug={slug} images={c.images} />
          <Attachments slug={slug} items={c.attachments} />
        </div>
        {c.upvotes > 0 && (
          <div className="comment-likes">
            <Icon name="like" size={13} /> {c.upvotes}
          </div>
        )}
        {c.replies.map((r) => (
          <CommentView key={r.id} slug={slug} c={r} depth={depth + 1} />
        ))}
      </div>
    </div>
  )
}
