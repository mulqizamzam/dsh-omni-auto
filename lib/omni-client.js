// Persistent stdio MCP client for a private `omni --mcp` worker process.
//
// The plugin uses OMNI only as a text distiller (`omni_signal_extract`). It never
// registers the worker's tools with the harness, so the worker's tool surface is
// not model-visible. Every failure surfaces as a thrown error so the caller can
// fail open: the original tool result always survives.

import { spawn } from 'node:child_process'

/** Protocol revision the official SDK selects for this client (2026-07-28). */
const PROTOCOL_VERSION = '2026-07-28'

/** Error type for every client failure, including timeouts and dead workers. */
export class OmniMcpError extends Error {
  constructor(message) {
    super(message)
    this.name = 'OmniMcpError'
  }
}

/**
 * Minimal newline-delimited JSON-RPC 2.0 client over a child's stdio.
 *
 * One worker serves every call. A worker that exits or wedges is killed and
 * respawned on the next call, so a stale process can never poison later turns.
 */
export class OmniMcpClient {
  /** @param {{bin: string, cwd?: string, env?: Record<string,string>, logger?: (level: string, message: string) => void}} options */
  constructor({ bin, cwd, env, logger }) {
    if (typeof bin !== 'string' || bin.length === 0) {
      throw new OmniMcpError('omni binary path is required')
    }
    this.bin = bin
    this.cwd = cwd
    this.env = env ?? {}
    this.logger = logger
    this.child = undefined
    this.pending = new Map()
    this.nextId = 1
    this.starting = undefined
    this.disposed = false
  }

  /** Spawn the worker if needed and complete the initialize handshake once. */
  async ensure() {
    if (this.disposed) throw new OmniMcpError('client is disposed')
    if (this.child !== undefined && this.child.exitCode === null) return
    if (this.starting !== undefined) return this.starting
    this.starting = this.#start().finally(() => {
      this.starting = undefined
    })
    return this.starting
  }

  async #start() {
    this.#teardown('replacing worker')
    const child = spawn(this.bin, ['--mcp'], {
      cwd: this.cwd,
      env: { ...process.env, ...this.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child = child
    let buffer = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      buffer += chunk
      let index = buffer.indexOf('\n')
      while (index !== -1) {
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        if (line.length > 0) this.#onLine(line)
        index = buffer.indexOf('\n')
      }
    })
    child.stdin.on('error', () => this.#failPending('worker stdin closed'))
    // A spawn failure (missing or non-executable binary) arrives as an 'error'
    // event. With no listener it becomes an uncaught exception that kills the
    // host, so it is routed into the ordinary pending-failure path instead.
    child.on('error', error => {
      if (this.child !== child) return
      this.child = undefined
      this.#failPending(`worker failed to start: ${error.message}`)
    })
    child.on('exit', code => {
      if (this.child === child) {
        this.child = undefined
        this.#failPending(`worker exited with code ${code}`)
      }
    })
    try {
      await this.#request(child, 'initialize', {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'dsh-omni-auto', version: '0.1.0' },
      }, 20000)
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
    } catch (error) {
      this.#teardown('initialize failed')
      throw error instanceof OmniMcpError ? error : new OmniMcpError(`initialize failed: ${error.message}`)
    }
  }

  #onLine(line) {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      return
    }
    if (message.id === undefined || message.id === null) return
    const pending = this.pending.get(message.id)
    if (pending === undefined) return
    this.pending.delete(message.id)
    clearTimeout(pending.timer)
    if (Object.hasOwn(message, 'error')) {
      // `error` is not guaranteed to be an object by every worker; reading
      // through it unguarded throws inside this stream handler and kills the host.
      pending.reject(new OmniMcpError(`tool error: ${message.error?.message ?? 'unknown'}`))
      return
    }
    pending.resolve(message.result)
  }

  #failPending(reason) {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(new OmniMcpError(reason))
    }
    this.pending.clear()
  }

  /**
   * Call one MCP tool on the worker.
   * @param {string} name - tool name, e.g. `omni_signal_extract`.
   * @param {Record<string, unknown>} args - tool arguments.
   * @param {{timeoutMs?: number, signal?: AbortSignal}} [options]
   * @returns {Promise<unknown>} the raw JSON-RPC `result`.
   */
  async callTool(name, args, { timeoutMs = 15000, signal } = {}) {
    await this.ensure()
    const child = this.child
    if (child === undefined) throw new OmniMcpError('worker is not running')
    if (signal?.aborted === true) throw new OmniMcpError('call aborted before start')
    return new Promise((resolve, reject) => {
      const id = this.nextId++
      const entry = { resolve, reject, timer: undefined }
      entry.timer = setTimeout(() => {
        this.pending.delete(id)
        // A wedged worker cannot serve later calls; replace it.
        this.#teardown('call timed out')
        // Settle through the entry wrapper, not the bare reject: it is what
        // detaches the abort listener from the caller's signal.
        entry.reject(new OmniMcpError(`tool ${name} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      this.pending.set(id, entry)
      const onAbort = () => {
        if (!this.pending.delete(id)) return
        clearTimeout(entry.timer)
        reject(new OmniMcpError('call aborted'))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      entry.cleanup = () => signal?.removeEventListener('abort', onAbort)
      const original = entry.resolve
      entry.resolve = value => {
        entry.cleanup?.()
        original(value)
      }
      const originalReject = entry.reject
      entry.reject = error => {
        entry.cleanup?.()
        originalReject(error)
      }
      try {
        child.stdin.write(`${JSON.stringify({
          jsonrpc: '2.0',
          id,
          method: 'tools/call',
          params: { name, arguments: args },
        })}\n`)
      } catch (error) {
        this.pending.delete(id)
        clearTimeout(entry.timer)
        entry.cleanup?.()
        reject(new OmniMcpError(`write failed: ${error.message}`))
      }
    })
  }

  #request(child, method, params, timeoutMs) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++
      const entry = { resolve, reject, timer: undefined }
      entry.timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new OmniMcpError(`${method} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      this.pending.set(id, entry)
      try {
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
      } catch (error) {
        this.pending.delete(id)
        clearTimeout(entry.timer)
        reject(new OmniMcpError(`write failed: ${error.message}`))
      }
    })
  }

  #teardown(reason) {
    const child = this.child
    this.child = undefined
    this.#failPending(reason)
    if (child !== undefined) {
      try {
        child.stdin.end()
      } catch {
        // A worker whose stdin is already gone cannot be closed again.
      }
      try {
        child.kill('SIGTERM')
      } catch {
        // Killing an already-dead worker is a no-op.
      }
    }
  }

  dispose() {
    this.disposed = true
    this.#teardown('client disposed')
  }
}
