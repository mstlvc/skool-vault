import { createHash } from 'crypto'
import { appendFileSync, existsSync, mkdirSync } from 'fs'
import { join, relative, extname } from 'path'
import type {
  Attachment, Category, Comment, Course, DownloadOptions, GroupArchive, JobState, Lesson, Person,
  Post, RemoteGroup, ScanCourse, ScanResult, ScanSection, Section, VideoRef
} from '../shared/types'
import { outlineOf } from '../shared/outline'
import { groupDir, loadGroup, writeJson } from './archive'
import { downloadVideo, existingCaptions, existingVideo } from './media'
import { imageUrls, toHtml, toText } from './richtext'
import { getSettings, speedProfile } from './settings'
import { BASE, PageLoader, deepFind, fetchText, fetchToFile, loomShareUrl, parseJson, urlFromApi, writeCookieFile } from './skool'

/** Bumped when lesson handling improves, so "only new" re-checks lessons saved by older versions once. */
const LESSON_REV = 2

// ------------------------------------------------------------------ helpers

const safeName = (s: any, max = 80) =>
  (String(s ?? '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '').replace(/\s+/g, ' ').trim().replace(/\.+$/, '').slice(0, max).trim() ||
  'untitled')

const pad = (n: number, w = 3) => String(n).padStart(w, '0')

export function toRemoteGroup(g: any): RemoteGroup {
  const m = g?.metadata || {}
  return {
    id: g?.id,
    slug: g?.name,
    name: m.displayName || g?.name,
    logo: m.logoUrl || m.faviconUrl || null,
    cover: m.coverSmallUrl || null,
    color: m.color,
    description: m.description
  }
}

const pageProps = (nd: any) => nd?.props?.pageProps || {}

// ------------------------------------------------------------------ discovery

export async function listRemoteGroups(loader: PageLoader): Promise<{ me: any; groups: RemoteGroup[] }> {
  const pp = pageProps(await loader.nextData(BASE + '/'))
  const me = pp.self || null
  const groups = (me?.allGroups || pp.allGroups || []).map(toRemoteGroup).filter((g: RemoteGroup) => g.slug)
  return { me, groups }
}

async function classroomCourses(loader: PageLoader, slug: string) {
  let pp = pageProps(await loader.nextData(`${BASE}/${slug}/classroom`))
  if (!pp.self) throw new Error('Not logged in (or the session expired). Log in again.')
  const first = pp
  const courses: any[] = []
  const seen = new Set<string>()
  for (let p = 2; p < 50; p++) {
    const batch = (pp.allCourses || []).filter((c: any) => !seen.has(c.id))
    if (!batch.length) break
    for (const c of batch) {
      seen.add(c.id)
      courses.push(c)
    }
    if ((pp.allCourses || []).length < 8) break // a short page is the last page
    pp = pageProps(await loader.nextData(`${BASE}/${slug}/classroom?p=${p}`))
  }
  return { pp: first, courses }
}

export async function scanGroup(loader: PageLoader, slug: string): Promise<ScanResult> {
  const { pp, courses } = await classroomCourses(loader, slug)
  const g = pp.currentGroup || {}
  return {
    group: toRemoteGroup(g),
    totalPosts: g.metadata?.totalPosts,
    courses: courses.map(
      (c): ScanCourse => ({
        id: c.id,
        slug: c.name,
        title: c.metadata?.title || c.name,
        cover: c.metadata?.coverImage || null,
        lessons: c.metadata?.numModules || 0,
        locked: c.metadata?.hasAccess === 0
      })
    )
  }
}

/** Lesson titles for one course, read from Skool without downloading it. */
export async function courseOutline(loader: PageLoader, groupSlug: string, courseSlug: string): Promise<ScanSection[]> {
  if (!groupSlug || !courseSlug) throw new Error('Missing course')
  const pp = pageProps(await loader.nextData(`${BASE}/${groupSlug}/classroom/${courseSlug}`))
  if (!pp.self) throw new Error('Not logged in (or the session expired). Log in again.')
  if (!pp.course) throw new Error('Skool did not return this course.')
  return outlineOf(pp.course)
}

// ------------------------------------------------------------------ job

type Emit = (s: JobState) => void

interface VideoTask {
  key: string
  label: string
  url: string
  dir: string
  stem: string
  durationMs?: number | null
  refresh?: () => Promise<string | null>
  target: VideoRef
}

export class DownloadJob {
  state: JobState
  abort = new AbortController()
  private archive!: GroupArchive
  private dir: string
  private saveTimer: NodeJS.Timeout | null = null
  private emitTimer: NodeJS.Timeout | null = null
  private queue: VideoTask[] = []
  private active = 0
  private idle: (() => void)[] = []
  private cookieFile: string
  private linkedPosts = new Set<string>()
  /** Post slugs we already tried to fetch because something linked to them. */
  private linkAttempts = new Set<string>()
  /** One archive merge at a time. Parallel post downloads used to drop each other's posts. */
  private postChain: Promise<void> = Promise.resolve()
  private filledLessons = 0 // slim lessons completed from Skool's course data
  /** Lesson recordings that live on a pinned community post (slug -> where the lesson video should go). */
  private recordingLessons = new Map<string, { lessonId: string; folder: string; stem: string }>()
  /** Video refs already handed to the download queue, so a lesson and its post don't download the same file twice. */
  private enqueuedTargets = new WeakSet<VideoRef>()
  /** Lessons the user left unchecked. They are not downloaded or updated. */
  private skipLessons: Set<string>
  /** Why the last playback-token request produced no link. Appended to the lesson warning. */
  private playbackNote = ''

  constructor(private loader: PageLoader, private opts: DownloadOptions, private emitFn: Emit) {
    this.dir = groupDir(opts.slug)
    this.cookieFile = join(this.dir, '.cookies.txt')
    this.skipLessons = new Set(opts.skipLessons || [])
    this.state = {
      id: `${opts.slug}-${Date.now()}`,
      slug: opts.slug,
      status: 'running',
      phase: 'Starting',
      current: '',
      done: 0,
      total: 0,
      videos: [],
      videosDone: 0,
      videosTotal: 0,
      log: [],
      errors: [],
      startedAt: Date.now()
    }
  }

  // ---------------- plumbing
  private emit(now = false) {
    if (now) {
      if (this.emitTimer) clearTimeout(this.emitTimer)
      this.emitTimer = null
      this.emitFn({ ...this.state, videos: [...this.state.videos] })
      return
    }
    if (this.emitTimer) return
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null
      this.emitFn({ ...this.state, videos: [...this.state.videos] })
    }, 250)
  }

  log(msg: string) {
    const line = `${new Date().toLocaleTimeString()}  ${msg}`
    this.state.log = [...this.state.log.slice(-300), line]
    try {
      appendFileSync(join(this.dir, 'download-log.txt'), line + '\n')
    } catch {
      /* ignore */
    }
    this.emit()
  }

  fail(msg: string) {
    this.state.errors = [...this.state.errors, msg]
    this.log('⚠ ' + msg)
  }

  private check() {
    if (this.abort.signal.aborted) throw new Error('cancelled')
  }

  // ---------------- pause / resume
  private paused = false
  private resumeWaiters: (() => void)[] = []
  private phaseBeforePause = ''
  /** Running video downloads, each stoppable on its own (pause stops them and queues them again). */
  private taskAborts = new Map<string, AbortController>()
  private interrupted = new Set<string>()

  /** Checkpoint between steps: stops here while paused, throws if the job was stopped. */
  private async gate() {
    this.check()
    while (this.paused) await new Promise<void>((r) => this.resumeWaiters.push(r))
    this.check()
  }

  pause() {
    if (this.state.status !== 'running' || this.paused) return
    this.paused = true
    this.phaseBeforePause = this.state.phase
    this.state.paused = true
    this.state.phase = 'Paused'
    // stop the videos in progress; they go back to the front of the queue and start over on resume
    for (const [key, ctrl] of this.taskAborts) {
      this.interrupted.add(key)
      ctrl.abort()
    }
    this.log('paused')
    this.emit(true)
  }

  resume() {
    if (!this.paused) return
    this.paused = false
    this.state.paused = false
    this.state.phase = this.phaseBeforePause || this.state.phase
    this.log('resumed')
    this.resumeWaiters.splice(0).forEach((r) => r())
    this.pump()
    this.emit(true)
  }

  private save(now = false) {
    const write = () => {
      this.saveTimer = null
      const a = this.archive
      a.group.updatedAt = new Date().toISOString()
      writeJson(join(this.dir, 'group.json'), a.group)
      writeJson(join(this.dir, 'classroom.json'), a.classroom)
      writeJson(join(this.dir, 'community.json'), a.community)
    }
    if (now) {
      if (this.saveTimer) clearTimeout(this.saveTimer)
      return write()
    }
    if (!this.saveTimer) this.saveTimer = setTimeout(write, 2000)
  }

  private rel(p: string) {
    return relative(this.dir, p).split('\\').join('/')
  }

  /** Limits parallel CDN downloads (images, avatars, files) to the speed preset. */
  private slots = 0
  private slotWaiters: (() => void)[] = []
  private async withSlot<T>(fn: () => Promise<T>): Promise<T> {
    while (this.slots >= speedProfile().assets) await new Promise<void>((r) => this.slotWaiters.push(r))
    this.slots++
    try {
      return await fn()
    } finally {
      this.slots--
      this.slotWaiters.shift()?.()
    }
  }

  /**
   * Download an image/asset once; returns a local relative path (or the URL if it failed).
   * Concurrent calls for the same URL (the same avatar on many comments) share one download.
   */
  private assetCache = new Map<string, Promise<string>>()
  asset(url: any): Promise<string | null> {
    if (!url || typeof url !== 'string' || !/^https?:/.test(url)) return Promise.resolve(null)
    const hit = this.assetCache.get(url)
    if (hit) return hit
    const p = (async () => {
      let ext = extname(new URL(url).pathname).toLowerCase()
      if (!ext || ext.length > 5) ext = '.jpg'
      const name = createHash('sha1').update(url).digest('hex').slice(0, 20) + ext
      const dest = join(this.dir, 'media', name)
      try {
        if (!existsSync(dest)) await this.withSlot(() => fetchToFile(url, dest))
        return this.rel(dest)
      } catch (e: any) {
        this.log(`image failed (${e.message}): ${url.slice(0, 90)}`)
        return url
      }
    })()
    this.assetCache.set(url, p)
    return p
  }

  /** Run `fn` over items with at most `limit` running at once, keeping result order. */
  private async pool<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
    const out: R[] = new Array(items.length)
    let next = 0
    const worker = async () => {
      while (next < items.length) {
        const i = next++
        out[i] = await fn(items[i], i)
      }
    }
    await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker))
    return out
  }

  /** Download every image URL in `urls` in parallel; returns url -> local path. */
  private async localImages(urls: string[]): Promise<Map<string, string>> {
    const paths = await Promise.all(urls.map((u) => this.asset(u)))
    return new Map(urls.map((u, i) => [u, paths[i] || u]))
  }

  private async person(u: any): Promise<Person> {
    u = u || {}
    const m = u.metadata || {}
    const name = [u.firstName, u.lastName].filter(Boolean).join(' ') || m.displayName || u.name || 'Member'
    return { id: u.id || '', name, handle: u.name, avatar: await this.asset(m.pictureBubble || m.pictureProfile) }
  }

  /**
   * Signed download of a Skool-hosted file (POST /files/:id/download-url, as Skool's web app does).
   * The request runs inside the logged-in page so Skool's cookies/WAF token apply; `owned` means
   * the caller already holds the browser tab (inside withPage).
   */
  private async fileById(fileId: string, name: string, dest: string, owned = false): Promise<boolean> {
    if (existsSync(dest)) return true
    const path = `/files/${fileId}/download-url?expire=28800`
    const inPage = () => this.loader.apiInPage(path, 'POST')
    let status = 0
    try {
      const r = owned ? await inPage() : await this.loader.run(inPage)
      status = r.status
      const link = r.status < 400 ? urlFromApi(r.text) : null
      if (link) {
        await fetchToFile(link, dest)
        return true
      }
    } catch {
      /* fall back below */
    }
    try {
      const r = await fetchText(`https://api2.skool.com${path}`, { method: 'POST' })
      const link = r.ok ? urlFromApi(r.text) : null
      if (link) {
        await fetchToFile(link, dest)
        return true
      }
      status = status || r.status
    } catch {
      /* give up */
    }
    this.log(`file link request failed for "${name}" (HTTP ${status || '?'})`)
    return false
  }

  // ---------------- video queue
  private enqueue(t: VideoTask) {
    if (this.enqueuedTargets.has(t.target)) return
    this.enqueuedTargets.add(t.target)
    const existing = existingVideo(t.dir, t.stem)
    if (existing) {
      t.target.file = this.rel(existing)
      const cap = existingCaptions(t.dir, t.stem)
      if (cap) t.target.captions = this.rel(cap)
      return
    }
    this.state.videosTotal++
    this.queue.push(t)
    this.pump()
  }

  private pump() {
    const max = speedProfile().videos
    while (this.active < max && this.queue.length && !this.abort.signal.aborted && !this.paused) {
      const t = this.queue.shift()!
      this.active++
      this.runVideo(t).then((outcome) => {
        this.active--
        // a paused video goes back to the front of the queue; anything else counts as handled
        if (outcome === 'paused') this.queue.unshift(t)
        else this.state.videosDone++
        this.state.videos = this.state.videos.filter((v) => v.key !== t.key)
        this.emit()
        this.save()
        this.pump()
        if (!this.active && !this.queue.length) this.idle.splice(0).forEach((f) => f())
      })
    }
    if (!this.active && !this.queue.length) this.idle.splice(0).forEach((f) => f())
  }

  private videosIdle() {
    return new Promise<void>((r) => {
      if (!this.active && !this.queue.length) r()
      else this.idle.push(r)
    })
  }

  private async runVideo(t: VideoTask): Promise<'done' | 'paused' | 'stopped'> {
    const ctrl = new AbortController()
    const stopAll = () => ctrl.abort()
    this.abort.signal.addEventListener('abort', stopAll, { once: true })
    this.taskAborts.set(t.key, ctrl)
    try {
      return await this.runVideoOnce(t, ctrl.signal)
    } finally {
      this.abort.signal.removeEventListener('abort', stopAll)
      this.taskAborts.delete(t.key)
    }
  }

  private async runVideoOnce(t: VideoTask, signal: AbortSignal): Promise<'done' | 'paused' | 'stopped'> {
    const prog = { key: t.key, label: t.label, pct: 0 as number, speed: '' as string | undefined }
    this.state.videos = [...this.state.videos, prog]
    let url = t.url
    // when stopped by pause or Stop, say which so the queue can react
    const why = () => {
      if (this.abort.signal.aborted) return 'stopped' as const
      if (this.interrupted.delete(t.key)) return 'paused' as const
      return null
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const file = await downloadVideo({
          url,
          dir: t.dir,
          stem: t.stem,
          maxHeight: getSettings().maxHeight,
          cookieFile: this.cookieFile,
          durationMs: t.durationMs,
          signal,
          log: (s) => this.log(s),
          onProgress: (pct, speed) => {
            prog.pct = pct
            prog.speed = speed
            this.emit()
          }
        })
        t.target.file = this.rel(file)
        const cap = existingCaptions(t.dir, t.stem)
        if (cap) t.target.captions = this.rel(cap)
        delete t.target.error
        this.log(`✓ video saved: ${t.label}`)
        return 'done'
      } catch (e: any) {
        if (signal.aborted) return why() || 'stopped'
        // Same Mux playback id is also served from Mux's own host.
        if (/\/\/stream\.video\.skool\.com\//.test(url)) {
          url = url.replace('//stream.video.skool.com/', '//stream.mux.com/')
          attempt--
          continue
        }
        // Skool's signed video URLs expire; reload the lesson for a fresh one and retry.
        if (attempt === 0 && t.refresh) {
          this.log(`retrying "${t.label}" with a fresh link (${e.message})`)
          const fresh = await t.refresh().catch(() => null)
          if (fresh) {
            url = fresh
            t.target.source = fresh
            continue
          }
        }
        t.target.error = e.message
        this.fail(`video failed: ${t.label} — ${e.message}`)
        return 'done'
      }
    }
    return 'done'
  }

  // ---------------- main
  async run() {
    const o = this.opts
    mkdirSync(this.dir, { recursive: true })
    try {
      await writeCookieFile(this.cookieFile)
      this.loader.onBackoff = (msg) => this.log(msg)
      this.state.phase = 'Reading community'
      this.emit(true)
      const { pp, courses } = await classroomCourses(this.loader, o.slug)
      const g = pp.currentGroup || {}
      const gm = g.metadata || {}
      const prev = loadGroup(o.slug)
      this.archive = {
        group: {
          id: g.id,
          slug: o.slug,
          name: gm.displayName || o.slug,
          description: gm.description || '',
          color: gm.color || '#F8D481',
          logo: await this.asset(gm.logoUrl || gm.faviconUrl),
          cover: await this.asset(gm.coverSmallUrl),
          url: `${BASE}/${o.slug}`,
          memberCount: gm.totalMembers,
          updatedAt: new Date().toISOString()
        },
        classroom: prev?.classroom || { courses: [] },
        community: prev?.community || { categories: [], posts: [] }
      }
      this.save(true)

      const selected = courses.filter((c) => o.courses.includes(c.id) && c.metadata?.hasAccess !== 0)
      this.state.total = selected.reduce((n, c) => n + (c.metadata?.numModules || 0), 0)
      this.emit(true)

      // classroom keeps Skool's course order; replace downloaded courses, keep others from earlier runs
      for (const [i, c] of selected.entries()) {
        await this.gate()
        const idx = courses.findIndex((x) => x.id === c.id) + 1
        const course = await this.course(c, idx)
        const list = this.archive.classroom.courses.filter((x) => x.id !== course.id)
        list.push(course)
        const order = new Map(courses.map((x, k) => [x.id, k]))
        list.sort((a, b) => (order.get(a.id) ?? 999) - (order.get(b.id) ?? 999))
        this.archive.classroom.courses = list
        this.save(true)
        this.log(`course ${i + 1}/${selected.length} done: ${course.title}`)
      }

      if (o.community) {
        await this.gate()
        await this.community(g)
      }

      // Posts a lesson or another post links to. A few rounds, so a post that links to a post is saved too.
      for (let round = 0; round < 5; round++) {
        for (const p of this.archive.community.posts) {
          this.noteLinks(p.html)
          this.noteTree(p.comments)
        }
        const have = new Set(
          this.archive.community.posts.filter((p) => this.linkSaved(p)).map((p) => p.slug.toLowerCase())
        )
        const missing = [...this.linkedPosts].filter((s) => !have.has(s) && !this.linkAttempts.has(s))
        if (!missing.length) break
        for (const s of missing) this.linkAttempts.add(s)
        this.state.phase = round ? 'Posts linked from posts' : 'Posts linked from lessons'
        this.log(`posts linked from the classroom or community: ${missing.length} to download`)
        this.state.total += missing.length
        this.emit(true)
        await this.pool(missing, speedProfile().posts, async (s) => {
          await this.gate()
          await this.fetchPost(s, true, g.id)
          this.state.done++
          this.emit()
        })
      }

      await this.attachRecordings(g.id)

      if (this.active || this.queue.length) {
        this.state.phase = 'Finishing video downloads'
        this.state.current = ''
        this.emit(true)
        await this.videosIdle()
      }
      await this.gate()
      this.save(true)
      if (this.filledLessons) this.log(`${this.filledLessons} lessons were completed from Skool's course data`)
      this.state.status = 'done'
      this.state.phase = this.state.errors.length ? `Finished with ${this.state.errors.length} issue(s)` : 'Finished'
      this.state.current = ''
    } catch (e: any) {
      if (this.archive) this.save(true)
      const cancelled = this.abort.signal.aborted || e?.message === 'cancelled'
      if (!cancelled) this.log('✗ ' + e.message)
      // Videos already queued keep their files. Finish them before the job is marked stopped.
      if (!cancelled && (this.active || this.queue.length)) {
        this.state.phase = 'Finishing video downloads'
        this.state.current = ''
        this.emit(true)
        await this.videosIdle()
        if (this.archive) this.save(true)
      }
      this.state.status = cancelled ? 'cancelled' : 'error'
      this.state.phase = cancelled ? 'Cancelled' : `Error: ${e.message}`
      this.state.current = ''
    }
    this.emit(true)
  }

  cancel() {
    this.abort.abort()
    this.queue = []
    // a paused job is waiting at a checkpoint: let it continue so it can end as "Cancelled"
    this.paused = false
    this.state.paused = false
    this.resumeWaiters.splice(0).forEach((r) => r())
    this.pump()
  }

  // ---------------- classroom
  private async course(c: any, idx: number): Promise<Course> {
    const cm = c.metadata || {}
    const title = cm.title || c.name
    const folder = `${pad(idx, 2)} - ${safeName(title)}`
    this.state.phase = `Classroom: ${title}`
    this.emit()
    const nd = await this.loader.nextData(`${BASE}/${this.opts.slug}/classroom/${c.name}`)
    const tree = pageProps(nd).course || {}
    writeJson(join(this.dir, 'raw', 'classroom', folder, '_course.json'), pageProps(nd).course || {})

    // lessons saved by earlier runs, for "only new" mode
    const prevCourse = this.archive.classroom.courses.find((x) => x.id === c.id)
    const prevLessons = new Map((prevCourse ? prevCourse.items.flatMap((i) => (i.type === 'set' ? i.items : [i])) : []).map((l) => [l.id, l]))

    let n = 0
    const walk = async (node: any): Promise<(Section | Lesson)[]> => {
      const items: (Section | Lesson)[] = []
      for (const ch of node?.children || []) {
        await this.gate()
        const u = ch.course || {}
        if (u.unitType === 'set') {
          const sub = (await walk(ch)).flatMap((x) => (x.type === 'set' ? x.items : [x]))
          items.push({ type: 'set', id: u.id, title: u.metadata?.title || 'Section', items: sub })
        } else if (u.unitType === 'module') {
          n++
          const prev = prevLessons.get(u.id)
          if (this.skipLessons.has(u.id)) {
            // Leave this lesson out. Keep a copy that is already on disk, and do not update it.
            this.log(`skipped: ${u.metadata?.title || prev?.title || `Lesson ${n}`}`)
            this.state.done++
            if (prev) items.push({ ...prev, n })
            else n--
            this.emit()
            continue
          }
          const sameTitle = prev && prev.title === (u.metadata?.title || prev.title)
          if (this.opts.onlyNew && prev && sameTitle && this.lessonComplete(prev)) {
            // already fully saved: keep it, but still archive the posts it links to
            for (const s of prev.posts || []) this.notePost(s)
            this.noteLinks(prev.html)
            this.state.done++
            items.push({ ...prev, n })
          } else if (this.opts.onlyNew && prev && sameTitle && !prev.video && this.queueRecording(prev, folder, n)) {
            // The lesson has no video of its own; the last run already saved the pinned post that holds it.
            for (const s of prev.posts || []) this.notePost(s)
            this.noteLinks(prev.html)
            this.state.done++
            items.push({ ...prev, n })
          } else {
            try {
              items.push(await this.lesson(c.name, c.id, folder, u, n))
            } catch (e: any) {
              if (this.abort.signal.aborted || e?.message === 'cancelled') throw e
              if (!String(e?.message || '').includes('Could not load ')) throw e
              const name = u.metadata?.title || prev?.title || `Lesson ${n}`
              // Keep a copy already on disk. The next update opens this lesson again.
              this.fail(`lesson page did not load; it will be tried again on the next update: ${name} — ${e.message}`)
              this.state.done++
              if (prev) items.push({ ...prev, n })
              else items.push({ type: 'lesson', id: u.id, n, title: name, html: '', resources: [], videoMissing: true })
              this.emit()
            }
          }
        } else if (ch.children?.length) {
          items.push(...(await walk(ch)))
        }
      }
      return items
    }
    const items = await walk(tree)
    return {
      id: c.id,
      slug: c.name,
      title,
      desc: cm.desc || '',
      cover: await this.asset(cm.coverImage),
      items,
      lessonCount: n
    }
  }

  /** A saved lesson needs no re-download when its video and files are on disk and attached posts were recorded. */
  private lessonComplete(l: Lesson): boolean {
    if (l.posts === undefined) return false // saved before attached-post support
    if ((l.rev ?? 0) < LESSON_REV) return false // saved by an older version: check once more
    if (l.videoMissing) return false // try the video again
    if (l.video && this.opts.videos && !l.video.file) return false
    if (l.video?.file && !existsSync(join(this.dir, l.video.file))) return false
    return l.resources.every((r) => (r.file ? existsSync(join(this.dir, r.file)) : !!r.href))
  }

  /** A saved post needs no re-download when Skool's comment count is unchanged and its media is on disk. */
  private postComplete(p: Post | undefined, comments: number): boolean {
    if (!p) return false
    if (this.opts.comments && p.syncedComments !== comments) return false
    // comments saved before snake_case API fields were handled have no dates/avatars: fetch again
    const undated = (cs: Comment[]): boolean => cs.some((c) => !c.createdAt || undated(c.replies))
    if (this.opts.comments && undated(p.comments)) return false
    if (this.opts.postVideos && p.videos.some((v) => !v.file)) return false
    return p.attachments.every((a) => !!a.file)
  }

  /**
   * A lesson link still needs a download when the post on disk has no comments yet,
   * or its video file is missing. Posts filled from a lesson page look like this
   * until the linked-post pass fetches them.
   */
  private linkSaved(p: Post): boolean {
    if (this.opts.comments && p.commentCount > 0 && p.syncedComments == null) return false
    if (this.opts.postVideos && p.videos.some((v) => !v.file)) return false
    return true
  }

  /** A saved lesson whose video is a pinned post we already have. Skips opening the lesson page again. */
  private queueRecording(prev: Lesson, folder: string, n: number): boolean {
    const hit = (prev.posts || [])
      .map((s) => this.archive.community.posts.find((p) => p.slug === s))
      .find((p) => p?.videos.some((v) => v.source))
    if (!hit) return false
    this.recordingLessons.set(hit.slug, { lessonId: prev.id, folder, stem: `${pad(n)} - ${safeName(prev.title)}` })
    return true
  }

  private findLesson(id: string): Lesson | null {
    const walk = (items: (Section | Lesson)[]): Lesson | null => {
      for (const it of items) {
        if (it.type === 'set') {
          const hit = walk(it.items)
          if (hit) return hit
        } else if (it.id === id) return it
      }
      return null
    }
    for (const c of this.archive?.classroom.courses || []) {
      const hit = walk(c.items)
      if (hit) return hit
    }
    return null
  }

  /** Point the lesson at its pinned post's video and download that file once. */
  private attachRecording(slug: string, videos: VideoRef[], pageUrl: string) {
    const key = [...this.recordingLessons.keys()].find((k) => k.toLowerCase() === slug.toLowerCase())
    const rec = key ? this.recordingLessons.get(key) : undefined
    if (!rec || !key) return
    const lesson = this.findLesson(rec.lessonId)
    const v = videos.find((x) => x.source)
    if (!lesson || !v) return
    lesson.video = v
    lesson.videoMissing = false
    this.recordingLessons.delete(key)
    if (this.opts.videos && !v.file) {
      this.enqueue({
        key: `lesson-recording:${rec.lessonId}`,
        label: lesson.title,
        url: v.source,
        dir: join(this.dir, 'videos', rec.folder),
        stem: rec.stem,
        durationMs: v.durationMs,
        target: v,
        refresh: async () =>
          this.loader.withPage(pageUrl, async (nd) => {
            const fresh = (pageProps(nd).postTree?.videos || [])[0]
            const tok = playbackJwt(fresh?.playbackToken)
            if (fresh?.playbackId && tok) return `https://stream.video.skool.com/${fresh.playbackId}.m3u8?token=${tok}`
            return fresh?.id ? this.playbackFromTokens(String(fresh.id), fresh.playbackId ? String(fresh.playbackId) : undefined) : null
          })
      })
    }
    this.log(`✓ video is on the attached post: ${lesson.title}`)
  }

  /** Lessons recorded only as a pinned post: use the post we already saved, or fetch it now. */
  private async attachRecordings(groupId: string) {
    for (const slug of [...this.recordingLessons.keys()]) {
      const post = this.archive.community.posts.find((p) => p.slug.toLowerCase() === slug.toLowerCase())
      if (post?.videos.some((v) => v.source)) this.attachRecording(slug, post.videos, `${BASE}/${this.opts.slug}/${slug}`)
      else await this.fetchPost(slug, true, groupId)
      if (this.recordingLessons.has(slug)) {
        const lesson = this.findLesson(this.recordingLessons.get(slug)!.lessonId)
        if (lesson) {
          lesson.videoMissing = true
          this.fail(`no video link in Skool's data (the creator may have removed the video): ${lesson.title}`)
        }
        this.recordingLessons.delete(slug)
      }
    }
  }

  private findStream(pp: any, meta: any): string | null {
    // Skool-hosted video: a {playbackId, playbackToken} object, ideally the one matching this lesson's videoId
    const scoped: any = {}
    for (const [k, v] of Object.entries(pp)) if (!['currentGroup', 'self', 'allCourses', 'settings', 'renderData'].includes(k)) scoped[k] = v
    const found: any[] = []
    for (const [, v, parent] of deepFind(scoped, new Set(['playbackId', 'playback_id']))) if (typeof v === 'string' && v) found.push(parent)
    const vid = String(meta.videoId || meta.video_id || '')
    const pick = found.find((p) => vid && [p.id, p.videoId, p.video_id].map(String).includes(vid)) || found[0]
    if (pick) {
      const id = pick.playbackId || pick.playback_id
      const tok = playbackJwt(pick.playbackToken || pick.playback_token || pick.token)
      // A playback id with no playback JWT is refused by Mux (403). Ask for the token instead of saving that link.
      if (id && tok) return `https://stream.video.skool.com/${id}.m3u8?token=${tok}`
    }
    const link = String(meta.videoLink || meta.video_link || '').trim()
    if (/^https?:/.test(link)) return loomShareUrl(link) || link
    // Some courses only carry a Loom thumbnail; its address contains the Loom video id
    return loomShareUrl(meta.videoThumbnail || meta.video_thumbnail)
  }

  /**
   * Some lesson pages include playbackId, thumbnailToken and expire, and leave out playbackToken.
   * Skool's player then POSTs /videos/:id/tokens. Call while owning the tab.
   * An in-page 401 leaves the session cookie off, so the next try sends that cookie and no Bearer header.
   */
  private async playbackFromTokens(videoId: string, playbackId?: string): Promise<string | null> {
    this.playbackNote = ''
    if (!/^[0-9a-f-]{16,}$/i.test(videoId)) return null
    const path = `/videos/${videoId}/tokens`
    const tried: { status: number; text: string }[] = []
    const take = (r: { status: number; text: string }) => {
      tried.push(r)
      return playbackUrl(r, playbackId)
    }
    // Skool posts this with cookies only, and attaches the page's one-shot x-sk-sec nonce
    // only after that call comes back without a playback JWT. A 401 is not that case.
    let url = take(await this.loader.apiInPage(path, 'POST'))
    const first = tried[0]
    if (!url && first.status !== 0 && first.status !== 401) {
      const nonce = await this.loader.pageSecurityNonce()
      if (nonce) url = take(await this.loader.apiInPage(path, 'POST', { 'x-sk-sec': nonce }))
    }
    if (!url) {
      try {
        const session = await fetchText(`https://api2.skool.com${path}`, { method: 'POST' }, 'cookie')
        url = take(session)
        // GET /videos/:id is the owner's status poll ("only owner can read status").
        // Members fill a missing playback token with POST /videos/:id/request-data.
        if (!url && session.status >= 400) {
          const dataPath = `/videos/${videoId}/request-data`
          const data = await this.loader.apiInPage(dataPath, 'POST')
          url = take(data)
          if (!url && data.status >= 400) url = take(await fetchText(`https://api2.skool.com${dataPath}`, { method: 'POST' }, 'cookie'))
        }
      } catch {
        /* the in-page result is still the one to report */
      }
    }
    if (!url) this.playbackNote = ` (${playbackFailureNotes(tried)})`
    return url
  }

  /** Signed Skool/Mux link from the page, or a fresh one from /videos/:id/tokens when the page omitted it. */
  private async streamFor(pp: any, meta: any): Promise<string | null> {
    this.playbackNote = ''
    const direct = this.findStream(pp, meta)
    if (direct) return direct
    const pageVideo = pp?.video && typeof pp.video === 'object' ? pp.video : null
    const vid = String(pageVideo?.id || meta?.videoId || meta?.video_id || '')
    if (pageVideo?.playbackId && !playbackJwt(pageVideo.playbackToken) && vid) {
      if (courseLockNote(pp)) return null
      return this.playbackFromTokens(vid, String(pageVideo.playbackId))
    }
    return null
  }

  /** Skool's full course data (GET /courses/:id, as its lesson page uses), fetched once per course. */
  private courseData = new Map<string, Promise<any>>()
  private courseFromApi(courseId: string): Promise<any> {
    if (!this.courseData.has(courseId))
      this.courseData.set(
        courseId,
        this.loader.apiInPage(`/courses/${courseId}`).then((r) => (r.status < 400 ? camelize(parseJson(r.text)) : null))
      )
    return this.courseData.get(courseId)!
  }

  /** Lesson resources come in a few shapes: {title, link}, {file_id, file_name}, or {file: {metadata: {read_url}}}. */
  private parseResources(raw: any): { name: string; href?: string; fileId?: string; readUrl?: string; type?: string; fileName?: string }[] {
    const out: any[] = []
    const seen = new Set<string>()
    const walk = (n: any) => {
      if (Array.isArray(n)) return n.forEach(walk)
      if (!n || typeof n !== 'object') return
      const file = n.file && typeof n.file === 'object' ? n.file : null
      const fmeta = file ? file.metadata || file : {}
      const fileId = n.file_id || n.fileId || file?.id || file?.file_id
      const name = n.title || n.file_name || n.fileName || n.label || n.name || fmeta.file_name || fmeta.title || fmeta.name
      const readUrl = fmeta.read_url || fmeta.readUrl || n.read_url || n.readUrl
      const link = n.link || n.url || n.href
      const type = n.file_content_type || fmeta.content_type || fmeta.file_content_type
      if (fileId || readUrl) {
        const key = fileId || readUrl
        if (!seen.has(key))
          out.push({ name: String(name || 'Download'), fileId, readUrl, type, fileName: n.file_name || n.fileName || fmeta.file_name, href: typeof link === 'string' ? link : undefined })
        seen.add(key)
        return
      }
      if (typeof link === 'string' && /^https?:/.test(link)) {
        if (!seen.has(link)) out.push({ name: String(name || link), href: link })
        seen.add(link)
        return
      }
      Object.values(n).forEach((v) => v && typeof v === 'object' && walk(v))
    }
    walk(parseJson(raw, typeof raw === 'string' && /^https?:/.test(raw) ? [{ link: raw }] : []))
    return out
  }

  /** Save a resource file: direct read_url first, then the signed-URL API, then clicking it on the page. */
  private async saveResource(r: { name: string; fileId?: string; readUrl?: string; type?: string }, dest: string, onPage: boolean) {
    if (existsSync(dest)) return true
    if (r.readUrl) {
      try {
        await fetchToFile(r.readUrl, dest)
        return true
      } catch {
        /* fall through */
      }
    }
    if (r.fileId && (await this.fileById(r.fileId, r.name, dest, onPage))) return true
    return onPage ? this.loader.clickDownload(r.name, dest) : false
  }

  private async lesson(courseSlug: string, courseId: string, folder: string, unit: any, n: number): Promise<Lesson> {
    const lid = unit.id
    let title = unit.metadata?.title || `Lesson ${n}`
    this.state.current = title
    this.emit()
    const url = `${BASE}/${this.opts.slug}/classroom/${courseSlug}?md=${lid}`
    const stemOf = (t: string) => `${pad(n)} - ${safeName(t)}`
    const filesDir = join(this.dir, 'files', folder)

    const res = await this.loader.withPage(url, async (nd) => {
      const pp = pageProps(nd)
      const meta: any = { ...(unit.metadata || {}) }
      for (const [, v, parent] of deepFind(pp.course || {}, new Set(['id']))) {
        if (v === lid && parent.metadata && typeof parent.metadata === 'object') {
          Object.assign(meta, parent.metadata)
          break
        }
      }
      // Some courses arrive slimmed down (title + thumbnail only); Skool's page then loads the
      // lesson details separately. Take them from what the page received, else from the course data.
      if (!('desc' in meta) && !('videoLink' in meta) && !('resources' in meta)) {
        const fromNode = (data: any) => {
          for (const [, v, parent] of deepFind(data, new Set(['id'])))
            if (v === lid && parent.metadata && typeof parent.metadata === 'object' && Object.keys(parent.metadata).length > Object.keys(meta).length)
              return parent.metadata
          return null
        }
        let full: any = null
        for (const r of this.loader.apiResponses) if (!full) full = fromNode(camelize(parseJson(r.body)))
        if (!full) full = fromNode(await this.courseFromApi(courseId))
        if (full) {
          Object.assign(meta, full)
          this.filledLessons++
        }
      }
      let stream = await this.streamFor(pp, meta)
      // A duration with an empty link is not a player. Probing it only waits and still finds nothing.
      const linkHint = !!(meta.videoId || meta.video_id || String(meta.videoLink || meta.video_link || '').trim() || loomShareUrl(meta.videoThumbnail || meta.video_thumbnail))
      if (!stream && linkHint) stream = playable(await this.loader.probeVideo())

      // attachments: direct URL / API first, then click-to-download on the open page
      const resources: Attachment[] = []
      for (const r of this.parseResources(meta.resources)) {
        const item: Attachment = { name: r.name, href: r.href || null, type: r.type }
        if (r.fileId || r.readUrl) {
          const dest = join(filesDir, `${pad(n)} - ${fileNameFor(r.name, r.fileName, r.type)}`)
          if (await this.saveResource(r, dest, true)) item.file = this.rel(dest)
          else this.fail(`attachment not downloaded: ${title} / ${r.name}`)
        }
        resources.push(item)
      }
      // community posts the creator attached to this lesson (Skool shows them as post cards)
      const pinned: { name: string; hasVideo: boolean }[] = (Array.isArray(pp.pinnedPosts) ? pp.pinnedPosts : [])
        .map((t: any) => t?.post || t)
        .filter((p: any) => p?.name && (!p.metadata?.pinnedModule || p.metadata.pinnedModule === lid))
        .map((p: any) => ({ name: p.name as string, hasVideo: postCarriesVideo(p) }))
      return { pp, meta, stream, resources, pinned }
    })
    await this.gate()
    writeJson(join(this.dir, 'raw', 'classroom', folder, `${pad(n)}_${lid}.json`), res.pp)

    const meta = res.meta
    title = meta.title || title
    const desc = meta.desc || ''
    // Lessons often just link to a community post; remember those so we archive them too.
    this.noteLinks(JSON.stringify(desc) + JSON.stringify(meta.resources || ''))
    for (const s of res.pinned) this.notePost(s.name)
    const local = await this.localImages(imageUrls(desc))
    const html = toHtml(desc, (u) => local.get(u) || u)

    let video: VideoRef | null = null
    if (res.stream) {
      video = { source: res.stream, durationMs: meta.videoLenMs || null, thumb: await this.asset(meta.videoThumbnail) }
      if (this.opts.videos) {
        this.enqueue({
          key: lid,
          label: title,
          url: res.stream,
          dir: join(this.dir, 'videos', folder),
          stem: stemOf(title),
          durationMs: meta.videoLenMs,
          target: video,
          refresh: async () =>
            this.loader.withPage(url, async (nd) => {
              const pp = pageProps(nd)
              return (await this.streamFor(pp, meta)) || playable(await this.loader.probeVideo())
            })
        })
      }
    }
    // say what's actually missing, and remember it so "only new" tries this lesson again next time
    let videoMissing = false
    if (!res.stream) {
      const recording = res.pinned.find((p) => p.hasVideo)
      if (recording) {
        // The lesson module has an empty video link. The recording is the pinned community post.
        this.recordingLessons.set(recording.name, { lessonId: lid, folder, stem: stemOf(title) })
        videoMissing = true
      } else if (res.pp?.video?.playbackId && !playbackJwt(res.pp.video.playbackToken)) {
        videoMissing = true
        const lock = courseLockNote(res.pp)
        this.fail(lock ? `${lock}: ${title}` : `could not get a playback link: ${title}${this.playbackNote}`)
      } else if (meta.videoId || meta.videoLink || loomShareUrl(meta.videoThumbnail)) {
        videoMissing = true
        this.fail(`video not found on page: ${title}`)
      } else if (meta.videoLenMs) {
        videoMissing = true
        this.fail(`no video link in Skool's data (the creator may have removed the video): ${title}`)
      }
    }

    this.state.done++
    this.emit()
    return { type: 'lesson', id: lid, n, title, html, video, resources: res.resources, posts: res.pinned.map((p) => p.name), rev: LESSON_REV, videoMissing }
  }

  // ---------------- community
  private async community(g: any) {
    const o = this.opts
    this.state.phase = 'Community: listing posts'
    this.state.current = ''
    this.emit(true)

    const feed: any[] = []
    const seen = new Set<string>()
    let categories: Category[] = []
    let pageMisses = 0
    for (let p = 1; p < 2000; p++) {
      await this.gate()
      let pp: any
      try {
        pp = pageProps(await this.loader.nextData(`${BASE}/${o.slug}${p > 1 ? `?p=${p}` : ''}`))
        pageMisses = 0
      } catch (e: any) {
        if (this.abort.signal.aborted || e?.message === 'cancelled') throw e
        pageMisses++
        const why = String(e?.message || e)
        // One bad page is skipped. Two in a row means the feed has stopped responding.
        if (pageMisses < 2) {
          this.log(`community page ${p} did not load; trying the next page. ${why}`)
          continue
        }
        this.fail(
          feed.length
            ? `community page ${p} did not load (${why}). Later pages were skipped; the ${feed.length} posts found before it are still saved.`
            : `community page ${p} did not load (${why}).`
        )
        break
      }
      if (p === 1) categories = this.categories(pp, g)
      const posts = postsOf(pp)
      // checked one by one: Skool lists pinned posts twice on the same page
      let added = 0
      for (const x of posts) {
        if (!x?.id || seen.has(x.id) || seen.has('slug:' + x.name)) continue
        seen.add(x.id)
        seen.add('slug:' + x.name)
        feed.push(x)
        added++
      }
      if (!added) break
      this.state.current = `${feed.length} posts found`
      this.emit()
      if (o.maxPosts && feed.length >= o.maxPosts) break
    }
    const list = o.maxPosts ? feed.slice(0, o.maxPosts) : feed
    this.log(`community: ${list.length} posts`)
    this.state.total += list.length
    this.state.phase = 'Community: downloading posts'
    this.emit(true)

    this.archive.community.categories = categories
    let skipped = 0
    // Several posts in flight: page loads still queue one at a time in the loader,
    // but each post's media downloads while the next post's page loads.
    await this.pool(list, speedProfile().posts, async (raw) => {
      await this.gate()
      const saved = this.archive.community.posts.find((p) => p.id === raw.id)
      if (o.onlyNew && this.postComplete(saved, Number(raw.metadata?.comments || 0))) {
        skipped++
      } else {
        await this.fetchPost(raw, o.comments, g.id)
      }
      this.state.done++
      this.emit()
    })
    if (o.onlyNew) this.log(`community: ${skipped} unchanged posts skipped, ${list.length - skipped} new or updated`)
  }

  /** Remember a community post slug so a later pass downloads it if it is not in the archive yet. */
  private notePost(slug: string) {
    const s = String(slug || '').trim().toLowerCase()
    if (s && !RESERVED.has(s)) this.linkedPosts.add(s)
  }

  private noteLinks(text: string) {
    for (const s of postLinks(text, this.opts.slug)) this.notePost(s)
  }

  private noteTree(cs: Comment[]) {
    for (const c of cs) {
      this.noteLinks(c.html)
      if (c.replies.length) this.noteTree(c.replies)
    }
  }

  /** Download one post (by feed object or slug), with comments, and merge it into the archive. */
  private async fetchPost(raw: any, comments: boolean, groupId: string) {
    const name = typeof raw === 'string' ? raw : raw.name
    this.state.current = (typeof raw === 'object' && raw.metadata?.title) || name
    this.emit()
    let full = typeof raw === 'object' ? raw : null
    let children: any[] = []
    let videos: any[] = []
    const url = `${BASE}/${this.opts.slug}/${name}`
    try {
      // Open the post like a visitor would. Skool's page then loads the comments itself;
      // we read that response, and page through the rest from inside the page if needed.
      const res = await this.loader.withPage(url, async (nd) => {
        const pp = pageProps(nd)
        const tree = pp.postTree || findTree(pp, full?.id)
        const post = tree?.post ? { ...(full || {}), ...tree.post, user: tree.post.user || full?.user } : full
        let kids: any[] = []
        if (comments && post?.id) kids = await this.loadComments(post, groupId, tree?.children || [])
        for (const v of Array.isArray(tree?.videos) ? tree.videos : []) {
          if (v?.playbackId && !playbackJwt(v.playbackToken) && v.id) {
            const signed = await this.playbackFromTokens(String(v.id), String(v.playbackId))
            const tok = signed ? new URL(signed).searchParams.get('token') : null
            if (tok) v.playbackToken = tok
          }
        }
        return { pp, tree, post, kids }
      })
      writeJson(join(this.dir, 'raw', 'community', `${safeName(name)}.json`), { ...(res.tree || res.pp), comments: res.kids })
      full = res.post
      children = res.kids
      videos = res.tree?.videos || []
    } catch (e: any) {
      this.fail(`post page failed: ${name} — ${e.message}`)
    }
    if (!full?.id) return null
    const expected = Number(full.metadata?.comments || 0)
    if (comments && expected && countTree(children) < expected)
      this.log(`comments: got ${countTree(children)}/${expected} for "${full.metadata?.title || name}"`)
    try {
      const post = await this.post(full, children, videos, url)
      await this.mergePost(post, url)
      return post
    } catch (e: any) {
      this.fail(`post failed: ${name} — ${e.message}`)
      return null
    }
  }

  /** Keep the richer saved copy, then swap this post into the archive. One merge at a time. */
  private mergePost(post: Post, url: string): Promise<void> {
    const job = this.postChain.then(() => {
      const saved = this.archive.community.posts.find((p) => p.id === post.id)
      const size = (cs: Comment[]): number => cs.reduce((n, c) => n + 1 + size(c.replies), 0)
      if (saved && size(saved.comments) > size(post.comments)) {
        post.comments = saved.comments
        post.syncedComments = saved.syncedComments
      }
      post.videos.forEach((v, i) => {
        const old = saved?.videos[i]
        if (!v.file && old?.file && old.source.split('?')[0] === v.source.split('?')[0]) v.file = old.file
      })
      const posts = this.archive.community.posts.filter((p) => p.id !== post.id)
      posts.push(post)
      posts.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.createdAt.localeCompare(a.createdAt))
      this.archive.community.posts = posts
      this.attachRecording(post.slug, post.videos, url)
      this.noteLinks(post.html)
      this.noteTree(post.comments)
      this.save()
    })
    this.postChain = job.then(
      () => undefined,
      () => undefined
    )
    return job
  }

  private categories(pp: any, g: any): Category[] {
    const ids = String(g.metadata?.labels || '').split(',').filter(Boolean)
    const out = new Map<string, Category>()
    for (const [, v, parent] of deepFind(pp, new Set(['id']))) {
      if (ids.includes(v) && parent.metadata) {
        const name = parent.metadata.displayName || parent.metadata.name || parent.name
        if (name) out.set(v, { id: v, name })
      }
    }
    return ids.filter((i) => out.has(i)).map((i) => out.get(i)!)
  }

  /**
   * All comments + replies of a post, as a {post, children} tree. Called while owning the post page:
   * uses the comments response Skool's page fetched, then GET /posts/:id/comments from inside the page.
   */
  private async loadComments(post: any, groupId: string, initial: any[]): Promise<any[]> {
    const expected = Number(post.metadata?.comments || 0)
    const bodies: any[] = [initial]
    const count = () => buildCommentTree(bodies, post.id).count
    if (!expected) return buildCommentTree(bodies, post.id).tree

    // Each comments response carries `first`/`last` cursors; Skool's page asks for the next batch
    // with created-gt=<last> (newer) and created-lt=<first> (older), 25 top-level comments at a time.
    let first: string | null = null
    let last: string | null = null
    const take = (body: any) => {
      if (!body || typeof body !== 'object') return
      bodies.push(body)
      if (body.first != null && (first == null || String(body.first) < first)) first = String(body.first)
      if (body.last != null && (last == null || String(body.last) > last)) last = String(body.last)
    }
    const seen = await this.loader.waitForApi(new RegExp(`/posts/${post.id}/comments`), 8000)
    if (seen) take(camelize(parseJson(seen.body)))

    const base = `/posts/${post.id}/comments?group-id=${groupId}&limit=25`
    const get = async (q: string): Promise<any> => {
      const r = await this.loader.apiInPage(base + q)
      if (r.status >= 400) {
        this.log(`comments API HTTP ${r.status} for "${post.metadata?.title || post.name}"`)
        return null
      }
      const body = camelize(parseJson(r.text))
      take(body)
      return body || {}
    }
    if (count() < expected && !seen) await get('')

    for (const dir of ['gt', 'lt'] as const) {
      for (let i = 0; i < 200 && count() < expected; i++) {
        const before = count()
        // prefer Skool's own cursor; fall back to the newest/oldest comment date
        const t = buildCommentTree(bodies, post.id)
        const cursor = (dir === 'gt' ? last : first) ?? (dir === 'gt' ? t.latest : t.earliest)
        if (!cursor) break
        const body = await get(`&created-${dir}=${encodeURIComponent(cursor)}`)
        if (!body || count() === before) break
      }
    }
    return buildCommentTree(bodies, post.id).tree
  }

  /** A post's or comment's attachments: images go to the gallery, files are saved. All in parallel, order kept. */
  private async media(m: any, key: string) {
    const list = parseJson<any>(m.attachmentsData, []) || []
    const atts: any[] = (Array.isArray(list) ? list : list.attachments || list.attachments_data || []).filter(
      (a: any) => a && typeof a === 'object'
    )
    const results = await Promise.all(
      atts.map(async (a): Promise<{ image?: string; file?: Attachment }> => {
        const meta = a.metadata || {}
        const type = String(a.file_content_type || a.content_type || meta.content_type || a.type || '')
        let url: string | null = a.url || a.image_url || meta.url || meta.read_url || a.read_url || a.file_url || null
        if (!url)
          for (const [, v] of deepFind(a, new Set(['url', 'image', 'src'])))
            if (typeof v === 'string' && /^https?:/.test(v)) {
              url = v
              break
            }
        const name = a.file_name || meta.file_name || a.title || 'file'
        const isImage = type.startsWith('image') || /\.(png|jpe?g|gif|webp|avif)(\?|$)/i.test(url || '') || /\.(png|jpe?g|gif|webp)$/i.test(name)
        if (isImage && url) return { image: (await this.asset(url)) || undefined }
        if (!(a.id || a.file_id || url)) return {}
        const item: Attachment = { name, href: url, type }
        const dest = join(this.dir, 'files', 'community', `${safeName(key, 40)} - ${fileNameFor(name, name, type)}`)
        let ok = existsSync(dest)
        if (!ok && url && /(assets|files)\.skool\.com|amazonaws\.com|cloudfront\.net/.test(url)) {
          try {
            await this.withSlot(() => fetchToFile(url!, dest))
            ok = true
          } catch {
            /* fall through */
          }
        }
        if (!ok && (a.file_id || a.id)) ok = await this.fileById(a.file_id || a.id, name, dest)
        if (ok) item.file = this.rel(dest)
        return { file: item }
      })
    )
    return {
      images: results.flatMap((r) => (r.image ? [r.image] : [])),
      attachments: results.flatMap((r) => (r.file ? [r.file] : []))
    }
  }

  private async post(p: any, children: any[], hosted: any[] = [], pageUrl = ''): Promise<Post> {
    const m = p.metadata || {}
    const { images, attachments } = await this.media(m, p.name || p.id)
    const local = await this.localImages(imageUrls(m.content))

    const videos: VideoRef[] = []
    // Skool-hosted (Mux) videos uploaded to the post
    for (const [i, v] of hosted.entries()) {
      if (!v?.playbackId) continue
      const tok = playbackJwt(v.playbackToken)
      if (!tok) {
        this.fail(`could not get a playback link: ${m.title || p.name}${this.playbackNote}`)
        // Keep a file-less entry so the next update tries the token request again.
        videos.push({ source: `https://stream.video.skool.com/${v.playbackId}.m3u8`, durationMs: v.duration || null, error: 'could not get a playback link' })
        continue
      }
      const stream = `https://stream.video.skool.com/${v.playbackId}.m3u8?token=${tok}`
      const thumbUrl = i === 0 && m.imagePreview ? m.imagePreview : v.thumbnailToken ? `https://image.video.skool.com/${v.playbackId}/thumbnail.jpg?token=${v.thumbnailToken}` : null
      const ref: VideoRef = { source: stream, thumb: await this.asset(thumbUrl), durationMs: v.duration || null }
      videos.push(ref)
      if (this.opts.postVideos)
        this.enqueue({
          key: `${p.id}-h${i}`,
          label: `${m.title || p.name}${hosted.length > 1 ? ` (video ${i + 1})` : ''}`,
          url: stream,
          dir: join(this.dir, 'videos', 'community'),
          stem: `${safeName(p.name || p.id, 60)}-v${i + 1}`,
          durationMs: v.duration,
          target: ref,
          refresh: pageUrl
            ? async () =>
                this.loader.withPage(pageUrl, async (nd) => {
                  const fresh = (pageProps(nd).postTree?.videos || []).find((x: any) => x.id === v.id || x.playbackId === v.playbackId)
                  const tok = playbackJwt(fresh?.playbackToken)
                  if (fresh?.playbackId && tok) return `https://stream.video.skool.com/${fresh.playbackId}.m3u8?token=${tok}`
                  return fresh?.id ? this.playbackFromTokens(String(fresh.id), fresh.playbackId ? String(fresh.playbackId) : undefined) : null
                })
            : undefined
        })
    }
    const vlist = parseJson<any>(m.videoLinksData, []) || []
    for (const [i, v] of (Array.isArray(vlist) ? vlist : []).entries()) {
      const url = v?.url || v?.link
      if (!url) continue
      const ref: VideoRef = { source: url, thumb: await this.asset(v.thumbnail || v.thumbnail_url || v.image) }
      videos.push(ref)
      if (this.opts.postVideos)
        this.enqueue({
          key: `${p.id}-${i}`,
          label: `${m.title || p.name} (video ${i + 1})`,
          url,
          dir: join(this.dir, 'videos', 'community'),
          stem: `${safeName(p.name || p.id, 60)}-${i + 1}`,
          target: ref
        })
    }

    return {
      id: p.id,
      slug: p.name,
      title: m.title || '',
      html: toHtml(m.content || '', (u) => local.get(u) || u),
      text: toText(m.content || '').slice(0, 2000),
      author: await this.person(p.user),
      createdAt: p.createdAt || '',
      updatedAt: p.updatedAt,
      upvotes: Number(m.upvotes || 0),
      commentCount: Number(m.comments || 0),
      // mark comments as synced only if we actually got (nearly) all of them; otherwise retry next time
      syncedComments:
        this.opts.comments && countTree(children) >= Number(m.comments || 0) - 1 ? Number(m.comments || 0) : undefined,
      pinned: !!Number(m.pinned || 0),
      category: m.labels || null,
      images,
      videos,
      attachments,
      comments: await Promise.all(children.map((c) => this.comment(c)))
    }
  }

  private async comment(node: any): Promise<Comment> {
    const c = node.post || node
    const m = c.metadata || {}
    const { images, attachments } = await this.media(m, c.id)
    const local = await this.localImages(imageUrls(m.content))
    const replies: Comment[] = await Promise.all((node.children || []).map((r: any) => this.comment(r)))
    return {
      id: c.id,
      author: await this.person(c.user),
      createdAt: c.createdAt || '',
      html: toHtml(m.content || '', (u) => local.get(u) || u),
      upvotes: Number(m.upvotes || 0),
      images,
      attachments,
      replies
    }
  }
}

const MIME_EXT: Record<string, string> = {
  'text/plain': '.txt', 'text/markdown': '.md', 'text/csv': '.csv', 'text/html': '.html', 'application/json': '.json',
  'application/pdf': '.pdf', 'application/zip': '.zip', 'application/msword': '.doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp',
  'audio/mpeg': '.mp3', 'audio/wav': '.wav', 'video/mp4': '.mp4'
}
const realExt = (n?: string) => {
  const m = /\.([a-z0-9]{1,6})$/i.exec(String(n || '').trim())
  return m && !/^\d+$/.test(m[1]) ? '.' + m[1].toLowerCase() : ''
}

/** "<title>.<ext>": extension from the original file name, else the content type (a title like "Notes 2.0" has none). */
export function fileNameFor(title: string, original?: string, type?: string): string {
  const ext = realExt(original) || MIME_EXT[String(type || '').split(';')[0].trim().toLowerCase()] || ''
  const base = safeName(title || original || 'file', 120)
  return base.toLowerCase().endsWith(ext) ? base : base + ext
}

const RESERVED = new Set(['classroom', 'about', 'members', 'leaderboards', 'calendar', 'map', 'settings', '-', 'admin', 'chat', 'notifications'])

/** A pinned post that holds the lesson recording: a Skool upload id, or a Skool video thumbnail. */
function postCarriesVideo(p: any): boolean {
  const m = p?.metadata || {}
  if (String(m.videoIds || m.video_ids || '').trim()) return true
  return /\/\/(?:image|stream)\.video\.skool\.com\//.test(String(m.imagePreview || m.image_preview || m.imagePreviewSmall || ''))
}

/** Slugs of community posts linked as https://www.skool.com/<group>/<post-slug>. */
function postLinks(text: string, slug: string): string[] {
  const esc = slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`skool\\.com/${esc}/([a-z0-9][a-z0-9-]*)`, 'gi')
  const out = new Set<string>()
  for (const m of text.matchAll(re)) if (!RESERVED.has(m[1].toLowerCase())) out.add(m[1])
  return [...out]
}

function postsOf(pp: any): any[] {
  if (Array.isArray(pp.postTrees)) return pp.postTrees.map((t: any) => t.post || t)
  for (const [, v] of deepFind(pp, new Set(['postTrees', 'posts']))) {
    if (Array.isArray(v) && v.length && (v[0]?.post || v[0]?.metadata)) return v.map((t: any) => t.post || t)
  }
  return []
}

function findTree(pp: any, id: string): any {
  for (const [, v] of deepFind(pp, new Set(['postTree']))) if (v?.post) return v
  for (const [, v, parent] of deepFind(pp, new Set(['post']))) if (v?.id === id) return parent
  return null
}

/**
 * Skool's REST API (api2.skool.com) uses snake_case (created_at, parent_id, first_name, picture_bubble)
 * while page data uses camelCase. Convert API objects so the rest of the code sees one shape.
 */
/**
 * Skool omits the playback link when the course has not unlocked.
 * Drip is counted from the member's approved date.
 */
function courseLockNote(pp: any): string | null {
  const meta = pp?.course?.course?.metadata || pp?.course?.metadata
  if (!meta || meta.hasAccess === 1 || meta.hasAccess === true) return null
  let drip: any = null
  try {
    drip = typeof meta.dripConfig === 'string' ? JSON.parse(meta.dripConfig) : meta.dripConfig
  } catch {
    drip = null
  }
  const days = Number(drip?.days)
  if (drip?.enabled && days > 0) {
    const joined = pp?.self?.member?.approvedAt || pp?.self?.member?.createdAt
    const start = joined ? new Date(joined) : null
    if (start && !Number.isNaN(start.getTime())) {
      const until = new Date(start.getTime() + days * 86400000)
      return `locked until ${until.toISOString().slice(0, 10)} (opens ${days} days after joining)`
    }
    return `locked until ${days} days after joining`
  }
  if (meta.hasAccess === 0) return 'locked on Skool'
  return null
}

/** Playback JWTs are aud "v". Thumbnail tokens (aud "t") are not accepted on the playlist. */
function playbackJwt(tok: unknown): string | null {
  const s = String(tok || '')
  const mid = s.split('.')[1]
  if (!mid) return null
  try {
    const json = JSON.parse(Buffer.from(mid, 'base64url').toString('utf8'))
    return json?.aud === 'v' ? s : null
  } catch {
    return null
  }
}

/** Pull a signed playlist URL out of a /videos/:id/tokens body. */
function urlFromPlayback(data: any, playbackId?: string): string | null {
  if (typeof data === 'string') {
    if (data[0] === '{' || data[0] === '[') {
      const parsed = parseJson(data)
      if (parsed && typeof parsed === 'object') return urlFromPlayback(camelize(parsed), playbackId)
    }
    const tok = playbackJwt(data)
    return playbackId && tok ? `https://stream.video.skool.com/${playbackId}.m3u8?token=${tok}` : null
  }
  if (!data || typeof data !== 'object') return null
  if (Array.isArray(data)) {
    for (const x of data) {
      const hit = urlFromPlayback(x, playbackId)
      if (hit) return hit
    }
    return null
  }
  const ownId = data.playbackId || data.playback_id
  const id = typeof ownId === 'string' && ownId ? ownId : playbackId
  const tok = playbackJwt(data.playbackToken || data.playback_token || data.tokens?.playback || data.playback)
  if (id && tok) return `https://stream.video.skool.com/${id}.m3u8?token=${tok}`
  for (const v of Object.values(data)) {
    if (typeof v === 'string' || (v && typeof v === 'object')) {
      const hit = urlFromPlayback(v, id)
      if (hit) return hit
    }
  }
  return null
}

function playbackUrl(r: { status: number; text: string }, playbackId?: string): string | null {
  if (r.status >= 400 || !r.text) return null
  return urlFromPlayback(camelize(parseJson(r.text)), playbackId)
}

/** Every distinct reply, so a later owner-only error does not hide the token request. */
function playbackFailureNotes(tried: { status: number; text: string }[]): string {
  const out: string[] = []
  const seen = new Set<string>()
  for (const r of tried) {
    const n = playbackFailureNote(r)
    if (seen.has(n)) continue
    seen.add(n)
    out.push(n)
  }
  return out.join('; ') || 'HTTP 0'
}

/** Status, field names, and a short plain reply. Never the token itself. */
function playbackFailureNote(r: { status: number; text: string }): string {
  const j = parseJson(r.text)
  const obj = j && typeof j === 'object' && !Array.isArray(j) ? (j as Record<string, unknown>) : null
  const raw = obj ? obj.code ?? (obj.error as any)?.code ?? (obj.data as any)?.code : null
  const code = typeof raw === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(raw) ? raw : typeof raw === 'number' ? String(raw) : ''
  const keys = obj ? Object.keys(obj).slice(0, 8).join(',') : ''
  let snippet = ''
  if (!obj) {
    const t = String(r.text || '').replace(/\s+/g, ' ').trim()
    if (t && !t.includes('eyJ') && t.length <= 200) snippet = ' ' + JSON.stringify(t.slice(0, 60))
  }
  return `HTTP ${r.status}${code ? ' ' + code : ''}${keys ? ' ' + keys : ''}${snippet}`
}

/** Drop a Skool/Mux playlist that has no playback token. Other hosts pass through. */
function playable(url: string | null | undefined): string | null {
  if (!url) return null
  if (/\/\/stream\.(video\.skool|mux)\.com\/[^/?]+\.m3u8(?=$|\?)/.test(url) && !/[?&]token=/.test(url)) return null
  return url
}

export function camelize(v: any): any {
  if (Array.isArray(v)) return v.map(camelize)
  if (!v || typeof v !== 'object') return v
  const out: any = {}
  for (const [k, val] of Object.entries(v)) out[k.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase())] = camelize(val)
  return out
}

/**
 * Merge comment data from any number of responses (nested {post, children} trees or flat lists)
 * into one de-duplicated tree under `rootId`, using parentId where present.
 */
export function buildCommentTree(
  bodies: any[],
  rootId: string
): { tree: any[]; count: number; latest: string | null; earliest: string | null } {
  const nodes = new Map<string, { post: any; nestParent: string | null }>()
  const visit = (o: any, nestParent: string | null) => {
    if (!o || typeof o !== 'object') return
    if (Array.isArray(o)) return o.forEach((x) => visit(x, nestParent))
    const p = o.post && typeof o.post === 'object' ? o.post : o.metadata && o.id && 'content' in (o.metadata || {}) ? o : null
    if (p?.id && p.id !== rootId) {
      const prev = nodes.get(p.id)
      if (!prev || (!prev.post.user && p.user)) nodes.set(p.id, { post: p, nestParent: prev?.nestParent ?? nestParent })
      if (Array.isArray(o.children)) o.children.forEach((c: any) => visit(c, p.id))
      return
    }
    for (const v of Object.values(o)) if (v && typeof v === 'object') visit(v, p?.id === rootId ? null : nestParent)
  }
  bodies.forEach((b) => visit(b, null))
  const kids = new Map<string | null, any[]>()
  for (const [id, n] of nodes) {
    let parent: string | null = n.post.parentId && n.post.parentId !== rootId && nodes.has(n.post.parentId) ? n.post.parentId : n.nestParent
    if (parent === id || !nodes.has(parent || '')) parent = null
    if (!kids.has(parent)) kids.set(parent, [])
    kids.get(parent)!.push({ post: n.post, children: [] as any[] })
  }
  const build = (parent: string | null): any[] =>
    (kids.get(parent) || [])
      .sort((a, b) => String(a.post.createdAt).localeCompare(String(b.post.createdAt)))
      .map((n) => ({ post: n.post, children: build(n.post.id) }))
  const top = build(null)
  const latest = top.length ? top[top.length - 1].post.createdAt || null : null
  const earliest = top.length ? top[0].post.createdAt || null : null
  return { tree: top, count: nodes.size, latest, earliest }
}

function countTree(kids: any[]): number {
  return kids.reduce((n, k) => n + 1 + countTree(k.children || []), 0)
}
