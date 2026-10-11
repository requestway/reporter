import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_URL, reporter } from '../src/index.js'
import type { FetchLike, Reporter, ReporterErrorContext } from '../src/types.js'
import { type Call, deferred, fakeFetch, make, payment, status } from './helpers.js'

const KEY = 'rw_live_test_key'

function methods(rw: Reporter) {
  return [
    () => rw.settled({ ...payment, transaction: '0xdef', pending: false }),
    () => rw.failed({ ...payment, stage: 'verify', reason: 'invalid_signature' }),
    () => rw.observed(payment),
  ]
}

function settle(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

afterEach(() => {
  vi.useRealTimers()
})

describe('never throws', () => {
  const hostile: Array<[string, FetchLike]> = [
    ['a dead network', () => Promise.reject(new TypeError('fetch failed'))],
    ['a fetch that throws synchronously', () => {
      throw new Error('boom')
    }],
    ['a 401', () => Promise.resolve(status(401))],
    ['a 500', () => Promise.resolve(status(500))],
    ['a fetch that never answers', () => new Promise<Response>(() => {})],
    ['a fetch that resolves to garbage', () => Promise.resolve({} as Response)],
    ['a fetch that resolves to null', () => Promise.resolve(null as unknown as Response)],
  ]

  it.each(hostile)('with %s: records return void synchronously and flush resolves', async (_, fetch) => {
    const errors: ReporterErrorContext[] = []
    const { reporter: rw } = make({ key: KEY, fetch, timeout: 20, maxBuffer: 2, onError: (_e, c) => errors.push(c) })

    for (const record of methods(rw)) {
      expect(record()).toBeUndefined()
    }
    await expect(rw.flush()).resolves.toBeUndefined()
    await expect(rw.shutdown()).resolves.toBeUndefined()
    expect(errors.length).toBeGreaterThan(0)
  })

  it.each([
    ['a missing key', {}],
    ['an empty key', { key: '' }],
    ['a whitespace key', { key: '   ' }],
    ['a non-string key', { key: 42 as unknown as string }],
  ])('with %s', async (_, options) => {
    const { fn } = fakeFetch()
    const rw = reporter({ ...options, fetch: fn })
    for (const record of methods(rw)) expect(record()).toBeUndefined()
    await expect(rw.flush()).resolves.toBeUndefined()
    await expect(rw.shutdown()).resolves.toBeUndefined()
    expect(rw.enabled).toBe(false)
  })

  it.each([
    ['a malformed resource', { resource: 'http://[::1' }],
    ['a non-URL resource', { resource: 'definitely not a url ?token=1' }],
    ['a numeric resource', { resource: 42 }],
    ['null input', null],
    ['undefined input', undefined],
    ['a string input', 'payment'],
    ['numeric amounts', { priceUsd: 0.1, amountAtomic: 10n }],
    ['a circular object', (() => { const o: Record<string, unknown> = { route: 'r' }; o.self = o; return o })()],
    ['a throwing getter', Object.defineProperty({}, 'route', { get() { throw new Error('getter') }, enumerable: true })],
    ['a hostile proxy', new Proxy({}, { get() { throw new Error('proxy') } })],
  ])('with %s', async (_, input) => {
    const { fn } = fakeFetch()
    const { reporter: rw } = make({ key: KEY, fetch: fn })
    expect(rw.settled(input as never)).toBeUndefined()
    expect(rw.failed(input as never)).toBeUndefined()
    expect(rw.observed(input as never)).toBeUndefined()
    await expect(rw.flush()).resolves.toBeUndefined()
  })

  it.each([null, undefined, 'key', 42, { key: KEY, maxBuffer: Number.NaN, timeout: -1, flushInterval: Infinity }])(
    'when constructed with %j',
    async (options) => {
      let rw: Reporter | undefined
      expect(() => (rw = reporter(options as never))).not.toThrow()
      await rw?.shutdown()
    },
  )

  it('times out a hung request', async () => {
    const errors: ReporterErrorContext[] = []
    const { reporter: rw } = make({ key: KEY, fetch: () => new Promise<Response>(() => {}), timeout: 10, onError: (_e, c) => errors.push(c) })
    rw.observed(payment)
    const started = Date.now()
    await rw.flush()
    expect(Date.now() - started).toBeLessThan(1000)
    expect(errors).toEqual([{ reason: 'timeout', events: 1, retried: true }])
  })

  it('aborts the request on timeout', async () => {
    let signal: AbortSignal | undefined
    const { reporter: rw } = make({
      key: KEY,
      timeout: 10,
      fetch: (_url, init) => {
        signal = init.signal ?? undefined
        return new Promise<Response>(() => {})
      },
    })
    rw.observed(payment)
    await rw.flush()
    expect(signal?.aborted).toBe(true)
  })

  it('does not let a throwing onError escape', async () => {
    const onError = vi.fn(() => {
      throw new Error('user callback')
    })
    const { reporter: rw } = make({ key: KEY, fetch: () => Promise.resolve(status(401)), onError })
    expect(rw.observed(payment)).toBeUndefined()
    await expect(rw.flush()).resolves.toBeUndefined()
    expect(onError).toHaveBeenCalledOnce()
  })

  it('does not let a rejecting async onError escape', async () => {
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      const { reporter: rw } = make({ key: KEY, fetch: () => Promise.resolve(status(401)), onError: async () => Promise.reject(new Error('async')) })
      rw.observed(payment)
      await rw.flush()
      await settle(10)
      expect(unhandled).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', unhandled)
    }
  })

  it('does not let a throwing waitUntil escape', async () => {
    const { fn, calls } = fakeFetch()
    const { reporter: rw } = make({ key: KEY, fetch: fn, waitUntil: () => { throw new Error('waitUntil') } })
    expect(rw.observed(payment)).toBeUndefined()
    await rw.flush()
    expect(calls).toHaveLength(1)
  })
})

describe('disabled', () => {
  it('makes zero fetch calls without a key', async () => {
    const { fn } = fakeFetch()
    const rw = reporter({ fetch: fn, flushInterval: 1, maxBuffer: 1 })
    for (const record of methods(rw)) record()
    await rw.flush()
    await settle(10)
    await rw.shutdown()
    expect(fn).not.toHaveBeenCalled()
  })

  it('makes zero fetch calls when enabled is false', async () => {
    const { fn } = fakeFetch()
    const rw = reporter({ key: KEY, enabled: false, fetch: fn, maxBuffer: 1 })
    for (const record of methods(rw)) record()
    await rw.flush()
    expect(fn).not.toHaveBeenCalled()
    expect(rw.enabled).toBe(false)
  })

  it('stays off when enabled is true without a key', async () => {
    const { fn } = fakeFetch()
    const rw = reporter({ enabled: true, fetch: fn, maxBuffer: 1 })
    rw.observed(payment)
    await rw.flush()
    expect(fn).not.toHaveBeenCalled()
  })

  it('registers no timers or process listeners', () => {
    const interval = vi.spyOn(globalThis, 'setInterval')
    const before = process.listenerCount('SIGTERM')
    reporter({})
    expect(interval).not.toHaveBeenCalled()
    expect(process.listenerCount('SIGTERM')).toBe(before)
  })
})

describe('wire contract', () => {
  it('matches the envelope byte for byte', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-11T12:34:56.789Z') })
    const { fn, calls } = fakeFetch()
    const { reporter: rw } = make({ key: KEY, fetch: fn })

    rw.settled({ ...payment, payTo: '0xabc...', transaction: '0xdef...', pending: false })
    await rw.flush()

    expect(calls).toHaveLength(1)
    const [call] = calls as [Call]
    expect(call.url).toBe('https://api.requestway.com/x402/events')
    expect(call.init.method).toBe('POST')
    expect(call.init.headers).toMatchObject({ Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' })
    expect(call.raw).toBe(
      '{"source":"node-requestway","events":[{"type":"payment.settled","at":"2026-10-11T12:34:56+00:00",' +
        '"payment":{"route":"market-data","method":"GET","resource":"https://api.example.com/premium-data",' +
        '"mode":"enforce","price_usd":"0.01","amount_atomic":"10000","asset":"USDC","network":"eip155:8453",' +
        '"pay_to":"0xabc...","request_id":"req_123","transaction":"0xdef...","pending":false}}]}',
    )
  })

  it('sends the three event types with their extras', async () => {
    const { fn, calls } = fakeFetch()
    const { reporter: rw } = make({ key: KEY, fetch: fn })
    rw.settled({ route: 'a', transaction: '0x1', pending: true })
    rw.failed({ route: 'b', stage: 'settle', reason: 'timeout' })
    rw.observed({ route: 'c' })
    await rw.flush()

    const events = calls[0]?.body.events ?? []
    expect(events.map((e) => [e.type, e.payment])).toEqual([
      ['payment.settled', { route: 'a', transaction: '0x1', pending: true }],
      ['payment.failed', { route: 'b', stage: 'settle', reason: 'timeout' }],
      ['payment.observed', { route: 'c' }],
    ])
  })

  it('uses the configured url', async () => {
    const { fn, calls } = fakeFetch()
    const { reporter: rw } = make({ key: KEY, fetch: fn, url: 'http://localhost:9999/ingest' })
    rw.observed(payment)
    await rw.flush()
    expect(calls[0]?.url).toBe('http://localhost:9999/ingest')
    expect(DEFAULT_URL).toBe('https://api.requestway.com/x402/events')
  })

  it('does not follow redirects', async () => {
    const { fn, calls } = fakeFetch()
    const { reporter: rw } = make({ key: KEY, fetch: fn })
    rw.observed(payment)
    await rw.flush()
    expect(calls[0]?.init.redirect).toBe('manual')
  })

  it('strips query strings and fragments before buffering', async () => {
    const { fn, calls } = fakeFetch()
    const { reporter: rw } = make({ key: KEY, fetch: fn })
    rw.observed({ resource: 'https://api.example.com/data?api_key=SECRET&email=a@b.c#token=SECRET' })
    await rw.flush()
    expect(calls[0]?.raw).not.toContain('SECRET')
    expect(calls[0]?.body.events[0]?.payment.resource).toBe('https://api.example.com/data')
  })

  it('keeps a 20-digit atomic amount intact', async () => {
    const { fn, calls } = fakeFetch()
    const { reporter: rw } = make({ key: KEY, fetch: fn })
    rw.settled({ amountAtomic: '98765432109876543210', priceUsd: '98765432109876.543210' })
    await rw.flush()
    expect(calls[0]?.raw).toContain('"price_usd":"98765432109876.543210","amount_atomic":"98765432109876543210"')
  })

  it('omits null and undefined fields', async () => {
    const { fn, calls } = fakeFetch()
    const { reporter: rw } = make({ key: KEY, fetch: fn })
    rw.settled({ route: 'r', method: null, asset: undefined, requestId: null, transaction: null, pending: undefined })
    await rw.flush()
    expect(calls[0]?.raw).not.toContain('null')
    expect(calls[0]?.body.events[0]?.payment).toEqual({ route: 'r' })
  })

  it('never sends a payer or wallet', async () => {
    const { fn, calls } = fakeFetch()
    const { reporter: rw } = make({ key: KEY, fetch: fn })
    rw.settled({ ...payment, payer: '0xPAYER', wallet: '0xWALLET' } as never)
    await rw.flush()
    expect(calls[0]?.raw).not.toMatch(/payer|wallet/i)
  })
})

describe('buffering', () => {
  it('flushes when the buffer reaches maxBuffer', async () => {
    const { fn, calls } = fakeFetch()
    const { reporter: rw } = make({ key: KEY, fetch: fn, maxBuffer: 3 })
    rw.observed(payment)
    rw.observed(payment)
    expect(fn).not.toHaveBeenCalled()
    rw.observed(payment)
    expect(fn).toHaveBeenCalledOnce()
    await rw.flush()
    expect(calls[0]?.body.events).toHaveLength(3)
  })

  it('drops and counts events beyond the cap while a send is in flight', async () => {
    const gate = deferred<Response>()
    const errors: ReporterErrorContext[] = []
    const { fn, calls } = fakeFetch((_c, i) => (i === 0 ? gate.promise : status(202)))
    const { reporter: rw } = make({ key: KEY, fetch: fn, maxBuffer: 2, onError: (_e, c) => errors.push(c) })

    rw.observed({ requestId: '1' })
    rw.observed({ requestId: '2' }) // full: first batch in flight
    rw.observed({ requestId: '3' })
    rw.observed({ requestId: '4' }) // buffer full again, still in flight
    rw.observed({ requestId: '5' })
    rw.observed({ requestId: '6' })
    rw.observed({ requestId: '7' })

    expect(fn).toHaveBeenCalledOnce()
    gate.resolve(status(202))
    await rw.flush()

    const sent = calls.flatMap((c) => c.body.events.map((e) => e.payment.request_id))
    expect(sent).toEqual(['1', '2', '3', '4'])
    expect(errors).toEqual([{ reason: 'dropped', dropped: 3 }])
  })

  it('never holds more than two batches in memory under sustained load', async () => {
    const gate = deferred<Response>()
    const { fn } = fakeFetch(() => gate.promise)
    const { reporter: rw } = make({ key: KEY, fetch: fn, maxBuffer: 10 })
    for (let i = 0; i < 100_000; i++) rw.observed(payment)
    expect(fn).toHaveBeenCalledOnce()
    gate.resolve(status(202))
    await rw.shutdown()
    expect(fn.mock.calls.length).toBeLessThanOrEqual(3)
  })

  it('clamps maxBuffer to the server batch limit', async () => {
    const { fn, calls } = fakeFetch()
    const { reporter: rw } = make({ key: KEY, fetch: fn, maxBuffer: 10_000 })
    for (let i = 0; i < 500; i++) rw.observed(payment)
    await rw.flush()
    expect(calls[0]?.body.events).toHaveLength(500)
  })

  it('flushes on the interval', async () => {
    vi.useFakeTimers()
    const { fn } = fakeFetch()
    const { reporter: rw } = make({ key: KEY, fetch: fn, flushInterval: 1000 })
    rw.observed(payment)
    expect(fn).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1000)
    expect(fn).toHaveBeenCalledOnce()
    await rw.shutdown()
  })

  it('unrefs the interval so it cannot hold the event loop open', () => {
    const interval = vi.spyOn(globalThis, 'setInterval')
    const rw = reporter({ key: KEY, fetch: fakeFetch().fn, flushInterval: 1000, exitHandlers: false })
    const timer = interval.mock.results[0]?.value as NodeJS.Timeout
    expect(timer.hasRef()).toBe(false)
    void rw.shutdown()
  })

  it('does not start a timer when flushInterval is 0', () => {
    const interval = vi.spyOn(globalThis, 'setInterval')
    make({ key: KEY, fetch: fakeFetch().fn, flushInterval: 0 })
    expect(interval).not.toHaveBeenCalled()
  })

  it('flush with an empty buffer makes no request', async () => {
    const { fn } = fakeFetch()
    const { reporter: rw } = make({ key: KEY, fetch: fn })
    await rw.flush()
    expect(fn).not.toHaveBeenCalled()
  })

  it('flush waits for an in-flight send and then sends the rest', async () => {
    const gate = deferred<Response>()
    const { fn, calls } = fakeFetch((_c, i) => (i === 0 ? gate.promise : status(202)))
    const { reporter: rw } = make({ key: KEY, fetch: fn, maxBuffer: 1 })
    rw.observed({ requestId: '1' })
    rw.observed({ requestId: '2' })
    const flushed = rw.flush()
    gate.resolve(status(202))
    await flushed
    expect(calls.map((c) => c.body.events[0]?.payment.request_id)).toEqual(['1', '2'])
  })
})

describe('retries', () => {
  it('retries once on a 500', async () => {
    const errors: ReporterErrorContext[] = []
    const { fn } = fakeFetch(() => status(500))
    const { reporter: rw } = make({ key: KEY, fetch: fn, onError: (_e, c) => errors.push(c) })
    rw.observed(payment)
    await rw.flush()
    expect(fn).toHaveBeenCalledTimes(2)
    expect(errors).toEqual([{ reason: 'http', status: 500, events: 1, retried: true }])
  })

  it('sends the identical body on retry', async () => {
    const { fn, calls } = fakeFetch(() => status(503))
    const { reporter: rw } = make({ key: KEY, fetch: fn })
    rw.observed(payment)
    await rw.flush()
    expect(calls[0]?.raw).toBe(calls[1]?.raw)
  })

  it('retries once on a network error', async () => {
    const { fn } = fakeFetch(() => Promise.reject(new TypeError('fetch failed')))
    const { reporter: rw } = make({ key: KEY, fetch: fn })
    rw.observed(payment)
    await rw.flush()
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('succeeds quietly when the retry succeeds', async () => {
    const onError = vi.fn()
    const { fn } = fakeFetch((_c, i) => status(i === 0 ? 502 : 202))
    const { reporter: rw } = make({ key: KEY, fetch: fn, onError })
    rw.observed(payment)
    await rw.flush()
    expect(fn).toHaveBeenCalledTimes(2)
    expect(onError).not.toHaveBeenCalled()
  })

  it.each([400, 401, 403, 404, 413, 422, 429])('does not retry a %i', async (code) => {
    const errors: ReporterErrorContext[] = []
    const { fn } = fakeFetch(() => status(code))
    const { reporter: rw } = make({ key: KEY, fetch: fn, onError: (_e, c) => errors.push(c) })
    rw.observed(payment)
    await rw.flush()
    expect(fn).toHaveBeenCalledOnce()
    expect(errors).toEqual([{ reason: 'http', status: code, events: 1 }])
  })

  it('does not retry or follow a redirect', async () => {
    const { fn } = fakeFetch(() => new Response(null, { status: 307, headers: { location: 'https://elsewhere.example' } }))
    const { reporter: rw } = make({ key: KEY, fetch: fn })
    rw.observed(payment)
    await rw.flush()
    expect(fn).toHaveBeenCalledOnce()
  })

  it('resolves flush on network failure', async () => {
    const { reporter: rw } = make({ key: KEY, fetch: () => Promise.reject(new Error('down')) })
    rw.observed(payment)
    await expect(rw.flush()).resolves.toBeUndefined()
  })
})

describe('waitUntil', () => {
  it('registers one flush per tick with waitUntil', async () => {
    const waitUntil = vi.fn<(p: Promise<unknown>) => void>()
    const { fn, calls } = fakeFetch()
    const { reporter: rw } = make({ key: KEY, fetch: fn, waitUntil })
    rw.settled(payment)
    rw.failed(payment)
    rw.observed(payment)
    expect(waitUntil).toHaveBeenCalledOnce()
    await waitUntil.mock.calls[0]?.[0]
    expect(calls).toHaveLength(1)
    expect(calls[0]?.body.events).toHaveLength(3)
  })

  it('schedules again for events in a later tick', async () => {
    const waitUntil = vi.fn<(p: Promise<unknown>) => void>()
    const { fn } = fakeFetch()
    const { reporter: rw } = make({ key: KEY, fetch: fn, waitUntil })
    rw.observed(payment)
    await waitUntil.mock.calls[0]?.[0]
    rw.observed(payment)
    await waitUntil.mock.calls[1]?.[0]
    expect(waitUntil).toHaveBeenCalledTimes(2)
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('registers a promise that never rejects', async () => {
    const waitUntil = vi.fn<(p: Promise<unknown>) => void>()
    const { reporter: rw } = make({ key: KEY, fetch: () => Promise.reject(new Error('down')), waitUntil })
    rw.observed(payment)
    await expect(waitUntil.mock.calls[0]?.[0]).resolves.toBeUndefined()
  })
})

describe('shutdown', () => {
  it('flushes, and is idempotent', async () => {
    const { fn } = fakeFetch()
    const { reporter: rw } = make({ key: KEY, fetch: fn })
    rw.observed(payment)
    const first = rw.shutdown()
    const second = rw.shutdown()
    expect(second).toBe(first)
    await first
    await rw.shutdown()
    expect(fn).toHaveBeenCalledOnce()
  })

  it('stops the interval', async () => {
    const clear = vi.spyOn(globalThis, 'clearInterval')
    const { reporter: rw } = make({ key: KEY, fetch: fakeFetch().fn, flushInterval: 1000 })
    await rw.shutdown()
    expect(clear).toHaveBeenCalledOnce()
  })

  it('ignores events recorded after shutdown', async () => {
    const { fn } = fakeFetch()
    const { reporter: rw } = make({ key: KEY, fetch: fn })
    await rw.shutdown()
    expect(rw.observed(payment)).toBeUndefined()
    await rw.flush()
    expect(fn).not.toHaveBeenCalled()
  })

  it('removes its process listeners', async () => {
    const before = ['beforeExit', 'SIGTERM', 'SIGINT'].map((e) => process.listenerCount(e))
    const rw = reporter({ key: KEY, fetch: fakeFetch().fn })
    expect(['beforeExit', 'SIGTERM', 'SIGINT'].map((e) => process.listenerCount(e))).toEqual(before.map((n) => n + 1))
    await rw.shutdown()
    await rw.shutdown()
    expect(['beforeExit', 'SIGTERM', 'SIGINT'].map((e) => process.listenerCount(e))).toEqual(before)
  })

  it('registers no listeners when exitHandlers is false', () => {
    const before = process.listenerCount('SIGTERM')
    const rw = reporter({ key: KEY, fetch: fakeFetch().fn, exitHandlers: false })
    expect(process.listenerCount('SIGTERM')).toBe(before)
    void rw.shutdown()
  })
})
