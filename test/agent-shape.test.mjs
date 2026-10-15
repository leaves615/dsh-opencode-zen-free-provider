import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ensureAgentTools, maybeEnsureAgentTools, prepareZenContext, remapEventToolCalls, remapZenToolCall, transcriptToContext } from '../lib/index.js'
import { OFFICIAL_TOOL_DEFS } from '../lib/opencode-tools.js'

const CORE = ['shell', 'edit', 'glob', 'grep', 'read']

const userTool = (name) => ({
  name,
  description: `user ${name}`,
  parameters: { type: 'object', properties: { q: { type: 'string' } } },
})

test('empty tools get all five core agent tools with genuine definitions', () => {
  const out = ensureAgentTools({ messages: [], tools: [] })
  assert.deepEqual(out.tools.map(t => t.name), CORE)
  for (const tool of out.tools) {
    assert.equal(tool.description, OFFICIAL_TOOL_DEFS[tool.name].description)
    assert.deepEqual(tool.parameters, OFFICIAL_TOOL_DEFS[tool.name].parameters)
  }
})

test('missing tools are appended, declared tools untouched except recognised names', () => {
  const mine = userTool('read')
  const custom = userTool('mytool')
  const out = ensureAgentTools({ messages: [], tools: [mine, custom] })
  assert.deepEqual(out.tools.map(t => t.name), ['read', 'mytool', 'shell', 'edit', 'glob', 'grep'])
  // A recognised name ships the genuine definition so the gate passes.
  assert.notEqual(out.tools[0], mine)
  assert.equal(out.tools[0].name, 'read')
  assert.equal(out.tools[0].description, OFFICIAL_TOOL_DEFS.read.description)
  // Unknown names travel exactly as declared.
  assert.equal(out.tools[1], custom)
  assert.deepEqual(mine.parameters, { type: 'object', properties: { q: { type: 'string' } } })
})

test('a declared bash carries the shell definition on the wire', () => {
  const out = ensureAgentTools({ messages: [], tools: [userTool('bash')] })
  const bash = out.tools.find(t => t.name === 'bash')
  assert.equal(bash.description, OFFICIAL_TOOL_DEFS.shell.description)
  assert.deepEqual(bash.parameters, OFFICIAL_TOOL_DEFS.shell.parameters)
})

test('full house with genuine definitions returns the context unchanged', () => {
  const genuine = (name) => ({ name, description: OFFICIAL_TOOL_DEFS[name].description, parameters: OFFICIAL_TOOL_DEFS[name].parameters })
  const context = { messages: [], tools: [...CORE.map(genuine), userTool('mytool')] }
  assert.equal(ensureAgentTools(context), context)
})

test('undefined tools are treated as empty', () => {
  const out = ensureAgentTools({ messages: [] })
  assert.deepEqual(out.tools.map(t => t.name), CORE)
})

test('input context is not mutated', () => {
  const context = { messages: [], tools: [userTool('read')] }
  ensureAgentTools(context)
  assert.equal(context.tools.length, 1)
  assert.equal(context.tools[0].description, 'user read')
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
  assert.deepEqual(shaped.tools.map(t => t.name), ['read', 'shell', 'edit', 'glob', 'grep'])
  assert.notEqual(shaped.tools[0], read)
})

test('0.87 boundary: tool-less transcript still gets the five core agent tools', () => {
  const shaped = maybeEnsureAgentTools(prepareZenContext(transcriptToContext({ messages: [] })))
  assert.deepEqual(shaped.tools.map(t => t.name), CORE)
})

test('remapZenToolCall translates official args back to harness args', () => {
  assert.deepEqual(
    remapZenToolCall('edit', { path: 'a.ts', oldString: 'x', newString: 'y', replaceAll: true }),
    { name: 'edit', args: { file_path: 'a.ts', old_string: 'x', new_string: 'y', replace_all: true } },
  )
  assert.deepEqual(
    remapZenToolCall('read', { path: 'a.ts', offset: 3 }),
    { name: 'read', args: { file_path: 'a.ts', offset: 3 } },
  )
  assert.deepEqual(
    remapZenToolCall('write', { path: 'a.ts', content: 'hi' }),
    { name: 'write', args: { file_path: 'a.ts', content: 'hi' } },
  )
  assert.deepEqual(
    remapZenToolCall('skill', { id: 's1' }),
    { name: 'skill', args: { id: 's1', name: 's1' } },
  )
  // glob/grep are schema-compatible: untouched.
  const globArgs = { pattern: '**/*.ts', path: 'src' }
  assert.deepEqual(remapZenToolCall('glob', globArgs), { name: 'glob', args: globArgs })
  // Unknown names are untouched.
  assert.deepEqual(remapZenToolCall('mytool', { q: 1 }), { name: 'mytool', args: { q: 1 } })
  // Non-object args pass through.
  assert.deepEqual(remapZenToolCall('read', 'oops'), { name: 'read', args: 'oops' })
})

test('remapZenToolCall routes shell through bash and synthesises its description', () => {
  const out = remapZenToolCall('shell', { command: 'ls -la', workdir: '/tmp' })
  assert.equal(out.name, 'bash')
  assert.equal(out.args.command, 'ls -la')
  assert.equal(out.args.workdir, '/tmp')
  assert.match(out.args.description, /^Run shell command: ls -la/)
  const mapped = remapZenToolCall('bash', { command: 'pwd', timeout: 5000, background: true })
  assert.deepEqual(mapped, {
    name: 'bash',
    args: { command: 'pwd', description: 'Run shell command: pwd', timeoutMs: 5000, run_in_background: true },
  })
})

test('remapEventToolCalls rewrites toolcall_end and done message blocks', () => {
  const endEvent = {
    type: 'toolcall_end',
    contentIndex: 0,
    toolCall: { type: 'toolCall', id: 'call_1', name: 'edit', arguments: { path: 'a.ts', oldString: 'x', newString: 'y' } },
    partial: {},
  }
  remapEventToolCalls(endEvent)
  assert.deepEqual(endEvent.toolCall.arguments, { file_path: 'a.ts', old_string: 'x', new_string: 'y' })
  const doneEvent = {
    type: 'done',
    reason: 'toolUse',
    message: {
      role: 'assistant',
      content: [
        { type: 'toolCall', id: 'call_1', name: 'edit', arguments: { path: 'a.ts', oldString: 'x', newString: 'y' } },
        { type: 'toolCall', id: 'call_2', name: 'shell', arguments: { command: 'ls' } },
        { type: 'text', text: 'hi' },
      ],
    },
  }
  remapEventToolCalls(doneEvent)
  assert.deepEqual(doneEvent.message.content[0].arguments, { file_path: 'a.ts', old_string: 'x', new_string: 'y' })
  assert.equal(doneEvent.message.content[1].name, 'bash')
  assert.match(doneEvent.message.content[1].arguments.description, /^Run shell command: ls/)
  assert.equal(doneEvent.message.content[2].text, 'hi')
  // Non-tool events pass through untouched.
  const other = { type: 'text_start', contentIndex: 0 }
  remapEventToolCalls(other)
  assert.deepEqual(other, { type: 'text_start', contentIndex: 0 })
})

test('remapZenToolCall is idempotent across toolcall_end and done replays', () => {
  const once = remapZenToolCall('edit', { path: 'a.ts', oldString: 'x', newString: 'y' })
  const twice = remapZenToolCall(once.name, once.args)
  assert.deepEqual(twice, once)
  const shellOnce = remapZenToolCall('shell', { command: 'ls' })
  const shellTwice = remapZenToolCall(shellOnce.name, shellOnce.args)
  assert.deepEqual(shellTwice, shellOnce)
})
