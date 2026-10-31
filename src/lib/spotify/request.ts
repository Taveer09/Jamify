export class RequestTimeoutError extends Error {
  constructor() {
    super('Spotify request timed out')
    this.name = 'RequestTimeoutError'
  }
}

// AbortSignal.timeout is absent in some embedded WebKit browsers. Keep the
// deadline around the complete operation, including reading the response body.
export async function withRequestTimeout<T>(
  request: (signal: AbortSignal) => Promise<T>,
  milliseconds = 20_000,
): Promise<T> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new RequestTimeoutError())
      controller.abort()
    }, milliseconds)
  })
  try {
    return await Promise.race([request(controller.signal), deadline])
  } finally {
    clearTimeout(timer)
  }
}
