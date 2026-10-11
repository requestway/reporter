/** Fields shared by every payment event. All optional; omitted fields are not sent. */
export interface PaymentEvent {
  /** A stable label for the paid route, e.g. "market-data". */
  route?: string | null | undefined
  /** HTTP method, e.g. "GET". */
  method?: string | null | undefined
  /** The requested URL. Reduced to scheme + host + path before it is buffered. */
  resource?: string | null | undefined
  /** "enforce" or "observe". */
  mode?: string | null | undefined
  /** Decimal USD price as a string, e.g. "0.01". Never a number. */
  priceUsd?: string | null | undefined
  /** Amount in the asset's smallest unit, as a string. Never a number. */
  amountAtomic?: string | null | undefined
  /** Asset symbol, e.g. "USDC". */
  asset?: string | null | undefined
  /** CAIP-2 network id, e.g. "eip155:8453". */
  network?: string | null | undefined
  /** Receiving address. */
  payTo?: string | null | undefined
  /**
   * A stable id for the request. The server de-duplicates on it, so it is what
   * makes a retried batch safe to count once.
   */
  requestId?: string | null | undefined
}

export interface SettledEvent extends PaymentEvent {
  /** Settlement transaction hash. */
  transaction?: string | null | undefined
  /** True when settlement was accepted but not yet confirmed. */
  pending?: boolean | null | undefined
}

export interface FailedEvent extends PaymentEvent {
  /** Where the payment failed, e.g. "verify" or "settle". */
  stage?: string | null | undefined
  /** Machine-readable reason, e.g. "insufficient_funds". */
  reason?: string | null | undefined
}

export type ObservedEvent = PaymentEvent

export type EventType = 'payment.settled' | 'payment.failed' | 'payment.observed'

/** A payment as it is sent: snake_case, nulls omitted. */
export interface WirePayment {
  route?: string
  method?: string
  resource?: string
  mode?: string
  price_usd?: string
  amount_atomic?: string
  asset?: string
  network?: string
  pay_to?: string
  request_id?: string
  transaction?: string
  pending?: boolean
  stage?: string
  reason?: string
}

export interface WireEvent {
  type: EventType
  /** ISO 8601 UTC, e.g. "2026-10-11T12:34:56+00:00". */
  at: string
  payment: WirePayment
}

export interface WireEnvelope {
  source: 'node-requestway'
  events: WireEvent[]
}

export type ReporterErrorReason =
  /** The request could not be sent or the connection failed. */
  | 'network'
  /** The request exceeded `timeout`. */
  | 'timeout'
  /** The server answered with a non-2xx status. */
  | 'http'
  /** Events were dropped because the buffer was full while a send was in flight. */
  | 'dropped'
  /** An unexpected internal error. Reporting continues. */
  | 'internal'

export interface ReporterErrorContext {
  reason: ReporterErrorReason
  /** HTTP status, for `reason: "http"`. */
  status?: number
  /** Events in the batch that was lost, for send failures. */
  events?: number
  /** Events dropped since the last report, for `reason: "dropped"`. */
  dropped?: number
  /** Whether the batch was retried before giving up. */
  retried?: boolean
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>

export interface ReporterOptions {
  /** Project key (rw_live_… or rw_test_…). Without one the reporter is a no-op. */
  key?: string | null | undefined
  /** Ingest endpoint. Default: https://api.requestway.com/x402/events */
  url?: string | undefined
  /** Milliseconds between background flushes. 0 disables the timer. Default: 5000 */
  flushInterval?: number | undefined
  /** Buffered events that force a flush. Clamped to 1–500. Default: 100 */
  maxBuffer?: number | undefined
  /** Milliseconds allowed per HTTP request. Default: 5000 */
  timeout?: number | undefined
  /** Default: true when `key` is set. Setting true without a key still does nothing. */
  enabled?: boolean | undefined
  /** Called on delivery failures and dropped events. Never called with a throw; throwing from it is ignored. */
  onError?: ((error: Error, context: ReporterErrorContext) => void) | undefined
  /**
   * Keeps a serverless invocation alive until a flush completes, e.g. `waitUntil`
   * from `@vercel/functions`. When set, every recorded event schedules a flush
   * registered through it.
   */
  waitUntil?: ((promise: Promise<unknown>) => void) | undefined
  /** Flush on beforeExit, SIGTERM and SIGINT. Default: true */
  exitHandlers?: boolean | undefined
  /** Override the global fetch, e.g. in tests. */
  fetch?: FetchLike | undefined
}

export interface Reporter {
  /** False when there is no key or reporting is disabled. */
  readonly enabled: boolean
  /** Record a settled payment. Synchronous, fire and forget, never throws. */
  settled(event: SettledEvent): void
  /** Record a failed payment. Synchronous, fire and forget, never throws. */
  failed(event: FailedEvent): void
  /** Record an observe-mode payment that would have been charged. Synchronous, never throws. */
  observed(event: ObservedEvent): void
  /** Send everything buffered now. Resolves when done; never rejects. */
  flush(): Promise<void>
  /** Flush, stop the timer and remove exit handlers. Safe to call more than once. */
  shutdown(): Promise<void>
}
