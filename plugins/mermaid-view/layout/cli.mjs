import { layoutAll } from './elk-layout.mjs'

let input = ''
for await (const chunk of process.stdin) input += chunk
process.stdout.write(JSON.stringify(await layoutAll(JSON.parse(input))))
