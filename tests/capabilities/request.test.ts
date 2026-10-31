import { afterEach, describe, expect, it, vi } from 'vitest'
import { RequestTimeoutError, withRequestTimeout } from '../../src/lib/spotify/request'

afterEach(() => vi.useRealTimers())

describe('portable request deadline', () => {
  it('does not call the unsupported native AbortSignal.timeout helper', async () => {
    const nativeTimeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => { throw new TypeError('not supported') })
    try {
      await expect(withRequestTimeout(async (signal) => ({ aborted: signal.aborted }))).resolves.toEqual({ aborted: false })
      expect(nativeTimeout).not.toHaveBeenCalled()
    } finally { nativeTimeout.mockRestore() }
  })

  it('aborts a hung request and reports a timeout even if the request never settles', async () => {
    vi.useFakeTimers()
    let activeSignal: AbortSignal | undefined
    const result = withRequestTimeout((signal) => { activeSignal = signal; return new Promise<never>(() => {}) }, 100)
    const assertion = expect(result).rejects.toBeInstanceOf(RequestTimeoutError)
    await vi.advanceTimersByTimeAsync(100)
    await assertion
    expect(activeSignal?.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps the deadline active while the response body is being consumed', async () => {
    vi.useFakeTimers()
    const result = withRequestTimeout(async () => {
      await Promise.resolve('headers received')
      return new Promise<never>(() => {})
    }, 100)
    const assertion = expect(result).rejects.toBeInstanceOf(RequestTimeoutError)
    await vi.advanceTimersByTimeAsync(100)
    await assertion
  })

  it('clears its timer on a transport failure and does not retry', async () => {
    vi.useFakeTimers()
    const operation = vi.fn().mockRejectedValue(new TypeError('Network request failed'))
    await expect(withRequestTimeout(operation)).rejects.toThrow('Network request failed')
    expect(operation).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })
})
