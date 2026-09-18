import { test } from 'node:test'
import assert from 'node:assert/strict'
import { opencodeRequestId, opencodeSessionId, opencodeUserAgentFor, zenApiHeaders } from '../lib/index.js'

// opencode CLI id shape: `ses_`/`msg_` + 12 lowercase hex + 14 base62 chars.
const ID_SHAPE = /^(ses|msg)_[0-9a-f]{12}[0-9A-Za-z]{14}$/

test('User-Agent reproduces the opencode CLI fingerprint', () => {
  assert.equal(
    opencodeUserAgentFor('1.18.31'),
    'opencode/1.18.31 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14',
  )
})

test('msg_ ids follow the opencode shape and are fresh per call', () => {
  const ids = new Set()
  for (let i = 0; i < 200; i += 1) ids.add(opencodeRequestId())
  assert.equal(ids.size, 200)
  for (const id of ids) assert.match(id, ID_SHAPE)
})

test('ses_ id is a pure mapping of the dsh session id (no cache, no eviction)', () => {
  assert.equal(opencodeSessionId('ses_a'), opencodeSessionId('ses_a'))
  assert.match(opencodeSessionId('ses_a'), ID_SHAPE)
  assert.notEqual(opencodeSessionId('ses_a'), opencodeSessionId('ses_b'))
  // A mapping cannot be evicted: many other sessions must not change this one.
  const first = opencodeSessionId('ses_first')
  for (let i = 0; i < 2000; i += 1) opencodeSessionId(`ses_filler_${i}`)
  assert.equal(opencodeSessionId('ses_first'), first)
})

test('zenApiHeaders carries the full opencode request fingerprint', () => {
  const userAgent = opencodeUserAgentFor('1.18.31')
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
  assert.match(headers['x-opencode-request'], ID_SHAPE)
  assert.notEqual(headers['x-opencode-request'], opencodeRequestId())
})
