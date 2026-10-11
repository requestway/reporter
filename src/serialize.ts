import type { EventType, FailedEvent, PaymentEvent, SettledEvent, WireEvent, WirePayment } from './types.js'

/** Longest string we will send for any field. Longer values are dropped, never truncated. */
const MAX_FIELD_LENGTH = 2048

type StringKey = Exclude<keyof WirePayment, 'pending'>

const COMMON: ReadonlyArray<readonly [keyof PaymentEvent, StringKey]> = [
  ['route', 'route'],
  ['method', 'method'],
  ['resource', 'resource'],
  ['mode', 'mode'],
  ['priceUsd', 'price_usd'],
  ['amountAtomic', 'amount_atomic'],
  ['asset', 'asset'],
  ['network', 'network'],
  ['payTo', 'pay_to'],
  ['requestId', 'request_id'],
]

/**
 * Reduce a URL to scheme + host + path. Query strings, fragments and
 * credentials are discarded. A relative path keeps only its path; anything
 * else unparseable is dropped.
 */
export function stripResource(value: unknown): string | undefined {
  if (typeof value !== 'string' || value === '') return undefined

  try {
    const url = new URL(value)
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      return `${url.protocol}//${url.host}${url.pathname}`
    }
    return undefined
  } catch {
    // Not absolute. Fall through to the relative-path case.
  }

  if (value.startsWith('/') && !value.startsWith('//')) {
    const end = value.search(/[?#]/)
    return end === -1 ? value : value.slice(0, end)
  }

  return undefined
}

/** UTC timestamp in the exact shape the Laravel package sends: 2026-10-11T12:34:56+00:00 */
export function timestamp(date: Date = new Date()): string {
  return `${date.toISOString().slice(0, 19)}+00:00`
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' && value.length <= MAX_FIELD_LENGTH ? value : undefined
}

function read(input: object, key: string): unknown {
  return (input as Record<string, unknown>)[key]
}

/**
 * Build the wire event from an allowlist of fields. Anything not listed,
 * including any payer or wallet field, is never read.
 */
export function toWireEvent(type: EventType, input: unknown, at: string = timestamp()): WireEvent {
  const payment: WirePayment = {}
  const source = typeof input === 'object' && input !== null ? input : {}

  for (const [from, to] of COMMON) {
    const value = from === 'resource' ? stripResource(read(source, from)) : text(read(source, from))
    if (value !== undefined) payment[to] = value
  }

  if (type === 'payment.settled') {
    const transaction = text(read(source, 'transaction' satisfies keyof SettledEvent))
    if (transaction !== undefined) payment.transaction = transaction
    const pending = read(source, 'pending' satisfies keyof SettledEvent)
    if (typeof pending === 'boolean') payment.pending = pending
  } else if (type === 'payment.failed') {
    const stage = text(read(source, 'stage' satisfies keyof FailedEvent))
    if (stage !== undefined) payment.stage = stage
    const reason = text(read(source, 'reason' satisfies keyof FailedEvent))
    if (reason !== undefined) payment.reason = reason
  }

  return { type, at, payment }
}
