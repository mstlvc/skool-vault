// One-off repair: archives saved before the markdown-escape fix show "\(" instead of "(".
// Usage: node scripts/fix-md-escapes.js "<library>/<community>"
const fs = require('fs')
const path = require('path')

const dir = process.argv[2]
const ESC = /\\([\\`*_{}\[\]()#+\-.!~|>])/g
let fixed = 0

const clean = (s) => {
  if (typeof s !== 'string' || !ESC.test(s)) return s
  ESC.lastIndex = 0
  fixed++
  return s.replace(ESC, '$1')
}
const walk = (o) => {
  if (Array.isArray(o)) return o.forEach(walk)
  if (!o || typeof o !== 'object') return
  for (const k of Object.keys(o)) {
    if ((k === 'html' || k === 'text' || k === 'title') && typeof o[k] === 'string') o[k] = clean(o[k])
    else walk(o[k])
  }
}

for (const name of ['community.json', 'classroom.json']) {
  const file = path.join(dir, name)
  if (!fs.existsSync(file)) continue
  fs.copyFileSync(file, file + '.before-escape-fix')
  const data = JSON.parse(fs.readFileSync(file, 'utf8'))
  walk(data)
  fs.writeFileSync(file + '.tmp', JSON.stringify(data, null, 1))
  fs.renameSync(file + '.tmp', file)
}
console.log(`fixed ${fixed} text fields`)
