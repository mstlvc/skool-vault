"""README screenshots from the fictional demo archive (never from a real one).

1. npm run fixture
2. SKOOL_VAULT_LIBRARY=test-library SKOOL_VAULT_PORT=4788 npm start
3. python scripts/screenshots.py            -> docs/screenshots/*.png

The dashboard is shown with a stand-in for the app bridge filled with demo data.
"""
import json
import re
import subprocess
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "docs" / "screenshots"
OUT.mkdir(parents=True, exist_ok=True)
BASE = "http://127.0.0.1:4788"
SLUG = "frame-and-light"
SIZE = {"width": 1280, "height": 800}

html = (ROOT / "out" / "renderer" / "index.html").read_text(encoding="utf-8")
DASH_JS = re.search(r'src="\./(assets/index-[^"]+\.js)"', html).group(1)
DASH_CSS = re.findall(r'href="\./(assets/[^"]+\.css)"', html)

fake_link = "https://quiet-harbor-lens-frame.trycloudflare.com/?k=demo-key-not-real"
qr_svg = subprocess.run(
    ["node", "-e", "require('qrcode').toString(process.argv[1],{type:'svg',margin:1,color:{dark:'#1e2a38',light:'#ffffff'}}).then(s=>process.stdout.write(s))", fake_link],
    cwd=ROOT, capture_output=True, text=True, check=True,
).stdout

BRIDGE = """
(() => {
  const SLUG = '%(slug)s', PORT = 4788;
  const job = { id: 'j', slug: SLUG, status: 'running', phase: 'Classroom: Lighting on a Budget', current: 'Bouncing with a reflector',
    done: 7, total: 10, videos: [{ key: 'a', label: 'Window light', pct: 64, speed: '9.2MiB/s' }, { key: 'b', label: 'Night exteriors', pct: 21, speed: '7.8MiB/s' }],
    videosDone: 3, videosTotal: 6, log: ['course 1/4 done: Getting Started'], errors: [], startedAt: Date.now() };
  const remote = { status: 'on', url: %(link)s, qr: %(qr)s, lanUrls: ['http://192.168.1.20:4777/?k=demo-key-not-real'] };
  window.appWindow = { platform: 'win32', minimize: async () => {}, toggleMaximize: async () => {}, close: async () => {}, isMaximized: async () => false, onMaximized: () => () => {} };
  window.__mode = 'community';
  window.vault = {
    account: async () => ({ loggedIn: true, name: 'Demo User', avatar: null }),
    login: async () => ({ loggedIn: true }), logout: async () => ({ loggedIn: false }),
    remoteGroups: async () => [{ id: '1', slug: SLUG, name: 'Frame & Light', logo: '/archive/' + SLUG + '/media/logo.png' },
                               { id: '2', slug: 'night-shooters', name: 'Night Shooters' }, { id: '3', slug: 'sound-for-film', name: 'Sound for Film' }],
    scan: async () => { const g = await (await fetch('/api/group/' + SLUG)).json();
      return { group: {}, totalPosts: g.community.posts.length, courses: g.classroom.courses.map((c) => ({ id: c.id, slug: c.slug, title: c.title,
        cover: '/archive/' + SLUG + '/' + c.cover, lessons: c.lessonCount, locked: false })).concat([{ id: 'vip', slug: 'vip', title: 'Members-only Workshops', lessons: 6, locked: true }]) } },
    startJob: async () => 'j', cancelJob: async () => {}, clearJobs: async () => {},
    jobs: async () => (window.__mode === 'community' ? [job] : []), onJob: () => () => {},
    library: async () => (await fetch('/api/library')).json(),
    openViewer: async () => {}, openInBrowser: async () => {}, showFolder: async () => {},
    settings: async () => ({ libraryDir: 'C:\\\\Users\\\\you\\\\Documents\\\\Skool Vault', port: 4777, lan: true, maxHeight: 0, speed: 'normal', accessKey: 'x' }),
    saveSettings: async (p) => p, pickDir: async () => null,
    serverInfo: async () => ({ url: 'http://127.0.0.1:4777/viewer.html#/', port: PORT, lan: [] }),
    remote: async () => remote, startRemote: async () => remote, stopRemote: async () => ({ status: 'off' }),
    resetAccessKey: async () => remote, onRemote: () => () => {}, copy: () => {}
  };
})();
""" % {"slug": SLUG, "link": json.dumps(fake_link), "qr": json.dumps(qr_svg)}


def dashboard(page, theme, nav=None, name=""):
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
        # sidebar items can carry extra text ("Library sharing"), so match the start of the name
        page.get_by_role("button", name=re.compile(rf"^\s*{nav}")).first.click()
        page.wait_for_timeout(1200)
    page.screenshot(path=str(OUT / name))
    print("saved", name)


def viewer(page, theme, route, name, wait=1500, after=None):
    page.goto(f"{BASE}/viewer.html#/{route}")
    page.evaluate("(t) => { localStorage.setItem('sv:theme', JSON.stringify(t)); }", theme)
    page.reload()
    page.wait_for_timeout(wait)
    if after:
        after(page)
    page.screenshot(path=str(OUT / name))
    print("saved", name)


with sync_playwright() as p:
    browser = p.chromium.launch()
    for theme in ("light", "dark"):
        ctx = browser.new_context(viewport=SIZE, color_scheme=theme, device_scale_factor=1)
        ctx.add_init_script(BRIDGE)
        page = ctx.new_page()
        dashboard(page, theme, None, f"app-community-{theme}.png")
        page.evaluate("window.__mode = 'library'")
        dashboard(page, theme, "Library", f"app-library-{theme}.png")
        viewer(page, theme, f"g/{SLUG}", f"viewer-community-{theme}.png")
        viewer(page, theme, f"g/{SLUG}/classroom/c-start/l2-13", f"viewer-lesson-{theme}.png")
        viewer(page, theme, f"g/{SLUG}/post/p-intro", f"viewer-post-{theme}.png")
        ctx.close()
    ctx = browser.new_context(viewport=SIZE, color_scheme="light")
    ctx.add_init_script(BRIDGE)
    page = ctx.new_page()
    viewer(page, "light", f"g/{SLUG}/classroom", "viewer-classroom-light.png")
    viewer(page, "light", f"g/{SLUG}/classroom/c-start/l1-7", "viewer-video-light.png", wait=2500)
    dashboard(page, "light", "Settings", "app-settings-light.png")
    browser.close()
