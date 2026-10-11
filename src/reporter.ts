import { processExitRegistry, type ExitFlushable, type ExitRegistry } from './exit.js'
import { toWireEvent } from './serialize.js'
import type {
  EventType,
  FailedEvent,
  FetchLike,
  ObservedEvent,
  Reporter,
  ReporterErrorContext,
  ReporterOptions,
  SettledEvent,
  WireEnvelope,
  WireEvent,
} from './types.js'
import { VERSION } from './version.js'

export const DEFAULT_URL = 'https://api.requestway.com/x402/events'
const SOURCE = 'node-requestway'
const MAX_BATCH = 500
const RETRY_DELAY_MS = 250

interface Settings {
  key: string
  url: string
  flushInterval: number
  maxBuffer: number
  timeout: number
  onError: ReporterOptions['onError']
  waitUntil: ReporterOptions['waitUntil']
  exitHandlers: boolean
  fetch: FetchLike | undefined
}

type SendResult = { ok: true } | { ok: false; retryable: boolean; error: Error; context: ReporterErrorContext }

const resolved = Promise.resolve()

function noop(): Reporter {
  return {
    enabled: false,
    settled() {},
    failed() {},
    observed() {},
    flush: () => resolved,
    shutdown: () => resolved,
  }
}

function integer(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.floor(value)))
}

function settings(options: ReporterOptions): Settings | undefined {
  const key = typeof options.key === 'string' ? options.key.trim() : ''
  if (key === '' || options.enabled === false) return undefined

  const globalFetch = typeof globalThis.fetch === 'function' ? (globalThis.fetch.bind(globalThis) as FetchLike) : undefined

  return {
    key,
    url: typeof options.url === 'string' && options.url !== '' ? options.url : DEFAULT_URL,
    flushInterval: integer(options.flushInterval, 5000, 0, 2_147_483_647),
    maxBuffer: integer(options.maxBuffer, 100, 1, MAX_BATCH),
    timeout: integer(options.timeout, 5000, 1, 2_147_483_647),
    onError: typeof options.onError === 'function' ? options.onError : undefined,
    waitUntil: typeof options.waitUntil === 'function' ? options.waitUntil : undefined,
    exitHandlers: options.exitHandlers !== false,
    fetch: typeof options.fetch === 'function' ? options.fetch : globalFetch,
  }
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Create a reporter. Never throws: invalid or missing options give a reporter
 * that does nothing.
 */
export function reporter(options?: ReporterOptions | null): Reporter {
  return createReporter(options, processExitRegistry())
}

export function createReporter(options: ReporterOptions | null | undefined, exit: ExitRegistry): Reporter {
  try {
    const config = options !== null && typeof options === 'object' ? settings(options) : undefined
    return config === undefined ? noop() : new ActiveReporter(config, exit)
  } catch {
    return noop()
  }
}

class ActiveReporter implements Reporter, ExitFlushable {
  readonly enabled = true
  readonly exitBudget: number

  private buffer: WireEvent[] = []
  private inFlight: Promise<void> | undefined
  private scheduled: Promise<void> | undefined
  private dropped = 0
  private closed = false
  private closing: Promise<void> | undefined
  private timer: ReturnType<typeof setInterval> | undefined

  constructor(
    private readonly config: Settings,
    private readonly exit: ExitRegistry,
  ) {
    this.exitBudget = config.timeout
    if (config.flushInterval > 0) {
      this.timer = setInterval(() => void this.flush(), config.flushInterval)
      this.timer.unref?.()
    }
    if (config.exitHandlers) exit.add(this)
  }

  settled(event: SettledEvent): void {
    this.record('payment.settled', event)
  }

  failed(event: FailedEvent): void {
    this.record('payment.failed', event)
  }

  observed(event: ObservedEvent): void {
    this.record('payment.observed', event)
  }

  flush(): Promise<void> {
    try {
      return this.drain()
    } catch (error) {
      this.notify(error, { reason: 'internal' })
      return resolved
    }
  }

  exitFlush(): Promise<void> {
    return this.flush()
  }

  shutdown(): Promise<void> {
    if (this.closing !== undefined) return this.closing
    try {
      this.closed = true
      if (this.timer !== undefined) clearInterval(this.timer)
      this.timer = undefined
      this.exit.remove(this)
      this.closing = this.flush().then(() => this.reportDropped())
    } catch (error) {
      this.notify(error, { reason: 'internal' })
      this.closing = resolved
    }
    return this.closing
  }

  private record(type: EventType, input: unknown): void {
    try {
      if (this.closed) {
        this.dropped++
        return
      }

      if (this.buffer.length >= this.config.maxBuffer) {
        if (this.inFlight !== undefined) {
          this.dropped++
          return
        }
        void this.flush()
      }

      this.buffer.push(toWireEvent(type, input))

      if (this.buffer.length >= this.config.maxBuffer && this.inFlight === undefined) void this.flush()
      if (this.config.waitUntil !== undefined) this.scheduleForWaitUntil(this.config.waitUntil)
    } catch (error) {
      this.notify(error, { reason: 'internal' })
    }
  }

  /** Coalesce events recorded in the same tick into one flush the host keeps alive. */
  private scheduleForWaitUntil(waitUntil: (promise: Promise<unknown>) => void): void {
    if (this.scheduled !== undefined) return
    const scheduled = delay(0).then(() => {
      this.scheduled = undefined
      return this.flush()
    })
    this.scheduled = scheduled
    try {
      waitUntil(scheduled)
    } catch (error) {
      this.notify(error, { reason: 'internal' })
    }
  }

  /**
   * Send what is buffered. If a send is in flight, wait for it first. Bounded
   * so that a steady stream of new events cannot keep a flush pending forever.
   */
  private drain(waits = 0): Promise<void> {
    if (this.inFlight !== undefined) {
      return waits >= 2 ? this.inFlight : this.inFlight.then(() => this.drain(waits + 1))
    }
    if (this.buffer.length === 0) return resolved

    const batch = this.buffer
    this.buffer = []

    const current = this.send(batch)
      .catch((error: unknown) => this.notify(error, { reason: 'internal', events: batch.length }))
      .then(() => {
        this.inFlight = undefined
        this.reportDropped()
        if (this.buffer.length >= this.config.maxBuffer) void this.flush()
      })
    this.inFlight = current
    return current
  }

  private async send(batch: WireEvent[]): Promise<void> {
    const envelope: WireEnvelope = { source: SOURCE, events: batch }
    const body = JSON.stringify(envelope)

    let result = await this.post(body, batch.length)
    if (!result.ok && result.retryable) {
      await delay(RETRY_DELAY_MS)
      result = await this.post(body, batch.length)
      if (!result.ok) result.context.retried = true
    }
    if (!result.ok) this.notify(result.error, result.context)
  }

  private async post(body: string, events: number): Promise<SendResult> {
    const fetchImpl = this.config.fetch
    if (fetchImpl === undefined) {
      return { ok: false, retryable: false, error: new Error('fetch is not available'), context: { reason: 'network', events } }
    }

    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const timedOut = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => {
        controller.abort()
        resolve('timeout')
      }, this.config.timeout)
    })

    try {
      const request = fetchImpl(this.config.url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.key}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'User-Agent': `requestway-reporter-node/${VERSION}`,
        },
        body,
        signal: controller.signal,
        redirect: 'manual',
      })
      // The fetch may be abandoned on timeout; keep its rejection from going unhandled.
      request.catch(() => undefined)

      const response = await Promise.race([request, timedOut])
      if (response === 'timeout') {
        return { ok: false, retryable: true, error: new Error(`Request timed out after ${this.config.timeout}ms`), context: { reason: 'timeout', events } }
      }

      discardBody(response)

      if (response.status >= 200 && response.status < 300) return { ok: true }
      return {
        ok: false,
        retryable: response.status >= 500,
        error: new Error(`Requestway responded with HTTP ${response.status}`),
        context: { reason: 'http', status: response.status, events },
      }
    } catch (error) {
      const aborted = controller.signal.aborted
      return {
        ok: false,
        retryable: true,
        error: asError(error),
        context: { reason: aborted ? 'timeout' : 'network', events },
      }
    } finally {
      clearTimeout(timer)
    }
  }

  private reportDropped(): void {
    if (this.dropped === 0) return
    const dropped = this.dropped
    this.dropped = 0
    this.notify(new Error(`Dropped ${dropped} event(s): buffer full while a send was in flight`), { reason: 'dropped', dropped })
  }

  private notify(error: unknown, context: ReporterErrorContext): void {
    const onError = this.config.onError
    if (onError === undefined) return
    try {
      const result: unknown = onError(asError(error), context)
      if (result instanceof Promise) result.catch(() => undefined)
    } catch {
      // A throwing callback must never reach the host application.
    }
  }
}

function discardBody(response: Response): void {
  try {
    const body = response.body
    if (body !== null && body !== undefined) body.cancel().catch(() => undefined)
  } catch {
    // Some fake or polyfilled responses have no cancellable body.
  }
}
