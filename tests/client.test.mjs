import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

const CLIENT_URL = new URL('../lib/omni-client.js', import.meta.url).href

/** A stdio worker that answers every call with a null JSON-RPC error. */
const NULL_ERROR_WORKER = `#!/usr/bin/env node
let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  buf += chunk
  let i
  while ((i = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, i)
    buf = buf.slice(i + 1)
    if (!line.trim()) continue
    const message = JSON.parse(line)
    const reply = message.id === 1
      ? { jsonrpc: '2.0', id: 1, result: {} }
      : { jsonrpc: '2.0', id: message.id, error: null }
    process.stdout.write(JSON.stringify(reply) + '\\n')
  }
})
`

/** A worker that completes the handshake but never answers a tools/call. */
const SILENT_WORKER = `#!/usr/bin/env node
let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  buf += chunk
  let i
  while ((i = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, i)
    buf = buf.slice(i + 1)
    if (!line.trim()) continue
    const message = JSON.parse(line)
    if (message.method === 'initialize') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} }) + '\\n')
    }
    // tools/call is answered with silence, so every call reaches its timeout.
  }
})
`

/** Install an executable worker script and return its path. */
function installWorker(dir, source) {
  const path = join(dir, 'worker.mjs')
  writeFileSync(path, source, 'utf8')
  chmodSync(path, 0o755)
  return path
}

/** Run one snippet against a client bound to `bin`, in a child process. */
function runAgainst(bin, body) {
  const script = `
    import { OmniMcpClient } from ${JSON.stringify(CLIENT_URL)}
    process.on('uncaughtException', () => { process.exit(9) })
    const client = new OmniMcpClient({ bin: ${JSON.stringify(bin)} })
    ${body}
  `
  return spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    timeout: 20000,
  })
}

describe('omni-client worker lifecycle', () => {
  it('reports a missing worker binary instead of crashing the host', () => {
    // The plugin's contract is "fails open ... no worker". A spawn failure that
    // escapes as an unhandled 'error' event takes the whole DSH process with it,
    // so the client must surface it as an ordinary rejection the caller can catch.
    const script = `
      import { OmniMcpClient } from ${JSON.stringify(CLIENT_URL)}
      process.on('uncaughtException', () => { process.exit(9) })
      const client = new OmniMcpClient({ bin: ${JSON.stringify(join(tmpdir(), 'no-such-omni-binary'))} })
      try {
        await client.ensure()
        console.log('RESOLVED')
      } catch (error) {
        console.log('CAUGHT ' + error.name + ' ' + (error.code ?? error.message))
      }
      await new Promise(resolve => setTimeout(resolve, 250))
      console.log('SURVIVED')
    `
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8',
      timeout: 20000,
    })

    assert.equal(run.status, 0, `a spawn failure must stay inside the client; status=${run.status} stderr=${run.stderr}`)
    assert.match(run.stdout, /CAUGHT OmniMcpError/)
    assert.match(run.stdout, /SURVIVED/)
  })

  it('survives a worker that reports a null JSON-RPC error', () => {
    // `error: null` reaches the response handler through the stdout stream, so an
    // unguarded property read there throws inside the listener and kills the host.
    const dir = mkdtempSync(join(tmpdir(), 'omni-auto-worker-'))
    try {
      const bin = installWorker(dir, NULL_ERROR_WORKER)
      const run = runAgainst(bin, `
        await client.ensure()
        try { await client.callTool('omni_signal_extract', { text: 'x' }, { timeoutMs: 3000 }) }
        catch (error) { console.log('CAUGHT ' + error.name + ': ' + error.message) }
        await new Promise(resolve => setTimeout(resolve, 200))
        console.log('SURVIVED')
        process.exit(0)
      `)

      assert.equal(run.status, 0, `a malformed worker reply must not crash the host; status=${run.status} stderr=${run.stderr}`)
      assert.match(run.stdout, /CAUGHT OmniMcpError/)
      assert.match(run.stdout, /SURVIVED/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('detaches the abort listener after a call times out', () => {
    // The timeout branch must settle through the same wrapper as every other
    // exit, otherwise the abort listener stays attached to the caller's signal
    // for the lifetime of the session and each timed-out call leaks one.
    const dir = mkdtempSync(join(tmpdir(), 'omni-auto-worker-'))
    try {
      const bin = installWorker(dir, SILENT_WORKER)
      const run = runAgainst(bin, `
        const { getEventListeners } = await import('node:events')
        const controller = new AbortController()
        for (let i = 0; i < 3; i++) {
          try { await client.callTool('omni_signal_extract', { text: 'x' }, { timeoutMs: 80, signal: controller.signal }) }
          catch (error) { console.log('caught ' + i + ': ' + error.message) }
        }
        await new Promise(resolve => setTimeout(resolve, 150))
        console.log('LEAKED ' + getEventListeners(controller.signal, 'abort').length)
        process.exit(0)
      `)

      assert.equal(run.status, 0, `a timing-out call must not crash the host; status=${run.status} stderr=${run.stderr}`)
      assert.match(run.stdout, /LEAKED 0/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
