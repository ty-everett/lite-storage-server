import { CachedKeyDeriver, PrivateKey, WalletInterface } from '@bsv/sdk'
import { Services, StorageClient, Wallet, WalletSigner, WalletStorageManager } from '@bsv/wallet-toolbox-client'

const SERVER_PRIVATE_KEY = process.env.SERVER_PRIVATE_KEY as string
const WALLET_STORAGE_URL = process.env.WALLET_STORAGE_URL as string
const BSV_NETWORK = process.env.BSV_NETWORK as 'mainnet' | 'testnet'

let walletPromise: Promise<WalletInterface> | null = null

export function getWallet(): Promise<WalletInterface> {
  if (!walletPromise) {
    // Auth, payments and CDN metadata share one fully initialized wallet.
    // Keep concurrent callers behind the same initialization and retry a
    // failed connection on a later call instead of caching its rejection.
    walletPromise = createWallet().catch(error => {
      walletPromise = null
      throw error
    })
  }
  return walletPromise
}

async function createWallet(): Promise<WalletInterface> {
  const chain = BSV_NETWORK === 'mainnet' ? 'main' : 'test'
  const keyDeriver = new CachedKeyDeriver(new PrivateKey(SERVER_PRIVATE_KEY, 'hex'))
  const storageManager = new WalletStorageManager(keyDeriver.identityKey)
  const signer = new WalletSigner(chain, keyDeriver, storageManager)
  const services = new Services(chain)
  const wallet = new Wallet(signer, services)
  const client = new StorageClient(wallet, WALLET_STORAGE_URL)
  await client.makeAvailable()
  await storageManager.addWalletStorageProvider(client)
  return wallet
}
