import { constants } from 'fs'
import { lstat, open, unlink } from 'fs/promises'
import path from 'path'

export interface CdnWritePolicy {
  mirrorRoot?: string
  writeOrder?: 'mirror-first' | 'primary-first'
}

export function configuredCdnWritePolicy (): CdnWritePolicy {
  const writeOrder = process.env.CDN_WRITE_ORDER || 'mirror-first'
  if (writeOrder !== 'mirror-first' && writeOrder !== 'primary-first') {
    throw new Error('Invalid CDN write order')
  }
  return { mirrorRoot: process.env.CDN_MIRROR_DIR, writeOrder }
}

function destination (root: string, objectID: string): string {
  const resolvedRoot = path.resolve(root)
  const resolved = path.resolve(resolvedRoot, objectID)
  if (path.dirname(resolved) !== resolvedRoot || objectID !== path.basename(objectID)) {
    throw new Error('Invalid object path')
  }
  return resolved
}

/**
 * Keep the same physical first writer throughout a storage migration. For
 * A -> B: initially use primary A/mirror B/mirror-first, then primary B/mirror
 * A/primary-first, then B alone. B's exclusive create serializes both versions.
 * No success is returned until every configured copy is flushed and closed.
 */
export async function storeCdnObject (
  primaryRoot: string,
  objectID: string,
  content: Uint8Array,
  policy: CdnWritePolicy = configuredCdnWritePolicy()
): Promise<void> {
  const primary = destination(primaryRoot, objectID)
  const mirror = policy.mirrorRoot ? destination(policy.mirrorRoot, objectID) : undefined
  if (mirror === primary) throw new Error('CDN mirror must use a distinct storage root')
  if (policy.writeOrder && !['mirror-first', 'primary-first'].includes(policy.writeOrder)) {
    throw new Error('Invalid CDN write order')
  }
  const targets = mirror
    ? (policy.writeOrder === 'primary-first' ? [primary, mirror] : [mirror, primary])
    : [primary]
  const owned: { file: string, dev: number, ino: number }[] = []
  try {
    for (const file of targets) {
      const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o640)
      try {
        const identity = await handle.stat()
        owned.push({ file, dev: identity.dev, ino: identity.ino })
        await handle.writeFile(content)
        await handle.sync()
      } finally {
        await handle.close()
      }
    }
  } catch (cause) {
    // Never remove a pre-existing object or somebody else's replacement.
    // Exclusive creation is also retained for a one-volume deployment.
    const cleanupErrors: unknown[] = []
    for (const created of owned.reverse()) {
      try {
        const current = await lstat(created.file)
        if (current.dev !== created.dev || current.ino !== created.ino) {
          throw new Error('CDN object identity changed during failed-write cleanup')
        }
        await unlink(created.file)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') cleanupErrors.push(error)
      }
    }
    if (cleanupErrors.length) {
      // A cleanup failure is an internal error, never a successful upload or a
      // normal duplicate response that could conceal an incomplete mirror.
      const failure = new Error('CDN write failed and owned storage cleanup was incomplete') as Error & { cause?: unknown }
      failure.cause = cause
      throw failure
    }
    throw cause
  }
}
