import { describe, expect, it } from 'vitest'
import { stripResource, timestamp, toWireEvent } from '../src/serialize.js'

const payment = {
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

describe('stripResource', () => {
  it.each([
    ['https://api.example.com/premium-data?token=abc&email=a@b.c#frag', 'https://api.example.com/premium-data'],
    ['https://api.example.com/premium-data#section', 'https://api.example.com/premium-data'],
    ['http://user:pass@api.example.com:8080/v1/x?y=1', 'http://api.example.com:8080/v1/x'],
    ['https://API.Example.com', 'https://api.example.com/'],
    ['/premium-data?session=xyz', '/premium-data'],
    ['/premium-data#frag', '/premium-data'],
    ['/premium-data', '/premium-data'],
  ])('reduces %s to %s', (input, expected) => {
    expect(stripResource(input)).toBe(expected)
  })

  it.each([
    'not a url',
    'api.example.com/x?token=1',
    '//api.example.com/x?token=1',
    'javascript:alert(1)',
    'mailto:someone@example.com',
    'http://',
    '',
    '?token=abc',
  ])('drops unparseable or non-http resource %j', (input) => {
    expect(stripResource(input)).toBeUndefined()
  })

  it.each([null, undefined, 42, {}, [], true])('ignores non-string %j', (input) => {
    expect(stripResource(input)).toBeUndefined()
  })
})

describe('timestamp', () => {
  it('matches the Laravel package format', () => {
    expect(timestamp(new Date(Date.UTC(2026, 9, 11, 12, 34, 56, 789)))).toBe('2026-10-11T12:34:56+00:00')
  })
})

describe('toWireEvent', () => {
  const at = '2026-10-11T12:34:56+00:00'

  it('maps camelCase to snake_case in the contract order', () => {
    const event = toWireEvent('payment.settled', { ...payment, transaction: '0xdef', pending: false }, at)
    expect(JSON.stringify(event)).toBe(
      '{"type":"payment.settled","at":"2026-10-11T12:34:56+00:00","payment":{"route":"market-data","method":"GET",' +
        '"resource":"https://api.example.com/premium-data","mode":"enforce","price_usd":"0.01","amount_atomic":"10000",' +
        '"asset":"USDC","network":"eip155:8453","pay_to":"0xabc","request_id":"req_123","transaction":"0xdef","pending":false}}',
    )
  })

  it('adds stage and reason to failed events only', () => {
    const failed = toWireEvent('payment.failed', { route: 'r', stage: 'verify', reason: 'insufficient_funds', transaction: '0x1' }, at)
    expect(failed.payment).toEqual({ route: 'r', stage: 'verify', reason: 'insufficient_funds' })
  })

  it('carries no extras on observed events', () => {
    const observed = toWireEvent('payment.observed', { route: 'r', transaction: '0x1', pending: true, stage: 's', reason: 'x' }, at)
    expect(observed.payment).toEqual({ route: 'r' })
  })

  it('omits null and undefined rather than sending null', () => {
    const event = toWireEvent('payment.settled', { route: 'r', method: null, asset: undefined, pending: null, transaction: null }, at)
    expect(JSON.stringify(event.payment)).toBe('{"route":"r"}')
  })

  it('never reads payer or wallet fields', () => {
    const input = { ...payment, payer: '0xpayer', wallet: '0xwallet', from: '0xfrom', payerAddress: '0xp' }
    const json = JSON.stringify(toWireEvent('payment.settled', input, at))
    expect(json).not.toMatch(/payer|wallet|0xp|"from"/)
  })

  it('passes monetary strings through untouched', () => {
    const event = toWireEvent('payment.settled', { priceUsd: '0.000001', amountAtomic: '123456789012345678901' }, at)
    expect(event.payment.price_usd).toBe('0.000001')
    expect(event.payment.amount_atomic).toBe('123456789012345678901')
    expect(JSON.stringify(event)).toContain('"amount_atomic":"123456789012345678901"')
  })

  it('drops numeric amounts instead of coercing them', () => {
    const input = { priceUsd: 0.01, amountAtomic: 12345678901234567890 } as unknown
    expect(toWireEvent('payment.settled', input, at).payment).toEqual({})
  })

  it('drops oversized strings instead of truncating them', () => {
    expect(toWireEvent('payment.failed', { reason: 'x'.repeat(5000), route: 'r' }, at).payment).toEqual({ route: 'r' })
  })

  it('strips query strings from resource', () => {
    const event = toWireEvent('payment.observed', { resource: 'https://a.example/p?q=secret#f' }, at)
    expect(event.payment.resource).toBe('https://a.example/p')
  })

  it.each([null, undefined, 'string', 42])('tolerates non-object input %j', (input) => {
    expect(toWireEvent('payment.observed', input, at)).toEqual({ type: 'payment.observed', at, payment: {} })
  })
})
