import { useEffect, useState } from 'react'
import type { GroupArchive } from '../../../shared/types'
import { Classroom } from './Classroom'
import { Community } from './Community'
import { go, lessonsOf, media, useGroup, useLibrary, useRoute, useStored } from './lib'
import { Empty, Icon, LightboxProvider } from './ui'
import { inAppWindow, WindowControls } from '../common/WindowControls'

/** Double-clicking empty title bar space maximizes, like a normal window. */
const maximizeOnDoubleClick = (e: React.MouseEvent) => {
  if (!(e.target as HTMLElement).closest('button, a, input')) window.appWindow?.toggleMaximize()
}

export function App() {
  const route = useRoute()
  const [theme, setTheme] = useStored<'light' | 'dark'>('sv:theme', matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])
  // inside the app's own window there is no OS title bar: the top bar drags the window
  useEffect(() => {
    document.documentElement.classList.toggle('in-app', inAppWindow())
  }, [])
  const themeBtn = (
    <button className="icon-btn" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} title="Toggle dark mode">
      <Icon name={theme === 'dark' ? 'sun' : 'moon'} />
    </button>
  )
  return (
    <LightboxProvider>
      {route[0] === 'g' && route[1] ? <GroupView slug={route[1]} route={route.slice(2)} themeBtn={themeBtn} /> : <Home themeBtn={themeBtn} />}
      {inAppWindow() && (
        <div className="app-wc">
          <WindowControls />
        </div>
      )}
    </LightboxProvider>
  )
}

function Home({ themeBtn }: { themeBtn: React.ReactNode }) {
  const { lib, err } = useLibrary()
  useEffect(() => {
    if (lib?.length === 1) go(`g/${lib[0].slug}`)
  }, [lib])
  return (
    <>
      {/* no top bar here: just the communities and a theme button in the corner */}
      <div className="home-drag" onDoubleClick={maximizeOnDoubleClick} />
      <div className="home-corner">{themeBtn}</div>
      <main className="page home-page">
        {err && <Empty title="Can't reach the Skool Vault app">Make sure the app is running. ({err})</Empty>}
        {lib && !lib.length && <Empty title="Nothing downloaded yet">Use the Skool Vault app to download a community.</Empty>}
        <div className="course-grid">
          {lib?.map((g) => (
            <button key={g.slug} className="card course-card" onClick={() => go(`g/${g.slug}`)}>
              <div className="course-cover">{g.cover ? <img src={media(g.slug, g.cover)} alt="" /> : <div className="cover-fallback">{g.name}</div>}</div>
              <div className="course-info">
                <h3>{g.name}</h3>
                <div className="muted small">
                  {g.courses} courses · {g.lessons} lessons · {g.posts} posts · {g.videos} videos
                </div>
              </div>
            </button>
          ))}
        </div>
      </main>
    </>
  )
}

function GroupView({ slug, route, themeBtn }: { slug: string; route: string[]; themeBtn: React.ReactNode }) {
  const { g, err } = useGroup(slug)
  const { lib } = useLibrary()
  const [query, setQuery] = useState('')
  const [switcher, setSwitcher] = useState(false)
  const tab = route[0] === 'classroom' ? 'classroom' : route[0] === 'about' ? 'about' : 'community'
  useEffect(() => setQuery(''), [tab])
  useEffect(() => {
    if (g) document.title = `${tab[0].toUpperCase() + tab.slice(1)} · ${g.group.name}`
  }, [g, tab])

  if (err) return <Empty title="Couldn't load this community">{err}</Empty>
  if (!g) return <div className="loading">Loading…</div>

  return (
    <>
      <header className="topbar" onDoubleClick={maximizeOnDoubleClick}>
        <div className="topbar-inner">
          <button className="group-switch" onClick={() => setSwitcher(!switcher)}>
            {g.group.logo ? <img className="group-logo" src={media(slug, g.group.logo)} alt="" /> : <span className="brand-mark">{g.group.name[0]}</span>}
            <span className="group-name">{g.group.name}</span>
            {(lib?.length || 0) > 1 && <Icon name="down" size={16} />}
          </button>
          {switcher && (lib?.length || 0) > 1 && (
            <div className="dropdown" onMouseLeave={() => setSwitcher(false)}>
              {lib!.map((x) => (
                <button key={x.slug} onClick={() => (setSwitcher(false), go(`g/${x.slug}`))}>
                  {x.logo ? <img src={media(x.slug, x.logo)} alt="" /> : <span className="brand-mark sm">{x.name[0]}</span>}
                  {x.name}
                </button>
              ))}
              <button onClick={() => go('')}>
                <Icon name="home" size={16} /> All communities
              </button>
            </div>
          )}
          <div className="search">
            <Icon name="search" size={16} />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={tab === 'classroom' ? 'Search lessons' : 'Search posts'} />
          </div>
          <span className="spacer" />
          {themeBtn}
        </div>
        <nav className="tabs">
          <a className={tab === 'community' ? 'active' : ''} href={`#/g/${slug}`}>
            Community
          </a>
          <a className={tab === 'classroom' ? 'active' : ''} href={`#/g/${slug}/classroom`}>
            Classroom
          </a>
          <a className={tab === 'about' ? 'active' : ''} href={`#/g/${slug}/about`}>
            About
          </a>
        </nav>
      </header>
      <main className="page">
        {tab === 'community' && <Community data={g} postId={route[0] === 'post' ? route[1] : undefined} query={query} />}
        {tab === 'classroom' && <Classroom data={g} courseId={route[1]} lessonId={route[2]} query={query} />}
        {tab === 'about' && <About data={g} />}
      </main>
    </>
  )
}

export function GroupSidebar({ data }: { data: GroupArchive }) {
  const { group, classroom, community } = data
  const lessons = classroom.courses.flatMap((c) => lessonsOf(c.items)).length
  return (
    <aside className="card group-card">
      {group.cover && <img className="group-cover" src={media(group.slug, group.cover)} alt="" />}
      <div className="group-card-body">
        <h3>{group.name}</h3>
        <div className="muted small">skool.com/{group.slug}</div>
        {group.description && <p className="group-desc">{group.description}</p>}
        <div className="stats">
          <div>
            <b>{community.posts.length}</b>
            <span>Posts</span>
          </div>
          <div>
            <b>{classroom.courses.length}</b>
            <span>Courses</span>
          </div>
          <div>
            <b>{lessons}</b>
            <span>Lessons</span>
          </div>
        </div>
        <div className="archived muted small">Archived {new Date(group.updatedAt).toLocaleDateString()}</div>
      </div>
    </aside>
  )
}

function About({ data }: { data: GroupArchive }) {
  const { group } = data
  return (
    <div className="layout-2col">
      <div className="card about">
        <h1>{group.name}</h1>
        {group.cover && <img className="about-cover" src={media(group.slug, group.cover)} alt="" />}
        <p className="about-desc">{group.description}</p>
        <div className="muted small">
          {group.memberCount ? `${group.memberCount.toLocaleString()} members · ` : ''}
          Original: <a href={group.url} target="_blank" rel="noopener">{group.url}</a>
        </div>
      </div>
      <GroupSidebar data={data} />
    </div>
  )
}
