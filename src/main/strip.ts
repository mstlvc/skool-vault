// Take the logged-in account out of a saved library: the cookie jar, the page's
// `self` profile (email, Stripe ids), request secrets, and playback tokens.
// Lessons, posts, other members, and local video files stay so the viewer still plays.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { StripResult } from '../shared/types'

const SKIP_DIRS = new Set(['videos', 'media', 'files', 'node_modules'])
/** Credential fields on a saved Skool page. The viewer never reads these. */
const TOKEN_KEYS = new Set([
  'playbackToken',
  'playback_token',
  'thumbnailToken',
  'thumbnail_token',
  'storyboardToken',
  'storyboard_token',
  'securityNonce'
])
/** Browser session stuck to the page JSON. Not course content. */
const DROP_KEYS = new Set([
  'userAgent',
  '_sentryTraceData',
  '_sentryBaggage',
  'myView',
  'myVote',
  'lastCommentView',
  'followingPost',
  'hasNewComments'
])
const COOKIE_NAMES = new Set([
  'auth_token',
  'client_id',
  'aws-waf-token',
  'm',
  '__stripe_mid',
  '__stripe_sid',
  'awsalb',
  'awsalbcors',
  'awsalbtg',
  'awsalbtgcors'
])
/** Account billing blobs on `self`. Short hex ids are left alone so lesson ids stay intact. */
const BILLING_KEYS = new Set(['mmbp', 'msbi', 'msbs', 'spData', 'aflCode'])
const STRIPE_ID = /\b(?:cus|sub|pm|pi|seti|src)_[A-Za-z0-9]{8,}\b/g
const TOKEN_HOST = /https?:\/\/(?:stream\.video\.skool\.com|image\.video\.skool\.com|stream\.mux\.com|image\.mux\.com|assets\.skool\.com)[^\s"'<>]*/gi

interface Found {
  secrets: string[]
  emails: Set<string>
  /** Skool user id of the logged-in account. Post authors keep this id; it is not a login. */
  ids: Set<string>
}

interface GroupResult {
  filesChanged: number
  cookiesRemoved: number
  kept: number
}

function isAccount(v: any): boolean {
  return !!v && typeof v === 'object' && !Array.isArray(v) && typeof v.id === 'string' && ('email' in v || 'allGroups' in v || (v.member && typeof v.member === 'object'))
}

function isPageEnv(v: any): boolean {
  return !!v && typeof v === 'object' && !Array.isArray(v) && ('STRIPE_PUBLISHABLE_KEY' in v || 'BILLING_STRIPE_PUBLISHABLE_KEY' in v || ('API_URL' in v && 'CLIENT_ID_KEY' in v))
}

function addSecret(set: Set<string>, value: unknown) {
  if (typeof value !== 'string') return
  const v = value.trim()
  if (v.length >= 12) set.add(v)
}

/** Email, user id, and Stripe ids from the logged-in profile only, not from group descriptions or other members. */
function harvestAccount(self: any, secrets: Set<string>, emails: Set<string>, ids: Set<string>) {
  if (typeof self.id === 'string' && self.id.length >= 8) ids.add(self.id)
  const userId = self.member && self.member.userId
  if (typeof userId === 'string' && userId.length >= 8) ids.add(userId)
  if (typeof self.email === 'string' && self.email.includes('@')) emails.add(self.email.trim())
  const memberMeta = self.member?.metadata
  if (typeof memberMeta?.mbme === 'string' && memberMeta.mbme.includes('@')) emails.add(memberMeta.mbme.trim())
  for (const bag of [self.metadata, memberMeta]) {
    if (!bag || typeof bag !== 'object') continue
    for (const [k, v] of Object.entries(bag)) {
      if (typeof v !== 'string') continue
      if (BILLING_KEYS.has(k)) addSecret(secrets, v)
      for (const m of v.match(STRIPE_ID) || []) addSecret(secrets, m)
    }
  }
}

function harvest(node: any, secrets: Set<string>, emails: Set<string>, ids: Set<string>) {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const item of node) harvest(item, secrets, emails, ids)
    return
  }
  if (isAccount(node.self)) harvestAccount(node.self, secrets, emails, ids)
  for (const value of Object.values(node)) if (value && typeof value === 'object') harvest(value, secrets, emails, ids)
}

function cookieSecrets(file: string, secrets: Set<string>) {
  if (!existsSync(file)) return
  let text = ''
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return
  }
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue
    const parts = line.split('\t')
    if (parts.length < 7) continue
    const name = parts[5].toLowerCase()
    const value = parts.slice(6).join('\t')
    // 32-char hex ids collide with Skool lesson ids, so only long cookie values are searched for later.
    if (COOKIE_NAMES.has(name) && (value.length >= 40 || value.startsWith('eyJ'))) addSecret(secrets, value)
  }
}

/** Drop `token` on signed media URLs. The path (and a local video.file) still identifies the video. */
function stripTokenParam(url: string): string {
  const htmlAmp = url.includes('&amp;')
  let u = htmlAmp ? url.replace(/&amp;/g, '&') : url
  u = u
    .replace(/([?&])token=[^&#\s"']*/gi, '$1')
    .replace(/\?&/g, '?')
    .replace(/&&+/g, '&')
    .replace(/[?&]$/g, '')
  return htmlAmp ? u.replace(/&/g, '&amp;') : u
}

function stripHostTokens(s: string): string {
  if (!s.includes('token=')) return s
  return s.replace(TOKEN_HOST, (url) => stripTokenParam(url))
}

/** `C:\Users\<name>\...` becomes `C:\Users\...\...`. A site path such as openart.ai/home/tools is left alone. */
function redactHome(s: string): string {
  if (!/Users|\/home\/|\\home\\/i.test(s)) return s
  return s
    .replace(/[A-Za-z]:(?:\\{1,2})Users(?:\\{1,2})[^\\/\s'"]+/gi, (m) => m.replace(/(?:\\{1,2})[^\\/\s'"]+$/, (tail) => (tail.startsWith('\\\\') ? '\\\\...' : '\\...')))
    .replace(/[A-Za-z]:\/Users\/[^/\s'"]+/gi, (m) => m.replace(/\/[^/\s'"]+$/, '/...'))
    .replace(/(^|[^A-Za-z0-9.])\/Users\/[^/\s"']+/g, '$1/Users/...')
    .replace(/(^|[^A-Za-z0-9.])\/home\/[^/\s"']+/g, '$1/home/...')
}

/** A clock (`01:21:18`) is three decimal groups. An address has `::`, a hex letter, or four or more groups. */
function isIpv6(token: string): boolean {
  if (!token.includes(':')) return false
  const parts = token.split(':')
  if (parts.length < 3 || parts.length > 8) return false
  if (!parts.every((p) => p === '' || /^[0-9a-f]{1,4}$/i.test(p))) return false
  if (token.includes('::')) return true
  if (parts.some((p) => /[a-f]/i.test(p))) return true
  return parts.length >= 4
}

function stripIps(s: string): string {
  let out = s.replace(/\b(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\b/g, (ip) => (ip === '0.0.0.0' || ip === '127.0.0.1' ? ip : ''))
  if (!out.includes(':')) return out
  return out.replace(/(^|[^A-Za-z0-9:])((?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4})(?![A-Za-z0-9:])/gi, (all, pre, token) => (isIpv6(token) ? pre : all))
}

function cleanString(s: string, found: Found): string {
  let out = s
  if (out.includes('token=')) out = stripHostTokens(out)
  if (/Bearer\s+eyJ/i.test(out)) out = out.replace(/Bearer\s+eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/gi, '')
  if (/auth_token=/i.test(out)) out = out.replace(/\bauth_token=[^;\s&"]+/gi, '')
  if (/Users|\/home\/|\\home\\/i.test(out)) out = redactHome(out)
  if (out.includes('.') || out.includes(':')) out = stripIps(out)
  for (const email of found.emails) if (out.includes(email)) out = out.split(email).join('')
  for (const secret of found.secrets) if (out.includes(secret)) out = out.split(secret).join('')
  return out
}

const PROFILE_KEYS = ['email', 'bio', 'location', 'timeZone', 'timezone', 'loginTimezone']
const PROFILE_META = [
  'bio',
  'location',
  'timezone',
  'timeZone',
  'loginTimezone',
  'linkFacebook',
  'linkInstagram',
  'linkLinkedin',
  'linkTwitter',
  'linkWebsite',
  'linkYoutube',
  'spData',
  'aflCode',
  'mbme',
  'mmbp',
  'msbi',
  'msbs'
]

/** Drop the account's email, location, and social links. The post name, handle, and avatar stay. */
function blankAccountProfile(node: any, found: Found): boolean {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return false
  if (typeof node.id !== 'string' || !found.ids.has(node.id)) return false
  if (!('firstName' in node || 'lastName' in node || 'email' in node || 'handle' in node)) return false
  let dirty = false
  for (const key of PROFILE_KEYS) {
    if (typeof node[key] === 'string' && node[key]) {
      node[key] = ''
      dirty = true
    }
  }
  const meta = node.metadata
  if (meta && typeof meta === 'object' && !Array.isArray(meta)) {
    for (const key of PROFILE_META) {
      if (typeof meta[key] === 'string' && meta[key]) {
        meta[key] = ''
        dirty = true
      }
    }
  }
  return dirty
}

function scrub(node: any, found: Found): boolean {
  if (Array.isArray(node)) {
    let dirty = false
    for (let i = 0; i < node.length; i++) {
      const v = node[i]
      if (typeof v === 'string') {
        const next = cleanString(v, found)
        if (next !== v) {
          node[i] = next
          dirty = true
        }
      } else if (v && typeof v === 'object' && scrub(v, found)) dirty = true
    }
    return dirty
  }
  if (!node || typeof node !== 'object') return false
  let dirty = blankAccountProfile(node, found)
  for (const key of Object.keys(node)) {
    if (
      (key === 'self' && isAccount(node[key])) ||
      key === 'onlineUsers' ||
      (key === 'env' && isPageEnv(node[key])) ||
      TOKEN_KEYS.has(key) ||
      DROP_KEYS.has(key)
    ) {
      delete node[key]
      dirty = true
      continue
    }
    if ((key === 'email' || key === 'mbme') && found.emails.has(node[key])) {
      node[key] = ''
      dirty = true
      continue
    }
    const v = node[key]
    if (typeof v === 'string') {
      const next = cleanString(v, found)
      if (next !== v) {
        node[key] = next
        dirty = true
      }
    } else if (v && typeof v === 'object' && scrub(v, found)) dirty = true
  }
  return dirty
}

function lessonState(data: any): { courses: number; lessons: number; files: string; titles: string } {
  const files: string[] = []
  const titles: string[] = []
  let lessons = 0
  const walk = (items: any[]) => {
    for (const it of items || []) {
      if (it?.type === 'set') walk(it.items)
      else if (it) {
        lessons++
        titles.push(String(it.title || ''))
        files.push(String(it.video?.file || ''))
      }
    }
  }
  for (const c of data?.courses || []) walk(c.items)
  return { courses: (data?.courses || []).length, lessons, files: files.join('\n'), titles: titles.join('\n') }
}

function postState(data: any): string {
  return (data?.posts || [])
    .map((p: any) => {
      const files = (p?.videos || []).map((v: any) => v?.file || '').join(',')
      return `${p?.id || ''}\t${p?.slug || ''}\t${files}`
    })
    .join('\n')
}

/** True when a scrub would drop a course, a post, a lesson title, or a downloaded video. */
function unsafe(name: string, data: any, before: { slug?: string; gname?: string; lessons: ReturnType<typeof lessonState> | null; posts: string; course: boolean; post: boolean; pins: number }): boolean {
  if (name === 'group.json' && (data?.slug !== before.slug || data?.name !== before.gname)) return true
  if (before.lessons) {
    const after = lessonState(data)
    if (after.courses !== before.lessons.courses || after.lessons !== before.lessons.lessons || after.files !== before.lessons.files) return true
  }
  if (name === 'community.json' && postState(data) !== before.posts) return true
  if (before.course && !data?.course) return true
  if (before.post && !data?.post) return true
  if (before.pins >= 0 && (!Array.isArray(data?.pinnedPosts) || data.pinnedPosts.length !== before.pins)) return true
  return false
}

function writeAtomic(file: string, text: string) {
  mkdirSync(join(file, '..'), { recursive: true })
  const tmp = file + '.strip-tmp'
  writeFileSync(tmp, text)
  try {
    renameSync(tmp, file)
  } catch {
    try {
      unlinkSync(file)
    } catch {
      /* the rename below reports the real failure */
    }
    renameSync(tmp, file)
  }
}

function listSaved(dir: string): { json: string[]; text: string[]; cookies: string[] } {
  const json: string[] = []
  const text: string[] = []
  const cookies: string[] = []
  const walk = (folder: string) => {
    let entries
    try {
      entries = readdirSync(folder, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = join(folder, e.name)
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(p)
      } else if (e.name === '.cookies.txt' || e.name === 'cookies.txt') cookies.push(p)
      else if (e.name.endsWith('.json') && !e.name.endsWith('.strip-tmp')) json.push(p)
      else if (e.name.endsWith('.txt') || e.name.endsWith('.log')) text.push(p)
    }
  }
  walk(dir)
  return { json, text, cookies }
}

function isVault(dir: string): boolean {
  return existsSync(join(dir, 'group.json'))
}

const breathe = () => new Promise<void>((r) => setImmediate(r))

/** Strip one community folder. Yields between files so the viewer can keep streaming. */
export async function stripGroup(dir: string): Promise<GroupResult> {
  const saved = listSaved(dir)
  const secretSet = new Set<string>()
  const emails = new Set<string>()
  const ids = new Set<string>()
  for (const file of saved.cookies) cookieSecrets(file, secretSet)
  for (const file of saved.json) {
    await breathe()
    let text = ''
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    if (!text.includes('"self"') && !text.includes('"email"')) continue
    try {
      harvest(JSON.parse(text), secretSet, emails, ids)
    } catch {
      /* the edit pass reports invalid JSON by skipping it */
    }
  }
  const found: Found = { secrets: [...secretSet].sort((a, b) => b.length - a.length), emails, ids }
  let filesChanged = 0
  let kept = 0

  for (const file of saved.json) {
    await breathe()
    let text = ''
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      kept++
      continue
    }
    const base = file.slice(dir.length + 1)
    const interesting =
      text.includes('"self"') ||
      text.includes('"env"') ||
      text.includes('securityNonce') ||
      text.includes('playbackToken') ||
      text.includes('thumbnailToken') ||
      text.includes('storyboardToken') ||
      text.includes('userAgent') ||
      text.includes('_sentry') ||
      text.includes('token=') ||
      text.includes('onlineUsers') ||
      text.includes('\\Users\\') ||
      text.includes('/Users/') ||
      text.includes('/home/') ||
      /\b(?:\d{1,3}\.){3}\d{1,3}\b/.test(text) ||
      found.secrets.some((s) => text.includes(s)) ||
      [...emails].some((s) => text.includes(s))
    if (!interesting) continue
    let data: any
    try {
      data = JSON.parse(text)
    } catch {
      kept++
      continue
    }
    const name = base.replace(/\\/g, '/').split('/').pop() || ''
    const before = {
      slug: name === 'group.json' ? data?.slug : undefined,
      gname: name === 'group.json' ? data?.name : undefined,
      lessons: name === 'classroom.json' ? lessonState(data) : null,
      posts: name === 'community.json' ? postState(data) : '',
      course: !!data?.course,
      post: !!data?.post,
      pins: Array.isArray(data?.pinnedPosts) ? data.pinnedPosts.length : -1
    }
    if (!scrub(data, found)) continue
    if (unsafe(name, data, before)) {
      kept++
      continue
    }
    writeAtomic(file, JSON.stringify(data, null, 1))
    filesChanged++
  }

  for (const file of saved.text) {
    let text = ''
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    const next = cleanString(text, found)
    if (next === text) continue
    writeAtomic(file, next)
    filesChanged++
  }

  let cookiesRemoved = 0
  for (const file of saved.cookies) {
    try {
      unlinkSync(file)
      cookiesRemoved++
      filesChanged++
    } catch {
      kept++
    }
  }
  return { filesChanged, cookiesRemoved, kept }
}

export async function stripLibrary(libraryDir: string): Promise<StripResult> {
  const empty = { groups: 0, filesChanged: 0, cookiesRemoved: 0, kept: 0, busy: false }
  if (!existsSync(libraryDir)) return empty
  let groups = 0
  let filesChanged = 0
  let cookiesRemoved = 0
  let kept = 0
  let entries
  try {
    entries = readdirSync(libraryDir, { withFileTypes: true })
  } catch {
    return empty
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const dir = join(libraryDir, e.name)
    if (!isVault(dir)) continue
    try {
      if (!statSync(dir).isDirectory()) continue
    } catch {
      continue
    }
    groups++
    const r = await stripGroup(dir)
    filesChanged += r.filesChanged
    cookiesRemoved += r.cookiesRemoved
    kept += r.kept
  }
  return { groups, filesChanged, cookiesRemoved, kept, busy: false }
}
