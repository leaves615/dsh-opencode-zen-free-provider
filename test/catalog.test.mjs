
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../lib/index.js'

// Stub the upstream feeds so sync() populates a two-model catalog without
// network. Regression: the hand-built ResolvedPiAiProviderProfile used to
// omit modelErrors, so PiAiAdapter.modelOf() threw
// "Cannot read properties of undefined (reading 'get')" and the whole
// "OpenCode Zen Free" group failed to load in the host model catalog.
const zenModels = {
  data: [
    { id: 'deepseek-v4-flash-free', name: 'DeepSeek V4 Flash (free)' },
    { id: 'muse-spark-lite-free', name: 'Muse Spark Lite (free)' },
  ],
}
const modelsDev = {
  opencode: {
    models: {
      'deepseek-v4-flash-free': { name: 'DeepSeek V4 Flash (free)', status: 'active', limit: { context: 131072, output: 32768 } },
      'muse-spark-lite-free': { name: 'Muse Spark Lite (free)', status: 'active', limit: { context: 131072, output: 32768 } },
    },
  },
}
const realFetch = globalThis.fetch

function makeCtx() {
  const registered = { providers: [], adapter: null }
  return {
    get: () => undefined,
    inject: () => {},
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    llm: {
      registerConfigurableProviders: () => {},
      registerAdapter: (providers, adapter) => {
        registered.providers.push(...providers)
        registered.adapter = adapter
      },
    },
    _registered: registered,
  }
}

before(() => {
  globalThis.fetch = async (url) => {
    const u = String(url)
    const text = u.includes('jsdelivr.com')
      ? JSON.stringify({ version: '1.18.18' })
      : u.includes('/zen/v1/models')
        ? JSON.stringify(zenModels)
        : u.includes('models.dev')
          ? JSON.stringify(modelsDev)
          : '{}'
    return new Response(text, { status: 200, headers: { 'content-type': 'application/json' } })
  }
})
after(() => {
  globalThis.fetch = realFetch
})

test('provider profile carries modelErrors so the catalog can build', async () => {
  const ctx = makeCtx()
  await apply(ctx, {})
  // Let the background sync() settle before catalog reads.
  await new Promise((resolve) => setTimeout(resolve, 300))
  const provider = ctx._registered.providers[0]
  assert.ok(provider, 'adapter registered a provider route')

  // Replay the host catalog build (buildModelCatalog): listModels then
  // resolveModel for every advertised model must not throw.
  const models = await ctx._registered.adapter.listModels(provider)
  assert.ok(models.length > 0, 'catalog exposes free models')
  for (const model of models) {
    const info = await ctx._registered.adapter.resolveModel(provider, model.id)
    assert.equal(info.provider, provider)
    assert.equal(info.id, model.id)
  }
})
