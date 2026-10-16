// dsh-omni-auto — automatic OMNI distillation for tool results.
//
// OMNI ships hooks for Claude Code, Cursor, Codex and the other hosts it can
// wrap, but not for DeepSeek Harness: nothing on the DSH side invokes it, so
// `omni_run` stays a tool the model must choose by hand while `bash` wins 63:1.
//
// This plugin closes that gap on the only seam DSH documents for post-dispatch
// rewriting: the `tools/post-execute` waterfall. It lets every downstream policy
// run first (`next()`), then replaces the model-facing content of oversized shell
// results with the signal OMNI extracts from the same text.
//
// Contract:
//   - Delegates first. A non-`accept` decision (another policy blocked or
//     amended the call) is returned untouched, so this plugin can never mask or
//     reorder a guard decision.
//   - Fails open. No worker, a timeout, unparsable output, non-text blocks,
//     structured (JSON) payloads, or an extraction that is not smaller than the
//     original all return the original content.
//   - Preserves the retrievable original. Bash already spills oversized output to
//     a file; when the canonical value carries `spillPath` the replacement keeps
//     that path so the raw bytes stay reachable.
//   - Never distills OMNI's own output (`mcp__omni__*`), avoiding recursion.

import { mkdirSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { OmniMcpClient } from './omni-client.js'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'omni-auto'

/** The tool registry service whose post-execute waterfall this plugin rewrites. */
export const inject = ['tools']

/** Every default is overridable from `cordis.yml`. */
export const DEFAULTS = {
  /** Master switch; `false` leaves the pipeline byte-identical. */
  enabled: true,
  /** Tool names whose text results are eligible for distillation. */
  tools: ['bash'],
  /** Skip anything smaller than this many bytes of joined text. */
  minBytes: 4000,
  /** Never rewrite JSON/NDJSON payloads: line dropping corrupts structure. */
  skipJson: true,
  /** Keep bash's `[exit code: N]` / `[still running ...]` marker lines. */
  preserveMarkers: true,
  /** Per-call budget for the OMNI worker, including worker startup. */
  timeoutMs: 15000,
  /** Directory for the raw copies this plugin keeps before rewriting. */
  spillDir: '/tmp/dsh-omni-auto-spill',
  /** Days after which an unwritten-then-unread raw copy is removed. */
  spillRetentionDays: 7,
  /** Absolute path of the `omni` binary. */
  omniBin: '/home/administrator/.local/bin/omni',
  /** Worker working directory; OMNI resolves its database from it. */
  omniCwd: '',
  /** Extra environment for the worker, merged over the host environment. */
  omniEnv: {},
  /**
   * Test seam: a factory returning `{ ensure, callTool, dispose }`. The default
   * spawns the real binary. Injected by tests to keep them hermetic.
   * @type {((options: {bin: string, cwd: string, env: Record<string,string>, logger: (level: string, message: string) => void}) => {ensure: () => Promise<void>, callTool: (name: string, args: Record<string, unknown>, options?: {timeoutMs?: number, signal?: AbortSignal}) => Promise<unknown>, dispose: () => void}) | undefined}
   */
  clientFactory: undefined,
}

/**
 * Apply the plugin.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Cordis context.
 * @param {Partial<typeof DEFAULTS>} [config] - Overrides from `cordis.yml`.
 * @returns {{dispose: () => void}} disposer that stops the worker.
 */
export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...config }
  const logger = makeLogger(ctx)

  let client
  const getClient = () => {
    if (client === undefined) {
      const factory = cfg.clientFactory ?? (options => new OmniMcpClient(options))
      client = factory({
        bin: cfg.omniBin,
        cwd: cfg.omniCwd,
        // `all` exposes `omni_signal_extract`; a plain tool list does not. It is
        // re-applied after the caller env so an override that drops it fails
        // loudly here instead of silently degrading to pass-through.
        env: { ...cfg.omniEnv, OMNI_MCP_TOOLS: cfg.omniEnv?.OMNI_MCP_TOOLS ?? 'all' },
        logger,
      })
    }
    return client
  }

  ctx.on('tools/post-execute', async (exec, result, next) => {
    // Downstream policies run first; their decision is authoritative.
    const decision = await next()
    if (cfg.enabled !== true) return decision
    if (decision.kind !== 'accept') return decision
    if (!isEligible(exec.name, cfg)) return decision

    const blocks = decision.content ?? result.content
    if (!Array.isArray(blocks) || blocks.length === 0) return decision
    if (blocks.some(block => block?.type !== 'text')) return decision

    const raw = blocks.map(block => block.text).join('\n')
    if (raw.length < cfg.minBytes) return decision
    if (cfg.skipJson === true && looksJson(raw)) return decision

    // The raw bytes must stay reachable after the rewrite: use the spill file
    // bash already wrote, or keep our own copy before replacing anything.
    let spillPath
    try {
      spillPath = readSpillPath(result.value) ?? spillRaw(raw, cfg, exec)
    } catch (error) {
      logger('warn', `[omni-auto] ${exec.name} left unchanged: raw could not be preserved (${error.message})`)
      return decision
    }

    let distilled
    try {
      distilled = await distill(getClient(), raw, cfg, exec.signal, spillPath)
    } catch (error) {
      logger('debug', `[omni-auto] ${exec.name} left unchanged: ${error.message}`)
      return decision
    }
    if (distilled === undefined) return decision

    return { ...decision, content: [{ type: 'text', text: distilled }] }
  })

  return {
    dispose() {
      client?.dispose()
      client = undefined
    },
  }
}

/** @returns {(level: string, message: string) => void} plugin-scoped logger. */
function makeLogger(ctx) {
  return (level, message) => {
    try {
      ctx.logger?.(level, message)
    } catch {
      // A logger that throws must not break tool execution.
    }
  }
}

/**
 * @param {string} toolName - dispatched tool name.
 * @param {typeof DEFAULTS} cfg - resolved config.
 * @returns {boolean} whether this call is eligible.
 */
function isEligible(toolName, cfg) {
  if (typeof toolName !== 'string' || toolName.length === 0) return false
  // Distilling OMNI's own output would nest and could loop.
  if (toolName.startsWith('mcp__omni__')) return false
  return Array.isArray(cfg.tools) && cfg.tools.includes(toolName)
}

/**
 * Structural payload guard: JSON and JSON-lines documents are dropped by line
 * filtering, so they are never rewritten. Detection parses instead of guessing
 * from the first character, because a bash `[exit code: N]` marker line starts
 * with `[` too.
 * @param {string} raw - joined result text.
 * @returns {boolean} true when the text is a JSON document or JSON lines.
 */
function looksJson(raw) {
  const lines = contentLines(raw)
  if (lines.length === 0) return false
  try {
    const parsed = JSON.parse(lines.join('\n'))
    return typeof parsed === 'object' && parsed !== null
  } catch {
    // Not one document; fall through to the JSON-lines check.
  }
  return lines.every(line => {
    try {
      const parsed = JSON.parse(line)
      return typeof parsed === 'object' && parsed !== null
    } catch {
      return false
    }
  })
}

/**
 * Non-empty content lines with bash marker lines removed.
 * @param {string} raw - joined result text.
 * @returns {string[]} trimmed lines that carry payload.
 */
function contentLines(raw) {
  return raw
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0 && !isMarkerLine(line))
}

/**
 * @param {string} line - raw line.
 * @returns {boolean} whether the line is a bracketed bash marker.
 */
function isMarkerLine(line) {
  return line.startsWith('[') && line.endsWith(']')
}

/**
 * Distill raw tool text through `omni_signal_extract`.
 * @param {{callTool: OmniMcpClient['callTool']}} client - OMNI worker client.
 * @param {string} raw - joined original text.
 * @param {typeof DEFAULTS} cfg - resolved config.
 * @param {AbortSignal} [signal] - caller cancellation signal.
 * @param {string | undefined} [spillPath] - where the tool already spilled the raw bytes.
 * @returns {Promise<string | undefined>} replacement text, or undefined to keep the original.
 */
async function distill(client, raw, cfg, signal, spillPath) {
  const response = await client.callTool('omni_signal_extract', { text: raw }, {
    timeoutMs: cfg.timeoutMs,
    signal,
  })
  const text = firstText(response)
  if (text === undefined) return undefined

  /** @type {{critical?: unknown, important?: unknown}} */
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  const signalLines = dedupe([
    ...asLines(parsed.critical),
    ...asLines(parsed.important),
  ])
  // An extraction that keeps nothing is a classification failure, not a
  // distillation: the raw text stays so no information is invented or lost.
  if (signalLines.length === 0) return undefined

  const markers = cfg.preserveMarkers === true ? leadingMarkers(raw) : []
  const body = [...markers, ...signalLines].join('\n')
  const footer = footerFor(raw, body, spillPath)
  const replacement = footer === undefined ? body : `${body}\n${footer}`
  // The contract is a reduction, not a rewrite: a worker that returns as much as
  // it received would grow the model's context, so fail open and keep the original.
  if (replacement.length >= raw.length) return undefined
  return replacement
}

/**
 * Read the spill path from a tool's canonical value without assuming its shape.
 * @param {unknown} value - canonical tool value.
 * @returns {string | undefined} absolute spill path when the tool recorded one.
 */
function readSpillPath(value) {
  if (typeof value !== 'object' || value === null) return undefined
  const spillPath = /** @type {{spillPath?: unknown}} */ (value).spillPath
  return typeof spillPath === 'string' && spillPath.length > 0 ? spillPath : undefined
}

/**
 * Keep the raw bytes of a result that is about to be rewritten.
 *
 * The file name carries the date, tool name, and byte size so an operator can
 * find it without opening it. A failure throws, which the listener turns into
 * "keep the original content": a rewrite is never worth losing the raw output.
 *
 * @param {string} raw - joined original text.
 * @param {typeof DEFAULTS} cfg - resolved config.
 * @param {{name: string}} exec - the dispatched call.
 * @returns {string} absolute path of the written copy.
 */
function spillRaw(raw, cfg, exec) {
  const day = new Date().toISOString().slice(0, 10)
  const dir = join(cfg.spillDir, day)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const suffix = Math.random().toString(36).slice(2, 8)
  const file = join(dir, `${stamp}-${exec.name}-${raw.length}-${suffix}.txt`)
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(file, raw, 'utf8')
    sweepSpill(cfg)
  } catch (error) {
    throw new Error(`spill write failed: ${error.message}`)
  }
  return file
}

/**
 * Remove raw copies older than the retention window. Best-effort: a file that
 * cannot be removed is left for the next sweep.
 * @param {typeof DEFAULTS} cfg - resolved config.
 * @returns {void}
 */
function sweepSpill(cfg) {
  const cutoff = Date.now() - cfg.spillRetentionDays * 24 * 60 * 60 * 1000
  let entries
  try {
    entries = readdirSync(cfg.spillDir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const dir = join(cfg.spillDir, entry.name)
    let files
    try {
      files = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const file of files) {
      const path = join(dir, file.name)
      try {
        if (statSync(path).mtimeMs < cutoff) unlinkSync(path)
      } catch {
        // A file removed between the listing and the unlink is already gone.
      }
    }
    try {
      if (readdirSync(dir).length === 0) rmSync(dir, { recursive: true, force: true })
    } catch {
      // An empty directory that cannot be removed is harmless.
    }
  }
}

/** @returns {string | undefined} first text block of an MCP tool result. */
function firstText(response) {
  const content = /** @type {{content?: Array<{type?: string, text?: string}>}} */ (response)?.content
  if (!Array.isArray(content)) return undefined
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') return block.text
  }
  return undefined
}

/** @returns {string[]} string array from an unknown JSON field. */
function asLines(value) {
  return Array.isArray(value) ? value.filter(line => typeof line === 'string' && line.length > 0) : []
}

/** @returns {string[]} lines without duplicates, first occurrence wins. */
function dedupe(lines) {
  const seen = new Set()
  const out = []
  for (const line of lines) {
    if (seen.has(line)) continue
    seen.add(line)
    out.push(line)
  }
  return out
}

/**
 * Bash prefixes cancellation and exit-state markers; they carry the outcome and
 * must survive distillation.
 * @param {string} raw - joined original text.
 * @returns {string[]} leading bracketed marker lines.
 */
function leadingMarkers(raw) {
  const markers = []
  for (const line of raw.split('\n')) {
    if (line.trim().length === 0) continue
    if (!isMarkerLine(line.trim())) break
    markers.push(line)
  }
  return markers
}

/**
 * @param {string} raw - joined original text.
 * @param {string} body - distilled body.
 * @param {string | undefined} spillPath - where the tool spilled the raw bytes.
 * @returns {string} one-line provenance footer with sizes and the raw location.
 */
function footerFor(raw, body, spillPath) {
  const dropped = raw.length === 0 ? 0 : 1 - body.length / raw.length
  const percent = Math.round(Math.max(0, Math.min(1, dropped)) * 100)
  const footer = `[omni-auto] ${raw.length} -> ${body.length} bytes of signal (${percent}% dropped by omni_signal_extract)`
  return spillPath === undefined ? footer : `${footer}; full output: ${spillPath}`
}
