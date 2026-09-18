import { test } from 'node:test'
import assert from 'node:assert/strict'
import { stripReasoningEncryptedContent, withStrippedResponsesInclude } from '../lib/index.js'

const reasoningItem = JSON.stringify({
  type: 'reasoning',
  id: 'rs_123',
  encrypted_content: 'cipher-bytes',
  summary: [{ type: 'summary_text', text: 'thinking...' }],
})
const completionsDetails = JSON.stringify([
  { type: 'reasoning.encrypted', id: 'd1', data: 'opaque' },
  { type: 'reasoning.text', id: 'd2', text: 'plain thought' },
])

function assistantMessage(content) {
  return { role: 'assistant', content }
}

test('G2: Responses reasoning items are dropped, siblings kept', () => {
  const context = {
    messages: [
      { role: 'user', content: 'hi' },
      assistantMessage([
        { type: 'thinking', thinking: 'hmm', thinkingSignature: reasoningItem },
        { type: 'text', text: 'hello' },
        { type: 'toolCall', id: 'c1|fc_1', name: 'read', arguments: {} },
      ]),
    ],
  }
  const stripped = stripReasoningEncryptedContent(context)
  assert.equal(stripped.messages[0].content, 'hi')
  const kept = stripped.messages[1].content
  assert.equal(kept.length, 2)
  assert.equal(kept[0].type, 'text')
  assert.equal(kept[1].type, 'toolCall')
  assert.ok(!JSON.stringify(stripped).includes('cipher-bytes'), 'no ciphertext survives')
})

test('plain reasoning_content markers and garbage signatures are kept', () => {
  const context = {
    messages: [
      assistantMessage([
        { type: 'thinking', thinking: 'replayed', thinkingSignature: 'reasoning_content' },
        { type: 'thinking', thinking: 'odd', thinkingSignature: 'not-json{{{ ' },
      ]),
    ],
  }
  const stripped = stripReasoningEncryptedContent(context)
  assert.equal(stripped.messages[0].content.length, 2)
  assert.equal(stripped.messages[0].content[0].thinkingSignature, 'reasoning_content')
})

test('Completions signatures keep text, drop only the opaque signature', () => {
  const thoughtSignature = JSON.stringify({ type: 'reasoning.encrypted', id: 'x', data: 'yyy' })
  const context = {
    messages: [
      assistantMessage([
        { type: 'thinking', thinking: 'plain thought', thinkingSignature: completionsDetails },
        { type: 'toolCall', id: 'c1|fc_1', name: 'read', arguments: {}, thoughtSignature },
      ]),
    ],
  }
  const stripped = stripReasoningEncryptedContent(context)
  const kept = stripped.messages[0].content
  assert.equal(kept.length, 2)
  assert.equal(kept[0].thinking, 'plain thought')
  assert.equal(kept[0].thinkingSignature, undefined)
  assert.equal(kept[1].name, 'read')
  assert.equal(kept[1].thoughtSignature, undefined)
  assert.ok(!JSON.stringify(stripped).includes('opaque'), 'no opaque payload survives')
})

test('strip does not mutate the input context', () => {
  const thinking = { type: 'thinking', thinking: 'hmm', thinkingSignature: reasoningItem }
  const context = { messages: [assistantMessage([thinking])] }
  stripReasoningEncryptedContent(context)
  assert.equal(thinking.thinkingSignature, reasoningItem)
  assert.equal(context.messages[0].content.length, 1)
})

test('withStrippedResponsesInclude removes the ciphertext request', async () => {
  const wrapped = withStrippedResponsesInclude({})
  const params = { model: 'muse-spark', include: ['reasoning.encrypted_content', 'other'] }
  const kept = await wrapped.onPayload(params, {})
  assert.equal(kept, undefined)
  assert.deepEqual(params.include, ['other'])

  const empty = { model: 'muse-spark', include: ['reasoning.encrypted_content'] }
  await wrapped.onPayload(empty, {})
  assert.ok(!('include' in empty), 'empty include is deleted, not left as []')

  const plain = { model: 'muse-spark' }
  await wrapped.onPayload(plain, {})
  assert.ok(!('include' in plain))
})

test('withStrippedResponsesInclude preserves an inner onPayload', async () => {
  let called = 0
  const wrapped = withStrippedResponsesInclude({
    onPayload: async (params) => {
      called += 1
      return { ...params, include: [...params.include, 'reasoning.encrypted_content'] }
    },
  })
  const out = await wrapped.onPayload({ include: ['other'] }, {})
  assert.equal(called, 1)
  assert.deepEqual(out.include, ['other'])
})
test('switch off: prepare keeps ciphertext, include untouched', async () => {
  const { prepareZenContext, maybeStripResponsesInclude, Config } = await import('../lib/index.js')
  // Schema default keeps stripping on when the key is omitted.
  assert.equal(Config({}).stripReasoningEncryptedContent, true)

  const context = {
    messages: [{ role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm', thinkingSignature: reasoningItem }] }],
  }
  const kept = prepareZenContext(context, false)
  assert.equal(kept.messages[0].content.length, 1)
  assert.equal(kept.messages[0].content[0].thinkingSignature, reasoningItem)

  const stripped = prepareZenContext(context, true)
  assert.equal(stripped.messages[0].content.length, 0)

  const options = { onPayload: async () => {} }
  assert.equal(maybeStripResponsesInclude(options, false), options)
  assert.notEqual(maybeStripResponsesInclude(options, true), options)
})

test('switch follows settings off/on through apply', async () => {
  const { apply, prepareZenContext } = await import('../lib/index.js')
  let hooks
  const settingsCtx = { settings: { installSection: (ctx, ns, schema, cfg, h) => { hooks = h } } }
  const ctx = { get: () => undefined, inject: (deps, fn) => fn(settingsCtx), logger: { info: () => {}, warn: () => {} }, llm: { registerConfigurableProviders: () => {}, registerAdapter: () => {} } }
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({ version: '9.9.9' }), { status: 200 })
  try {
    await apply(ctx, {})
    let current = {}
    hooks.setSource(() => current)
    hooks.onChange()
    const context = {
      messages: [{ role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm', thinkingSignature: reasoningItem }] }],
    }
    // Default (missing key) strips: module switch synced to true.
    assert.equal(prepareZenContext(context).messages[0].content.length, 0)
    current = { stripReasoningEncryptedContent: false }
    hooks.onChange()
    assert.equal(prepareZenContext(context).messages[0].content.length, 1)
    current = { stripReasoningEncryptedContent: true }
    hooks.onChange()
    assert.equal(prepareZenContext(context).messages[0].content.length, 0)
  } finally {
    globalThis.fetch = realFetch
    // Leave the module switch on for other tests (import order independent).
    hooks.setSource(() => ({}))
    hooks.onChange()
  }
})

