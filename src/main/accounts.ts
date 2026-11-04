// Saved Skool logins. Each one has its own Chromium profile (cookies, storage, cache)
// and a fingerprint that no other saved login uses.
import { app, session, Session } from 'electron'
import { randomBytes } from 'crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { chooseFingerprint, fingerprintKey, withBrowser, type Fingerprint } from './fingerprint'
import type { Account, SavedAccount } from '../shared/types'

interface StoredAccount {
  id: string
  partition: string
  name?: string
  avatar?: string | null
  loggedIn: boolean
  fingerprint: Fingerprint
}

interface Store {
  active: string
  accounts: StoredAccount[]
}

const file = () => join(app.getPath('userData'), 'accounts.json')

let cache: Store | null = null
const bound = new WeakSet<Session>()

const forThisBrowser = (fp: Fingerprint) => withBrowser(fp, process.versions.chrome || '')

function emptyStore(): Store {
  const fingerprint = forThisBrowser(chooseFingerprint([]))
  const primary: StoredAccount = {
    id: 'primary',
    partition: 'persist:skool',
    loggedIn: false,
    fingerprint
  }
  return { active: primary.id, accounts: [primary] }
}

function load(): Store {
  if (cache) return cache
  let data: Store | null = null
  try {
    if (existsSync(file())) data = JSON.parse(readFileSync(file(), 'utf8'))
  } catch {
    data = null
  }
  // A missing file is the first run: keep the existing Skool login in persist:skool.
  // An empty list is a user who removed every account, so don't recreate that login.
  if (!data || !Array.isArray(data.accounts)) data = emptyStore()
  for (const a of data.accounts) {
    if (!a.partition) a.partition = a.id === 'primary' ? 'persist:skool' : `persist:skool-${a.id}`
    if (!a.fingerprint?.ua) {
      const used = data.accounts.filter((x) => x !== a && x.fingerprint?.ua).map((x) => fingerprintKey(x.fingerprint))
      a.fingerprint = chooseFingerprint(used)
    }
    a.fingerprint = forThisBrowser(a.fingerprint)
  }
  if (!data.accounts.length) data.active = ''
  else if (!data.accounts.some((a) => a.id === data.active)) data.active = data.accounts[0].id
  cache = data
  persist()
  return data
}

function persist() {
  if (!cache) return
  mkdirSync(app.getPath('userData'), { recursive: true })
  const { active, accounts } = cache
  writeFileSync(file(), JSON.stringify({ active, accounts }, null, 2))
}

export function activeAccount(): StoredAccount {
  const data = load()
  const found = data.accounts.find((a) => a.id === data.active)
  if (found) return found
  if (data.accounts[0]) {
    data.active = data.accounts[0].id
    persist()
    return data.accounts[0]
  }
  throw new Error('No Skool account')
}

export const activePartition = () => activeAccount().partition
export const activeFingerprint = () => activeAccount().fingerprint

function setHeader(headers: Record<string, string>, name: string, value: string) {
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase()) || name
  headers[key] = value
}

/** Point this profile's requests at its own user agent, language, and client hints. */
export function bindSession(ses: Session, fp: Fingerprint = activeFingerprint()) {
  ses.setUserAgent(fp.ua, fp.lang)
  if (bound.has(ses)) return
  bound.add(ses)
  ses.webRequest.onBeforeSendHeaders({ urls: ['<all_urls>'] }, (details, cb) => {
    const headers = { ...details.requestHeaders }
    setHeader(headers, 'User-Agent', fp.ua)
    setHeader(headers, 'Accept-Language', fp.lang)
    setHeader(headers, 'sec-ch-ua', fp.secChUa)
    setHeader(headers, 'sec-ch-ua-mobile', '?0')
    setHeader(headers, 'sec-ch-ua-platform', `"${fp.platform}"`)
    cb({ requestHeaders: headers })
  })
}

export function viewAccount(liveLoggedIn: boolean): Account {
  const data = load()
  if (!data.accounts.length) return { loggedIn: false, accounts: [] }
  const active = activeAccount()
  const accounts: SavedAccount[] = data.accounts.map((a) => ({
    id: a.id,
    name: a.name,
    avatar: a.avatar,
    loggedIn: a.id === active.id ? liveLoggedIn : !!a.loggedIn,
    active: a.id === active.id
  }))
  return { loggedIn: liveLoggedIn, id: active.id, name: active.name, avatar: active.avatar, accounts }
}

/** Remember the signed-in name for the switcher. Inactive accounts keep the name from their last use. */
export function noteActive(patch: { loggedIn: boolean; name?: string; avatar?: string | null }) {
  const data = load()
  const a = data.accounts.find((x) => x.id === data.active)
  if (!a) return
  let changed = a.loggedIn !== patch.loggedIn
  a.loggedIn = patch.loggedIn
  if (patch.name && patch.name !== a.name) {
    a.name = patch.name
    changed = true
  }
  if (patch.avatar !== undefined && patch.avatar !== a.avatar) {
    a.avatar = patch.avatar
    changed = true
  }
  if (changed) persist()
}

export function createAccount() {
  const data = load()
  const id = randomBytes(8).toString('hex')
  const fingerprint = forThisBrowser(chooseFingerprint(data.accounts.map((a) => fingerprintKey(a.fingerprint))))
  data.accounts.push({ id, partition: `persist:skool-${id}`, loggedIn: false, fingerprint })
  data.active = id
  cache = data
  persist()
}

export function activate(id: string) {
  const data = load()
  if (!data.accounts.some((a) => a.id === id)) throw new Error('That account is not on this PC.')
  if (data.active === id) return
  data.active = id
  persist()
}

export async function deleteAccount(id: string) {
  const data = load()
  const acc = data.accounts.find((a) => a.id === id)
  if (!acc) return
  const ses = session.fromPartition(acc.partition)
  await ses.clearStorageData()
  await ses.clearCache().catch(() => {})
  data.accounts = data.accounts.filter((a) => a.id !== id)
  data.active = data.accounts.some((a) => a.id === data.active) ? data.active : data.accounts[0]?.id || ''
  cache = data
  persist()
}

export function hasActiveAccount() {
  return load().accounts.some((a) => a.id === load().active)
}
