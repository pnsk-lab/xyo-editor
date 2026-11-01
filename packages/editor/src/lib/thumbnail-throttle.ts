/** Run the first request immediately and coalesce later requests to the latest
 * value, no more often than once per 300ms. Invalidate in-flight work as soon
 * as a new value is requested, rather than waiting for the trailing refresh. */
export function createThumbnailThrottle<T>(run: (value: T) => void, invalidate: () => void) {
  let timer: ReturnType<typeof setTimeout> | undefined
  let lastRun: number | undefined
  let pending: T | undefined
  let hasPending = false
  let disposed = false

  function flush() {
    timer = undefined
    if (disposed || !hasPending) return
    const value = pending as T
    pending = undefined
    hasPending = false
    lastRun = Date.now()
    run(value)
  }

  function request(value: T, immediate = false) {
    if (disposed) return
    invalidate()
    pending = value
    hasPending = true
    if (immediate && timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
    const delay = lastRun === undefined || immediate ? 0 : Math.max(0, 300 - (Date.now() - lastRun))
    if (delay === 0) {
      if (timer !== undefined) clearTimeout(timer)
      flush()
    } else if (timer === undefined) {
      timer = setTimeout(flush, delay)
    }
  }

  function reset() {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    pending = undefined
    hasPending = false
    lastRun = undefined
    invalidate()
  }

  function dispose() {
    reset()
    disposed = true
  }

  return { request, reset, dispose }
}
