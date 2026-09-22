// `node --test tests/js` runs this file. Node 24 treats a directory argument as a
// module to run (this index.js), not as a folder to search, so it imports every
// *.test.js beside it. A bare `node --test`, or `node --test "tests/js/*.test.js"`,
// finds the test files directly and never runs this one.
import { readdirSync } from 'node:fs'

const here = new URL('./', import.meta.url)
for (const f of readdirSync(here).filter((f) => f.endsWith('.test.js')).sort()) {
  await import(new URL(f, here))
}
