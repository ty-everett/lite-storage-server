const WELL_KNOWN_AUTH_PATH = '/.well-known/auth'

export function isAuthMiddlewarePath (pathname: string, postAuthPaths: ReadonlySet<string>): boolean {
  return pathname === WELL_KNOWN_AUTH_PATH || postAuthPaths.has(pathname)
}

export function isPaymentMiddlewarePath (pathname: string, postAuthPaths: ReadonlySet<string>): boolean {
  return postAuthPaths.has(pathname)
}
