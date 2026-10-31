import { describe, expect, it, vi } from 'vitest'
import { challengeFor, SCOPES, SpotifyAuth, validateConfig } from '../../src/lib/spotify/auth'
import { json, MemoryStorage } from './helpers'

const config = { clientId: 'a'.repeat(32), redirectUri: 'http://127.0.0.1:5173/callback' }
const origin = 'http://127.0.0.1:5173'
const token = { access_token: 'fixture-access', refresh_token: 'fixture-refresh', expires_in: 3600, token_type: 'Bearer' }

async function prepare(fetcher = vi.fn<typeof fetch>()) {
  const storage = new MemoryStorage()
  let now = 100_000
  const auth = new SpotifyAuth({ storage, fetcher, clock: () => now })
  const authorization = new URL(await auth.authorize(config, origin))
  const callback = `${config.redirectUri}?code=fixture-code&state=${authorization.searchParams.get('state')}`
  return { storage, auth, authorization, callback, fetcher, advance: (ms: number) => { now += ms } }
}

describe('OAuth PKCE capability contracts', () => {
  it('matches the RFC 7636 S256 test vector', async () => {
    expect(await challengeFor('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'))
      .toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')
  })
  it('requests PKCE and all SDK scopes without a client secret', async () => {
    const { authorization } = await prepare()
    expect(authorization.origin).toBe('https://accounts.spotify.com')
    expect(authorization.searchParams.get('code_challenge_method')).toBe('S256')
    expect(authorization.searchParams.get('scope')?.split(' ')).toEqual([...SCOPES])
    expect(SCOPES).toContain('user-read-email')
    expect(authorization.href).not.toContain('client_secret')
  })
  it.each(['http://localhost:5173/callback', 'https://evil.example/callback', 'http://127.0.0.1:5173/wrong', 'http://127.0.0.1:5173/callback?extra=1'])('rejects an invalid redirect: %s', (redirectUri) => {
    expect(() => validateConfig({ ...config, redirectUri }, origin)).toThrow()
  })
  it('rejects an invalid Client ID before navigation', () => {
    expect(() => validateConfig({ ...config, clientId: 'wrong' }, origin)).toThrow(/32/)
  })
  it('consumes an invalid state without exchanging a token', async () => {
    const { auth, callback, fetcher, storage } = await prepare()
    await expect(auth.complete(callback.replace(/state=.*/, 'state=wrong'))).rejects.toThrow(/проверить/)
    expect(fetcher).not.toHaveBeenCalled()
    expect(storage.length).toBe(0)
    await expect(auth.complete(callback)).rejects.toThrow(/устарел/)
  })
  it('rejects a callback from the wrong origin', async () => {
    const { auth, callback, fetcher } = await prepare()
    await expect(auth.complete(callback.replace(origin, 'https://evil.example'))).rejects.toThrow(/проверить/)
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('clears an existing refresh grant when a new callback has an invalid state', async () => {
    const { auth, callback, fetcher, storage } = await prepare()
    fetcher.mockResolvedValue(json(token))
    await auth.complete(callback)
    await auth.authorize(config, origin)
    await expect(auth.complete(`${config.redirectUri}?code=unused&state=invalid`)).rejects.toThrow(/проверить/)
    expect(auth.hasSession()).toBe(false)
    expect(storage.length).toBe(0)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it('expires pending login after ten minutes', async () => {
    const { auth, callback, fetcher, advance } = await prepare()
    advance(600_001)
    await expect(auth.complete(callback)).rejects.toThrow(/проверить/)
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('handles a denied grant without requesting tokens', async () => {
    const { auth, callback, fetcher } = await prepare()
    await expect(auth.complete(callback.replace('code=fixture-code', 'error=access_denied'))).rejects.toThrow(/не предоставлен/)
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('stores only the refresh token and prevents callback replay', async () => {
    const { auth, callback, fetcher, storage } = await prepare()
    fetcher.mockResolvedValue(json(token))
    await auth.complete(callback)
    expect(await auth.getAccessToken()).toBe('fixture-access')
    expect(storage.dump()).not.toContain('fixture-access')
    expect(storage.dump()).not.toContain('fixture-code')
    expect(storage.dump()).toContain('fixture-refresh')
    await expect(auth.complete(callback)).rejects.toThrow(/устарел/)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it('distinguishes an immediate transport failure and consumes the callback without retrying', async () => {
    const { auth, callback, fetcher, storage } = await prepare()
    fetcher.mockRejectedValue(new TypeError('private network diagnostic'))
    await expect(auth.complete(callback)).rejects.toThrow('Браузер не смог выполнить запрос входа')
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(storage.length).toBe(0)
    expect(auth.hasSession()).toBe(false)
  })
  it('reports malformed successful token responses separately from transport errors', async () => {
    const { auth, callback, fetcher } = await prepare()
    fetcher.mockResolvedValue(new Response('invalid-json', { status: 200 }))
    await expect(auth.complete(callback)).rejects.toThrow('ответ в неожиданном формате')
    expect(auth.hasSession()).toBe(false)
  })
  it('reports a deadline separately and aborts the exchange without retrying', async () => {
    const { auth, callback, fetcher } = await prepare()
    vi.useFakeTimers()
    try {
      fetcher.mockImplementation(() => new Promise<Response>(() => {}))
      const assertion = expect(auth.complete(callback)).rejects.toThrow('Spotify не ответил за 20 секунд')
      await vi.advanceTimersByTimeAsync(20_000)
      await assertion
      expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true)
      expect(fetcher).toHaveBeenCalledTimes(1)
      expect(auth.hasSession()).toBe(false)
    } finally { vi.useRealTimers() }
  })
  it('refreshes once for concurrent callers and retains a non-rotated refresh token', async () => {
    const { auth, callback, fetcher, storage, advance } = await prepare()
    fetcher.mockResolvedValueOnce(json(token)).mockResolvedValueOnce(json({ ...token, access_token: 'renewed-access', refresh_token: undefined }))
    await auth.complete(callback)
    advance(3_600_000)
    expect(await Promise.all([auth.getAccessToken(), auth.getAccessToken()])).toEqual(['renewed-access', 'renewed-access'])
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(storage.dump()).toContain('fixture-refresh')
  })
  it('clears an invalid refresh grant without exposing response contents', async () => {
    const { auth, callback, fetcher, storage, advance } = await prepare()
    fetcher.mockResolvedValueOnce(json(token)).mockResolvedValueOnce(json({ error: 'private-diagnostic' }, 400))
    await auth.complete(callback)
    advance(3_600_000)
    await expect(auth.getAccessToken()).rejects.toThrow(/HTTP 400/)
    expect(storage.length).toBe(0)
  })
  it('does not resurrect a session when logout occurs during refresh', async () => {
    const { auth, callback, fetcher, advance, storage } = await prepare()
    fetcher.mockResolvedValueOnce(json(token))
    await auth.complete(callback)
    advance(3_600_000)
    let resolve: ((response: Response) => void) | undefined
    fetcher.mockImplementationOnce(() => new Promise<Response>((done) => { resolve = done }))
    const request = auth.getAccessToken()
    auth.logout()
    resolve!(json(token))
    await expect(request).rejects.toThrow(/отключён/)
    expect(storage.length).toBe(0)
    expect(auth.hasSession()).toBe(false)
  })
})
