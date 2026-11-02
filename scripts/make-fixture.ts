// Builds a fictional demo archive ("Frame & Light") for testing the viewer and for README
// screenshots, without a Skool login. Every name, post and image here is made up.
// Usage: npm run fixture   (writes test-library/frame-and-light)
import { execFileSync } from 'child_process'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { Comment, GroupArchive, Lesson, Person, Post } from '../src/shared/types'
import { toHtml, toText } from '../src/main/richtext'

const lib = process.argv[2]
const slug = 'frame-and-light'
const dir = join(lib, slug)
const ffmpeg = require('ffmpeg-static') as string
for (const d of ['media', 'videos/01 - Getting Started', 'files/community', 'files/01 - Getting Started']) mkdirSync(join(dir, d), { recursive: true })

execFileSync('python', [join(__dirname, '..', 'scripts', 'demo-images.py'), dir], { stdio: 'inherit' })
const m = (f: string) => `media/${f}`

// 12 s 1080p lesson video (title card + tone) with English captions
const video = 'videos/01 - Getting Started/001 - Welcome.mp4'
execFileSync(ffmpeg, [
  '-y', '-loglevel', 'error', '-loop', '1', '-i', join(dir, 'media', 'frame-welcome.png'), '-f', 'lavfi', '-i', 'sine=f=330:d=12',
  '-t', '12', '-r', '30', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', join(dir, video)
])
writeFileSync(join(dir, 'videos/01 - Getting Started/001 - Welcome.en.vtt'),
  'WEBVTT\n\n00:00.000 --> 00:05.000\nWelcome to Frame & Light.\n\n00:05.000 --> 00:12.000\nStart with the gear list, then say hi in the community.\n')
writeFileSync(join(dir, 'files/community/free-lut-pack - Dusk LUT notes.txt'), 'Dusk LUT pack: apply at 60-80% strength over a log profile.\n')
writeFileSync(join(dir, 'files/01 - Getting Started/002 - Gear checklist.txt'), 'Camera, one prime lens, a reflector, a clip-on mic.\n')

const people: Person[] = [
  { id: 'u1', name: 'Mara Okafor', avatar: m('av0.jpg') },
  { id: 'u2', name: 'Tomas Kowal', avatar: m('av1.jpg') },
  { id: 'u3', name: 'Priya Raman', avatar: m('av2.jpg') },
  { id: 'u4', name: 'Sven Aalto', avatar: m('av3.jpg') },
  { id: 'u5', name: 'Jun Lee', avatar: m('av4.jpg') },
  { id: 'u6', name: 'Nora Beck', avatar: m('av5.jpg') }
]
const ago = (h: number) => new Date(Date.now() - h * 3600e3).toISOString()

// Skool "[v2]" rich text
const t = (text: string, marks: string[] = []) => ({ type: 'text', text, marks: marks.map((x) => ({ type: x })) })
const p = (...content: any[]) => ({ type: 'paragraph', content })
const li = (s: string) => ({ type: 'listItem', content: [p(t(s))] })
const gearDesc = '[v2]' + JSON.stringify([
  p(t('You need less than you think. This is the kit every lesson in this course uses.')),
  { type: 'horizontalRule' },
  p(t('Camera', ['bold']), t(': anything that shoots 1080p at 24 fps and lets you lock exposure.')),
  p(t('One prime lens', ['bold']), t(': a 35 mm or 50 mm. Zooms come later.')),
  p(t('A reflector', ['bold']), t(': the cheapest light you will ever own.')),
  { type: 'bulletList', content: [li('Clip-on lavalier mic'), li('Two spare batteries'), li('A fast SD card (V30 or better)')] },
  { type: 'image', attrs: { src: m('still-noon.jpg') } },
  p(t('Prices change; '), { type: 'text', text: 'check the community gear thread', marks: [{ type: 'link', attrs: { href: `https://www.skool.com/${slug}/gear-thread` } }] }, t(' before you buy.'))
])
const introUrl = `https://www.skool.com/${slug}/welcome-introduce-yourself`

const lesson = (n: number, title: string, desc: string, extra: Partial<Lesson> = {}): Lesson => ({
  type: 'lesson', id: `l${n}-${title.length}`, n, title, html: toHtml(desc), video: null, resources: [], posts: [], ...extra
})
const comment = (id: string, who: number, hours: number, text: string, replies: Comment[] = [], images: string[] = []): Comment => ({
  id, author: people[who], createdAt: ago(hours), html: toHtml(text), upvotes: (who * 3) % 7, images, attachments: [], replies
})
const post = (o: Partial<Post> & Pick<Post, 'id' | 'slug' | 'title' | 'author'>, body: string): Post => ({
  html: toHtml(body), text: toText(body), createdAt: ago(30), upvotes: 0, commentCount: 0, pinned: false, category: 'c3',
  images: [], videos: [], attachments: [], comments: [], syncedComments: 0, ...o
})

const intro = post(
  {
    id: 'p-intro', slug: 'welcome-introduce-yourself', title: 'Welcome! Introduce yourself', author: people[0], createdAt: ago(24 * 40),
    upvotes: 48, commentCount: 6, pinned: true, category: 'c1',
    comments: [
      comment('c1', 1, 30, 'Tomas from Krakow. Shooting short docs on weekends, mostly handheld.', [comment('c1r', 0, 28, 'Welcome Tomas! The handheld lesson in course 3 is for you.')]),
      comment('c2', 2, 20, 'Priya here, wedding videographer trying to get better at colour.', [comment('c2r', 3, 18, 'Same boat. The Color Grading course is great.')]),
      comment('c3', 4, 6, 'Jun, first camera ever as of last week. Excited to learn!'),
      comment('c4', 5, 2, 'Nora from Hamburg. I mostly edit, but want to start shooting my own stuff.')
    ]
  },
  'Tell us who you are, what you shoot and what you want to get better at this year.\n\nOne rule: be kind about each other\'s work. Everyone starts somewhere.'
)

const posts: Post[] = [
  intro,
  post(
    {
      id: 'p-dusk', slug: 'shot-this-at-dusk', title: 'Shot this at dusk with just a reflector', author: people[2], createdAt: ago(5),
      upvotes: 23, commentCount: 3, category: 'c2', images: [m('still-dusk.jpg'), m('still-night.jpg')],
      comments: [
        comment('d1', 3, 4, 'The bounce on her face is so soft. What size reflector?', [comment('d1r', 2, 3, 'A cheap 80 cm 5-in-1, gold side.')]),
        comment('d2', 4, 1, 'Saving this for reference, thank you.')
      ]
    },
    'Everything from the **Lighting on a Budget** course, no lights at all. Two stills from the same shoot below.'
  ),
  post(
    {
      id: 'p-lut', slug: 'free-lut-pack', title: 'Free dusk LUT pack (notes attached)', author: people[0], createdAt: ago(26),
      upvotes: 31, commentCount: 2, category: 'c1',
      attachments: [{ name: 'Dusk LUT notes.txt', file: 'files/community/free-lut-pack - Dusk LUT notes.txt', type: 'text/plain' }],
      comments: [comment('l1', 1, 20, 'These are great on Fuji F-Log too.'), comment('l2', 5, 12, 'Thanks Mara!')]
    },
    'Three LUTs I made for the colour course. The notes explain how strong to apply them \\(spoiler: less than you think\\).'
  ),
  ...[
    ['Which mic for run-and-gun interviews?', 'c3', 'Looking at clip-on lavs under 100. Wired or wireless for a beginner?', 4],
    ['My first short is finished!', 'c2', 'Four minutes, shot over two weekends. Feedback very welcome.', 9],
    ['24 or 30 fps for YouTube?', 'c3', 'I keep reading both. What do you all shoot?', 14],
    ['Budget gimbal recommendations', 'c4', 'Phone or small mirrorless, under 150.', 22],
    ['Editing on a laptop, proxies worth it?', 'c3', 'My edits stutter on 4K footage. Is making proxies the answer?', 31],
    ['Before and after: my first grade', 'c2', 'Flat log footage on the left, my grade on the right.', 40],
    ['ND filters explained simply?', 'c3', 'Why do I need one if my camera has a fast shutter?', 52],
    ['Live Q&A this Thursday', 'c1', 'Bring your lighting questions. Recording will be posted after.', 60]
  ].map(([title, category, body, hours], i): Post =>
    post({ id: `px${i}`, slug: `post-${i}`, title: String(title), author: people[(i + 1) % 6], createdAt: ago(Number(hours)), upvotes: (i * 5) % 17, commentCount: 0, category: String(category) }, String(body))
  )
]

const archive: GroupArchive = {
  group: {
    id: 'g1', slug, name: 'Frame & Light', color: '#26323e', logo: m('logo.png'), cover: m('group.jpg'), url: `https://www.skool.com/${slug}`,
    description: 'A community for small-crew filmmakers: lighting, editing and colour on a real-world budget.',
    memberCount: 2140, updatedAt: new Date().toISOString()
  },
  classroom: {
    courses: [
      {
        id: 'c-start', slug: 'getting-started', title: 'Getting Started', desc: 'Your gear, the community and your first shot.', cover: m('cover-start.jpg'), lessonCount: 4,
        items: [
          lesson(1, 'Welcome', 'Start here. A two-minute tour of the courses and how to get help.', {
            video: { source: 'https://stream.video.skool.com/demo.m3u8', file: video, captions: 'videos/01 - Getting Started/001 - Welcome.en.vtt', durationMs: 12000 }
          }),
          lesson(2, 'The gear list', gearDesc, {
            resources: [
              { name: 'Gear checklist.txt', file: 'files/01 - Getting Started/002 - Gear checklist.txt' },
              { name: 'Lens comparison (spreadsheet)', href: 'https://example.com/lens-comparison' }
            ]
          }),
          lesson(3, 'How this community works', 'Post your work in **Showcase**, questions in **Questions** \\(search first!\\).\n- Be specific when asking for feedback\n- Share settings with your clips'),
          lesson(4, 'Introduce yourself', '', { posts: ['welcome-introduce-yourself'] })
        ]
      },
      {
        id: 'c-light', slug: 'lighting-on-a-budget', title: 'Lighting on a Budget', desc: 'Make natural and practical light do the work.', cover: m('cover-light.jpg'), lessonCount: 4,
        items: [
          { type: 'set', id: 's1', title: 'Natural light', items: [lesson(1, 'Window light', 'Put your subject at 45 degrees to the window.'), lesson(2, 'Bouncing with a reflector', 'Gold side for warmth, white for neutral.')] },
          { type: 'set', id: 's2', title: 'Practical lights', items: [lesson(3, 'Using lamps in frame', 'Swap bulbs to match colour temperature.'), lesson(4, 'Night exteriors', `See how one member did it: ${introUrl}`)] }
        ]
      },
      { id: 'c-edit', slug: 'editing-fundamentals', title: 'Editing Fundamentals', desc: 'Cutting for rhythm, sound first.', cover: m('cover-edit.jpg'), lessonCount: 2,
        items: [lesson(1, 'Cutting on action', 'Cut in the middle of a movement, not at the start.'), lesson(2, 'J and L cuts', 'Let sound lead the picture.')] },
      { id: 'c-color', slug: 'color-grading', title: 'Color Grading', desc: 'From flat log footage to a consistent look.', cover: m('cover-color.jpg'), lessonCount: 0, items: [] }
    ]
  },
  community: {
    categories: [{ id: 'c1', name: 'Announcements' }, { id: 'c2', name: 'Showcase' }, { id: 'c3', name: 'Questions' }, { id: 'c4', name: 'Gear' }],
    posts
  }
}

for (const [k, v] of Object.entries({ group: archive.group, classroom: archive.classroom, community: archive.community }))
  writeFileSync(join(dir, `${k}.json`), JSON.stringify(v, null, 1))
console.log('demo archive written to', dir)
