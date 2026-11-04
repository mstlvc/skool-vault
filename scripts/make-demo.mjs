// Trim a local AI Video Bootcamp archive into demo/aivideobootcamp for README screenshots.
// The slice keeps the community's name, course list, covers and a few real posts and lessons.
// It does not copy videos, attached files, the raw page dump, cookies, or comment threads.
// Display names from the local accounts file are removed when that file exists.
//
// Usage: node scripts/make-demo.mjs [path-to-aivideobootcamp]
import { execFileSync } from 'child_process'
import { createRequire } from 'module'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'

const require = createRequire(import.meta.url)
const ffmpeg = require('ffmpeg-static')
const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '..')
const source = resolve(process.argv[2] || join(process.env.USERPROFILE || '', 'Documents', 'Skool Vault', 'aivideobootcamp'))
const outRoot = join(repo, 'demo')
const slug = 'aivideobootcamp'
const dest = join(outRoot, slug)

const IMAGE_LESSON = '341a26d0a74543cfad0e1324558a5318' // Upscaling to 4k
const VIDEO_LESSON = '474a7f33668642e3899756454087968f' // How To Use The Course
const FEATURED_POST = '77076f5257004e8fad5069d62737f4b5' // tool launch, image gallery

function localNames() {
  const names = new Set()
  try {
    const file = join(process.env.APPDATA || '', 'Skool Vault', 'accounts.json')
    const acc = JSON.parse(readFileSync(file, 'utf8'))
    for (const a of acc.accounts || []) if (typeof a.name === 'string' && a.name.trim().length > 1) names.add(a.name.trim())
  } catch { /* no local accounts */ }
  return [...names]
}

const blockNames = localNames()

function scrub(value) {
  if (typeof value !== 'string') return value
  let s = value
  s = s.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '')
  s = s.replace(/\b(?:cus|sub|pm|pi|seti|src)_[A-Za-z0-9]{8,}\b/g, '')
  s = s.replace(/[A-Za-z]:\\Users\\[^\\/"'\s<]+/g, '')
  s = s.replace(/token=[^&\s"'<>]+/gi, '')
  s = s.replace(/\bauth_token=[^;\s&"]+/gi, '')
  for (const name of blockNames) s = s.split(name).join('')
  return s
}

function cleanSource(url) {
  if (typeof url !== 'string' || !url) return ''
  if (/token=|stream\.video\.skool\.com|stream\.mux\.com|image\.mux\.com|eyJ/i.test(url)) return ''
  try {
    const u = new URL(url)
    u.search = ''
    u.hash = ''
    return u.toString()
  } catch {
    return ''
  }
}

const copied = new Map() // source rel -> demo rel

function destOf(rel) {
  return join(dest, rel.split('/').join('\\'))
}

function importMedia(rel, { resize = false, maxBytes = Infinity } = {}) {
  if (!rel || typeof rel !== 'string' || !rel.startsWith('media/')) return null
  if (copied.has(rel)) return copied.get(rel)
  const src = join(source, rel.split('/').join('\\'))
  if (!existsSync(src)) {
    copied.set(rel, null)
    return null
  }
  const size = statSync(src).size
  const image = /\.(png|jpe?g|gif|webp)$/i.test(rel)
  if (!image) {
    copied.set(rel, null)
    return null
  }
  let outRel = rel
  const destPath = () => destOf(outRel)
  mkdirSync(dirname(destPath()), { recursive: true })
  if (resize && size > 700_000) {
    outRel = rel.replace(/\.[^.]+$/, '.jpg')
    if (copied.has(rel) === undefined) {
      /* set after write */
    }
    execFileSync(ffmpeg, ['-y', '-loglevel', 'error', '-i', src, '-vf', "scale='min(1400,iw)':-2", '-q:v', '4', destOf(outRel)], { stdio: 'inherit' })
  } else if (size > maxBytes) {
    copied.set(rel, null)
    return null
  } else {
    copyFileSync(src, destPath())
  }
  copied.set(rel, outRel)
  return outRel
}

function mediaRefs(html) {
  return [...new Set(String(html || '').match(/media\/[A-Za-z0-9]+\.(?:jpg|jpeg|png|gif|webp)/gi) || [])]
}

function rewriteHtml(html) {
  let out = scrub(html || '')
  out = out.replace(/<img\b[^>]*>/gi, (tag) => {
    const m = /src=["']([^"']+)["']/i.exec(tag)
    if (!m) return ''
    const rel = (m[1].match(/media\/[A-Za-z0-9]+\.(?:jpg|jpeg|png|gif|webp)/i) || [])[0]
    const stored = rel && copied.get(rel)
    if (!stored) return ''
    return tag.replace(m[1], stored)
  })
  return out
}

function person(p) {
  if (!p) return { id: '', name: 'Member' }
  const name = scrub(p.name || 'Member').trim() || 'Member'
  return {
    id: p.id || '',
    name,
    handle: scrub(p.handle || ''),
    avatar: importMedia(p.avatar, { maxBytes: 250_000 })
  }
}

function blocked(name, html) {
  const blob = `${name || ''}\n${html || ''}`
  return blockNames.some((n) => blob.includes(n))
}

function trimComments(list, depth = 0) {
  const out = []
  for (const c of list || []) {
    if (out.length >= (depth ? 1 : 3)) break
    if (blocked(c.author?.name, c.html)) continue
    const html = scrub(c.html || '')
    if (html.includes('@')) continue
    out.push({
      id: c.id,
      author: person(c.author),
      createdAt: c.createdAt,
      html,
      upvotes: c.upvotes || 0,
      images: [],
      attachments: [],
      replies: trimComments(c.replies, depth + 1)
    })
  }
  return out
}

if (!existsSync(join(source, 'group.json'))) {
  console.error('No archive at ' + source)
  process.exit(1)
}

rmSync(dest, { recursive: true, force: true })
mkdirSync(dest, { recursive: true })

const group = JSON.parse(readFileSync(join(source, 'group.json'), 'utf8'))
const classroom = JSON.parse(readFileSync(join(source, 'classroom.json'), 'utf8'))
const community = JSON.parse(readFileSync(join(source, 'community.json'), 'utf8'))

group.logo = importMedia(group.logo, { resize: true })
group.cover = importMedia(group.cover, { resize: true })
group.description = scrub(group.description || '')
group.url = `https://www.skool.com/${slug}`

const lessonsOf = (items) => (items || []).flatMap((it) => (it.type === 'set' ? it.items : [it]))

let videoLesson = null
let imageLesson = null
for (const course of classroom.courses) {
  course.cover = importMedia(course.cover, { resize: true })
  course.desc = scrub(course.desc || '')
  for (const lesson of lessonsOf(course.items)) {
    if (lesson.id === VIDEO_LESSON) videoLesson = { course, lesson }
    if (lesson.id === IMAGE_LESSON) imageLesson = { course, lesson }
  }
}
if (!videoLesson || !imageLesson) {
  console.error('Expected lessons were not in the archive')
  process.exit(1)
}

for (const rel of mediaRefs(imageLesson.lesson.html)) importMedia(rel, { resize: true })
for (const rel of mediaRefs(videoLesson.lesson.html)) importMedia(rel, { resize: true, maxBytes: 1_200_000 })

const clipRel = 'videos/how-to-use.mp4'
const posterRel = 'media/how-to-use.jpg'
const realVideo = videoLesson.lesson.video?.file
if (realVideo && existsSync(join(source, realVideo.split('/').join('\\')))) {
  const real = join(source, realVideo.split('/').join('\\'))
  mkdirSync(dirname(destOf(posterRel)), { recursive: true })
  mkdirSync(dirname(destOf(clipRel)), { recursive: true })
  execFileSync(ffmpeg, ['-y', '-loglevel', 'error', '-ss', '4', '-i', real, '-frames:v', '1', destOf(posterRel)], { stdio: 'inherit' })
  execFileSync(ffmpeg, [
    '-y', '-loglevel', 'error', '-loop', '1', '-i', destOf(posterRel),
    '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
    '-t', '6', '-r', '30', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
    '-shortest', '-movflags', '+faststart', destOf(clipRel)
  ], { stdio: 'inherit' })
}

function slimLesson(lesson) {
  const featuredImage = lesson.id === IMAGE_LESSON
  const featuredVideo = lesson.id === VIDEO_LESSON && existsSync(destOf(clipRel))
  const base = {
    type: 'lesson',
    id: lesson.id,
    n: lesson.n,
    title: scrub(lesson.title || ''),
    html: featuredImage || featuredVideo ? rewriteHtml(lesson.html) : '',
    resources: [],
    posts: []
  }
  if (featuredVideo) {
    base.video = {
      source: cleanSource(lesson.video?.source || ''),
      file: clipRel,
      thumb: posterRel,
      durationMs: 6000
    }
  } else {
    base.video = null
  }
  return base
}

const courses = classroom.courses.map((course) => ({
  id: course.id,
  slug: course.slug,
  title: scrub(course.title || ''),
  desc: scrub(course.desc || ''),
  cover: course.cover,
  lessonCount: course.lessonCount,
  items: (course.items || []).map((it) =>
    it.type === 'set'
      ? { type: 'set', id: it.id, title: scrub(it.title || ''), items: it.items.map(slimLesson) }
      : slimLesson(it)
  )
}))

// Posts in archive order, pinned ones first, so the feed opens on the real announcements.
const postsIn = [...community.posts.filter((p) => p.pinned), ...community.posts.filter((p) => !p.pinned)]
const posts = []
for (const p of postsIn) {
  if (blocked(p.author?.name, p.html)) continue
  const featured = p.id === FEATURED_POST
  const images = []
  for (const rel of p.images || []) {
    const stored = importMedia(rel, featured ? { resize: true } : { maxBytes: 450_000, resize: false })
    if (stored) images.push(stored)
  }
  for (const rel of mediaRefs(p.html)) {
    if ((p.images || []).includes(rel)) continue
    const stored = importMedia(rel, featured ? { resize: true } : { maxBytes: 450_000 })
    if (stored && !images.includes(stored)) images.push(stored)
  }
  if (featured && images.length > 1) {
    const best = [...images].sort((a, b) => statSync(destOf(b)).size - statSync(destOf(a)).size)[0]
    images.splice(images.indexOf(best), 1)
    images.unshift(best)
  }
  let thumb = null
  if (p.videos?.[0]?.thumb) thumb = importMedia(p.videos[0].thumb, { maxBytes: 900_000, resize: true })
  posts.push({
    id: p.id,
    slug: p.slug,
    title: scrub(p.title || ''),
    html: rewriteHtml(p.html),
    text: scrub(p.text || '').slice(0, 2000),
    author: person(p.author),
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    upvotes: p.upvotes || 0,
    commentCount: p.commentCount || 0,
    pinned: !!p.pinned,
    category: p.category || null,
    images,
    videos: thumb ? [{ source: '', thumb, durationMs: p.videos[0].durationMs || null }] : [],
    attachments: [],
    comments: trimComments(p.comments),
    syncedComments: p.commentCount || 0
  })
}

const demo = {
  group: {
    id: group.id,
    slug,
    name: scrub(group.name || ''),
    description: scrub(group.description || ''),
    color: group.color || '#E4A511',
    logo: group.logo,
    cover: group.cover,
    url: group.url,
    memberCount: group.memberCount,
    updatedAt: group.updatedAt
  },
  classroom: { courses },
  community: {
    categories: (community.categories || []).map((c) => ({ id: c.id, name: scrub(c.name || '') })),
    posts
  }
}

writeFileSync(join(dest, 'group.json'), JSON.stringify(demo.group, null, 1))
writeFileSync(join(dest, 'classroom.json'), JSON.stringify(demo.classroom, null, 1))
writeFileSync(join(dest, 'community.json'), JSON.stringify(demo.community, null, 1))

const imageLessonCourse = imageLesson.course
const shots = {
  slug,
  name: demo.group.name,
  logo: demo.group.logo,
  imageLesson: { courseId: imageLessonCourse.id, lessonId: IMAGE_LESSON, title: imageLesson.lesson.title },
  videoLesson: { courseId: videoLesson.course.id, lessonId: VIDEO_LESSON, title: videoLesson.lesson.title },
  postId: FEATURED_POST,
  expandCourse: courses[0]?.title || '',
  job: {
    phase: `Classroom: ${courses[3]?.title || courses[0]?.title || 'AI Videos'}`,
    current: lessonsOf(courses[3]?.items || [])[2]?.title || 'Downloading'
  }
}
writeFileSync(join(outRoot, 'shots.json'), JSON.stringify(shots, null, 2))

const text = JSON.stringify(demo)
const problems = []
if (/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(text)) problems.push('email')
if (/token=|auth_token|aws-waf/i.test(text)) problems.push('token')
if (/[A-Za-z]:\\Users\\/i.test(text)) problems.push('home path')
for (const name of blockNames) if (text.includes(name)) problems.push('account name')
if (problems.length) {
  console.error('Demo still has personal data:', problems.join(', '))
  process.exit(1)
}

function dirBytes(folder) {
  let n = 0
  for (const name of require('fs').readdirSync(folder)) {
    const p = join(folder, name)
    const st = statSync(p)
    n += st.isDirectory() ? dirBytes(p) : st.size
  }
  return n
}
console.log('demo', (dirBytes(dest) / 1024 / 1024).toFixed(1), 'MB', 'posts', posts.length, 'courses', courses.length)
console.log('shots', shots.imageLesson.title, '|', shots.videoLesson.title)
