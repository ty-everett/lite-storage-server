const assert = require('node:assert/strict')
const { mkdtemp, mkdir, readFile, writeFile, stat, rm } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const path = require('node:path')
const { storeCdnObject, configuredCdnWritePolicy } = require('../out/utils/cdnStorage')

async function main () {
  const directory = await mkdtemp(path.join(tmpdir(), 'uhrp-cdn-storage-'))
  const a = path.join(directory, 'a'); const b = path.join(directory, 'b')
  await mkdir(a); await mkdir(b)
  try {
    const bytes = Buffer.from('owned migration payload')
    await storeCdnObject(a, 'one', bytes, {})
    assert.deepEqual(await readFile(path.join(a, 'one')), bytes)
    await assert.rejects(storeCdnObject(a, 'one', Buffer.from('changed'), {}), { code: 'EEXIST' })
    assert.deepEqual(await readFile(path.join(a, 'one')), bytes)
    assert.equal((await stat(path.join(a, 'one'))).mode & 0o777, 0o640)

    await storeCdnObject(a, 'both', bytes, { mirrorRoot: b })
    assert.deepEqual(await readFile(path.join(a, 'both')), bytes)
    assert.deepEqual(await readFile(path.join(b, 'both')), bytes)

    // During initial rollout a legacy process may already own primary A.
    // A failed new upload must retain A and remove only its newly created B.
    await writeFile(path.join(a, 'legacy'), 'original', { flag: 'wx' })
    await assert.rejects(storeCdnObject(a, 'legacy', bytes, { mirrorRoot: b }), { code: 'EEXIST' })
    assert.equal(await readFile(path.join(a, 'legacy'), 'utf8'), 'original')
    await assert.rejects(stat(path.join(b, 'legacy')), { code: 'ENOENT' })

    await writeFile(path.join(b, 'conflict'), 'preserve', { flag: 'wx' })
    await assert.rejects(storeCdnObject(a, 'conflict', bytes, { mirrorRoot: b }), { code: 'EEXIST' })
    assert.equal(await readFile(path.join(b, 'conflict'), 'utf8'), 'preserve')
    await assert.rejects(stat(path.join(a, 'conflict')), { code: 'ENOENT' })

    // Promotion versions share physical B as the first exclusive writer.
    // Each simultaneous duplicate must yield exactly one success, not two ads.
    for (let index = 0; index < 20; index++) {
      const object = 'race' + index
      const results = await Promise.allSettled([
        storeCdnObject(a, object, bytes, { mirrorRoot: b, writeOrder: 'mirror-first' }),
        storeCdnObject(b, object, bytes, { mirrorRoot: a, writeOrder: 'primary-first' })
      ])
      assert.equal(results.filter(x => x.status === 'fulfilled').length, 1)
      const failure = results.find(x => x.status === 'rejected')
      assert.equal(failure.reason.code, 'EEXIST')
      assert.deepEqual(await readFile(path.join(a, object)), bytes)
      assert.deepEqual(await readFile(path.join(b, object)), bytes)
    }
    await assert.rejects(storeCdnObject(a, '../escape', bytes, { mirrorRoot: b }), /Invalid object path/)
    await assert.rejects(storeCdnObject(a, 'same', bytes, { mirrorRoot: a }), /distinct storage root/)
    await assert.rejects(storeCdnObject(a, 'missing', bytes, { mirrorRoot: path.join(directory, 'absent') }), { code: 'ENOENT' })
    await assert.rejects(stat(path.join(a, 'missing')), { code: 'ENOENT' })
    const before = process.env.CDN_WRITE_ORDER
    process.env.CDN_WRITE_ORDER = 'invalid'
    assert.throws(configuredCdnWritePolicy, /Invalid CDN write order/)
    if (before === undefined) delete process.env.CDN_WRITE_ORDER
    else process.env.CDN_WRITE_ORDER = before
    console.log('CDN storage migration boundary passed, including 20 mixed-version races')
  } finally { await rm(directory, { recursive: true, force: true }) }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
