const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')

const source = fs.readFileSync(require.resolve('../out/utils/walletSingleton'), 'utf8')

function deferred () {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function fixture (network = 'mainnet') {
  const connections = [], additions = [], wallets = []
  const modules = {
    '@bsv/sdk': {
      PrivateKey: class {},
      CachedKeyDeriver: class { constructor () { this.identityKey = 'synthetic identity' } }
    },
    '@bsv/wallet-toolbox-client': {
      WalletStorageManager: class {
        async addWalletStorageProvider (client) {
          const pending = deferred()
          additions.push({ client, ...pending })
          await pending.promise
        }
      },
      WalletSigner: class { constructor (chain) { this.chain = chain } },
      Services: class { constructor (chain) { this.chain = chain } },
      Wallet: class {
        constructor (signer, services) { this.signer = signer; this.services = services; wallets.push(this) }
      },
      StorageClient: class {
        constructor (wallet, url) { this.wallet = wallet; this.url = url }
        async makeAvailable () {
          const pending = deferred()
          connections.push({ client: this, ...pending })
          await pending.promise
        }
      }
    }
  }
  const exports = {}
  vm.runInNewContext(source, {
    exports,
    require: name => { assert.ok(Object.hasOwn(modules, name)); return modules[name] },
    process: { env: { BSV_NETWORK: network, SERVER_PRIVATE_KEY: 'synthetic', WALLET_STORAGE_URL: 'https://storage.example.invalid' } }
  })
  return { getWallet: exports.getWallet, connections, additions, wallets }
}

async function tick () { await Promise.resolve(); await Promise.resolve() }

async function main () {
  for (const [network, chain] of [['mainnet', 'main'], ['testnet', 'test']]) {
    const f = fixture(network)
    let returned = false
    const pending = Array.from({ length: 20 }, () => f.getWallet().then(wallet => { returned = true; return wallet }))
    assert.equal(f.connections.length, 1, 'concurrent users must share initialization')
    assert.equal(f.wallets[0].signer.chain, chain)
    assert.equal(f.wallets[0].services.chain, chain)
    await tick(); assert.equal(returned, false)
    f.connections[0].resolve(); await tick()
    assert.equal(f.additions.length, 1)
    assert.equal(f.additions[0].client, f.connections[0].client)
    assert.equal(returned, false, 'do not expose the wallet before provider registration')
    f.additions[0].resolve()
    const wallets = await Promise.all(pending)
    assert.ok(wallets.every(wallet => wallet === f.wallets[0]))
    assert.equal(await f.getWallet(), wallets[0], 'later metadata lookups must reuse the ready wallet')
    assert.equal(f.connections.length, 1)
  }

  for (const failedStage of ['connection', 'registration']) {
    const f = fixture()
    const pending = Promise.allSettled([f.getWallet(), f.getWallet()])
    if (failedStage === 'registration') {
      f.connections[0].resolve(); await tick()
      f.additions[0].reject(new Error('synthetic registration failure'))
    } else f.connections[0].reject(new Error('synthetic connection failure'))
    const failed = await pending
    assert.ok(failed.every(result => result.status === 'rejected'))
    assert.equal(failed[0].reason, failed[1].reason)
    const retry = f.getWallet()
    assert.equal(f.connections.length, 2, 'failed initialization must allow a new connection')
    f.connections[1].resolve(); await tick()
    f.additions.at(-1).resolve()
    assert.equal(await retry, f.wallets[1])
    assert.equal(await f.getWallet(), f.wallets[1])
  }
  console.log('Wallet reuse: concurrent initialization, ready reuse, network selection and failed initialization recovery passed')
}

main().catch(error => { console.error(error); process.exit(1) })
