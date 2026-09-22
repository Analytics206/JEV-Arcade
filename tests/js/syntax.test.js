// Every module the page loads parses. The page has no build step, so a syntax
// error would first be seen in a browser; this is the only thing that reads them
// all. Each file is checked as an ES module (a .mjs copy): Node 24 decides a .js
// file's type by sniffing it, and `node --check` on a .js module passes errors.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const STATIC = fileURLToPath(new URL('../../src/wikirace/static/', import.meta.url))

function modules(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) return e.name === 'vendor' ? [] : modules(p)
    return e.name.endsWith('.js') ? [p] : []
  })
}

describe('the page parses', () => {
  const files = modules(STATIC)
  const tmp = mkdtempSync(path.join(tmpdir(), 'wikirace-syntax-'))
  it('finds the modules', () => assert.ok(files.length > 20))
  for (const file of files) {
    it(path.relative(STATIC, file), () => {
      const copy = path.join(tmp, `${path.relative(STATIC, file).replace(/[\\/]/g, '__')}.mjs`)
      copyFileSync(file, copy)
      try {
        execFileSync(process.execPath, ['--check', copy], { stdio: 'pipe' })
      } catch (e) {
        assert.fail(`${path.relative(STATIC, file)} does not parse:\n${e.stderr}`)
      }
    })
  }
  it('cleans up', () => rmSync(tmp, { recursive: true, force: true }))
})
