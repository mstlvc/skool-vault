// Archive format written by the downloader and read by the viewer.
// All media paths are relative to the group's archive folder.

export interface Person {
  id: string
  name: string
  avatar?: string | null
  handle?: string
}

export interface Attachment {
  name: string
  file?: string | null // local path when downloaded
  href?: string | null // original link
  type?: string
}

export interface VideoRef {
  source: string // original stream / page url
  file?: string | null // local mp4 once downloaded
  thumb?: string | null
  captions?: string | null // .vtt subtitles
  durationMs?: number | null
  error?: string
}

export interface Lesson {
  type: 'lesson'
  id: string
  n: number
  title: string
  html: string
  video?: VideoRef | null
  resources: Attachment[]
  posts?: string[] // community posts attached to the lesson (slugs), shown as post cards
}

export interface Section {
  type: 'set'
  id: string
  title: string
  items: Lesson[]
}

export interface Course {
  id: string
  slug: string
  title: string
  desc: string
  cover?: string | null
  items: (Section | Lesson)[]
  lessonCount: number
}

export interface Comment {
  id: string
  author: Person
  createdAt: string
  html: string
  upvotes: number
  images: string[]
  attachments: Attachment[]
  replies: Comment[]
}

export interface Post {
  id: string
  slug: string
  title: string
  html: string
  text: string // plain text for search/previews
  author: Person
  createdAt: string
  updatedAt?: string
  upvotes: number
  commentCount: number
  pinned: boolean
  category?: string | null
  images: string[]
  videos: VideoRef[]
  attachments: Attachment[]
  comments: Comment[]
  syncedComments?: number // Skool's comment count when comments were saved (for "only new" updates)
}

export interface Category {
  id: string
  name: string
}

export interface GroupInfo {
  id: string
  slug: string
  name: string
  description: string
  color: string
  logo?: string | null
  cover?: string | null
  url: string
  memberCount?: number
  updatedAt: string
}

export interface ClassroomArchive {
  courses: Course[]
}

export interface CommunityArchive {
  categories: Category[]
  posts: Post[]
}

export interface GroupArchive {
  group: GroupInfo
  classroom: ClassroomArchive
  community: CommunityArchive
}

export interface LibraryEntry {
  slug: string
  name: string
  logo?: string | null
  cover?: string | null
  courses: number
  lessons: number
  posts: number
  videos: number
  updatedAt: string
}

// ---- dashboard <-> main process

export type Speed = 'gentle' | 'normal' | 'fast'

export interface RemoteState {
  status: 'off' | 'starting' | 'on' | 'error'
  url?: string // full link including the access key
  qr?: string // SVG markup
  lanUrls?: string[]
  error?: string
}

export interface Settings {
  libraryDir: string
  port: number
  lan: boolean
  speed: Speed
  accessKey: string // required by any device other than this PC (phone link, Wi-Fi link)
  maxHeight: number // 0 = best available
}

export interface Account {
  loggedIn: boolean
  name?: string
  avatar?: string | null
}

export interface RemoteGroup {
  id: string
  slug: string
  name: string
  logo?: string | null
  cover?: string | null
  color?: string
  description?: string
}

export interface ScanCourse {
  id: string
  slug: string
  title: string
  cover?: string | null
  lessons: number
  locked: boolean
}

export interface ScanResult {
  group: RemoteGroup
  courses: ScanCourse[]
  totalPosts?: number
}

export interface DownloadOptions {
  slug: string
  courses: string[] // course ids
  community: boolean
  comments: boolean
  videos: boolean
  postVideos: boolean
  maxPosts: number // 0 = all
  onlyNew: boolean // skip lessons/posts already fully saved (new comments still count as changed)
}

export interface VideoProgress {
  key: string
  label: string
  pct: number
  speed?: string
}

export interface JobState {
  id: string
  slug: string
  status: 'running' | 'done' | 'error' | 'cancelled'
  phase: string
  current: string
  done: number
  total: number
  videos: VideoProgress[]
  videosDone: number
  videosTotal: number
  log: string[]
  errors: string[]
  startedAt: number
}
