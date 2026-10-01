import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ensureAgentTools, maybeEnsureAgentTools, prepareZenContext, transcriptToContext } from '../lib/index.js'

const CORE = ['bash', 'edit', 'glob', 'grep', 'read']

const userTool = (name) => ({
  name,
  description: `user ${name}`,
  parameters: { type: 'object', properties: { q: { type: 'string' } } },
})

test('empty tools get all five core agent tools', () => {
  const out = ensureAgentTools({ messages: [], tools: [] })
  assert.deepEqual(out.tools.map(t => t.name), CORE)
  for (const tool of out.tools) {
    assert.equal(tool.description, `Agent tool ${tool.name}`)
    assert.deepEqual(tool.parameters, { type: 'object', properties: {} })
  }
})

test('missing tools are appended, declared tools untouched', () => {
  const mine = userTool('bash')
  const custom = userTool('mytool')
  const out = ensureAgentTools({ messages: [], tools: [mine, custom] })
  assert.equal(out.tools[0], mine)
  assert.equal(out.tools[1], custom)
  assert.deepEqual(out.tools.map(t => t.name), ['bash', 'mytool', 'edit', 'glob', 'grep', 'read'])
  assert.deepEqual(mine.parameters, { type: 'object', properties: { q: { type: 'string' } } })
})

test('full house returns the context unchanged', () => {
  const context = { messages: [], tools: CORE.map(userTool) }
  assert.equal(ensureAgentTools(context), context)
})

test('undefined tools are treated as empty', () => {
  const out = ensureAgentTools({ messages: [] })
  assert.deepEqual(out.tools.map(t => t.name), CORE)
})

test('input context is not mutated', () => {
  const context = { messages: [], tools: [userTool('bash')] }
  ensureAgentTools(context)
  assert.equal(context.tools.length, 1)
})

test('maybeEnsureAgentTools shapes while anonymous (no key seen)', () => {
  const out = maybeEnsureAgentTools({ messages: [], tools: [] })
  assert.deepEqual(out.tools.map(t => t.name), CORE)
})

test('0.87 boundary: tools are restored from the transcript system message', () => {
  const read = userTool('read')
  const transcript = {
    messages: [
      { role: 'system', content: '', toolsAdded: [read], timestamp: 0 },
      { role: 'user', content: 'hi' },
    ],
  }
  const restored = transcriptToContext(transcript)
  assert.deepEqual(restored.tools.map(t => t.name), ['read'])
  // Declared tools are kept; only the missing core agent tools are appended.
  const shaped = maybeEnsureAgentTools(prepareZenContext(restored))
  assert.deepEqual(shaped.tools.map(t => t.name), ['read', 'bash', 'edit', 'glob', 'grep'])
  assert.equal(shaped.tools[0], read)
})

test('0.87 boundary: tool-less transcript still gets the five core agent tools', () => {
  const shaped = maybeEnsureAgentTools(prepareZenContext(transcriptToContext({ messages: [] })))
  assert.deepEqual(shaped.tools.map(t => t.name), CORE)
})
