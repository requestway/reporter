import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// Runs the built package in a real child process. `npm test` builds first.
const dist = resolve(__dirname, '../dist')
const builds = {
  esm: `import { reporter } from ${JSON.stringify(`${dist}/index.js`)};`,
  cjs: `const { reporter } = require(${JSON.stringify(`${dist}/index.cjs`)});`,
}

let server: Server
let url: string
const received: string[] = []

beforeAll(async () => {
  if (!existsSync(`${dist}/index.js`)) throw new Error('dist is missing: run `npm run build` first')
  server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk: Buffer) => (body += chunk.toString()))
    req.on('end', () => {
      received.push(body)
      res.writeHead(202).end()
    })
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/x402/events`
})

afterAll(() => {
  server.close()
})

function run(format: keyof typeof builds, body: string, signal?: NodeJS.Signals) {
  const source = `${builds[format]}\n${body}`
  const args = format === 'esm' ? ['--input-type=module', '-e', source] : ['-e', source]
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null; ms: number }>((done, fail) => {
    const started = Date.now()
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'inherit'] })
    const killer = setTimeout(() => child.kill('SIGKILL'), 10_000)
    if (signal) {
      child.stdout.on('data', (chunk: Buffer) => {
        if (chunk.toString().includes('ready')) child.kill(signal)
      })
    }
    child.on('error', fail)
    child.on('exit', (code, sig) => {
      clearTimeout(killer)
      done({ code, signal: sig, ms: Date.now() - started })
    })
  })
}

describe.each(['esm', 'cjs'] as const)('in a real %s process', (format) => {
  it('does not hold the event loop open', async () => {
    const result = await run(format, `reporter({ key: 'rw_test_x', url: ${JSON.stringify(url)}, flushInterval: 60000 })`)
    expect(result.code).toBe(0)
    expect(result.ms).toBeLessThan(3000)
  })

  it('flushes buffered events on beforeExit', async () => {
    const before = received.length
    const result = await run(
      format,
      `const rw = reporter({ key: 'rw_test_x', url: ${JSON.stringify(url)} }); rw.observed({ route: 'exit-${format}' })`,
    )
    expect(result.code).toBe(0)
    expect(received.slice(before).join()).toContain(`exit-${format}`)
  })

  it.each(['SIGTERM', 'SIGINT'] as const)('flushes on %s and still exits by that signal', async (sig) => {
    const before = received.length
    const result = await run(
      format,
      `const rw = reporter({ key: 'rw_test_x', url: ${JSON.stringify(url)} });
       rw.observed({ route: '${sig}-${format}' });
       setInterval(() => {}, 1000);
       console.log('ready')`,
      sig,
    )
    expect(result.signal).toBe(sig)
    expect(received.slice(before).join()).toContain(`${sig}-${format}`)
  })

  it('leaves a signal to the application when it handles it', async () => {
    const result = await run(
      format,
      `const rw = reporter({ key: 'rw_test_x', url: ${JSON.stringify(url)} });
       process.on('SIGTERM', () => { rw.shutdown().then(() => process.exit(7)) });
       setInterval(() => {}, 1000);
       console.log('ready')`,
      'SIGTERM',
    )
    expect(result.code).toBe(7)
  })
})
