/** The slice of `process` the exit hooks use. Injected so tests never signal the real process. */
export interface ExitTarget {
  readonly pid: number
  on(event: string, listener: () => void): unknown
  prependListener(event: string, listener: () => void): unknown
  removeListener(event: string, listener: () => void): unknown
  listenerCount(event: string): number
  kill(pid: number, signal: string): unknown
}

export interface ExitFlushable {
  /** Flush for process exit. Must resolve, never reject. */
  exitFlush(): Promise<void>
  /** Upper bound in ms this reporter may hold up a signal-triggered exit. */
  readonly exitBudget: number
}

export interface ExitRegistry {
  add(reporter: ExitFlushable): void
  remove(reporter: ExitFlushable): void
}

const SIGNALS = ['SIGTERM', 'SIGINT'] as const

/**
 * One set of process listeners shared by every reporter, installed while at
 * least one is registered. Sharing them lets a signal handler tell its own
 * listeners apart from the application's, which decides whether to re-raise.
 */
export function createExitRegistry(target: ExitTarget | undefined): ExitRegistry {
  const reporters = new Set<ExitFlushable>()
  const installed = new Map<string, () => void>()

  const flushAll = (): Promise<void> =>
    Promise.all([...reporters].map((r) => r.exitFlush())).then(
      () => undefined,
      () => undefined,
    )

  const onBeforeExit = (): void => {
    void flushAll()
  }

  const onSignal = (signal: string): void => {
    // Our listener is prepended, so it runs first and every other listener,
    // including the app's once() handlers, is still registered here.
    const appHandles = target !== undefined && target.listenerCount(signal) > 1

    const listener = installed.get(signal)
    if (listener !== undefined && target !== undefined) {
      target.removeListener(signal, listener)
      installed.delete(signal)
    }

    // If the application listens for this signal it owns shutdown. Otherwise
    // our listener has suppressed Node's default exit, so restore it after
    // flushing by re-raising the signal with no listener attached.
    const budget = Math.max(0, ...[...reporters].map((r) => r.exitBudget))

    let timer: ReturnType<typeof setTimeout> | undefined
    const capped = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, budget)
    })

    void Promise.race([flushAll(), capped]).then(() => {
      clearTimeout(timer)
      if (!appHandles && target !== undefined) {
        try {
          target.kill(target.pid, signal)
        } catch {
          // Nothing left to do; the process carries on.
        }
      }
    })
  }

  const install = (): void => {
    if (target === undefined || installed.size > 0) return
    try {
      installed.set('beforeExit', onBeforeExit)
      target.on('beforeExit', onBeforeExit)
      for (const signal of SIGNALS) {
        const listener = (): void => onSignal(signal)
        installed.set(signal, listener)
        target.prependListener(signal, listener)
      }
    } catch {
      uninstall()
    }
  }

  const uninstall = (): void => {
    if (target === undefined) return
    for (const [event, listener] of installed) {
      try {
        target.removeListener(event, listener)
      } catch {
        // Ignore: the listener is gone either way.
      }
    }
    installed.clear()
  }

  return {
    add(reporter) {
      reporters.add(reporter)
      install()
    },
    remove(reporter) {
      reporters.delete(reporter)
      if (reporters.size === 0) uninstall()
    },
  }
}

function realProcess(): ExitTarget | undefined {
  const proc = (globalThis as unknown as { process?: Partial<ExitTarget> }).process
  if (
    proc === undefined ||
    typeof proc.on !== 'function' ||
    typeof proc.prependListener !== 'function' ||
    typeof proc.removeListener !== 'function' ||
    typeof proc.listenerCount !== 'function' ||
    typeof proc.kill !== 'function' ||
    typeof proc.pid !== 'number'
  ) {
    return undefined
  }
  return proc as ExitTarget
}

let shared: ExitRegistry | undefined

export function processExitRegistry(): ExitRegistry {
  shared ??= createExitRegistry(realProcess())
  return shared
}
