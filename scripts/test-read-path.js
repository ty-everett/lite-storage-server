const assert = require('node:assert/strict')
const Module = require('node:module')
const fs = require('node:fs')

// Load the compiled production modules with local doubles, never a wallet RPC.
function loadWith (name, replacements) {
  const filename = require.resolve(name)
  delete require.cache[filename]
  const original = Module._load
  Module._load = function (request, parent, ...rest) {
    if (parent?.filename === filename && Object.hasOwn(replacements, request)) return replacements[request]
    return original.call(this, request, parent, ...rest)
  }
  try { return require(filename) } finally { Module._load = original }
}

function deferred () {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function walletFixture (makeAvailable, addProvider) {
  const counts = { wallets: 0, available: 0, providers: 0 }
  const sdk = {
    PrivateKey: class {},
    CachedKeyDeriver: class { constructor () { this.identityKey = 'test-only' } }
  }
  const toolbox = {
    Services: class {}, WalletSigner: class {},
    Wallet: class { constructor () { counts.wallets++ } },
    WalletStorageManager: class {
      async addWalletStorageProvider () { counts.providers++; await addProvider?.() }
    },
    StorageClient: class {
      async makeAvailable () { counts.available++; await makeAvailable?.() }
    }
  }
  return {
    ...loadWith('../out/utils/walletSingleton', { '@bsv/sdk': sdk, '@bsv/wallet-toolbox-client': toolbox }),
    counts
  }
}

async function testWallet () {
  const available = deferred(), provider = deferred(), providerEntered = deferred()
  const f = walletFixture(() => available.promise, () => { providerEntered.resolve(); return provider.promise })
  let completed = 0
  const calls = Array.from({ length: 30 }, () => f.getWallet().then(w => { completed++; return w }))
  assert.equal(f.counts.wallets, 1)
  assert.equal(completed, 0)
  available.resolve()
  await providerEntered.promise
  assert.equal(completed, 0, 'a wallet cannot escape before its storage provider is ready')
  provider.resolve()
  const wallets = await Promise.all(calls)
  assert.ok(wallets.every(w => w === wallets[0]))
  assert.strictEqual(await f.getWallet(), wallets[0])
  assert.deepEqual(f.counts, { wallets: 1, available: 1, providers: 1 })

  for (const failingStage of ['available', 'provider']) {
    const failure = deferred()
    let first = true
    const failOnce = () => { if (first) { first = false; return failure.promise } }
    const g = walletFixture(failingStage === 'available' ? failOnce : undefined,
      failingStage === 'provider' ? failOnce : undefined)
    const attempts = Array.from({ length: 20 }, () => g.getWallet())
    const settled = Promise.allSettled(attempts)
    failure.reject(new Error('test-only provider unavailable'))
    assert.ok((await settled).every(r => r.status === 'rejected'))
    assert.equal(g.counts.wallets, 1)
    const retry = await Promise.all(Array.from({ length: 20 }, () => g.getWallet()))
    assert.ok(retry.every(w => w === retry[0]))
    assert.strictEqual(await g.getWallet(), retry[0])
    assert.equal(g.counts.wallets, 2, 'one new initialization after a shared failure')
    assert.equal(g.counts.available, 2)
    assert.equal(g.counts.providers, failingStage === 'available' ? 1 : 2)
  }
}

async function testMime () {
  let content = Buffer.alloc(0), offset = 0, readBytes = 0, opened = 0, closed = 0
  let maxChunk = Infinity, readFailure = false, outputs = [], lookups = 0, lookupArgs
  const fakeFs = {
    ...fs,
    existsSync: () => true,
    readFileSync: () => { throw new Error('whole-object reads are forbidden') },
    openSync: () => { opened++; offset = 0; return 42 },
    readSync: (fd, target, start, length) => {
      assert.equal(fd, 42)
      if (readFailure) throw new Error('test-only read failure')
      const n = Math.min(length, maxChunk, content.length - offset)
      content.copy(target, start, offset, offset + n)
      offset += n; readBytes += n
      return n
    },
    closeSync: fd => { assert.equal(fd, 42); closed++ }
  }
  const wallet = { listOutputs: async args => { lookups++; lookupArgs = args; return { outputs } } }
  const { cdnMimeTypeMiddleware: middleware } = loadWith('../out/utils/mimeTypeMiddleware', {
    fs: fakeFs,
    './walletSingleton': { getWallet: async () => wallet },
    '@bsv/sdk': { Utils: { toArray: text => [...Buffer.from(text)], toHex: bytes => Buffer.from(bytes).toString('hex') } }
  })
  let sequence = 0
  async function request (bytes, expected, object = `testObject${++sequence}`) {
    content = bytes; readBytes = 0
    let sent = false
    await middleware({ path: `/cdn/${object}` }, {
      setHeader: (name, value) => { assert.equal(name, 'Content-Type'); assert.equal(value, expected) },
      sendFile: file => { assert.ok(file.endsWith(`/cdn/${object}`)); sent = true }
    }, () => { throw new Error('existing CDN content must be served') })
    assert.equal(sent, true)
    assert.ok(readBytes <= 512, 'sniffing must not scale with object size')
    assert.equal(opened, closed, 'every opened descriptor must close')
  }

  for (const [bytes, type] of [
    [[0xff, 0xd8, 0xff], 'image/jpeg'], [[0x89, 0x50, 0x4e, 0x47], 'image/png'],
    [[0x47, 0x49, 0x46], 'image/gif'], [[0x25, 0x50, 0x44, 0x46], 'application/pdf'],
    [[0x50, 0x4b], 'application/zip'], [[0, 1, 2], 'application/octet-stream'],
    ['<!DOCTYPE html><html></html>', 'text/html'], ['<html></html>', 'text/html'],
    ['{"a":1}', 'application/json'], ['[1,2]', 'application/json'],
    ['{invalid', 'text/plain'], ['plain text', 'text/plain'], ['', 'text/plain']
  ]) await request(Buffer.from(bytes), type)

  maxChunk = 3 // Reads may return less than requested, including before EOF.
  await request(Buffer.from('{"split":"reads"}'), 'application/json')
  maxChunk = Infinity
  await request(Buffer.concat([Buffer.alloc(512, 65), Buffer.alloc(1024 * 1024, 0)]), 'text/plain')
  assert.equal(readBytes, 512)
  await request(Buffer.from('{"value":"' + 'a'.repeat(600) + '"}'), 'text/plain')
  readFailure = true
  await request(Buffer.from('unreadable'), 'application/octet-stream')
  readFailure = false

  // Preserve advertisement selection and positive caching, without negative caching.
  const future = Math.floor(Date.now() / 1000) + 3600
  outputs = [
    { tags: ['content_type_image/gif', 'expiry_time_1'] },
    { tags: ['content_type_image/png', `expiry_time_${future}`] },
    { tags: ['content_type_application/pdf', `expiry_time_${future + 1}`] }
  ]
  const before = opened
  await request(Buffer.from('fallback'), 'application/pdf', 'metadataObject')
  const afterLookup = lookups
  await request(Buffer.from('fallback'), 'application/pdf', 'metadataObject')
  assert.equal(lookups, afterLookup)
  assert.equal(opened, before, 'known advertisement MIME does not need file sniffing')
  assert.deepEqual(lookupArgs, {
    basket: 'uhrp advertisements', tags: [`object_identifier_${Buffer.from('metadataObject').toString('hex')}`],
    tagQueryMode: 'all', includeTags: true, limit: 50
  })
  outputs = []
  await request(Buffer.from('fallback'), 'text/plain', 'newAdvertisement')
  outputs = [{ tags: ['content_type_image/png', `expiry_time_${future}`] }]
  await request(Buffer.from('fallback'), 'image/png', 'newAdvertisement')
}

Promise.resolve().then(testWallet).then(testMime)
  .then(() => console.log('wallet initialization and bounded MIME read tests passed'))
  .catch(error => { console.error(error); process.exitCode = 1 })
