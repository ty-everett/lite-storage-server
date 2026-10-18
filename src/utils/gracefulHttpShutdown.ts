import { Server } from 'http'

const closing = new WeakMap<Server, Promise<void>>()

/** Stop admission, close idle keep-alives, and let accepted transfers finish.
 * The deployment owns the bounded termination grace. Do not introduce a
 * shorter process timer that can truncate a valid large upload/download.
 */
export function gracefulHttpShutdown (server: Server): Promise<void> {
  const existing = closing.get(server)
  if (existing) return existing
  const result = new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve())
    server.closeIdleConnections()
  })
  closing.set(server, result)
  return result
}
