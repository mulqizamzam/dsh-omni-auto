import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, after } from 'node:test'

import { apply } from '../lib/index.js'

/** Noise that OMNI classifies as droppable, plus real signal lines. */
function noisyText() {
  const lines = ['$ pnpm test', '> dsh@0.2.0 test']
  for (let i = 0; i < 200; i += 1) {
    lines.push(`✓ packages/core/agent (test ${i}) 12.4s`)
  }
  lines.push('FAIL packages/shell/tool-bash')
  lines.push('  ✗ rejects a sandboxed escalation without justification (12ms)')
  lines.push('    AssertionError: expected \'denied\' to equal \'allowed\'')
  lines.push('Test Files  1 failed | 41 passed (42)')
  return lines.join('\n')
}

/** A hermetic OMNI worker: canned signal extraction, no binary involved. */
function fakeClient(overrides = {}) {
  const calls = []
  const client = {
    calls,
    async ensure() {},
    async callTool(name, args) {
      calls.push({ name, args })
      if (overrides.throwOnCall === true) throw new Error('worker died')
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(overrides.result ?? {
            critical: ['FAIL packages/shell/tool-bash', '  ✗ rejects a sandboxed escalation without justification (12ms)'],
            important: ['Test Files  1 failed | 41 passed (42)'],
            dropped_pct: 0.9,
          }),
        }],
      }
    },
    dispose() {},
  }
  return () => client
}

/** Minimal dispatch triple: the pending call, its outcome, and a delegation stub. */
function dispatch({ toolName = 'bash', raw, resultValue, decision = { kind: 'accept' } }) {
  const nextCalls = []
  const next = async () => {
    nextCalls.push(1)
    return decision
  }
  return {
    exec: { name: toolName, signal: undefined },
    result: { content: [{ type: 'text', text: raw }], value: resultValue ?? {} },
    next,
    nextCalls,
  }
}

describe('omni-auto post-execute listener', () => {
  it('replaces oversized noisy output with the extracted signal', async () => {
    const raw = noisyText()
    const { listeners } = captureWith({ clientFactory: fakeClient() })
    const d = dispatch({ raw })
    const decision = await listeners.get('tools/post-execute')(d.exec, d.result, d.next)

    const text = decision.content[0].text
    assert.ok(text.includes('FAIL packages/shell/tool-bash'), 'keeps the failure line')
    assert.ok(text.includes('Test Files  1 failed | 41 passed (42)'), 'keeps the summary')
    assert.ok(!text.includes('✓ packages/core/agent (test 5)'), 'drops passing-test noise')
    assert.ok(text.includes('[omni-auto]'), 'footer records the reduction')
    assert.deepEqual(decision.kind, 'accept')
    assert.equal(d.nextCalls.length, 1, 'downstream policies still ran exactly once')
  })

  it('keeps oversized output untouched when it is below the threshold', async () => {
    const { listeners } = captureWith({ clientFactory: fakeClient(), minBytes: 10_000 })
    const d = dispatch({ raw: 'small output' })
    const decision = await listeners.get('tools/post-execute')(d.exec, d.result, d.next)

    assert.equal(decision.content, undefined, 'renderer output is preserved')
    assert.equal(d.nextCalls.length, 1)
  })

  it('never rewrites structured payloads', async () => {
    const raw = JSON.stringify({ a: 1, b: [1, 2, 3] })
    const { listeners } = captureWith({ clientFactory: fakeClient() })
    const d = dispatch({ raw })
    const decision = await listeners.get('tools/post-execute')(d.exec, d.result, d.next)

    assert.equal(decision.content, undefined)
    assert.equal(d.nextCalls.length, 1)
  })

  it('skips results containing non-text blocks', async () => {
    const { listeners } = captureWith({ clientFactory: fakeClient() })
    const d = dispatch({ raw: noisyText() })
    d.result.content.push({ type: 'image', source: { type: 'base64', data: 'x' } })
    const decision = await listeners.get('tools/post-execute')(d.exec, d.result, d.next)

    assert.equal(decision.content, undefined)
    assert.equal(d.nextCalls.length, 1)
  })

  it('returns a blocked decision unchanged', async () => {
    const { listeners } = captureWith({ clientFactory: fakeClient() })
    const d = dispatch({
      raw: noisyText(),
      decision: { kind: 'block', feedback: [{ type: 'text', text: 'denied by policy' }] },
    })
    const decision = await listeners.get('tools/post-execute')(d.exec, d.result, d.next)

    assert.equal(decision.kind, 'block')
    assert.equal(decision.feedback[0].text, 'denied by policy')
    assert.equal(d.nextCalls.length, 1)
  })

  it('fails open when the OMNI worker is unavailable', async () => {
    const { listeners } = captureWith({ clientFactory: fakeClient({ throwOnCall: true }) })
    const d = dispatch({ raw: noisyText() })
    const decision = await listeners.get('tools/post-execute')(d.exec, d.result, d.next)

    assert.equal(decision.content, undefined, 'original renderer output survives')
    assert.equal(d.nextCalls.length, 1)
  })

  it('keeps the original when extraction finds no signal', async () => {
    const { listeners } = captureWith({
      clientFactory: fakeClient({ result: { critical: [], important: [], dropped_pct: 1 } }),
    })
    const d = dispatch({ raw: noisyText() })
    const decision = await listeners.get('tools/post-execute')(d.exec, d.result, d.next)

    assert.equal(decision.content, undefined)
    assert.equal(d.nextCalls.length, 1)
  })

  it('keeps the original when the extraction is not smaller than the raw output', async () => {
    // The documented contract is "an extraction that is not smaller than the
    // original returns the original content". A worker that hands back more than
    // it received must never be allowed to grow the model's context.
    const bloated = Array.from({ length: 200 }, (_, i) => `signal line ${i} ${'x'.repeat(60)}`)
    const { listeners } = captureWith({
      clientFactory: fakeClient({ result: { critical: bloated, important: [] } }),
    })
    const d = dispatch({ raw: noisyText() })
    const decision = await listeners.get('tools/post-execute')(d.exec, d.result, d.next)

    assert.equal(decision.content, undefined, 'a non-reduction never replaces the original')
    assert.equal(d.nextCalls.length, 1)
  })

  it('never distills OMNI output', async () => {
    const client = fakeClient()
    const { listeners } = captureWith({ clientFactory: client })
    const d = dispatch({ toolName: 'mcp__omni__omni_run', raw: noisyText() })
    await listeners.get('tools/post-execute')(d.exec, d.result, d.next)

    assert.equal(client().calls.length, 0, 'no worker call is made')
    assert.equal(d.nextCalls.length, 1)
  })

  it('carries the spill path into the footer', async () => {
    const { listeners } = captureWith({ clientFactory: fakeClient() })
    const d = dispatch({ raw: noisyText(), resultValue: { spillPath: '/tmp/dsh-spill/abc/out.txt' } })
    const decision = await listeners.get('tools/post-execute')(d.exec, d.result, d.next)

    assert.ok(decision.content[0].text.includes('full output: /tmp/dsh-spill/abc/out.txt'))
  })

  it('preserves bash exit-code markers ahead of the signal', async () => {
    const { listeners } = captureWith({ clientFactory: fakeClient() })
    const d = dispatch({ raw: `[exit code: 1]\n${noisyText()}` })
    const decision = await listeners.get('tools/post-execute')(d.exec, d.result, d.next)

    assert.ok(decision.content[0].text.startsWith('[exit code: 1]\n'), 'marker survives first')
  })

  it('is inert when disabled', async () => {
    const client = fakeClient()
    const { listeners } = captureWith({ clientFactory: client, enabled: false })
    const d = dispatch({ raw: noisyText() })
    await listeners.get('tools/post-execute')(d.exec, d.result, d.next)

    assert.equal(client().calls.length, 0)
    assert.equal(d.nextCalls.length, 1)
  })

  it('always starts the worker with the distiller tool exposed', async () => {
    let spawned
    const listeners = new Map()
    const spillDir = mkdtempSync(join(tmpdir(), 'omni-auto-env-spill-'))
    testSpillDirs.push(spillDir)
    apply({
      on(name, listener) {
        listeners.set(name, listener)
        return () => listeners.delete(name)
      },
    }, {
      spillDir,
      omniEnv: { OMNI_AGENT_ID: 'dsh', OMNI_DB_PATH: '/tmp/omni.db' },
      clientFactory(options) {
        spawned = options.env
        return {
          async ensure() {},
          async callTool() {
            return { content: [{ type: 'text', text: '{"critical":[]}' }] }
          },
          dispose() {},
        }
      },
    })
    const d = dispatch({ raw: noisyText() })
    await listeners.get('tools/post-execute')(d.exec, d.result, d.next)

    assert.equal(spawned.OMNI_MCP_TOOLS, 'all', 'the distiller stays reachable')
    assert.equal(spawned.OMNI_AGENT_ID, 'dsh', 'caller environment is preserved')
    assert.equal(spawned.OMNI_DB_PATH, '/tmp/omni.db', 'caller environment is preserved')
  })

  it('keeps the raw bytes in a spill file the footer points at', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'omni-auto-spill-'))
    try {
      const raw = noisyText()
      const { listeners } = captureWith({ clientFactory: fakeClient(), spillDir: dir })
      const d = dispatch({ raw })
      const decision = await listeners.get('tools/post-execute')(d.exec, d.result, d.next)

      const match = decision.content[0].text.match(/full output: (\S+)/)
      assert.ok(match, 'footer names a spill file')
      assert.equal(readFileSync(match[1], 'utf8'), raw, 'the file holds the untouched raw output')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reuses the spill file bash already wrote', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'omni-auto-spill-'))
    try {
      const raw = noisyText()
      const bashSpill = join(dir, 'bash-spill.txt')
      writeFileSync(bashSpill, raw)
      const { listeners } = captureWith({ clientFactory: fakeClient(), spillDir: dir })
      const d = dispatch({ raw, resultValue: { spillPath: bashSpill } })
      await listeners.get('tools/post-execute')(d.exec, d.result, d.next)

      const dayDirs = readdirSync(dir).filter(name => name !== 'bash-spill.txt')
      assert.equal(dayDirs.length, 0, 'no duplicate copy is written')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('keeps the original when the raw cannot be preserved', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'omni-auto-spill-'))
    try {
      const blocker = join(dir, 'blocker')
      writeFileSync(blocker, 'not a directory')
      const { listeners } = captureWith({ clientFactory: fakeClient(), spillDir: join(blocker, 'nested') })
      const d = dispatch({ raw: noisyText() })
      const decision = await listeners.get('tools/post-execute')(d.exec, d.result, d.next)

      assert.equal(decision.content, undefined, 'the original content survives')
      assert.equal(d.nextCalls.length, 1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('removes raw copies older than the retention window', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'omni-auto-spill-'))
    try {
      const stale = join(dir, '2020-01-01', 'old.txt')
      mkdirSync(join(dir, '2020-01-01'), { recursive: true })
      writeFileSync(stale, 'stale')
      const past = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
      utimesSync(stale, past, past)

      const raw = noisyText()
      const { listeners } = captureWith({ clientFactory: fakeClient(), spillDir: dir })
      const d = dispatch({ raw })
      await listeners.get('tools/post-execute')(d.exec, d.result, d.next)

      assert.equal(existsSync(stale), false, 'stale copy is swept')
      assert.equal(existsSync(join(dir, '2020-01-01')), false, 'the emptied directory is removed')
      assert.ok(statSync(join(dir, new Date().toISOString().slice(0, 10))).isDirectory(), 'today lives on')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

/** Spill directories this file created, removed when the run ends. */
const testSpillDirs = []

/** Apply the plugin with a config override and capture its listener. */
function captureWith(config) {
  const listeners = new Map()
  const ctx = {
    on(name, listener) {
      listeners.set(name, listener)
      return () => listeners.delete(name)
    },
  }
  // Hermetic spilling: a test that does not name its own spill directory gets a
  // private one, so the suite never writes to the production default.
  const spillDir = config.spillDir ?? mkdtempSync(join(tmpdir(), 'omni-auto-test-spill-'))
  if (config.spillDir === undefined) testSpillDirs.push(spillDir)
  apply(ctx, { ...config, spillDir })
  return { listeners }
}

after(() => {
  for (const dir of testSpillDirs) rmSync(dir, { recursive: true, force: true })
})
