import { useEffect, useMemo, useState } from 'react'
import type { Course, GroupArchive, Lesson, Post, Section } from '../../../shared/types'
import { fmtDuration, go, lessonsOf, media, timeAgo, useStored } from './lib'
import { Attachments, Avatar, Empty, Icon, Rich, VideoPlayer } from './ui'

/** A community post attached to a lesson, shown as a card like on Skool. */
function PostEmbed({ slug, post, category }: { slug: string; post: Post; category?: string }) {
  const thumb = post.images[0] || post.videos[0]?.thumb
  return (
    <div className={'post-embed' + (thumb ? ' has-thumb' : '')} onClick={() => go(`g/${slug}/post/${post.id}`)}>
      <div>
        <div className="post-head">
          <Avatar slug={slug} person={post.author} size={36} />
          <div>
            <div className="author">{post.author.name}</div>
            <div className="meta">
              {timeAgo(post.createdAt)}
              {category && <> · <span className="cat">{category}</span></>}
            </div>
          </div>
        </div>
        <div className="pe-title">{post.title}</div>
        <div className="pe-text">{post.text}</div>
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
        </div>
      </div>
      {thumb && (
        <div className="pe-thumb">
          <img src={media(slug, thumb)} alt="" loading="lazy" />
          {!post.images[0] && <Icon name="play" size={22} className="thumb-play" />}
        </div>
      )}
    </div>
  )
}

function useDone(slug: string) {
  const [done, setDone] = useStored<string[]>(`sv:done:${slug}`, [])
  const set = useMemo(() => new Set(done), [done])
  const toggle = (id: string, v?: boolean) => {
    const on = v ?? !set.has(id)
    setDone(on ? [...new Set([...done, id])] : done.filter((x) => x !== id))
  }
  return { isDone: (id: string) => set.has(id), toggle }
}

function Progress({ pct }: { pct: number }) {
  return (
    <div className="progress">
      <div className="progress-bar" style={{ width: `${pct}%` }} />
      <span className="progress-label">{Math.round(pct)}%</span>
    </div>
  )
}

export function Classroom({ data, courseId, lessonId, query }: { data: GroupArchive; courseId?: string; lessonId?: string; query: string }) {
  const course = data.classroom.courses.find((c) => c.id === courseId || c.slug === courseId)
  if (course) return <CourseView data={data} course={course} lessonId={lessonId} query={query} />
  return <CourseGrid data={data} query={query} />
}

function CourseGrid({ data, query }: { data: GroupArchive; query: string }) {
  const slug = data.group.slug
  const { isDone } = useDone(slug)
  const q = query.trim().toLowerCase()
  const courses = data.classroom.courses.filter(
    (c) => !q || c.title.toLowerCase().includes(q) || lessonsOf(c.items).some((l) => l.title.toLowerCase().includes(q))
  )
  if (!data.classroom.courses.length) return <Empty title="No courses in this archive">Download courses from Skool Vault to see them here.</Empty>
  return (
    <div className="course-grid">
      {courses.map((c) => {
        const lessons = lessonsOf(c.items)
        const pct = lessons.length ? (lessons.filter((l) => isDone(l.id)).length * 100) / lessons.length : 0
        return (
          <button key={c.id} className="card course-card" onClick={() => go(`g/${slug}/classroom/${c.id}`)}>
            <div className="course-cover">
              {c.cover ? <img src={media(slug, c.cover)} alt="" loading="lazy" /> : <div className="cover-fallback">{c.title}</div>}
            </div>
            <div className="course-info">
              <h3>{c.title}</h3>
              {c.desc && <p className="course-desc">{c.desc}</p>}
              <div className="course-count muted small">{lessons.length} lessons</div>
              <Progress pct={pct} />
            </div>
          </button>
        )
      })}
    </div>
  )
}

function CourseView({ data, course, lessonId, query }: { data: GroupArchive; course: Course; lessonId?: string; query: string }) {
  const slug = data.group.slug
  const lessons = lessonsOf(course.items)
  const { isDone, toggle } = useDone(slug)
  const [lastKey] = useState(`sv:last:${slug}:${course.id}`)
  const current = lessons.find((l) => l.id === lessonId) || lessons.find((l) => l.id === localStorage.getItem(lastKey)) || lessons[0]
  const idx = current ? lessons.indexOf(current) : -1
  const pct = lessons.length ? (lessons.filter((l) => isDone(l.id)).length * 100) / lessons.length : 0
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const q = query.trim().toLowerCase()

  useEffect(() => {
    if (current) localStorage.setItem(lastKey, current.id)
    document.querySelector('.lesson-pane')?.scrollTo({ top: 0 })
    window.scrollTo({ top: 0 })
  }, [current?.id])

  const open = (l: Lesson) => go(`g/${slug}/classroom/${course.id}/${l.id}`)
  const match = (l: Lesson) => !q || l.title.toLowerCase().includes(q)

  const row = (l: Lesson) =>
    match(l) && (
      <button key={l.id} className={'lesson-row' + (l.id === current?.id ? ' active' : '')} onClick={() => open(l)}>
        <span className="lesson-title">{l.title}</span>
        {l.video?.durationMs ? <span className="muted small">{fmtDuration(l.video.durationMs)}</span> : null}
        <span className={'check' + (isDone(l.id) ? ' on' : '')}>{isDone(l.id) && <Icon name="check" size={14} />}</span>
      </button>
    )

  return (
    <div className="course-layout">
      <aside className="card course-nav">
        <button className="back-link" onClick={() => go(`g/${slug}/classroom`)}>
          <Icon name="left" size={16} /> All courses
        </button>
        <h2 className="course-nav-title">{course.title}</h2>
        <Progress pct={pct} />
        <div className="lesson-list">
          {course.items.map((it) =>
            it.type === 'set' ? (
              <SectionBlock key={it.id} s={it} collapsed={!!collapsed[it.id] && !q} toggle={() => setCollapsed({ ...collapsed, [it.id]: !collapsed[it.id] })}>
                {it.items.map(row)}
              </SectionBlock>
            ) : (
              row(it)
            )
          )}
        </div>
      </aside>

      <section className="card lesson-pane">
        {!current ? (
          <Empty title="This course has no lessons" />
        ) : (
          <>
            <div className="lesson-header">
              <h1>{current.title}</h1>
              <label className="done-toggle">
                <input type="checkbox" checked={isDone(current.id)} onChange={() => toggle(current.id)} />
                <span>{isDone(current.id) ? 'Completed' : 'Mark as done'}</span>
              </label>
            </div>
            {current.video && (
              <VideoPlayer
                slug={slug}
                video={current.video}
                storeKey={current.id}
                onEnded={() => toggle(current.id, true)}
              />
            )}
            <Rich slug={slug} html={current.html} className="lesson-body" posts={data.community.posts} />
            {(current.posts || []).length > 0 && (
              <div className="lesson-posts">
                {current.posts!.map((s) => {
                  const p = data.community.posts.find((x) => x.slug === s || x.id === s)
                  return p ? (
                    <PostEmbed key={s} slug={slug} post={p} category={data.community.categories.find((c) => c.id === p.category)?.name} />
                  ) : (
                    <a key={s} className="attachment" href={`${data.group.url}/${s}`} target="_blank" rel="noopener">
                      <Icon name="external" /> <span className="att-name">Community post: {s}</span>
                    </a>
                  )
                })}
              </div>
            )}
            {current.resources.length > 0 && (
              <div className="resources">
                <h4>Resources</h4>
                <Attachments slug={slug} items={current.resources} />
              </div>
            )}
            <div className="lesson-nav">
              <button className="btn" disabled={idx <= 0} onClick={() => open(lessons[idx - 1])}>
                <Icon name="left" size={16} /> Previous
              </button>
              <button
                className="btn primary"
                disabled={idx >= lessons.length - 1}
                onClick={() => {
                  toggle(current.id, true)
                  open(lessons[idx + 1])
                }}
              >
                Next lesson <Icon name="right" size={16} />
              </button>
            </div>
          </>
        )}
      </section>
    </div>
  )
}

function SectionBlock({ s, collapsed, toggle, children }: { s: Section; collapsed: boolean; toggle: () => void; children: React.ReactNode }) {
  return (
    <div className="section">
      <button className="section-head" onClick={toggle}>
        <span>{s.title}</span>
        <Icon name="down" size={16} className={collapsed ? 'rot' : ''} />
      </button>
      {!collapsed && <div className="section-items">{children}</div>}
    </div>
  )
}
