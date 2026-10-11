import { describe, expect, it } from 'vitest'
import { createExitRegistry } from '../src/exit.js'
import { createReporter } from '../src/reporter.js'
import { FakeProcess, deferred, fakeFetch, make, payment, status } from './helpers.js'

const KEY = 'rw_live_test_key'
const EVENTS = ['beforeExit', 'SIGTERM', 'SIGINT'] as const

function counts(target: FakeProcess) {
  return EVENTS.map((e) => target.listenerCount(e))
}

function tick(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe('process exit handling', () => {
  it('installs one listener per event, shared by every reporter', async () => {
    const target = new FakeProcess()
    const registry = createExitRegistry(target)
    const a = createReporter({ key: KEY, fetch: fakeFetch().fn, flushInterval: 0 }, registry)
    const b = createReporter({ key: KEY, fetch: fakeFetch().fn, flushInterval: 0 }, registry)
    expect(counts(target)).toEqual([1, 1, 1])
    await a.shutdown()
    expect(counts(target)).toEqual([1, 1, 1])
    await b.shutdown()
    expect(counts(target)).toEqual([0, 0, 0])
  })

  it('flushes on beforeExit', async () => {
    const { fn } = fakeFetch()
    const { reporter: rw, target } = make({ key: KEY, fetch: fn })
    rw.observed(payment)
    target.emit('beforeExit', 0)
    await tick()
    expect(fn).toHaveBeenCalledOnce()
  })

  it('does nothing on beforeExit with an empty buffer', async () => {
    const { fn } = fakeFetch()
    const { target } = make({ key: KEY, fetch: fn })
    target.emit('beforeExit', 0)
    await tick()
    expect(fn).not.toHaveBeenCalled()
  })

  it.each(['SIGTERM', 'SIGINT'])('flushes on %s, then re-raises it when the app has no handler', async (signal) => {
    const gate = deferred<Response>()
    const { fn } = fakeFetch(() => gate.promise)
    const { reporter: rw, target } = make({ key: KEY, fetch: fn })
    rw.observed(payment)

    target.emit(signal)
    expect(target.listenerCount(signal)).toBe(0)
    await tick()
    expect(fn).toHaveBeenCalledOnce()
    expect(target.kill).not.toHaveBeenCalled()

    gate.resolve(status(202))
    await tick()
    expect(target.kill).toHaveBeenCalledWith(target.pid, signal)
  })

  it('leaves shutdown to the app when it handles the signal itself', async () => {
    const { fn } = fakeFetch()
    const target = new FakeProcess()
    target.on('SIGTERM', () => {})
    const { reporter: rw } = make({ key: KEY, fetch: fn }, target)
    rw.observed(payment)
    target.emit('SIGTERM')
    await tick()
    expect(fn).toHaveBeenCalledOnce()
    expect(target.kill).not.toHaveBeenCalled()
  })

  it('does not hold a signal past the timeout budget', async () => {
    const { fn } = fakeFetch(() => new Promise<Response>(() => {}))
    const { reporter: rw, target } = make({ key: KEY, fetch: fn, timeout: 20 })
    rw.observed(payment)
    target.emit('SIGINT')
    await tick(60)
    expect(target.kill).toHaveBeenCalledWith(target.pid, 'SIGINT')
  })

  it('survives a target whose kill throws', async () => {
    const target = new FakeProcess()
    target.kill.mockImplementation(() => {
      throw new Error('EPERM')
    })
    make({ key: KEY, fetch: fakeFetch().fn }, target)
    expect(() => target.emit('SIGTERM')).not.toThrow()
    await tick()
  })

  it('is a no-op without a process', async () => {
    const registry = createExitRegistry(undefined)
    const rw = createReporter({ key: KEY, fetch: fakeFetch().fn, flushInterval: 0 }, registry)
    rw.observed(payment)
    await expect(rw.shutdown()).resolves.toBeUndefined()
  })
})
