import { EventEmitter } from 'node:events'
import { vi } from 'vitest'
import { createExitRegistry, type ExitTarget } from '../src/exit.js'
import { createReporter } from '../src/reporter.js'
import type { FetchLike, ReporterOptions } from '../src/types.js'

export interface Call {
  url: string
  init: RequestInit
  body: { source: string; events: Array<{ type: string; at: string; payment: Record<string, unknown> }> }
  raw: string
}

/** A fetch double that records calls and answers with the given handler. */
export function fakeFetch(handler: (call: Call, index: number) => Response | Promise<Response> = () => new Response(null, { status: 202 })) {
  const calls: Call[] = []
  const fn = vi.fn<FetchLike>((url, init) => {
    const raw = String(init.body)
    const call: Call = { url, init, raw, body: JSON.parse(raw) as Call['body'] }
    calls.push(call)
    return Promise.resolve().then(() => handler(call, calls.length - 1))
  })
  return { fn, calls }
}

export function status(code: number): Response {
  return new Response(code === 204 ? null : '{}', { status: code })
}

export function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

export class FakeProcess extends EventEmitter implements ExitTarget {
  readonly pid = 4242
  readonly kill = vi.fn()
}

/** A reporter wired to a fake process, so tests never touch real signal handlers. */
export function make(options: ReporterOptions, target: FakeProcess = new FakeProcess()) {
  const reporter = createReporter({ flushInterval: 0, ...options }, createExitRegistry(target))
  return { reporter, target }
}

export const payment = {
  route: 'market-data',
  method: 'GET',
  resource: 'https://api.example.com/premium-data',
  mode: 'enforce',
  priceUsd: '0.01',
  amountAtomic: '10000',
  asset: 'USDC',
  network: 'eip155:8453',
  payTo: '0xabc',
  requestId: 'req_123',
}
