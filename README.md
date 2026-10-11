# @requestway/reporter

Report x402 payment events from your Node app to [Requestway](https://requestway.com), where you see earnings and
per-route analytics.

```bash
npm install @requestway/reporter
```

Zero dependencies. Node 20+. ESM and CommonJS. MIT.

## A reporter, not a payment library

This package does **not** implement x402. It never issues a `402`, verifies a signature, settles a payment, holds funds
or decides a price. [`@x402/express`](https://www.npmjs.com/package/@x402/express),
[`@x402/next`](https://www.npmjs.com/package/@x402/next) and [`@x402/hono`](https://www.npmjs.com/package/@x402/hono)
do all of that. This package observes their outcome and reports it.

It runs inside your revenue path, so it is built to never get in the way:

- `settled()`, `failed()` and `observed()` are synchronous, return `void` and **never throw**: not on a bad key, bad
  input, a dead network or a full buffer.
- No key, no activity. Without `key` every method is a silent no-op that makes zero network calls.
- Memory is bounded. When the buffer is full and a send is already in flight, new events are dropped and counted rather
  than queued.
- Every request has a timeout. Nothing is logged to the console. Timers never keep your process alive.
- It only ever talks to the configured `url`. No telemetry of its own.

When delivering analytics would cost your app anything, the analytics lose.

> [!IMPORTANT]
> **On serverless (Vercel, Lambda, Netlify, Cloudflare)**, the platform freezes your function the moment the response
> is sent, so buffered events never leave. Either `await rw.flush()` before returning, or pass `waitUntil`. See
> [Serverless and edge](#serverless-and-edge). This is the most common reason events don't show up.

## Quickstart

1. Create a project at [requestway.com](https://requestway.com) and copy its key.
2. Add it to your environment:

   ```env
   REQUESTWAY_KEY=rw_live_xxxxxxxxxxxxxxxx
   ```

3. Create one reporter for the process and call it where your x402 middleware reports an outcome:

   ```ts
   import { reporter } from '@requestway/reporter'

   export const rw = reporter({ key: process.env.REQUESTWAY_KEY })

   rw.settled({
     route: 'market-data',
     method: 'GET',
     resource: 'https://api.example.com/premium-data',
     priceUsd: '0.01',
     amountAtomic: '10000',
     asset: 'USDC',
     network: 'eip155:8453',
     payTo: '0xYourAddress',
     requestId: 'req_123',
     transaction: '0x…',
   })
   ```

Events are batched and sent every 5 seconds, when 100 are buffered, and when the process exits. Use a `rw_test_` key
while you try it out; test events are kept apart from live ones in the dashboard.

To check the whole setup, run the [endpoint tester](#test-it-end-to-end) from your project in the dashboard.

## With @x402/express

The x402 resource server exposes lifecycle hooks. Register the reporter on them once:

```ts
// x402.ts
import { randomUUID } from 'node:crypto'
import { HTTPFacilitatorClient, x402ResourceServer, type HTTPTransportContext } from '@x402/core/server'
import { ExactEvmScheme } from '@x402/evm/exact/server'
import { reporter, type PaymentEvent } from '@requestway/reporter'

export const rw = reporter({ key: process.env.REQUESTWAY_KEY })

export const server = new x402ResourceServer(new HTTPFacilitatorClient({ url: 'https://x402.org/facilitator' }))
  .register('eip155:8453', new ExactEvmScheme())

type HookContext = {
  requirements: { amount: string; network: string; payTo: string }
  transportContext?: unknown
}

function details(ctx: HookContext): PaymentEvent {
  const request = (ctx.transportContext as HTTPTransportContext | undefined)?.request
  return {
    route: request?.routePattern ?? request?.path,
    method: request?.method,
    resource: request?.adapter.getUrl(), // query string is stripped before it is buffered
    mode: 'enforce',
    priceUsd: '0.01', // the price you configured for this route
    amountAtomic: ctx.requirements.amount,
    asset: 'USDC',
    network: ctx.requirements.network,
    payTo: ctx.requirements.payTo,
    requestId: request?.adapter.getHeader('x-request-id') ?? randomUUID(),
  }
}

function reasonOf(error: Error & { errorReason?: string; invalidReason?: string }): string {
  return error.errorReason ?? error.invalidReason ?? error.name
}

server
  .onAfterSettle(async (ctx) => {
    rw.settled({ ...details(ctx), transaction: ctx.result.transaction })
  })
  .onSettleFailure(async (ctx) => {
    rw.failed({ ...details(ctx), stage: 'settle', reason: reasonOf(ctx.error) })
  })
  .onVerifyFailure(async (ctx) => {
    rw.failed({ ...details(ctx), stage: 'verify', reason: reasonOf(ctx.error) })
  })
```

```ts
// app.ts
import express from 'express'
import { paymentMiddleware } from '@x402/express'
import { server } from './x402.js'

const app = express()

app.use(
  paymentMiddleware(
    {
      'GET /premium-data': {
        accepts: [{ scheme: 'exact', price: '$0.01', network: 'eip155:8453', payTo: '0xYourAddress' }],
        description: 'Premium market data',
      },
    },
    server,
  ),
)

app.get('/premium-data', (req, res) => res.json({ price: 42 }))
app.listen(3000)
```

On a long-lived server that is all: the interval sends batches and the reporter flushes on `SIGTERM`, `SIGINT` and
`beforeExit`.

## With @x402/next

Next.js route handlers usually run on serverless infrastructure, so register the flush with `waitUntil`. Reuse the
`server` and hooks from the Express example, and create the reporter with `waitUntil`:

```ts
// lib/x402.ts
import { waitUntil } from '@vercel/functions'
import { reporter } from '@requestway/reporter'

export const rw = reporter({ key: process.env.REQUESTWAY_KEY, waitUntil })
// …register rw on the x402ResourceServer hooks exactly as above
```

```ts
// app/api/premium-data/route.ts
import { NextResponse, type NextRequest } from 'next/server'
import { withX402 } from '@x402/next'
import { server } from '@/lib/x402'

const handler = async (_: NextRequest) => NextResponse.json({ price: 42 })

export const GET = withX402(
  handler,
  {
    accepts: [{ scheme: 'exact', price: '$0.01', network: 'eip155:8453', payTo: '0xYourAddress' }],
    description: 'Premium market data',
  },
  server,
)
```

Next.js 15+ also has [`after()`](https://nextjs.org/docs/app/api-reference/functions/after), which works the same way:
`after(() => rw.flush())`.

## Test it end to end

Each Requestway project has a **Test endpoint** tab. Give it the URL of a paid route and Requestway does what an agent
would, showing each step live:

1. Calls the route without paying and expects `402 Payment Required`.
2. Reads the payment requirements and checks a client could pay them: scheme, network, asset, `payTo`, and the EIP-712
   `name` and `version` in `extra`.
3. Signs an EIP-3009 payment with test USDC from a Requestway wallet and retries with it.
4. Reads the settlement receipt (`PAYMENT-RESPONSE`) and links the transaction on the block explorer.
5. Waits up to 20 seconds for this reporter's `payment.settled` event to reach your project.

It only ever pays on testnets. If your route only accepts mainnet, the tester checks the 402 and stops; it never spends
real money. To run the full paid test, accept Base Sepolia, for example on a staging deployment:

```ts
const server = new x402ResourceServer(new HTTPFacilitatorClient({ url: 'https://x402.org/facilitator' }))
  .register('eip155:84532', new ExactEvmScheme())

app.use(
  paymentMiddleware(
    {
      'GET /premium-data': {
        accepts: [{ scheme: 'exact', price: '$0.01', network: 'eip155:84532', payTo: '0xYourAddress' }],
      },
    },
    server,
  ),
)
```

For the last step to pass:

- **Report the transaction.** The tester matches your event by transaction hash, so pass
  `transaction: ctx.result.transaction` to `rw.settled()`, as the [Express example](#with-x402express) does.
- **Flush within 20 seconds.** A long-lived server's 5-second interval is enough. On serverless, use `waitUntil` or
  `await rw.flush()`, or the event never leaves the function.
- **Use a key for the same project.** Either its `rw_live_` or `rw_test_` key works.

Test payments are reported with their testnet network, so they appear under **Testnet** in the dashboard and never mix
with real earnings. The dashboard opens on whichever network your app reported from most recently, so it follows you to
**Mainnet** when you switch `network` to `eip155:8453`.

The tester calls only public `https` addresses, never follows redirects, and identifies itself as
`RequestwayEndpointTester/1.0`. It is part of the dashboard, not this package: nothing here sends test requests or
holds keys.

## Serverless and edge

A serverless platform suspends your function as soon as the response is sent. Timers stop and buffered events are lost,
silently. Pick one:

**Pass `waitUntil`.** Every recorded event schedules a flush and registers it with the platform, which keeps the
invocation alive until it finishes. Events recorded in the same tick share one request.

```ts
import { waitUntil } from '@vercel/functions'

const rw = reporter({ key: process.env.REQUESTWAY_KEY, waitUntil })
```

**Or flush per request.** Where `waitUntil` is per-request (Cloudflare Workers) or unavailable, flush explicitly. The
promise never rejects, so it is always safe to await.

```ts
// Cloudflare Workers
export default {
  async fetch(request, env, ctx) {
    const response = await handle(request)
    ctx.waitUntil(rw.flush())
    return response
  },
}

// AWS Lambda
export const handler = async (event) => {
  const result = await handle(event)
  await rw.flush()
  return result
}
```

Long-lived servers (Express, Fastify, Hono on Node, `next start` on your own box) need neither: the interval and the exit
handlers cover them.

## API

```ts
import { reporter } from '@requestway/reporter'

const rw = reporter(options)

rw.settled({ ...payment, transaction, pending }) // payment.settled
rw.failed({ ...payment, stage, reason })         // payment.failed
rw.observed({ ...payment })                      // payment.observed (observe mode: would have charged)

await rw.flush()    // send the buffer now; resolves, never rejects
await rw.shutdown() // flush, stop the timer, remove exit handlers; safe to call twice

rw.enabled          // false when there is no key or reporting is disabled
```

Every payment field is optional and every one is a string, except `pending`:

| Field          | Example                                | Notes                                                     |
| -------------- | -------------------------------------- | --------------------------------------------------------- |
| `route`        | `market-data`                          | A stable label for the paid route.                        |
| `method`       | `GET`                                  |                                                           |
| `resource`     | `https://api.example.com/premium-data` | Reduced to scheme + host + path. See [Privacy](#privacy). |
| `mode`         | `enforce` or `observe`                 |                                                           |
| `priceUsd`     | `"0.01"`                               | Decimal string. Numbers are dropped, never coerced.       |
| `amountAtomic` | `"10000"`                              | String in the asset's smallest unit. Never a number.      |
| `asset`        | `USDC`                                 |                                                           |
| `network`      | `eip155:8453`                          | CAIP-2.                                                   |
| `payTo`        | `0x…`                                  | Your receiving address.                                   |
| `requestId`    | `req_123`                              | Strongly recommended. See [Retries](#retries-and-requestid). |
| `transaction`  | `0x…`                                  | `settled` only.                                           |
| `pending`      | `false`                                | `settled` only. True if settlement is not yet confirmed.  |
| `stage`        | `verify`, `settle`                     | `failed` only.                                            |
| `reason`       | `insufficient_funds`                   | `failed` only.                                            |

Amounts are strings because `amountAtomic` routinely exceeds `Number.MAX_SAFE_INTEGER` and floats would corrupt
`priceUsd`. They are sent exactly as given. `null` and `undefined` fields are left out of the request. A string longer
than 2,048 characters is dropped rather than truncated.

## Options

| Option          | Default                                  | Description                                                                                   |
| --------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------- |
| `key`           | —                                        | Project key, `rw_live_…` or `rw_test_…`. Without it the reporter does nothing.                 |
| `url`           | `https://api.requestway.com/x402/events` | Ingest endpoint.                                                                              |
| `flushInterval` | `5000`                                   | Milliseconds between background flushes. `0` disables the timer.                              |
| `maxBuffer`     | `100`                                    | Buffered events that trigger a flush. Also the batch size. Clamped to 1–500.                  |
| `timeout`       | `5000`                                   | Milliseconds allowed per HTTP request, enforced with `AbortController`.                       |
| `enabled`       | `true` if `key` is set                   | `false` turns every method into a no-op. `true` without a key still does nothing.             |
| `onError`       | —                                        | `(error, context) => void`. Called on delivery failures and dropped events. See below.        |
| `waitUntil`     | —                                        | Keeps a serverless invocation alive until a flush finishes, e.g. from `@vercel/functions`.    |
| `exitHandlers`  | `true`                                   | Flush on `beforeExit`, `SIGTERM` and `SIGINT`. Set `false` if you manage shutdown yourself.   |
| `fetch`         | `globalThis.fetch`                       | Override the fetch implementation, e.g. in tests.                                             |

### onError

Failures are swallowed. Nothing is logged unless you ask for it:

```ts
const rw = reporter({
  key: process.env.REQUESTWAY_KEY,
  onError: (error, context) => logger.warn({ err: error, ...context }, 'requestway reporting failed'),
})
```

`context.reason` is one of `network`, `timeout`, `http` (with `status`), `dropped` (with `dropped`, the count since the
last report) or `internal`. Send failures include `events`, the size of the lost batch, and `retried`. The callback is
wrapped: if it throws or returns a rejected promise, that is ignored.

## Reliability

- **Buffer.** Events wait in memory until a flush. At `maxBuffer` a flush starts. If one is already in flight and the
  buffer fills again, further events are dropped and reported to `onError` as `dropped`. At most two batches are ever
  held: the one in flight and the one filling.
- **Flush.** On the interval, when the buffer fills, on `flush()`, and on process exit. One request at a time.
- **Timeout.** Each request is aborted after `timeout` ms.
- **Redirects.** Not followed, so your key is never sent anywhere but `url`.
- **Exit.** On `SIGTERM` or `SIGINT` the buffer is flushed (for at most `timeout` ms). If your app has its own handler for
  that signal, shutdown stays in your hands. If not, the signal is re-raised afterwards so the process exits exactly as
  it would have without this package.
- **Event loop.** The interval timer is `unref()`'d. A script that records events and finishes exits normally, after a
  final flush on `beforeExit`.

### Retries and requestId

A failed batch is retried **once**, after 250 ms, and only on a network error, a timeout or a `5xx`. A `4xx` is never
retried: the server has answered and repeating the request would get the same answer.

The retry resends the identical batch, byte for byte, and the server de-duplicates each event on `request_id` together
with its type, timestamp, route and amount. That key is what makes a retry safe, so **retry safety depends on you
supplying a stable, unique `requestId`.** Without one, the key falls back to type, timestamp, route and amount alone:
a retried event can no longer be told apart from a different payment that happens to match it, so two payments to the
same route, for the same amount, in the same second, are counted as one.

Use an id that identifies the request, such as an `x-request-id` header, or generate one with `crypto.randomUUID()` when
you record the event. Record each payment once: the timestamp is taken at record time, so recording the same payment
twice produces two events.

## Privacy

`resource` is a live URL from your production app, and query strings routinely carry API keys, session ids and email
addresses. So the reporter strips it **at the moment you record the event**, before it is buffered: only the scheme,
host and path are kept. The raw URL is never held in memory by this package, so it cannot appear in a heap dump or crash
log from here. A relative path keeps only its path; anything that is not a URL or a path is dropped.

**Sent**, and only when you provide it:

- event type and a UTC timestamp
- route label, HTTP method, mode
- resource as scheme + host + path, e.g. `https://api.example.com/premium-data`
- price in USD, atomic amount, asset, network
- your receiving address (`payTo`)
- request id
- for settled payments: transaction hash and pending flag
- for failed payments: stage and reason
- your project key, in the `Authorization` header

**Never sent**:

- query strings, fragments, or credentials embedded in URLs
- the payer, or any wallet address other than your own `payTo`. Wallet identity stays in your application. Fields are
  read from an allowlist, so a `payer` or `wallet` property passed in by mistake is ignored.
- request or response headers or bodies, IP addresses, cookies, user agents
- anything about your environment, and no telemetry about this package

Requests go to the configured `url` and nowhere else.

## Wire format

For anyone implementing a compatible endpoint. The body is snake_case; the JavaScript API is camelCase.

```http
POST /x402/events HTTP/1.1
Host: api.requestway.com
Authorization: Bearer rw_live_xxx
Content-Type: application/json

{
  "source": "node-requestway",
  "events": [
    {
      "type": "payment.settled",
      "at": "2026-10-11T12:34:56+00:00",
      "payment": {
        "route": "market-data",
        "method": "GET",
        "resource": "https://api.example.com/premium-data",
        "mode": "enforce",
        "price_usd": "0.01",
        "amount_atomic": "10000",
        "asset": "USDC",
        "network": "eip155:8453",
        "pay_to": "0xabc…",
        "request_id": "req_123",
        "transaction": "0xdef…",
        "pending": false
      }
    }
  ]
}
```

`type` is `payment.settled` (extras `transaction`, `pending`), `payment.failed` (extras `stage`, `reason`) or
`payment.observed` (no extras). The same envelope is sent by the Laravel package,
[`requestway/laravel-x402`](https://github.com/requestway/laravel-x402), with `"source": "laravel-x402"`.

## Learn more

- [Install guide](https://requestway.com/docs): Laravel and Node setup, the endpoint tester and the ingest API
- [What is x402?](https://requestway.com/x402): the protocol, its headers, facilitators, testnet and mainnet
- [x402 with Express, Next.js and Hono](https://requestway.com/articles/x402-express-nextjs-hono): a practical guide,
  including reporting from serverless functions
- [Testing x402 payments on Base Sepolia](https://requestway.com/articles/test-x402-payments-base-sepolia) without
  spending real money
- [Why x402 payments fail](https://requestway.com/articles/why-x402-payments-fail): the common errors and how to fix them
- [All articles](https://requestway.com/articles)
- On Laravel? [`requestway/laravel-x402`](https://github.com/requestway/laravel-x402) charges and reports in one package.

## License

MIT
