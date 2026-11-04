// One browser identity per Skool account. An account keeps the same profile on every visit.
// A new account gets a profile no other account on this PC is using.

export interface UaBrand {
  brand: string
  version: string
}

export interface Fingerprint {
  ua: string
  fullVersion: string
  brands: UaBrand[]
  fullVersionList: UaBrand[]
  secChUa: string
  platform: 'Windows'
  platformVersion: string
  lang: string
  screenWidth: number
  screenHeight: number
  hardwareConcurrency: number
}

function chrome(
  major: number,
  build: string,
  grease: [string, string],
  platformVersion: string,
  lang: string,
  screen: [number, number],
  cores: number,
  order: number
): Fingerprint {
  const full = `${major}.0.${build}`
  const brands = [
    { brand: 'Chromium', version: String(major) },
    { brand: grease[0], version: grease[1] },
    { brand: 'Google Chrome', version: String(major) }
  ]
  while (order-- > 0) brands.push(brands.shift()!)
  const fullVersionList = brands.map((b) => ({
    brand: b.brand,
    version: b.brand === grease[0] ? `${grease[1]}.0.0.0` : full
  }))
  return {
    ua: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${full} Safari/537.36`,
    fullVersion: full,
    brands,
    fullVersionList,
    secChUa: brands.map((b) => `"${b.brand}";v="${b.version}"`).join(', '),
    platform: 'Windows',
    platformVersion,
    lang,
    screenWidth: screen[0],
    screenHeight: screen[1],
    hardwareConcurrency: cores
  }
}

/** Distinct, ordinary Windows Chrome profiles. The list order is not a priority. */
export const FINGERPRINTS: Fingerprint[] = [
  chrome(131, '6778.204', ['Not_A Brand', '24'], '15.0.0', 'en-US,en;q=0.9', [1920, 1080], 8, 0),
  chrome(130, '6723.117', ['Not?A_Brand', '99'], '10.0.0', 'en-GB,en;q=0.9', [1536, 864], 4, 1),
  chrome(129, '6668.100', ['Not)A;Brand', '24'], '15.0.0', 'en-US,en;q=0.9,en-GB;q=0.8', [1366, 768], 16, 2),
  chrome(128, '6613.138', ['Not;A=Brand', '24'], '10.0.0', 'en-CA,en;q=0.9,en-US;q=0.8', [1440, 900], 8, 0),
  chrome(127, '6533.120', ['Not A(Brand', '99'], '15.0.0', 'en-AU,en;q=0.9', [1600, 900], 12, 1),
  chrome(126, '6478.127', ['Not/A)Brand', '8'], '10.0.0', 'en-US,en;q=0.8', [1280, 800], 4, 2),
  chrome(125, '6422.142', ['Not.A/Brand', '8'], '15.0.0', 'en-GB,en-US;q=0.9,en;q=0.8', [2560, 1440], 16, 0),
  chrome(124, '6367.207', ['Not_A Brand', '99'], '10.0.0', 'en-US', [1680, 1050], 12, 1)
]

export const fingerprintKey = (f: Fingerprint) =>
  `${f.ua}|${f.lang}|${f.screenWidth}x${f.screenHeight}|${f.hardwareConcurrency}|${f.platformVersion}`

const LANGS = ['en-US,en;q=0.9', 'en-GB,en;q=0.9', 'en-CA,en;q=0.9,en-US;q=0.8', 'en-AU,en;q=0.9', 'en-US']
const GREASE: [string, string][] = [
  ['Not_A Brand', '24'],
  ['Not?A_Brand', '99'],
  ['Not)A;Brand', '24'],
  ['Not;A=Brand', '24'],
  ['Not/A)Brand', '8']
]
const CORES = [4, 8, 12, 16]

function extraFingerprint(n: number): Fingerprint {
  const major = 120 + (n % 16)
  const build = `${6000 + (n % 800)}.${50 + (n % 180)}`
  return chrome(
    major,
    build,
    GREASE[n % GREASE.length],
    n % 2 ? '15.0.0' : '10.0.0',
    LANGS[n % LANGS.length],
    [1280 + (n % 10) * 80, 720 + (n % 6) * 72],
    CORES[n % CORES.length],
    n % 3
  )
}

/** The first built-in profile nobody else has, or a generated one that still doesn't collide. */
export function chooseFingerprint(used: string[]): Fingerprint {
  const free = FINGERPRINTS.find((f) => !used.includes(fingerprintKey(f)))
  if (free) return free
  for (let n = 0; n < 1000; n++) {
    const fp = extraFingerprint(n + used.length * 31)
    if (!used.includes(fingerprintKey(fp))) return fp
  }
  return extraFingerprint(used.length + 1000)
}

/**
 * Keep this account's language, screen, and client-hint grease, but use the running browser's Chrome version.
 * A page that claims an older Chrome than the one actually connecting is refused by CloudFront.
 */
export function withBrowser(fp: Fingerprint, chromeFull: string): Fingerprint {
  const full = chromeFull.trim()
  const major = full.split('.')[0]
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(full)) return fp
  if (fp.fullVersion === full && fp.ua.includes(`Chrome/${full} `)) return fp
  const brands = fp.brands.map((b) =>
    b.brand === 'Chromium' || b.brand === 'Google Chrome' ? { ...b, version: major } : b
  )
  const fullVersionList = fp.fullVersionList.map((b) =>
    b.brand === 'Chromium' || b.brand === 'Google Chrome' ? { ...b, version: full } : b
  )
  return {
    ...fp,
    ua: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${full} Safari/537.36`,
    fullVersion: full,
    brands,
    fullVersionList,
    secChUa: brands.map((b) => `"${b.brand}";v="${b.version}"`).join(', ')
  }
}

export function userAgentOverride(fp: Fingerprint) {
  const acceptLanguage = fp.lang.split(',')[0]
  return {
    userAgent: fp.ua,
    acceptLanguage,
    platform: 'Win32',
    userAgentMetadata: {
      brands: fp.brands,
      fullVersionList: fp.fullVersionList,
      fullVersion: fp.fullVersion,
      platform: fp.platform,
      platformVersion: fp.platformVersion,
      architecture: 'x86',
      model: '',
      mobile: false,
      bitness: '64',
      wow64: false
    }
  }
}

/** Layout stays the real window size. screen.width / screen.height come from the account profile. */
export function deviceMetrics(fp: Fingerprint, width: number, height: number) {
  return {
    width: Math.max(320, width),
    height: Math.max(400, height),
    deviceScaleFactor: 1,
    mobile: false,
    screenWidth: fp.screenWidth,
    screenHeight: fp.screenHeight
  }
}
