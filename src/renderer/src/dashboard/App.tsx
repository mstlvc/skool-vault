import { useEffect, useMemo, useState } from 'react'
import type {
  Account, GroupArchive, JobState, Lesson, LibraryEntry, RemoteGroup, RemoteState, ScanResult, Section, Settings, Speed
} from '../../../shared/types'
import { Icon } from '../viewer/ui'
import { WindowControls } from '../common/WindowControls'
import { useTheme } from './theme'

const vault = window.vault
type Page = 'group' | 'library' | 'settings'

interface Community {
  slug: string
  name: string
  logo?: string | null
  saved?: LibraryEntry
}

const fileUrl = (port: number, slug: string, p?: string | null) =>
  !p ? '' : /^https?:/.test(p) ? p : `http://127.0.0.1:${port}/archive/${encodeURIComponent(slug)}/${p.split('/').map(encodeURIComponent).join('/')}`

const errText = (e: any) => String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
const fmtDate = (iso?: string) =>
  iso ? new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : ''
const lessonsOf = (items: (Section | Lesson)[]) => items.flatMap((i) => (i.type === 'set' ? i.items : [i]))
const lessonSaved = (l: Lesson) => (!l.video || !!l.video.file) && l.resources.every((r) => r.file || r.href)

/** The app mark: an archive box with a label slot, drawn in the current text color. */
function VaultMark({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" aria-hidden>
      <rect x="2.5" y="3" width="15" height="4" rx="0.75" />
      <path d="M3.75 7v8.5a1 1 0 0 0 1 1h10.5a1 1 0 0 0 1-1V7" />
      <path d="M8 10.25h4" strokeLinecap="round" />
    </svg>
  )
}

export function App() {
  const [account, setAccount] = useState<Account | null>(null)
  const [port, setPort] = useState(0)
  const [library, setLibrary] = useState<LibraryEntry[]>([])
  const [remote, setRemote] = useState<RemoteGroup[] | null>(null)
  const [remoteErr, setRemoteErr] = useState('')
  const [jobs, setJobs] = useState<Record<string, JobState>>({})
  const [page, setPage] = useState<Page>('group')
  const [selected, setSelected] = useState<string | null>(null)
  const [addOpen, setAddOpen] = useState(false)
  const [mode, toggleTheme] = useTheme()
  const [remoteShare, setRemoteShare] = useState<RemoteState>({ status: 'off' })

  const refreshLibrary = () => vault.library().then(setLibrary)
  useEffect(() => {
    vault.account().then(setAccount)
    vault.serverInfo().then((i) => setPort(i.port))
    vault.jobs().then((l) => setJobs(Object.fromEntries(l.map((j) => [j.id, j]))))
    refreshLibrary()
    vault.remote().then(setRemoteShare)
    const offRemote = vault.onRemote(setRemoteShare)
    const offJob = vault.onJob((s) => {
      setJobs((j) => ({ ...j, [s.id]: s }))
      if (s.status !== 'running') refreshLibrary()
    })
    return () => {
      offRemote()
      offJob()
    }
  }, [])
  useEffect(() => {
    if (!account?.loggedIn) return
    setRemoteErr('')
    vault.remoteGroups().then(setRemote, (e) => setRemoteErr(errText(e)))
  }, [account?.loggedIn])

  // communities from your Skool account and from the library, merged
  const communities = useMemo<Community[]>(() => {
    const map = new Map<string, Community>()
    for (const g of remote || []) map.set(g.slug, { slug: g.slug, name: g.name, logo: g.logo })
    for (const l of library) {
      const c = map.get(l.slug)
      map.set(l.slug, { slug: l.slug, name: c?.name || l.name, logo: c?.logo || fileUrl(port, l.slug, l.logo), saved: l })
    }
    return [...map.values()]
  }, [remote, library, port])

  useEffect(() => {
    if (!selected && communities.length) setSelected(communities[0].slug)
  }, [communities, selected])

  const latestJob = (slug: string) =>
    Object.values(jobs).filter((j) => j.slug === slug).sort((a, b) => b.startedAt - a.startedAt)[0]
  const current = communities.find((c) => c.slug === selected) || null
  const mac = window.appWindow?.platform === 'darwin'
  const go = (p: Page, slug?: string) => {
    if (slug) setSelected(slug)
    setPage(p)
  }

  return (
    <div className="flex h-full">
      {/* left: everything you navigate with */}
      <aside className="flex w-64 flex-none flex-col bg-base-200">
        <div className={`drag flex h-11 flex-none items-center gap-2 ${mac ? 'pl-20' : 'pl-5'}`} onDoubleClick={() => window.appWindow?.toggleMaximize()}>
          <VaultMark />
          <span className="label-type-sm text-[15px]">Skool Vault</span>
        </div>

        <ul className="menu w-full flex-1 flex-nowrap overflow-y-auto px-3 pt-2">
          <li className="menu-title flex-row items-center justify-between pr-1">
            <span>Communities</span>
            <button className="text-xs font-normal text-secondary hover:text-base-content" onClick={() => setAddOpen(true)}>
              Add
            </button>
          </li>
          {communities.map((c) => {
            const running = latestJob(c.slug)?.status === 'running'
            return (
              <li key={c.slug}>
                <button className={page === 'group' && selected === c.slug ? 'menu-active' : ''} onClick={() => go('group', c.slug)}>
                  <GroupLogo src={c.logo} name={c.name} size="w-5" />
                  <span className="truncate">{c.name}</span>
                  {running ? (
                    <span className="rec ml-auto" title="Downloading" />
                  ) : c.saved ? (
                    <span className="ml-auto opacity-60" title="Saved on this PC">
                      <Icon name="check" size={14} />
                    </span>
                  ) : null}
                </button>
              </li>
            )
          })}
          {account?.loggedIn && !remote && !remoteErr && (
            <li className="disabled">
              <span>
                <span className="loading loading-spinner loading-xs" /> Reading your communities
              </span>
            </li>
          )}
          {remoteErr && <li className="px-3 py-1 text-xs text-error">{remoteErr}</li>}

          <li className="mt-5">
            <button className={page === 'library' ? 'menu-active' : ''} onClick={() => go('library')}>
              <Icon name="book" size={16} /> Library
              {remoteShare.status === 'on' && (
                <span className="ml-auto flex items-center gap-1.5 text-xs text-success" title="A phone link is live">
                  <span className="h-1.5 w-1.5 rounded-full bg-success" /> sharing
                </span>
              )}
            </button>
          </li>
          <li>
            <button className={page === 'settings' ? 'menu-active' : ''} onClick={() => go('settings')}>
              <Icon name="users" size={16} /> Settings
            </button>
          </li>
        </ul>

        <div className="flex items-center gap-1 px-3 pb-3">
          <AccountBox account={account} setAccount={setAccount} />
          <button
            className="btn btn-ghost btn-sm btn-square flex-none"
            onClick={toggleTheme}
            title={mode === 'dark' ? 'Light theme' : 'Dark theme'}
            aria-label={mode === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
          >
            <Icon name={mode === 'dark' ? 'sun' : 'moon'} size={16} />
          </button>
        </div>
      </aside>

      {/* right: the selected page; its top strip doubles as the title bar */}
      <main className="flex min-w-0 flex-1 flex-col">
        <div className="drag flex h-11 flex-none justify-end" onDoubleClick={() => window.appWindow?.toggleMaximize()}>
          <WindowControls />
        </div>
        {page === 'library' && <LibraryPage library={library} port={port} remote={remoteShare} setRemote={setRemoteShare} open={(s) => go('group', s)} />}
        {page === 'settings' && <SettingsPage onSaved={() => vault.serverInfo().then((i) => setPort(i.port))} />}
        {page === 'group' &&
          (current ? (
            <GroupPage key={current.slug} community={current} port={port} account={account} setAccount={setAccount} job={latestJob(current.slug)} />
          ) : account && !account.loggedIn ? (
            <ConnectPage setAccount={setAccount} />
          ) : (
            <div className="grid flex-1 place-items-center text-secondary">
              <span className="loading loading-spinner" />
            </div>
          ))}
      </main>

      {addOpen && (
        <AddCommunity
          close={() => setAddOpen(false)}
          add={(slug) => {
            if (!communities.some((c) => c.slug === slug)) setRemote((r) => [...(r || []), { id: '', slug, name: slug }])
            go('group', slug)
            setAddOpen(false)
          }}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------- small pieces
function GroupLogo({ src, name, size = 'w-8' }: { src?: string | null; name: string; size?: string }) {
  const [broken, setBroken] = useState(false)
  return (
    <div className="avatar avatar-placeholder flex-none">
      <div className={`${size} rounded bg-neutral text-neutral-content`}>
        {src && !broken ? <img src={src} alt="" onError={() => setBroken(true)} /> : <span className="text-[10px]">{name[0]}</span>}
      </div>
    </div>
  )
}

function AccountBox({ account, setAccount }: { account: Account | null; setAccount: (a: Account) => void }) {
  if (!account) return <div className="flex-1" />
  if (!account.loggedIn)
    return (
      <button className="btn btn-primary btn-sm flex-1" onClick={() => vault.login().then(setAccount)}>
        Log in to Skool
      </button>
    )
  return (
    <div className="dropdown dropdown-top min-w-0 flex-1">
      <div tabIndex={0} role="button" className="flex items-center gap-2.5 rounded-field px-2 py-1.5 hover:bg-base-300/60">
        <GroupLogo src={account.avatar} name={account.name || '?'} size="w-7" />
        <span className="truncate text-sm font-medium">{account.name || 'Logged in'}</span>
      </div>
      <ul tabIndex={0} className="dropdown-content menu z-10 mb-2 w-56 rounded-box border border-base-300 bg-base-100 p-2">
        <li>
          <button onClick={() => vault.logout().then(setAccount)}>Log out of Skool</button>
        </li>
      </ul>
    </div>
  )
}

function AddCommunity({ close, add }: { close: () => void; add: (slug: string) => void }) {
  const [url, setUrl] = useState('')
  const slug = (/skool\.com\/([^/?#\s]+)/.exec(url) || /^([\w-]+)$/.exec(url.trim()))?.[1]
  return (
    <dialog className="modal modal-open" onClose={close}>
      <div className="modal-box">
        <h3 className="text-lg font-semibold">Add a community</h3>
        <p className="mt-1 text-sm text-secondary">Paste the link of any Skool community you're a member of.</p>
        <input
          autoFocus
          className="input mt-4 w-full"
          placeholder="https://www.skool.com/community-name"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && slug && add(slug)}
        />
        <div className="modal-action">
          <button className="btn btn-ghost" onClick={close}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!slug} onClick={() => slug && add(slug)}>
            Add community
          </button>
        </div>
      </div>
      <form method="dialog" className="modal-backdrop">
        <button onClick={close}>close</button>
      </form>
    </dialog>
  )
}

function ConnectPage({ setAccount }: { setAccount: (a: Account) => void }) {
  const [busy, setBusy] = useState(false)
  return (
    <div className="flex flex-1 items-center px-14 pb-20">
      <div className="max-w-md">
        <h1 className="label-type">Connect your Skool account</h1>
        <p className="mt-4 text-secondary">
          A Skool sign-in window opens. Log in as usual; the session stays on this PC and is only used to download communities you're a
          member of.
        </p>
        <button
          className="btn btn-primary mt-6"
          disabled={busy}
          onClick={async () => {
            setBusy(true)
            setAccount(await vault.login())
            setBusy(false)
          }}
        >
          {busy && <span className="loading loading-spinner loading-sm" />}
          {busy ? 'Waiting for you to log in' : 'Log in to Skool'}
        </button>
      </div>
    </div>
  )
}

/** Plain page body: same width and padding everywhere, no panels. */
function Page({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-4xl px-10 pt-4 pb-16">{children}</div>
    </div>
  )
}

function Heading({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="mt-10 mb-2 flex items-baseline justify-between gap-4">
      <h2 className="font-semibold">{title}</h2>
      {children && <div className="flex items-center gap-5 text-sm text-secondary">{children}</div>}
    </div>
  )
}

// ---------------------------------------------------------------- a community
function GroupPage({
  community, port, account, setAccount, job
}: { community: Community; port: number; account: Account | null; setAccount: (a: Account) => void; job?: JobState }) {
  const slug = community.slug
  const [scan, setScan] = useState<ScanResult | null>(null)
  const [scanErr, setScanErr] = useState('')
  const [archive, setArchive] = useState<GroupArchive | null>(null)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [o, setO] = useState({ videos: true, community: true, comments: true, postVideos: true, maxPosts: 0, onlyNew: true })
  const set = (patch: Partial<typeof o>) => setO({ ...o, ...patch })
  const saved = !!community.saved
  const running = job?.status === 'running'

  useEffect(() => {
    if (!account?.loggedIn) return
    vault.scan(slug).then(
      (s) => {
        setScan(s)
        setPicked(new Set(s.courses.filter((c) => !c.locked).map((c) => c.id)))
      },
      (e) => setScanErr(errText(e))
    )
  }, [slug, account?.loggedIn])

  // what's already on disk, for the per-course column (refreshed after each run)
  useEffect(() => {
    if (!saved || !port) return
    fetch(`http://127.0.0.1:${port}/api/group/${encodeURIComponent(slug)}`)
      .then((r) => r.json())
      .then(setArchive, () => {})
  }, [slug, saved, port, job?.status])

  const savedCourse = (id: string) => {
    const c = archive?.classroom.courses.find((x) => x.id === id)
    if (!c) return null
    const ls = lessonsOf(c.items)
    return { done: ls.filter(lessonSaved).length, total: ls.length }
  }
  const commentTotal = useMemo(() => {
    const n = (cs: any[]): number => cs.reduce((a, c) => a + 1 + n(c.replies), 0)
    return archive ? archive.community.posts.reduce((a, p) => a + n(p.comments), 0) : 0
  }, [archive])

  const toggleCourse = (id: string) => {
    const n = new Set(picked)
    n.has(id) ? n.delete(id) : n.add(id)
    setPicked(n)
  }
  const open = scan?.courses.filter((c) => !c.locked) || []
  const allPicked = open.length > 0 && open.every((c) => picked.has(c.id))
  const start = () => vault.startJob({ slug, courses: [...picked], ...o, onlyNew: saved && o.onlyNew })
  const actionLabel = !saved ? 'Download' : o.onlyNew ? 'Download new' : 'Download everything again'

  return (
    <Page>
      <header className="flex items-start gap-5">
        <GroupLogo src={community.logo} name={community.name} size="w-14" />
        <div className="min-w-0 flex-1">
          <h1 className="label-type truncate">{community.name}</h1>
          <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-sm text-secondary">
            <span>skool.com/{slug}</span>
            {community.saved && <span>Last saved {fmtDate(community.saved.updatedAt)}</span>}
            {community.saved && (
              <>
                <button className="link link-hover" onClick={() => vault.openViewer(slug)}>
                  Open viewer
                </button>
                <button className="link link-hover" onClick={() => vault.showFolder(slug)}>
                  Folder
                </button>
              </>
            )}
          </div>
        </div>
        {scan && (
          <div className="flex flex-none flex-col items-end gap-2 pt-1">
            <button className="btn btn-primary" disabled={running || (!picked.size && !o.community)} onClick={start}>
              {running && <span className="loading loading-spinner loading-sm" />}
              {running ? 'Downloading' : actionLabel}
            </button>
            {saved && (
              <label
                className="flex cursor-pointer items-center gap-2 text-xs text-secondary"
                title="Skips lessons and posts that are fully saved. New lessons, new posts, posts with new comments and anything that failed before are still downloaded."
              >
                <input type="checkbox" className="checkbox checkbox-xs" checked={o.onlyNew} onChange={(e) => set({ onlyNew: e.target.checked })} />
                Only new and changed
              </label>
            )}
          </div>
        )}
      </header>

      {account && !account.loggedIn && (
        <p className="mt-8 text-sm">
          <button className="link font-medium" onClick={() => vault.login().then(setAccount)}>
            Log in to Skool
          </button>{' '}
          <span className="text-secondary">to download or update this community. What's already saved stays viewable.</span>
        </p>
      )}
      {scanErr && <p className="mt-8 text-sm text-error">Couldn't read this community from Skool: {scanErr}</p>}

      {job && <JobLine job={job} />}

      {account?.loggedIn && !scan && !scanErr && (
        <div className="mt-10 flex items-center gap-3 text-secondary">
          <span className="loading loading-spinner loading-sm" /> Reading the classroom from Skool
        </div>
      )}

      {scan && (
        <>
          <Heading title="Classroom">
            <label className="flex cursor-pointer items-center gap-2">
              <input type="checkbox" className="checkbox checkbox-xs" checked={o.videos} onChange={(e) => set({ videos: e.target.checked })} />
              Videos
            </label>
            {open.length > 0 && (
              <button className="link link-hover" onClick={() => setPicked(allPicked ? new Set() : new Set(open.map((c) => c.id)))}>
                {allPicked ? 'Select none' : 'Select all'}
              </button>
            )}
          </Heading>
          {!scan.courses.length ? (
            <p className="py-3 text-secondary">This community has no courses.</p>
          ) : (
            <table className="table">
              <tbody>
                {scan.courses.map((c) => {
                  const s = savedCourse(c.id)
                  return (
                    <tr key={c.id} className={c.locked ? 'opacity-45' : 'cursor-pointer hover:bg-base-200/50'} onClick={() => !c.locked && toggleCourse(c.id)}>
                      <td className="w-8 pr-0">
                        <input
                          type="checkbox"
                          className="checkbox checkbox-sm"
                          disabled={c.locked}
                          checked={picked.has(c.id)}
                          onChange={() => toggleCourse(c.id)}
                          onClick={(e) => e.stopPropagation()}
                          aria-label={c.title}
                        />
                      </td>
                      <td>
                        <div className="flex items-center gap-3">
                          <div className="h-8 w-14 flex-none overflow-hidden rounded bg-base-300">
                            {c.cover && <img src={c.cover} alt="" className="h-full w-full object-cover" />}
                          </div>
                          <span className="font-medium">{c.title}</span>
                        </div>
                      </td>
                      <td className="w-28 text-right text-sm tabular-nums text-secondary">{c.lessons} lessons</td>
                      <td className="w-32 text-right text-sm tabular-nums">
                        {c.locked ? (
                          <span className="text-secondary">No access</span>
                        ) : s ? (
                          <span className={s.done === s.total ? 'text-success' : 'text-warning'}>
                            {s.done === s.total ? 'Saved' : `${s.done} of ${s.total} saved`}
                          </span>
                        ) : (
                          <span className="text-secondary">Not saved</span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}

          <Heading title="Community">
            {archive ? (
              <span>
                {archive.community.posts.length} posts and {commentTotal} comments saved
              </span>
            ) : scan.totalPosts ? (
              <span>{scan.totalPosts.toLocaleString()} posts on Skool</span>
            ) : null}
          </Heading>
          <div className="flex flex-wrap items-center gap-x-7 gap-y-3 border-t border-base-300 pt-4 text-sm">
            <label className="flex cursor-pointer items-center gap-2">
              <input type="checkbox" className="checkbox checkbox-sm" checked={o.community} onChange={(e) => set({ community: e.target.checked })} />
              Posts
            </label>
            <label className={`flex cursor-pointer items-center gap-2 ${o.community ? '' : 'opacity-40'}`}>
              <input type="checkbox" className="checkbox checkbox-sm" disabled={!o.community} checked={o.comments} onChange={(e) => set({ comments: e.target.checked })} />
              Comments and replies
            </label>
            <label className={`flex cursor-pointer items-center gap-2 ${o.community ? '' : 'opacity-40'}`}>
              <input type="checkbox" className="checkbox checkbox-sm" disabled={!o.community} checked={o.postVideos} onChange={(e) => set({ postVideos: e.target.checked })} />
              Videos in posts
            </label>
            <label className={`flex items-center gap-2 ${o.community ? '' : 'opacity-40'}`}>
              Newest
              <input
                type="number"
                min={0}
                disabled={!o.community}
                className="input input-xs w-16 tabular-nums"
                value={o.maxPosts}
                onChange={(e) => set({ maxPosts: Math.max(0, Number(e.target.value)) })}
              />
              posts (0 for all)
            </label>
          </div>
          <p className="mt-3 text-xs text-secondary">Images, avatars and attached files are always saved. Video quality is in Settings.</p>
        </>
      )}
    </Page>
  )
}

/** Download progress, inline under the header. */
function JobLine({ job }: { job: JobState }) {
  const [log, setLog] = useState(false)
  const running = job.status === 'running'
  const pct = job.total ? Math.min(100, (job.done * 100) / job.total) : 0
  const tone = job.status === 'error' ? 'progress-error' : job.status === 'done' ? 'progress-success' : 'progress-primary'
  return (
    <div className="mt-8">
      <div className="flex items-center gap-3 text-sm">
        {running && <span className="rec" />}
        <span className="font-medium">{job.phase}</span>
        {job.current && <span className="min-w-0 flex-1 truncate text-secondary">{job.current}</span>}
        {!job.current && <span className="flex-1" />}
        <span className="tabular-nums text-secondary">
          {job.done}/{job.total || '?'} items, {job.videosDone}/{job.videosTotal} videos
        </span>
        <button className="link link-hover text-secondary" onClick={() => setLog(!log)}>
          {log ? 'Hide log' : 'Log'}
          {job.errors.length > 0 && <span className="ml-1 text-error">({job.errors.length})</span>}
        </button>
        {running && (
          <button className="link link-hover" onClick={() => vault.cancelJob(job.id)}>
            Stop
          </button>
        )}
      </div>
      <progress className={`progress mt-2 h-1 ${tone}`} value={running ? pct : 100} max={100} />
      {job.videos.map((v) => (
        <div key={v.key} className="mt-1 grid grid-cols-[minmax(0,1fr)_7rem_6rem] items-center gap-3 text-xs text-secondary">
          <span className="truncate">{v.label}</span>
          <progress className="progress h-0.5" value={v.pct} max={100} />
          <span className="text-right tabular-nums">
            {v.pct.toFixed(0)}% {v.speed || ''}
          </span>
        </div>
      ))}
      {log && (
        <pre className="mt-3 max-h-52 overflow-auto rounded-field bg-base-200 p-3 text-xs leading-relaxed">
          {job.log.slice(-200).join('\n')}
          {job.errors.length > 0 && '\n\nProblems:\n' + job.errors.join('\n')}
        </pre>
      )}
    </div>
  )
}

// ---------------------------------------------------------------- library
function LibraryPage({
  library, port, remote, setRemote, open
}: { library: LibraryEntry[]; port: number; remote: RemoteState; setRemote: (r: RemoteState) => void; open: (slug: string) => void }) {
  const [info, setInfo] = useState<{ url: string; lan: string[] } | null>(null)
  useEffect(() => {
    vault.serverInfo().then(setInfo)
  }, [port])
  return (
    <Page>
      <h1 className="label-type">Library</h1>
      <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-sm text-secondary">
        <span>
          Viewer in your browser:{' '}
          <button className="link link-hover" onClick={() => vault.openInBrowser()}>
            {info?.url.replace(/[?#].*$/, '')}
          </button>
        </span>
        <button className="link link-hover" onClick={() => vault.showFolder()}>
          Open library folder
        </button>
      </div>

      {!library.length ? (
        <p className="mt-10 text-secondary">Nothing saved yet. Pick a community on the left and download it.</p>
      ) : (
        <table className="table mt-8">
          <thead>
            <tr className="text-secondary">
              <th className="pl-0">Community</th>
              <th className="text-right">Lessons</th>
              <th className="text-right">Posts</th>
              <th className="text-right">Videos</th>
              <th>Last saved</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {library.map((l) => (
              <tr key={l.slug}>
                <td className="pl-0">
                  <button className="flex items-center gap-3 text-left font-medium hover:underline" onClick={() => open(l.slug)}>
                    <GroupLogo src={fileUrl(port, l.slug, l.logo)} name={l.name} size="w-7" />
                    {l.name}
                  </button>
                </td>
                <td className="text-right tabular-nums">{l.lessons}</td>
                <td className="text-right tabular-nums">{l.posts}</td>
                <td className="text-right tabular-nums">{l.videos}</td>
                <td className="text-sm text-secondary">{fmtDate(l.updatedAt)}</td>
                <td className="pr-0 text-right text-sm">
                  <button className="link link-hover mr-4" onClick={() => vault.openViewer(l.slug)}>
                    Open
                  </button>
                  <button className="link link-hover text-secondary" onClick={() => vault.showFolder(l.slug)}>
                    Folder
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <PhoneShare remote={remote} setRemote={setRemote} />
    </Page>
  )
}

/** Open the archive on a phone: temporary public link (Cloudflare) and/or the Wi-Fi link, both keyed. */
function PhoneShare({ remote, setRemote }: { remote: RemoteState; setRemote: (r: RemoteState) => void }) {
  const [copied, setCopied] = useState('')
  const on = remote.status === 'on' || remote.status === 'starting'
  const lan = remote.lanUrls || []
  const copy = (t: string) => {
    vault.copy(t)
    setCopied(t)
    setTimeout(() => setCopied(''), 1500)
  }
  const linkRow = (url: string, label: string) => (
    <div key={url} className="flex min-w-0 items-center gap-3 text-sm">
      <span className="w-24 flex-none text-secondary">{label}</span>
      <span className="min-w-0 flex-1 truncate font-mono text-xs" title={url}>
        {url}
      </span>
      <button className="link link-hover flex-none" onClick={() => copy(url)}>
        {copied === url ? 'Copied' : 'Copy link'}
      </button>
    </div>
  )
  return (
    <>
      <Heading title="On your phone" />
      <div className="border-t border-base-300 pt-4">
        <p className="max-w-xl text-sm text-secondary">
          Open your archive on your phone from anywhere with a temporary link. The link works until you turn sharing off or close the
          app, and only for people you give it to, so don&apos;t post it anywhere.
        </p>
        <label className="mt-4 flex cursor-pointer items-center gap-3 text-sm">
          <input
            type="checkbox"
            className="toggle toggle-sm toggle-success"
            checked={on}
            disabled={remote.status === 'starting'}
            onChange={async (e) => setRemote(await (e.target.checked ? vault.startRemote() : vault.stopRemote()))}
          />
          Share a temporary link
          {remote.status === 'starting' && (
            <span className="flex items-center gap-2 text-secondary">
              <span className="loading loading-spinner loading-xs" /> Opening a link through Cloudflare
            </span>
          )}
        </label>
        {remote.status === 'error' && <p className="mt-3 text-sm text-error">Couldn&apos;t share: {remote.error}</p>}

        {(remote.status === 'on' || lan.length > 0) && (
          <div className="mt-5 flex items-start gap-6">
            {remote.qr && (
              <div
                className="w-36 flex-none overflow-hidden rounded-field bg-white p-1"
                aria-label="QR code for the link"
                dangerouslySetInnerHTML={{ __html: remote.qr }}
              />
            )}
            <div className="flex min-w-0 flex-1 flex-col gap-3 pt-1">
              <p className="text-sm">Scan the code with your phone&apos;s camera, or send yourself the link.</p>
              {remote.status === 'on' && remote.url && linkRow(remote.url, 'Anywhere')}
              {lan.map((u) => linkRow(u, 'Same Wi-Fi'))}
              <button
                className="link link-hover self-start text-sm text-secondary"
                onClick={async () => setRemote(await vault.resetAccessKey())}
                title="Makes a new key. Every link you shared before stops working."
              >
                Reset link (old links stop working)
              </button>
            </div>
          </div>
        )}
      </div>
    </>
  )
}

// ---------------------------------------------------------------- settings
function SettingsPage({ onSaved }: { onSaved: () => void }) {
  const [s, setS] = useState<Settings | null>(null)
  const [saved, setSaved] = useState(false)
  useEffect(() => {
    vault.settings().then(setS)
  }, [])
  if (!s) return null
  const set = (p: Partial<Settings>) => {
    setS({ ...s, ...p })
    setSaved(false)
  }
  const row = 'grid grid-cols-[14rem_minmax(0,1fr)] items-center gap-6 border-t border-base-300 py-4'
  return (
    <Page>
      <h1 className="label-type mb-8">Settings</h1>

      <div className={row}>
        <span className="text-sm">Library folder</span>
        <div className="flex items-center gap-3">
          <span className="truncate text-sm text-secondary">{s.libraryDir}</span>
          <button
            className="link link-hover flex-none text-sm"
            onClick={async () => {
              const d = await vault.pickDir()
              if (d) set({ libraryDir: d })
            }}
          >
            Change
          </button>
        </div>
      </div>
      <div className={row}>
        <span className="text-sm">Video quality</span>
        <select className="select select-sm w-48" value={s.maxHeight} onChange={(e) => set({ maxHeight: Number(e.target.value) })}>
          <option value={0}>Best available</option>
          <option value={2160}>Up to 4K</option>
          <option value={1080}>Up to 1080p</option>
          <option value={720}>Up to 720p</option>
        </select>
      </div>
      <div className={row}>
        <span className="text-sm">Download speed</span>
        <div className="flex flex-col gap-1">
          <select className="select select-sm w-48" value={s.speed} onChange={(e) => set({ speed: e.target.value as Speed })}>
            <option value="gentle">Gentle</option>
            <option value="normal">Normal</option>
            <option value="fast">Fast</option>
          </select>
          <span className="text-xs text-secondary">
            {s.speed === 'gentle'
              ? 'Slowest. Long pauses between Skool pages and fewer videos at once.'
              : s.speed === 'fast'
                ? 'Most videos and images at once, short pauses between Skool pages. Slows down by itself if Skool pushes back.'
                : 'More videos and images at once with a safe pause between Skool pages.'}
          </span>
        </div>
      </div>
      <div className={row}>
        <span className="text-sm">Viewer port</span>
        <input type="number" min={1024} max={65535} className="input input-sm w-24 tabular-nums" value={s.port} onChange={(e) => set({ port: Number(e.target.value) })} />
      </div>
      <div className={row}>
        <span className="text-sm">Other devices</span>
        <label className="flex cursor-pointer items-center gap-3 text-sm">
          <input type="checkbox" className="toggle toggle-sm" checked={s.lan} onChange={(e) => set({ lan: e.target.checked })} />
          Let devices on my Wi-Fi open the viewer (they need the link from Library)
        </label>
      </div>

      <div className="flex items-center justify-end gap-4 border-t border-base-300 pt-5">
        {saved && <span className="text-sm text-success">Settings saved</span>}
        <button
          className="btn btn-primary btn-sm"
          onClick={async () => {
            setS(await vault.saveSettings(s))
            setSaved(true)
            onSaved()
          }}
        >
          Save settings
        </button>
      </div>
    </Page>
  )
}
