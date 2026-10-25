export const POLL_INTERVALS = Object.freeze({
  openChat: 15_000,
  inbox: 60_000,
  unread: 60_000,
})

export function schedulePolling(callback, interval, {
  setIntervalImpl = globalThis.setInterval,
  clearIntervalImpl = globalThis.clearInterval,
} = {}) {
  const timer = setIntervalImpl(callback, interval)
  return () => clearIntervalImpl(timer)
}
