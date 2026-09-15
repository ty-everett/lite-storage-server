import 'dotenv/config'
import express, { Request, Response, NextFunction } from 'express'
import bodyparser from 'body-parser'
import { spawn } from 'child_process'
import { PrivateKey } from '@bsv/sdk'
import { createAuthMiddleware } from '@bsv/auth-express-middleware'
import { createPaymentMiddleware } from '@bsv/payment-express-middleware'
import { getWallet } from './utils/walletSingleton'
import routes from './routes'
import getPriceForFile from './utils/getPriceForFile'
import { getMetadata } from './utils/getMetadata'
import { cdnMimeTypeMiddleware } from './utils/mimeTypeMiddleware'
import { isAuthMiddlewarePath, isPaymentMiddlewarePath } from './utils/requestBoundary'
import path from 'path'

const SERVER_PRIVATE_KEY = process.env.SERVER_PRIVATE_KEY as string
const HTTP_PORT = process.env.HTTP_PORT || 8080

const app = express()
// This allows the API to be used when CORS is enforced
app.use((req: Request, res: Response, next: NextFunction) => {
  res.header('Access-Control-Allow-Origin', '*')
  res.header('Access-Control-Allow-Headers', '*')
  res.header('Access-Control-Allow-Methods', '*')
  res.header('Access-Control-Expose-Headers', '*')
  res.header('Access-Control-Allow-Private-Network', 'true')
  if (req.method === 'OPTIONS') {
    res.send(200)
  } else {
    next()
  }
})
// Add CDN MIME type middleware before static middleware
app.use(cdnMimeTypeMiddleware)
app.use(express.static(path.join(__dirname, '../public')))
app.use(
  '/put',
  bodyparser.raw({ type: '*/*', limit: '2gb' })
)
app.use(bodyparser.json({ limit: '1gb', type: 'application/json' }))

app.use(express.static('public'))

// Unsecured pre-auth routes are added first
const preAuthRoutes = Object.values(routes.preAuth);
const postAuthRoutes = Object.values(routes.postAuth);
const postAuthPaths = new Set(postAuthRoutes.map(route => route.path));

// Cycle through pre-auth routes
preAuthRoutes.filter(route => (route as any).unsecured).forEach((route) => {
  console.log(`adding pre-auth route ${route.path}`)
  // If we need middleware for a route, attach it
  if ((route as any).middleware) {
    app[route.type as 'get' | 'put' | 'post' | 'patch' | 'delete'](
      route.path,
      (route as any).middleware,
      (route as any).func
    )
  } else {
    app[route.type as 'get' | 'put' | 'post' | 'patch' | 'delete'](route.path, (route as any).func)
  }
})

// Secured pre-auth routes are added next
preAuthRoutes.filter(route => !(route as any).unsecured).forEach((route) => {
  console.log(`adding route ${route.path}`)
  // If we need middleware for a route, attach it
  if ((route as any).middleware) {
    app[route.type as 'get' | 'put' | 'post' | 'patch' | 'delete'](
      route.path,
      (route as any).middleware,
      (route as any).func
    )
  } else {
    app[route.type as 'get' | 'put' | 'post' | 'patch' | 'delete'](route.path, (route as any).func)
  }
})

  // Auth is enforced from here forward
  ; (async () => {
    const wallet = await getWallet()
    const authMiddleware = createAuthMiddleware({
      wallet
    })

    const paymentMiddleware = createPaymentMiddleware({
      wallet,
      calculateRequestPrice: async (req) => {
        if (req.url === '/upload') {
          const { fileSize, retentionPeriod } = (req.body as any) || {}
          if (!fileSize || !retentionPeriod) return 0
          try {
            const satoshis = await getPriceForFile({ fileSize: +fileSize, retentionPeriod: +retentionPeriod })
            return satoshis
          } catch (e) {
            return 0
          }
        }
        if (req.url === '/renew') {
          const { uhrpUrl, additionalMinutes } = (req.body as any) || {}
          if (!uhrpUrl || !additionalMinutes) return 0
          try {
            const { size } = await getMetadata(uhrpUrl, (req as any).auth.identityKey)
            const satoshis = await getPriceForFile({ fileSize: +size, retentionPeriod: +additionalMinutes })
            return satoshis
          } catch (e) {
            return 0
          }
        }

        return 0
      }
    })

    app.use((req, res, next) => {
      if (!isAuthMiddlewarePath(req.path, postAuthPaths)) return next()
      void authMiddleware(req, res, next)
    })
    app.use((req, res, next) => {
      if (!isPaymentMiddlewarePath(req.path, postAuthPaths)) return next()
      void paymentMiddleware(req, res, next)
    })

    // Secured, post-auth routes are added
    postAuthRoutes.forEach((route) => {
      console.log(`adding post-auth route ${route.path}`)
      // If we need middleware for a route, attach it
      if ((route as any).middleware) {
        app[route.type as 'get' | 'put' | 'post' | 'patch' | 'delete'](
          route.path,
          (route as any).middleware,
          (route as any).func
        )
      } else {
        app[route.type as 'get' | 'put' | 'post' | 'patch' | 'delete'](route.path, (route as any).func)
      }
    })

    app.use((req, res) => {
      console.log('404', req.url)
      res.status(404).json({
        status: 'error',
        code: 'ERR_ROUTE_NOT_FOUND',
        description: 'Route not found.'
      })
    })

    app.listen(HTTP_PORT, () => {
      console.log('UHRP Storage Server listening on port', HTTP_PORT)
      const idKey = PrivateKey
        .fromString(SERVER_PRIVATE_KEY).toPublicKey().toString()
      console.log(`UHRP Host IdentityKey: ${idKey}`)
    })

  })();
