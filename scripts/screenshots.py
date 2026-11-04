"""README screenshots from the trimmed AI Video Bootcamp demo.

1. node scripts/make-demo.mjs
2. SKOOL_VAULT_LIBRARY=demo SKOOL_VAULT_PORT=4788 npm start
3. python scripts/screenshots.py            -> docs/screenshots/*.png

The dashboard is shown with a stand-in for the app bridge. The viewer reads the demo archive.
Nothing here uses a real login.
"""
import json
import re
import subprocess
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "docs" / "screenshots"
OUT.mkdir(parents=True, exist_ok=True)
SHOTS = json.loads((ROOT / "demo" / "shots.json").read_text(encoding="utf-8"))
BASE = "http://127.0.0.1:4788"
SLUG = SHOTS["slug"]
SIZE = {"width": 1280, "height": 800}

html = (ROOT / "out" / "renderer" / "index.html").read_text(encoding="utf-8")
DASH_JS = re.search(r'src="\./(assets/index-[^"]+\.js)"', html).group(1)
DASH_CSS = re.findall(r'href="\./(assets/[^"]+\.css)"', html)

fake_link = "https://quiet-harbor-lens-frame.trycloudflare.com/?k=demo-key-not-real"
qr_svg = subprocess.run(
    ["node", "-e", "require('qrcode').toString(process.argv[1],{type:'svg',margin:1,color:{dark:'#1e2a38',light:'#ffffff'}}).then(s=>process.stdout.write(s))", fake_link],
    cwd=ROOT, capture_output=True, text=True, check=True,
).stdout

logo = "/archive/" + SLUG + "/" + SHOTS["logo"]
job = {
    "id": "j",
    "slug": SLUG,
    "status": "running",
    "phase": SHOTS["job"]["phase"],
    "current": SHOTS["job"]["current"],
    "done": 18,
    "total": 48,
    "videos": [
        {"key": "a", "label": "Kling 3.0", "pct": 64, "speed": "9.2MiB/s"},
        {"key": "b", "label": "Seedance 2.0", "pct": 21, "speed": "7.8MiB/s"},
    ],
    "videosDone": 6,
    "videosTotal": 14,
    "log": ["course 1/8 done: Start Here"],
    "errors": [],
    "startedAt": 0,
}
BRIDGE = """
(() => {
  const SLUG = %(slug)s, LOGO = %(logo)s, JOB = %(job)s;
  const remote = { status: 'on', url: %(link)s, qr: %(qr)s, lanUrls: ['http://192.168.1.20:4777/?k=demo-key-not-real'] };
  const account = { loggedIn: true, id: 'demo', name: 'Demo', avatar: null, accounts: [{ id: 'demo', name: 'Demo', avatar: null, loggedIn: true, active: true }] };
  const settings = { libraryDir: 'C:\\\\Users\\\\you\\\\Documents\\\\Skool Vault', port: 4777, lan: true, maxHeight: 0, speed: 'normal', accessKey: 'x' };
  window.appWindow = { platform: 'win32', minimize: async () => {}, toggleMaximize: async () => {}, close: async () => {}, isMaximized: async () => false, onMaximized: () => () => {} };
  window.__mode = 'community';
  window.vault = {
    account: async () => account,
    login: async () => account, logout: async () => ({ loggedIn: false, accounts: [] }),
    switchAccount: async () => account, addAccount: async () => account, removeAccount: async () => account,
    remoteGroups: async () => [{ id: '1', slug: SLUG, name: %(name)s, logo: LOGO }],
    scan: async () => { const g = await (await fetch('/api/group/' + SLUG)).json();
      return { group: {}, totalPosts: g.community.posts.length, courses: g.classroom.courses.map((c) => ({ id: c.id, slug: c.slug, title: c.title,
        cover: '/archive/' + SLUG + '/' + c.cover, lessons: c.lessonCount, locked: false })) } },
    courseOutline: async (_slug, courseSlug) => { const g = await (await fetch('/api/group/' + SLUG)).json();
      const c = g.classroom.courses.find((x) => x.slug === courseSlug || x.id === courseSlug);
      if (!c) return [];
      return c.items.map((it) => it.type === 'set'
        ? { title: it.title, lessons: it.items.map((l) => ({ id: l.id, title: l.title })) }
        : { title: '', lessons: [{ id: it.id, title: it.title }] }); },
    browseSkool: async () => {},
    startJob: async () => 'j', cancelJob: async () => {}, pauseJob: async () => {}, resumeJob: async () => {}, clearJobs: async () => {},
    jobs: async () => (window.__mode === 'community' ? [{ ...JOB, startedAt: Date.now() }] : []), onJob: () => () => {},
    library: async () => (await fetch('/api/library')).json(),
    openViewer: async () => {}, openInBrowser: async () => {}, showFolder: async () => {},
    tempUsage: async () => ({ libraryBytes: 4.8 * 1024 * 1024 * 1024, videoBytes: 4.1 * 1024 * 1024 * 1024, cacheBytes: 180 * 1024 * 1024, leftoverBytes: 6 * 1024 * 1024 }),
    clearTemp: async () => ({ libraryBytes: 0, videoBytes: 0, cacheBytes: 0, leftoverBytes: 0, freedBytes: 0, keptLeftovers: false }),
    stripPersonal: async () => ({ groups: 1, filesChanged: 0, cookiesRemoved: 0, kept: 0, busy: false }),
    settings: async () => settings,
    saveSettings: async (p) => ({ ...settings, ...p }), pickDir: async () => null,
    serverInfo: async () => ({ url: 'http://127.0.0.1:4777/viewer.html#/', port: 4788, lan: [] }),
    remote: async () => remote, startRemote: async () => remote, stopRemote: async () => ({ status: 'off' }),
    resetAccessKey: async () => remote, onRemote: () => () => {}, copy: () => {}
  };
})();
""" % {
    "slug": json.dumps(SLUG),
    "logo": json.dumps(logo),
    "name": json.dumps(SHOTS["name"]),
    "job": json.dumps(job),
    "link": json.dumps(fake_link),
    "qr": json.dumps(qr_svg),
}


def dashboard(page, theme, nav=None, name="", expand=False):
    page.goto(f"{BASE}/dashboard-preview")
    page.evaluate(
        """([css, js, theme]) => new Promise((done) => {
          localStorage.setItem('sv:dash-theme', theme);
          document.head.innerHTML = css.map((c) => '<link rel=stylesheet href="/' + c + '">').join('');
          document.body.innerHTML = '<div id=root></div>';
          import('/' + js).then(() => setTimeout(done, 1500));
        })""",
        [DASH_CSS, DASH_JS, theme],
    )
    if nav:
        page.get_by_role("button", name=re.compile(rf"^\s*{nav}")).first.click()
        page.wait_for_timeout(1200)
    if expand:
        page.get_by_role("button", name=re.compile(r"Show lessons in")).first.click()
        page.wait_for_timeout(800)
    page.screenshot(path=str(OUT / name))
    print("saved", name)


def reveal(selector):
    def run(page):
        page.evaluate(
            """(sel) => { const el = document.querySelector(sel); if (el) el.scrollIntoView({ block: 'center' }); }""",
            selector,
        )
        page.wait_for_timeout(400)
    return run


def viewer(page, theme, route, name, wait=1500, after=None):
    page.goto(f"{BASE}/viewer.html#/{route}")
    page.evaluate("(t) => { localStorage.setItem('sv:theme', JSON.stringify(t)); }", theme)
    page.reload()
    page.wait_for_timeout(wait)
    if after:
        after(page)
    page.screenshot(path=str(OUT / name))
    print("saved", name)


image = SHOTS["imageLesson"]
video = SHOTS["videoLesson"]
post = SHOTS["postId"]

with sync_playwright() as p:
    browser = p.chromium.launch()
    for theme in ("light", "dark"):
        ctx = browser.new_context(viewport=SIZE, color_scheme=theme, device_scale_factor=1)
        ctx.add_init_script(BRIDGE)
        page = ctx.new_page()
        dashboard(page, theme, None, f"app-community-{theme}.png", expand=True)
        page.evaluate("window.__mode = 'library'")
        dashboard(page, theme, "Library", f"app-library-{theme}.png")
        viewer(page, theme, f"g/{SLUG}", f"viewer-community-{theme}.png")
        viewer(page, theme, f"g/{SLUG}/classroom/{image['courseId']}/{image['lessonId']}", f"viewer-lesson-{theme}.png")
        viewer(page, theme, f"g/{SLUG}/post/{post}", f"viewer-post-{theme}.png", after=reveal(".modal .image-grid img"))
        ctx.close()
    ctx = browser.new_context(viewport=SIZE, color_scheme="light")
    ctx.add_init_script(BRIDGE)
    page = ctx.new_page()
    viewer(page, "light", f"g/{SLUG}/classroom", "viewer-classroom-light.png")
    viewer(page, "light", f"g/{SLUG}/classroom/{video['courseId']}/{video['lessonId']}", "viewer-video-light.png", wait=2500)
    dashboard(page, "light", "Settings", "app-settings-light.png")
    browser.close()
