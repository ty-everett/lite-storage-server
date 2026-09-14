const assert = require('assert')
const path = require('path')
const { uploadHmacIsValid, validateUploadTarget } = require('../out/utils/uploadBoundary')

const root = '/srv/uhrp/public/cdn'
const objectID = '123456789ABCDEFGHJKLMN'
const hmac = 'a'.repeat(64)

const valid = validateUploadTarget(root, objectID, '4', 4, hmac)
assert.strictEqual(valid.destination, path.join(root, objectID))
assert.strictEqual(valid.fileSize, 4)

for (const invalid of ['../package.json', '../../out/index.js', '/etc/passwd', 'not base58']) {
  assert.throws(() => validateUploadTarget(root, invalid, '4', 4, hmac), /Invalid object ID/)
}
assert.throws(() => validateUploadTarget(root, objectID, '5', 4, hmac), /Size mismatch/)
assert.throws(() => validateUploadTarget(root, objectID, '4', 4, '00'), /Invalid upload authorization/)

async function testHmacBoundary () {
  assert.strictEqual(await uploadHmacIsValid(async () => ({ valid: true })), true)
  assert.strictEqual(await uploadHmacIsValid(async () => ({ valid: false })), false)
  assert.strictEqual(await uploadHmacIsValid(async () => { throw new Error('ERR_INVALID_HMAC') }), false)
}

testHmacBoundary()
  .then(() => console.log('upload boundary tests passed'))
  .catch(error => { console.error(error); process.exit(1) })
