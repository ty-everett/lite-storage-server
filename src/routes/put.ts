import createUHRPAdvertisement from '../utils/createUHRPAdvertisement';
import { Request, Response } from 'express';
import { Hash, Utils } from '@bsv/sdk';
import fs from 'fs'
import { getWallet } from '../utils/walletSingleton';
import path from 'path';
import { IncomingHttpHeaders } from 'http';
import { uploadHmacIsValid, validateUploadTarget } from '../utils/uploadBoundary';

const {
  HOSTING_DOMAIN
} = process.env

interface AdvertiseRequest extends Request {
  query: {
    uploader: string
    uhrpUrl: string
    objectID: string
    fileSize: string
    expiry: string
    hmac: string
  },
  headers: IncomingHttpHeaders
  body: Uint8Array
}

interface AdvertiseResponse {
  status: 'success' | 'error';
  code?: string;
  description?: string;
}

const advertiseHandler = async (req: AdvertiseRequest, res: Response<AdvertiseResponse>) => {
  const wallet = await getWallet()

  if (typeof req.query.expiry !== 'string' || typeof req.query.uploader !== 'string') {
    return res.status(400).json({
      status: 'error',
      description: 'Invalid upload request'
    })
  }

  let target
  try {
    target = validateUploadTarget(
      path.join(__dirname, '../../public/cdn'),
      req.query.objectID,
      req.query.fileSize,
      req.body?.byteLength,
      req.query.hmac
    )
  } catch (error) {
    return res.status(400).json({
      status: 'error',
      description: error instanceof Error ? error.message : 'Invalid upload request'
    })
  }

  // Verify hmac
  const str = `fileSize=${req.query.fileSize}&objectID=${req.query.objectID}&expiry=${req.query.expiry}&uploader=${req.query.uploader}`
  const valid = await uploadHmacIsValid(async () => await wallet.verifyHmac({
      protocolID: [2, 'storage upload'],
      keyID: '1',
      data: Utils.toArray(str, 'utf8'),
      hmac: Utils.toArray(req.query.hmac, 'hex')
    }))
  if (!valid) {
    return res.status(403).json({
      status: 'error',
      description: 'Invalid upload authorization'
    })
  }

  // An exclusive create prevents overwrites and closes the exists/write race.
  try {
    fs.writeFileSync(target.destination, req.body, { flag: 'wx', mode: 0o640 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      return res.status(409).json({
        status: 'error',
        description: 'File exists'
      })
    }
    throw error
  }

  // Create UHRP ad under /cdn
  try {
    if (HOSTING_DOMAIN?.startsWith('localhost')) {
      console.warn('Not advertising, loalhost')
      throw new Error('Not advertising in localhost')
    }
    const expiryTime = Math.floor(new Date(req.query.expiry).getTime() / 1000)
    await createUHRPAdvertisement({
      hash: Hash.sha256(Array.from(req.body)),
      objectIdentifier: target.objectID,
      url: `https://${HOSTING_DOMAIN}/cdn/${req.query.objectID}`,
      uploaderIdentityKey: req.query.uploader,
      expiryTime,
      contentLength: target.fileSize,
      contentType: req.headers['content-type'] || 'application/octet-stream'
    })
    res.status(200).json({ status: 'success' })
  } catch (error) {
    console.error('Error processing advertisement:', error)
    res.status(500).json({
      status: 'error',
      code: 'ERR_INTERNAL',
      description: 'An internal error occurred while processing the request.'
    })
  }
}

export default {
  type: 'put',
  path: '/put',
  func: advertiseHandler
}
