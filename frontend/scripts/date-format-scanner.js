import fs from 'node:fs'
import path from 'node:path'

export function findDirectDateFormattingOffenders(rootDir) {
  const offenders = []
  const unambiguous = /toLocaleDateString|toLocaleTimeString|Intl\.DateTimeFormat|toDateString|toTimeString|toUTCString/
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        if (!['node_modules', 'dist', 'test'].includes(entry.name)) walk(absolute)
      } else if (entry.name.endsWith('.js') || entry.name.endsWith('.jsx')) {
        if (entry.name.endsWith('.test.js') || entry.name.endsWith('.test.jsx')) continue
        if (absolute.endsWith(path.join('src', 'lib', 'pakistanTime.js'))) continue
        const lines = fs.readFileSync(absolute, 'utf8').split(/\r?\n/)
        lines.forEach((line, index) => {
          if (unambiguous.test(line)) offenders.push(`${path.relative(rootDir, absolute)}:${index + 1}`)
          if (/\.toLocaleString\s*\(/.test(line)) {
            const numericReceiver = /(?:Number\([^;]+\))\.toLocaleString\s*\(/.test(line)
            const hasDateOptions = /(timeZone|dateStyle|timeStyle|hour|minute|month|weekday|year)\s*:/.test(line)
            if (hasDateOptions || !numericReceiver) {
              offenders.push(`${path.relative(rootDir, absolute)}:${index + 1}`)
            }
          }
        })
      }
    }
  }
  walk(rootDir)
  return offenders
}
