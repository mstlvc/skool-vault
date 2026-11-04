import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { estimateLeft, formatLeft, videoWork, type EtaSample } from './eta'
import type {
  Account, GroupArchive, JobState, Lesson, LibraryEntry, RemoteGroup, RemoteState, ScanResult, ScanSection, Section, Settings, Speed, TempUsage
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
    vault.account().then(setAccount, () => setAccount({ loggedIn: false, accounts: [] }))
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
    setRemote(null)
    setRemoteErr('')
    if (!account?.loggedIn) return
    let cancel = false
    vault.remoteGroups().then(
      (groups) => {
        if (cancel) return
        setRemote(groups)
        vault.account().then((next) => {
          if (!cancel) setAccount(next)
        })
      },
      (e) => {
        if (!cancel) setRemoteErr(errText(e))
      }
    )
    return () => {
      cancel = true
    }
  }, [account?.id, account?.loggedIn])

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
    if (!communities.length) return
    if (!selected || !communities.some((c) => c.slug === selected)) setSelected(communities[0].slug)
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
            const job = latestJob(c.slug)
            const running = job?.status === 'running'
            return (
              <li key={c.slug}>
                <button className={page === 'group' && selected === c.slug ? 'menu-active' : ''} onClick={() => go('group', c.slug)}>
                  <GroupLogo src={c.logo} name={c.name} size="w-5" />
                  <span className="truncate">{c.name}</span>
                  {running && job?.paused ? (
                    <span className="ml-auto h-2 w-2 flex-none rounded-full bg-warning" title="Paused" />
                  ) : running ? (
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
            <GroupPage key={`${account?.id || 'none'}:${current.slug}`} community={current} port={port} account={account} setAccount={setAccount} job={latestJob(current.slug)} />
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

function accountLabel(name: string | undefined, loggedIn: boolean, index: number) {
  if (name) return name
  if (loggedIn) return 'Signed in'
  return index === 0 ? 'Not signed in' : `Account ${index + 1}`
}

function AccountBox({ account, setAccount }: { account: Account | null; setAccount: (a: Account) => void }) {
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState(false)
  useEffect(() => setConfirmRemove(false), [account?.id])
  if (!account)
    return (
      <div className="flex flex-1 items-center gap-2 px-2 text-sm text-secondary">
        <span className="loading loading-spinner loading-xs" />
      </div>
    )

  const run = async (fn: () => Promise<Account>) => {
    setErr('')
    setConfirmRemove(false)
    setBusy(true)
    try {
      setAccount(await fn())
    } catch (e) {
      setErr(errText(e))
    } finally {
      setBusy(false)
      ;(document.activeElement as HTMLElement | null)?.blur()
    }
  }
  const saved = account.accounts || []
  const activeIndex = Math.max(0, saved.findIndex((a) => a.active))
  const label = account.loggedIn ? accountLabel(account.name, true, activeIndex) : 'Log in to Skool'

  return (
    <div className="min-w-0 flex-1">
      <div className="dropdown dropdown-top w-full">
        <div
          tabIndex={0}
          role="button"
          className={
            account.loggedIn
              ? 'flex items-center gap-2.5 rounded-field px-2 py-1.5 hover:bg-base-300/60'
              : 'btn btn-primary btn-sm w-full justify-start'
          }
          onClick={() => setConfirmRemove(false)}
        >
          {account.loggedIn && <GroupLogo src={account.avatar} name={label} size="w-7" />}
          <span className="min-w-0 flex-1 truncate text-sm font-medium">{label}</span>
        </div>
        <ul tabIndex={0} className="dropdown-content menu z-20 mb-2 max-h-80 w-64 flex-nowrap overflow-y-auto rounded-box border border-base-300 bg-base-100 p-2">
          {saved.map((a, i) => (
            <li key={a.id}>
              <button
                disabled={busy}
                onClick={() => {
                  if (a.active) return
                  void run(() => vault.switchAccount(a.id))
                }}
              >
                <GroupLogo src={a.avatar} name={accountLabel(a.name, a.loggedIn, i)} size="w-5" />
                <span className="min-w-0 flex-1 truncate">{accountLabel(a.name, a.loggedIn, i)}</span>
                {a.active && <Icon name="check" size={14} />}
              </button>
            </li>
          ))}
          {saved.length > 0 && <div className="my-1 h-px bg-base-300" />}
          {!account.loggedIn && (
            <li>
              <button disabled={busy} onClick={() => void run(() => vault.login())}>
                Log in to Skool
              </button>
            </li>
          )}
          {account.id && (
            <li>
              <button disabled={busy} onClick={() => void run(() => vault.addAccount())}>
                Add account
              </button>
            </li>
          )}
          {account.loggedIn && (
            <li>
              <button
                onClick={() => {
                  void vault.browseSkool()
                  ;(document.activeElement as HTMLElement | null)?.blur()
                }}
              >
                Browse Skool
              </button>
            </li>
          )}
          {account.loggedIn && (
            <li>
              <button disabled={busy} onClick={() => void run(() => vault.logout())}>
                Log out of Skool
              </button>
            </li>
          )}
          {account.id && (
            <li>
              <button
                className="text-error"
                disabled={busy}
                onClick={() => {
                  if (!confirmRemove) {
                    setConfirmRemove(true)
                    return
                  }
                  void run(() => vault.removeAccount(account.id!))
                }}
              >
                {confirmRemove ? 'Click again to remove' : 'Remove this account'}
              </button>
            </li>
          )}
        </ul>
      </div>
      {err && <p className="px-2 pt-1 text-xs text-error">{err}</p>}
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
  const [skipped, setSkipped] = useState<Set<string>>(new Set())
  const [openIds, setOpenIds] = useState<Set<string>>(new Set())
  const [live, setLive] = useState<Record<string, ScanSection[] | 'loading' | 'error'>>({})
  const pickedRef = useRef(picked)
  const skippedRef = useRef(skipped)
  const liveRef = useRef(live)
  pickedRef.current = picked
  skippedRef.current = skipped
  liveRef.current = live
  const [o, setO] = useState({ videos: true, community: true, comments: true, postVideos: true, maxPosts: 0, onlyNew: true })
  const set = (patch: Partial<typeof o>) => setO({ ...o, ...patch })
  const saved = !!community.saved
  const running = job?.status === 'running'

  useEffect(() => {
    setScan(null)
    setScanErr('')
    if (!account?.loggedIn) return
    let cancel = false
    vault.scan(slug).then(
      (s) => {
        if (cancel) return
        setScan(s)
        setPicked(new Set(s.courses.filter((c) => !c.locked).map((c) => c.id)))
      },
      (e) => {
        if (!cancel) setScanErr(errText(e))
      }
    )
    return () => {
      cancel = true
    }
  }, [slug, account?.loggedIn, account?.id])

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

  const archiveSections = (id: string): ScanSection[] | null => {
    const c = archive?.classroom.courses.find((x) => x.id === id)
    if (!c) return null
    return c.items.map((it) =>
      it.type === 'set'
        ? { title: it.title, lessons: it.items.map((l) => ({ id: l.id, title: l.title })) }
        : { title: '', lessons: [{ id: it.id, title: it.title }] }
    )
  }
  const idsOf = (sections: ScanSection[]) => sections.flatMap((sec) => sec.lessons.map((l) => l.id))
  const knownSections = (id: string): ScanSection[] | null => {
    const liveSections = live[id]
    if (Array.isArray(liveSections)) return liveSections
    return archiveSections(id)
  }
  const lessonIds = (id: string) => idsOf(knownSections(id) || [])
  const commit = (n: Set<string>, s: Set<string>) => {
    pickedRef.current = n
    skippedRef.current = s
    setPicked(n)
    setSkipped(s)
  }
  // A full outline is required before turning a course back on for only some lessons.
  // The saved list can be shorter than the course, and those missing lessons would otherwise download.
  const ensureIds = async (courseId: string, courseSlug: string, expected: number): Promise<string[]> => {
    const current = liveRef.current[courseId]
    if (Array.isArray(current)) {
      const ids = idsOf(current)
      if (!expected || ids.length >= expected) return ids
    }
    const known = idsOf(archiveSections(courseId) || [])
    if (expected > 0 && known.length >= expected) return known
    try {
      const sections = await vault.courseOutline(slug, courseSlug)
      setLive((s) => ({ ...s, [courseId]: sections }))
      liveRef.current = { ...liveRef.current, [courseId]: sections }
      return idsOf(sections)
    } catch {
      return Array.isArray(current) ? idsOf(current) : known
    }
  }
  const dropIfNone = (courseId: string, allIds: string[], n: Set<string>, s: Set<string>) => {
    if (allIds.length > 0 && allIds.every((id) => s.has(id))) {
      n.delete(courseId)
      for (const id of allIds) s.delete(id)
    }
  }
  const toggleCourse = (id: string) => {
    const ids = lessonIds(id)
    const fully = pickedRef.current.has(id) && ids.every((lid) => !skippedRef.current.has(lid))
    const n = new Set(pickedRef.current)
    const s = new Set(skippedRef.current)
    if (fully) n.delete(id)
    else n.add(id)
    for (const lid of ids) s.delete(lid)
    commit(n, s)
  }
  const toggleLesson = (courseId: string, courseSlug: string, lessonId: string, expected: number) => {
    const n = new Set(pickedRef.current)
    const s = new Set(skippedRef.current)
    if (n.has(courseId)) {
      s.has(lessonId) ? s.delete(lessonId) : s.add(lessonId)
      dropIfNone(courseId, lessonIds(courseId), n, s)
      commit(n, s)
      return
    }
    void ensureIds(courseId, courseSlug, expected).then((ids) => {
      const next = new Set(pickedRef.current)
      const skip = new Set(skippedRef.current)
      if (next.has(courseId)) {
        skip.has(lessonId) ? skip.delete(lessonId) : skip.add(lessonId)
      } else {
        next.add(courseId)
        for (const id of ids) if (id !== lessonId) skip.add(id)
        skip.delete(lessonId)
      }
      dropIfNone(courseId, ids.length ? ids : lessonIds(courseId), next, skip)
      commit(next, skip)
    })
  }
  const toggleSection = (courseId: string, courseSlug: string, sectionTitle: string, sectionIds: string[], expected: number) => {
    void (async () => {
      if (expected > 0 && lessonIds(courseId).length < expected) await ensureIds(courseId, courseSlug, expected)
      const loaded = liveRef.current[courseId]
      const match = Array.isArray(loaded)
        ? loaded.find((sec) => sec.title === sectionTitle && sectionIds.every((id) => sec.lessons.some((l) => l.id === id)))
        : null
      const target = match ? match.lessons.map((l) => l.id) : sectionIds
      const all = Array.isArray(loaded) ? idsOf(loaded) : lessonIds(courseId)
      const n = new Set(pickedRef.current)
      const s = new Set(skippedRef.current)
      const allOn = n.has(courseId) && target.every((id) => !s.has(id))
      if (!n.has(courseId)) {
        n.add(courseId)
        const keep = new Set(target)
        for (const id of all) if (!keep.has(id)) s.add(id)
        for (const id of target) s.delete(id)
      } else if (allOn) {
        for (const id of target) s.add(id)
      } else {
        for (const id of target) s.delete(id)
      }
      dropIfNone(courseId, all.length ? all : target, n, s)
      commit(n, s)
    })()
  }
  const lessonMark = (courseId: string, lessonId: string) => {
    const c = archive?.classroom.courses.find((x) => x.id === courseId)
    const l = c && lessonsOf(c.items).find((x) => x.id === lessonId)
    if (!l) return 'Not saved'
    return lessonSaved(l) ? 'Saved' : 'Partly saved'
  }
  const toggleOpen = (id: string, courseSlug: string) => {
    const n = new Set(openIds)
    if (n.has(id)) {
      n.delete(id)
      setOpenIds(n)
      return
    }
    n.add(id)
    setOpenIds(n)
    const have = live[id]
    if (have && have !== 'error') return
    setLive((s) => ({ ...s, [id]: 'loading' }))
    vault.courseOutline(slug, courseSlug).then(
      (sections) => setLive((s) => ({ ...s, [id]: sections })),
      () => setLive((s) => ({ ...s, [id]: 'error' }))
    )
  }
  const open = scan?.courses.filter((c) => !c.locked) || []
  const allPicked = open.length > 0 && open.every((c) => picked.has(c.id)) && skipped.size === 0
  const start = () => vault.startJob({ slug, courses: [...picked], skipLessons: [...skipped], ...o, onlyNew: saved && o.onlyNew })
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
            {account?.loggedIn && (
              <>
                <button className="link link-hover" onClick={() => vault.browseSkool(`https://www.skool.com/${slug}`)}>
                  Browse on Skool
                </button>
              </>
            )}
          </div>
        </div>
        {scan && (
          <div className="flex flex-none flex-col items-end gap-2 pt-1">
            <button className="btn btn-primary" disabled={running || (!picked.size && !o.community)} onClick={start}>
              {running && !job?.paused && <span className="loading loading-spinner loading-sm" />}
              {running ? (job?.paused ? 'Paused' : 'Downloading') : actionLabel}
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

      {!account && (
        <div className="mt-10 flex items-center gap-3 text-secondary">
          <span className="loading loading-spinner loading-sm" /> Checking your Skool login
        </div>
      )}
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
              <button
                className="link link-hover"
                onClick={() => commit(allPicked ? new Set() : new Set(open.map((c) => c.id)), new Set())}
              >
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
                  const opened = openIds.has(c.id)
                  const status = live[c.id]
                  const sections = Array.isArray(status) ? status : archiveSections(c.id)
                  const ids = (sections || []).flatMap((sec) => sec.lessons.map((l) => l.id))
                  const skipCount = ids.filter((id) => skipped.has(id)).length
                  const courseOn = picked.has(c.id)
                  return (
                    <Fragment key={c.id}>
                      <tr className={c.locked ? 'opacity-45' : 'cursor-pointer hover:bg-base-200/50'} onClick={() => !c.locked && toggleCourse(c.id)}>
                        <td className="w-8 pr-0" onClick={(e) => e.stopPropagation()}>
                          <button
                            type="button"
                            className="btn btn-ghost btn-xs btn-square"
                            aria-expanded={opened}
                            aria-label={opened ? `Hide lessons in ${c.title}` : `Show lessons in ${c.title}`}
                            onClick={() => toggleOpen(c.id, c.slug)}
                          >
                            <span className={'inline-flex transition-transform ' + (opened ? 'rotate-90' : '')}>
                              <Icon name="chevron" size={16} />
                            </span>
                          </button>
                        </td>
                        <td className="w-8 pr-0">
                          <input
                            type="checkbox"
                            className="checkbox checkbox-sm"
                            disabled={c.locked}
                            checked={courseOn && skipCount === 0}
                            ref={(el) => {
                              if (el) el.indeterminate = courseOn && skipCount > 0
                            }}
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
                        <td className="w-32 text-right text-sm tabular-nums whitespace-nowrap text-secondary">
                          {courseOn && skipCount > 0 ? `${Math.max(0, c.lessons - skipCount)} of ${c.lessons}` : `${c.lessons} lessons`}
                        </td>
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
                      {opened && (
                        <tr>
                          <td colSpan={5} className="bg-base-200/40 py-2 pr-4 pl-14">
                            {status === 'loading' && (
                              <p className="mb-2 flex items-center gap-2 text-xs text-secondary">
                                <span className="loading loading-spinner loading-xs" />
                                {job?.status === 'running'
                                  ? 'Waiting for the current download, then reading lessons from Skool'
                                  : sections
                                    ? 'Checking Skool for lessons that are not saved yet'
                                    : 'Reading lessons from Skool'}
                              </p>
                            )}
                            {status === 'error' && !sections && (
                              <p className="text-sm text-error">Couldn't read this course's lessons from Skool.</p>
                            )}
                            {status === 'error' && !!sections && (
                              <p className="mb-2 text-xs text-secondary">Showing the saved lesson list. Skool didn't answer with a fresh one.</p>
                            )}
                            {Array.isArray(status) && !status.length && <p className="text-sm text-secondary">This course has no lessons.</p>}
                            {sections?.map((section, i) => {
                              const secIds = section.lessons.map((l) => l.id)
                              const secSelected = secIds.filter((id) => courseOn && !skipped.has(id)).length
                              const secOn = secIds.length > 0 && secSelected === secIds.length
                              const secSome = secSelected > 0 && !secOn
                              return (
                              <div key={section.title + i} className={i ? 'mt-3' : ''}>
                                {section.title && (
                                  <label className={'mb-1 flex items-center gap-2.5 text-xs font-semibold text-secondary ' + (c.locked ? '' : 'cursor-pointer')}>
                                    <input
                                      type="checkbox"
                                      className="checkbox checkbox-xs"
                                      disabled={c.locked}
                                      checked={secOn}
                                      ref={(el) => {
                                        if (el) el.indeterminate = secSome
                                      }}
                                      onChange={() => toggleSection(c.id, c.slug, section.title, secIds, c.lessons)}
                                      aria-label={section.title}
                                    />
                                    <span>{section.title}</span>
                                  </label>
                                )}
                                {section.lessons.map((l) => {
                                  const mark = lessonMark(c.id, l.id)
                                  const on = courseOn && !skipped.has(l.id)
                                  return (
                                    <label key={l.id} className={'flex items-center gap-2.5 py-0.5 text-sm ' + (c.locked ? '' : 'cursor-pointer')}>
                                      <input
                                        type="checkbox"
                                        className="checkbox checkbox-xs"
                                        disabled={c.locked}
                                        checked={on}
                                        onChange={() => toggleLesson(c.id, c.slug, l.id, c.lessons)}
                                        aria-label={`Save ${l.title}`}
                                      />
                                      <span className={'min-w-0 flex-1 ' + (on ? '' : 'text-secondary')}>{l.title}</span>
                                      <span className={'flex-none text-xs tabular-nums ' + (mark === 'Saved' ? 'text-success' : mark === 'Partly saved' ? 'text-warning' : 'text-secondary')}>
                                        {on ? mark : 'Leave out'}
                                      </span>
                                    </label>
                                  )
                                })}
                              </div>
                              )
                            })}
                          </td>
                        </tr>
                      )}
                    </Fragment>
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

/** Recent pace for this job. A gap longer than a few seconds starts the window over, so a pause is not counted as slow downloading. */
function useTimeLeft(job: JobState): string | null {
  const samples = useRef<EtaSample[]>([])
  const seen = useRef(job.id)
  const [label, setLabel] = useState<string | null>(null)
  useEffect(() => {
    if (seen.current !== job.id) {
      seen.current = job.id
      samples.current = []
      setLabel(null)
    }
    if (job.status !== 'running') {
      samples.current = []
      setLabel(null)
      return
    }
    if (job.paused) return
    const t = Date.now()
    const videos = videoWork(job)
    const list = samples.current
    const prev = list[list.length - 1]
    if (prev && t - prev.t > 20000) list.length = 0
    const head = list[list.length - 1]
    if (!head || t - head.t >= 1000 || job.done !== head.items || Math.abs(videos - head.videos) > 0.001) {
      list.push({ t, items: job.done, videos })
      const cutoff = t - 90000
      while (list.length > 2 && list[0].t < cutoff) list.shift()
    }
    const eta = estimateLeft(list, job)
    if (eta != null) setLabel(formatLeft(eta))
  }, [job])
  return job.status === 'running' ? label : null
}

/** Download progress, inline under the header. */
function JobLine({ job }: { job: JobState }) {
  const [log, setLog] = useState(false)
  const left = useTimeLeft(job)
  const running = job.status === 'running'
  const pct = job.total ? Math.min(100, (job.done * 100) / job.total) : 0
  const tone = job.status === 'error' ? 'progress-error' : job.status === 'done' ? 'progress-success' : 'progress-primary'
  return (
    <div className="mt-8">
      <div className="flex items-center gap-3 text-sm">
        {running && !job.paused && <span className="rec" />}
        {job.paused && <span className="h-2 w-2 flex-none rounded-full bg-warning" title="Paused" />}
        <span className="font-medium">{job.phase}</span>
        {job.current && <span className="min-w-0 flex-1 truncate text-secondary">{job.current}</span>}
        {!job.current && <span className="flex-1" />}
        <span className="flex-none whitespace-nowrap tabular-nums text-secondary">
          {job.done}/{job.total || '?'} items, {job.videosDone}/{job.videosTotal} videos
          {left && (
            <span title="Estimate from the recent pace, including videos still to be found."> · {left}</span>
          )}
        </span>
        <button className="link link-hover text-secondary" onClick={() => setLog(!log)}>
          {log ? 'Hide log' : 'Log'}
          {job.errors.length > 0 && <span className="ml-1 text-error">({job.errors.length})</span>}
        </button>
        {running && (
          <span className="flex items-center gap-1.5">
            {job.paused ? (
              <button className="btn btn-xs btn-primary" onClick={() => vault.resumeJob(job.id)} title="Continue where it left off">
                Resume
              </button>
            ) : (
              <button className="btn btn-xs" onClick={() => vault.pauseJob(job.id)} title="Hold the download. Videos in progress start over when you resume.">
                Pause
              </button>
            )}
            <button className="btn btn-xs btn-ghost" onClick={() => vault.cancelJob(job.id)} title="End the download; everything saved so far is kept">
              Stop
            </button>
          </span>
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
  const [copyFailed, setCopyFailed] = useState('')
  // say "Copied" only when it really was: the app's clipboard first, the browser's as a backup
  const copy = async (t: string) => {
    let ok = await vault.copy(t).catch(() => false)
    if (!ok) ok = await navigator.clipboard.writeText(t).then(() => true, () => false)
    setCopied(ok ? t : '')
    setCopyFailed(ok ? '' : t)
    setTimeout(() => (setCopied(''), setCopyFailed('')), 2000)
  }
  const linkRow = (url: string, label: string) => (
    <div key={url} className="flex min-w-0 items-center gap-3 text-sm">
      <span className="w-24 flex-none text-secondary">{label}</span>
      <span className="min-w-0 flex-1 truncate font-mono text-xs" title={url}>
        {url}
      </span>
      <button className="link link-hover flex-none" onClick={() => copy(url)}>
        {copied === url ? 'Copied' : copyFailed === url ? "Couldn't copy" : 'Copy link'}
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
const fmtBytes = (n: number) =>
  n < 1024 * 1024 * 1024 ? `${Math.max(0, Math.round(n / 1024 / 1024))} MB` : `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`

function SettingsPage({ onSaved }: { onSaved: () => void }) {
  const [s, setS] = useState<Settings | null>(null)
  const [saved, setSaved] = useState(false)
  const [usage, setUsage] = useState<TempUsage | null>(null)
  const [clearing, setClearing] = useState(false)
  const [cleared, setCleared] = useState('')
  const [stripping, setStripping] = useState(false)
  const [stripNote, setStripNote] = useState('')
  useEffect(() => {
    vault.settings().then(setS)
    vault.tempUsage().then(setUsage)
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
        <span className="text-sm">Disk space</span>
        <div className="flex flex-col items-start gap-2 text-sm">
          {usage ? (
            <>
              <span>
                Library {fmtBytes(usage.libraryBytes)}. Videos are {fmtBytes(usage.videoBytes)} of that, and each video is stored once.
              </span>
              <span className="text-secondary">
                Temporary data {fmtBytes(usage.cacheBytes + usage.leftoverBytes)}: the browser cache and unfinished download pieces.
              </span>
            </>
          ) : (
            <span className="text-secondary">Checking folder sizes…</span>
          )}
          <div className="flex items-center gap-3">
            <button
              className="btn btn-sm"
              disabled={clearing || !usage}
              onClick={async () => {
                setClearing(true)
                setCleared('')
                const r = await vault.clearTemp()
                setUsage(r)
                setClearing(false)
                const bits = [`Cleared ${fmtBytes(r.freedBytes)}.`]
                if (r.keptLeftovers) bits.push('Unfinished pieces stay until the download finishes.')
                if (r.cacheBytes > 5 * 1024 * 1024) bits.push('Cache files still open are removed after you close the app.')
                bits.push('Saved videos stay in the library.')
                setCleared(bits.join(' '))
              }}
            >
              {clearing ? 'Clearing…' : 'Clear temporary data'}
            </button>
            {cleared && <span className="text-xs text-secondary">{cleared}</span>}
          </div>
        </div>
      </div>
      <div className={row}>
        <span className="text-sm">Personal information</span>
        <div className="flex flex-col items-start gap-2 text-sm">
          <span className="text-secondary">
            Saved pages include the login cookie, request tokens, the Stripe id, the account email, and home-folder paths. Names on posts stay. Lessons and videos stay.
          </span>
          <div className="flex items-center gap-3">
            <button
              className="btn btn-sm"
              disabled={stripping}
              onClick={async () => {
                if (!confirm('Remove the login cookie, request tokens, the Stripe id, the account email, and home-folder paths from the saved library? Names on posts stay. Lessons and videos stay. This cannot be undone.')) return
                setStripping(true)
                setStripNote('')
                try {
                  const r = await vault.stripPersonal()
                  if (r.busy) setStripNote('A download is still saving. Wait until it finishes.')
                  else if (!r.filesChanged) setStripNote(r.kept ? 'Nothing was changed. Some files were left so the viewer would stay intact.' : 'No personal information found in the library.')
                  else {
                    const bits = [`Removed personal information from ${r.filesChanged} file${r.filesChanged === 1 ? '' : 's'}.`]
                    if (r.kept) bits.push(`${r.kept} file${r.kept === 1 ? ' was' : 's were'} left so the viewer would stay intact.`)
                    setStripNote(bits.join(' '))
                  }
                } catch (e) {
                  setStripNote(errText(e))
                }
                setStripping(false)
              }}
            >
              {stripping ? 'Removing…' : 'Remove personal information'}
            </button>
            {stripNote && <span className="text-xs text-secondary">{stripNote}</span>}
          </div>
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
