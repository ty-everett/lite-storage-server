const assert = require('node:assert/strict')
const http = require('node:http')
const { once } = require('node:events')
const { setTimeout: delay } = require('node:timers/promises')
const { gracefulHttpShutdown } = require('../out/utils/gracefulHttpShutdown')

async function main () {
  let accepted
  const incoming = new Promise(resolve => { accepted = resolve })
  const server = http.createServer((request, response) => {
    accepted()
    let data = ''
    request.on('data', chunk => { data += chunk })
    request.on('end', () => { response.end(data) })
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const request = http.request({ host: '127.0.0.1', port: server.address().port, method: 'POST', headers: { 'Content-Length': '12' } })
  const response = new Promise((resolve, reject) => {
    request.on('error', reject)
    request.on('response', reply => {
      let body = ''
      reply.on('data', chunk => { body += chunk })
      reply.on('end', () => resolve({ status: reply.statusCode, body }))
      reply.on('error', reject)
    })
  })
  request.write('hello '); await incoming
  let closed = false
  const shutdown = gracefulHttpShutdown(server)
  assert.equal(gracefulHttpShutdown(server), shutdown)
  shutdown.then(() => { closed = true })
  // A real accepted body remains open beyond the previous 25-second cutoff.
  await delay(26000)
  assert.equal(closed, false)
  request.end('world!')
  assert.deepEqual(await response, { status: 200, body: 'hello world!' })
  await shutdown; assert.equal(closed, true)

  const idleServer = http.createServer((_request, reply) => reply.end('ready'))
  idleServer.listen(0, '127.0.0.1'); await once(idleServer, 'listening')
  const agent = new http.Agent({ keepAlive: true })
  await new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: idleServer.address().port, agent }, reply => {
      reply.resume(); reply.on('end', resolve)
    }); req.on('error', reject)
  })
  await gracefulHttpShutdown(idleServer); agent.destroy()
  console.log('Graceful HTTP shutdown: held upload, repeated signal, idle keep-alive passed')
}
main().catch(error => { console.error(error); process.exit(1) })
