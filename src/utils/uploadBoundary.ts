import path from 'path'

export interface ValidatedUploadTarget {
  objectID: string
  fileSize: number
  destination: string
}

const base58ObjectID = /^[1-9A-HJ-NP-Za-km-z]{21,22}$/
const sha256Hmac = /^[0-9a-f]{64}$/i

export function validateUploadTarget (
  cdnRoot: string,
  objectID: unknown,
  fileSize: unknown,
  bodyLength: unknown,
  hmac: unknown
): ValidatedUploadTarget {
  if (typeof objectID !== 'string' || !base58ObjectID.test(objectID)) {
    throw new Error('Invalid object ID')
  }
  if (typeof fileSize !== 'string' || !/^\d+$/.test(fileSize)) {
    throw new Error('Invalid file size')
  }
  const expectedSize = Number(fileSize)
  if (typeof bodyLength !== 'number' || !Number.isSafeInteger(expectedSize) || expectedSize < 1 || expectedSize !== bodyLength) {
    throw new Error('Size mismatch')
  }
  if (typeof hmac !== 'string' || !sha256Hmac.test(hmac)) {
    throw new Error('Invalid upload authorization')
  }

  const root = path.resolve(cdnRoot)
  const destination = path.resolve(root, objectID)
  if (path.dirname(destination) !== root) {
    throw new Error('Invalid object path')
  }

  return { objectID, fileSize: expectedSize, destination }
}

export async function uploadHmacIsValid (
  verify: () => Promise<{ valid: boolean }>
): Promise<boolean> {
  try {
    return (await verify()).valid === true
  } catch {
    return false
  }
}
