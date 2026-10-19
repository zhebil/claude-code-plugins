import { writeFileSync } from 'node:fs'
import { renderDiagrams } from '../../hooks/register.js'
import { layoutAll } from '../../layout/elk-layout.mjs'
import * as diagrams from './diagrams.mjs'

const recorded = {}
async function record(graphs) {
  const key = JSON.stringify(graphs)
  recorded[key] = await layoutAll(graphs)
  return recorded[key]
}
for (const text of Object.values(diagrams)) await renderDiagrams(text, 120, record)
writeFileSync(new URL('./layouts.mjs', import.meta.url), `export default ${JSON.stringify(recorded)}\n`)
