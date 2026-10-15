import { test } from 'node:test'
import assert from 'node:assert/strict'
import { OPENCODE_USER_AGENT, opencodeRequestId, opencodeSessionId, opencodeUserAgentFor, zenApiHeaders } from '../lib/index.js'

// opencode CLI id shape: `ses_`/`msg_` + 12 lowercase hex + 14 base62 chars.
const ID_SHAPE = /^(ses|msg)_[0-9a-f]{12}[0-9A-Za-z]{14}$/

test('User-Agent reproduces the opencode 2.x CLI fingerprint', () => {
  assert.equal(opencodeUserAgentFor('2.0.29'), 'opencode/latest/2.0.29/cli')
  assert.equal(OPENCODE_USER_AGENT, 'opencode/latest/2.0.29/cli')
})

test('msg_ ids follow the opencode shape and are fresh per call', () => {
  const ids = new Set()
  for (let i = 0; i < 200; i += 1) ids.add(opencodeRequestId())
  assert.equal(ids.size, 200)
  for (const id of ids) assert.match(id, ID_SHAPE)
})

const decodeDescendingTimePart = (id) => {
  // opencode's descending id: value = ~(timestamp * 0x1000 + counter), low 48 bits.
  const value = ~BigInt(`0x${id.slice(4, 16)}`) & 0xFFFFFFFFFFFFn
  return { timestamp: value >> 12n, counter: value & 0xFFFn }
}

test('ses_ id decodes to the mint clock, not digest material, and stays cached', () => {
  const since = Date.now()
  const id = opencodeSessionId('ses_a')
  const until = Date.now()
  assert.match(id, ID_SHAPE)
  // Same conversation keeps its id across turns without the caller carrying state.
  assert.equal(opencodeSessionId('ses_a'), id)
  assert.notEqual(opencodeSessionId('ses_a'), opencodeSessionId('ses_b'))
  // The Zen free tier reads the 12 hex chars as ~(unix_ms * 0x1000 + counter);
  // a digest-derived prefix is refused with 403 FreeTierError.
  const { timestamp, counter } = decodeDescendingTimePart(id)
  const low36 = (ms) => BigInt(ms) % (1n << 36n)
  assert.ok(timestamp >= low36(since) && timestamp <= low36(until),
    `timestamp ${timestamp} is not the mint clock ${low36(since)}..${low36(until)}`)
  assert.ok(counter >= 1n && counter < 4096n, `counter ${counter}`)
  // A cached conversation survives other conversations.
  const first = opencodeSessionId('ses_first')
  for (let i = 0; i < 2000; i += 1) opencodeSessionId(`ses_filler_${i}`)
  assert.equal(opencodeSessionId('ses_first'), first)
})

test('the mint counter resets per millisecond (a runaway global counter fails the gate)', async () => {
  await new Promise(resolve => setTimeout(resolve, 5))
  const counters = Array.from({ length: 5 }, (_, i) => decodeDescendingTimePart(opencodeSessionId(`ses_burst_${i}`)).counter)
  assert.ok(counters.every(counter => counter >= 1n && counter < 100n), `counters ${counters}`)
})

test('ses_ minting stays bounded: an evicted conversation re-mints its random half', () => {
  const first = opencodeSessionId('ses_evict_me')
  for (let i = 0; i < 9000; i += 1) opencodeSessionId(`ses_overflow_${i}`)
  const again = opencodeSessionId('ses_evict_me')
  assert.match(again, ID_SHAPE)
  // Only the clock half is re-minted; the 14-char random half is digest-derived.
  assert.notEqual(again, first)
  assert.equal(again.slice(16), first.slice(16))
})

test('an official opencode session id passes through untouched', () => {
  const canonical = 'ses_0123456789abAbCdEfGhIjKlMn'
  assert.equal(opencodeSessionId(canonical), canonical)
})

test('zenApiHeaders carries the full opencode request fingerprint', () => {
  const userAgent = opencodeUserAgentFor('2.0.29')
  // Even if a model def still carries a referer, the wire headers must not.
  const model = { headers: { 'User-Agent': userAgent, 'HTTP-Referer': 'https://opencode.ai' } }
  const headers = zenApiHeaders(model, { sessionId: 'ses_x' })
  assert.equal(headers['User-Agent'], userAgent)
  assert.equal(headers['HTTP-Referer'], undefined)
  assert.equal(headers['accept'], '*/*')
  assert.equal(headers['accept-encoding'], 'gzip, deflate, br, zstd')
  assert.equal(headers['x-opencode-client'], 'cli')
  assert.equal(headers['x-opencode-project'], 'global')
  assert.equal(headers['x-opencode-session'], opencodeSessionId('ses_x'))
  // Both session headers carry the same id; the correlation header is never
  // sent (the gate rejects x-opencode-request with 403 since 2026-10-14).
  assert.equal(headers['x-opencode-session-id'], headers['x-opencode-session'])
  assert.equal(headers['x-opencode-request'], undefined)
})
