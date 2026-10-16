# dsh-omni-auto

Automatic OMNI distillation for DeepSeek Harness tool results.

OMNI installs hooks into the hosts it can wrap — Claude Code, Cursor, Codex, Zed,
Cline, Roo, Copilot CLI, Gemini CLI, OpenCode — but DeepSeek Harness is not one of
them. In DSH there is no hook that invokes OMNI, so `omni_run` stays a tool the
model must choose by hand, and `bash` wins that choice roughly 63 to 1.

This plugin moves the distillation to the seam DSH does document:
`tools/post-execute`. After every downstream policy has run, oversized text
results are rewritten with the signal OMNI extracts from the same bytes, so noisy
output never enters the model context.

## What it does

For each dispatched call whose name is in `tools` (default `bash`):

1. Delegates to the rest of the `tools/post-execute` chain first. A `block` or
   amended decision from another policy is returned untouched.
2. Skips the call unless the joined result text reaches `minBytes`.
3. Skips structured payloads. JSON documents and JSON-lines are never rewritten,
   because dropping lines corrupts structure. Detection parses the text, so a
   bash `[exit code: 1]` marker is not mistaken for a JSON array.
4. Skips results containing non-text blocks, and never touches `mcp__omni__*`.
5. Calls `omni_signal_extract` on a private `omni --mcp` worker and keeps only
   the `critical` and `important` lines, deduplicated, with bash's leading
   `[...]` markers preserved ahead of them.
6. Appends a provenance footer with the byte reduction and the path of the raw
   copy so the original stays reachable.

The raw bytes are preserved two ways. When the tool already spilled its own
output, that spill path is reused. Otherwise the plugin writes the raw text
under `spillDir/<date>/` before replacing anything, and removes copies older
than `spillRetentionDays`. A rewrite that cannot preserve the raw bytes is
abandoned: the original content is returned instead.

Every failure path returns the original content: no worker, a worker timeout, an
unparsable extraction, an extraction that keeps nothing, or an aborted call. The
plugin adds bytes only when it removes more.

## Configuration

Set through the package `cordis.patch.yml`, which is the single mount point.

```yaml
enabled: true            # master switch; false leaves the pipeline identical
tools: ['bash']          # tool names eligible for distillation
minBytes: 4000           # smaller results are returned untouched
skipJson: true           # never rewrite JSON / JSON-lines payloads
preserveMarkers: true    # keep bash's [exit code: N] markers
timeoutMs: 15000         # per-call budget including worker startup
omniBin: /home/administrator/.local/bin/omni
omniCwd: ''              # OMNI resolves its database from the worker cwd
omniEnv: {}              # extra environment merged over the host environment
```

The worker always starts with `OMNI_MCP_TOOLS=all`. A plain tool list does not
expose `omni_signal_extract`, which is the only text distiller OMNI offers. The
worker's own tools are never registered with the harness, so its 25-tool surface
is not model-visible.

## Why a persistent worker

OMNI exposes no CLI for text distillation (`omni signal-extract` is not a
command, and piping output into `omni` only records it). `omni_signal_extract`
exists only as an MCP tool, so the plugin keeps one long-lived worker and speaks
newline-delimited JSON-RPC to it. A worker that exits is respawned on the next
call; a worker that wedges is killed at the call timeout.

## Limits

- `omni_signal_extract` classifies lines; it does not summarize. A result whose
  value is a long list of distinct lines — a directory listing, a diff — keeps
  most of them, and the plugin falls back to the original when the extraction is
  not smaller.
- The rewrite changes what the model sees and what the session log records, which
  is the same trade OMNI itself makes. The canonical tool value is untouched, and
  bash's own spill file carries the raw bytes.
- `omni_signal_extract` records nothing: the OMNI database is unchanged by a
  rewrite, so `omni history` and `omni retrieve` cover only what `omni_run`
  executed and this plugin leaves no OMNI-side audit trail. The session log still
  carries the rewritten content, and the footer carries the byte counts.
- The executor that runs `bash` truncates long output itself, at roughly 64 KiB,
  keeping the head and the tail and reporting a spill path. `minBytes: 4000` sits
  below that, so a 5 KiB result is rewritten even though the executor produced no
  spill file. That is why the plugin keeps its own raw copy: without it, outputs
  between the two thresholds would exist only in the rewritten form.

## Tests

```sh
node --test
```

Hermetic on both seams: the OMNI worker is replaced through the `clientFactory`
test seam, and every test writes its raw copies to a private temporary directory,
so the suite covers delegation order, every skip rule, and each fail-open path
without spawning the binary or touching the production spill directory.
