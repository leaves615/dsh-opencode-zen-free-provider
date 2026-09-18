import type { Context } from '@deepseek-ai/cordis'
import { assertUsableApiKey, errorChain, resolveRetryPolicy, RetryPolicySchema } from '@deepseek-ai/dsh-llm'
import type { RetryPolicyConfig } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter, type ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { deepEqualJson } from '@deepseek-ai/dsh-util-values'
import type {} from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import { createHash, randomBytes } from 'node:crypto'
import { createProvider, type AuthContext, type Context as PiContext, type CredentialStore, type Model, type SimpleStreamOptions, type ThinkingLevelMap, type ProviderStreams, type Tool, type TSchema } from '@earendil-works/pi-ai'
import { getBuiltinModels } from '@earendil-works/pi-ai/providers/all'
// Cloned (and minimized) from @earendil-works/pi-ai's openai-completions module.
// See src/openai-completions.ts for the source URL + the only change (zenFetch).
// The cloned copy re-declares AssistantMessageEventStream as a separate class
// identity, so its stream functions are cast back to the package's types here.
// Runtime behavior is identical; only the (private) class identity differs.
import { stream as _piAgentStream, streamSimple as _piAgentStreamSimple, installZenUserAgent } from './openai-completions.js'
import { stream as _piResponsesStream, streamSimple as _piResponsesStreamSimple, installZenUserAgent as installZenUserAgentResponses } from './openai-responses.js'
const piAgentStream = _piAgentStream as unknown as ProviderStreams['stream']
const piAgentStreamSimple = _piAgentStreamSimple as unknown as ProviderStreams['streamSimple']
const piResponsesStream = _piResponsesStream as unknown as ProviderStreams['stream']
const piResponsesStreamSimple = _piResponsesStreamSimple as unknown as ProviderStreams['streamSimple']

export const name = 'opencode-zen-free-provider'
export const inject = ['llm']

const PROVIDER = name
const DISPLAY_NAME = 'OpenCode Zen Free'
const NS = 'opencode-zen-free-provider'
/** Latest CLI version, read off unpkg's `@latest` redirect via the package's own `package.json`. */
const OPENCODE_VERSION_URL = 'https://unpkg.com/opencode-ai@latest/package.json'
const OPENCODE_VERSION_FALLBACK = '1.18.18'
// Remaining tokens of the opencode CLI User-Agent fingerprint. Deliberately
// spoofed: dsh runs on Node, but the Zen free-tier gate expects the Bun/AI SDK
// identity opencode ships. Bump alongside the resolved CLI version.
// Verified against opencode 1.18.31 binary: provider-utils is 4.0.23, bun 1.3.14.
const OPENCODE_AI_SDK_PROVIDER_UTILS_VERSION = '4.0.23'
const OPENCODE_BUN_VERSION = '1.3.14'

export const opencodeUserAgentFor = (version: string): string =>
  `opencode/${version} ai-sdk/provider-utils/${OPENCODE_AI_SDK_PROVIDER_UTILS_VERSION} runtime/bun/${OPENCODE_BUN_VERSION}`

/** Envelope types that must stay AUTH-classified instead of being rewritten. */
const AUTH_ERROR_TYPES = new Set(['AuthError', 'authentication_error', 'invalid_api_key', 'unauthorized'])

export interface Config {
  /** Provider-owned model-request retry policy; omission uses normal defaults. */
  retryPolicy?: RetryPolicyConfig
  /** Strip replayed reasoning.encrypted_content before requests hit the Zen gateway. */
  stripReasoningEncryptedContent?: boolean
}

export const Config: z<Config> = z.object({
  retryPolicy: RetryPolicySchema,
  stripReasoningEncryptedContent: z.boolean().default(true),
})

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const resolveOpenCodeVersion = async (): Promise<string> => {
  try {
    const payload = await fetchJson(OPENCODE_VERSION_URL, { accept: 'application/json' })
    return typeof payload.version === 'string' && payload.version.length > 0 ? payload.version : OPENCODE_VERSION_FALLBACK
  } catch {
    return OPENCODE_VERSION_FALLBACK
  }
}

const OPENCODE_ID_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

// `msg_`: opencode CLI's own request-id generator — the low 48 bits of
// `Date.now() << 12 | counter` as six big-endian bytes, then 14 random base62
// chars. Generated fresh per request; the counter disambiguates ids minted in
// the same millisecond.
let opencodeLastTimestamp = 0
let opencodeTimestampCounter = 0
export const opencodeRequestId = (): string => {
  const timestamp = Date.now()
  opencodeTimestampCounter = timestamp === opencodeLastTimestamp ? opencodeTimestampCounter + 1 : 1
  opencodeLastTimestamp = timestamp
  const value = BigInt(timestamp) * 0x1000n + BigInt(opencodeTimestampCounter)
  let time = ''
  for (let index = 0; index < 6; index += 1) {
    time += Number((value >> BigInt(40 - 8 * index)) & 0xffn).toString(16).padStart(2, '0')
  }
  const random = [...randomBytes(14)].map(byte => OPENCODE_ID_ALPHABET[byte % 62]).join('')
  return `msg_${time}${random}`
}

// `ses_`: a pure mapping from the dsh session id, so the same dsh session keeps
// the same opencode session id forever without any cache (a cache could evict
// and silently re-mint it). Only the shape matches opencode
// (`ses_` + 12 hex + 14 base62); the 12 hex is digest material, not a clock,
// because the gateway does not validate that half as a timestamp.
export const opencodeSessionId = (sessionId: string): string => {
  const digest = createHash('sha256').update(`dsh-opencode-ses\0${sessionId}`).digest()
  const time = digest.toString('hex').slice(0, 12)
  const random = [...digest.subarray(6, 20)].map(byte => OPENCODE_ID_ALPHABET[byte % 62]).join('')
  return `ses_${time}${random}`
}

export const zenApiHeaders = (model: Pick<Model<ZenApi>, 'headers'>, options: SimpleStreamOptions) => {
  const sessionId = options.sessionId ?? 'dsh-session-unknown'
  // Match real opencode CLI headers exactly (captured from 1.18.31 binary):
  // - no HTTP-Referer (actively stripped: model defs may still carry one)
  // - accept: */*
  // - accept-encoding: gzip, deflate, br, zstd
  // - x-opencode-* headers
  const { 'HTTP-Referer': _droppedReferer, ...modelHeaders } = model.headers ?? {}
  void _droppedReferer
  return {
    ...modelHeaders,
    accept: '*/*',
    'accept-encoding': 'gzip, deflate, br, zstd',
    'x-opencode-project': 'global',
    'x-opencode-session': opencodeSessionId(sessionId),
    'x-opencode-request': opencodeRequestId(),
    'x-opencode-client': 'cli',
  }
}

// Zen rejects replayed reasoning.encrypted_content: stale or foreign ciphertext
// fails pairing validation at the gateway, so history must go out clean (G2:
// drop the whole reasoning item, keep the visible text + tool calls). Never
// gated on model.reasoning: replay happens regardless of effort control,
// and a Responses-history thinking block replayed into a Completions model
// would otherwise land as a garbage assistantMsg[json] field.
const isJsonSignature = (signature: unknown): boolean => {
  if (typeof signature !== 'string') return false
  const trimmed = signature.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return false
  try { JSON.parse(trimmed); return true } catch { return false }
}

const isResponsesReasoningItem = (signature: unknown): boolean => {
  if (typeof signature !== 'string') return false
  const trimmed = signature.trim()
  if (!trimmed.startsWith('{')) return false
  let parsed: unknown
  try { parsed = JSON.parse(trimmed) } catch { return false }
  return isRecord(parsed) && (parsed.type === 'reasoning' || 'encrypted_content' in parsed)
}

export const stripReasoningEncryptedContent = (context: PiContext): PiContext => ({
  ...context,
  messages: context.messages.map((message) => {
    if (message.role !== 'assistant') return message
    const content = message.content.flatMap((block) => {
      // Responses reasoning items (thinkingSignature = serialized reasoning
      // item incl. encrypted_content): drop the whole block, keep siblings.
      if (block.type === 'thinking' && isJsonSignature(block.thinkingSignature)) {
        if (isResponsesReasoningItem(block.thinkingSignature)) return []
        // Completions reasoning_details (JSON array / encrypted detail): keep
        // the visible thinking text, drop only the opaque signature so the
        // transport falls back to plain content (+ the reasoning_content
        // marker applied below) instead of a garbage field name.
        const next = { ...block }
        delete next.thinkingSignature
        return [next]
      }
      // Completions tool-call thought signatures replay as reasoning_details.
      if (block.type === 'toolCall' && typeof (block as { thoughtSignature?: unknown }).thoughtSignature === 'string') {
        const next = { ...(block as unknown as Record<string, unknown>) }
        delete next.thoughtSignature
        return [next as unknown as typeof block]
      }
      return [block]
    })
    return { ...message, content }
  }),
})

// The cloned Responses transport sets params.include =
// [reasoning.encrypted_content] whenever reasoning is requested; that asks Zen
// to mint fresh ciphertext. Scrub it post-merge (buildParams already folded
// samplingParams in by the time onPayload runs, so this one hook covers both)
// while preserving a caller-provided onPayload.
const REASONING_ENCRYPTED_INCLUDE = 'reasoning.encrypted_content'

export const withStrippedResponsesInclude = (options: SimpleStreamOptions): SimpleStreamOptions => {
  const inner = options.onPayload
  const scrub = (params: unknown): void => {
    if (!isRecord(params) || !Array.isArray(params.include)) return
    const kept = (params.include as unknown[]).filter((value) => value !== REASONING_ENCRYPTED_INCLUDE)
    if (kept.length === (params.include as unknown[]).length) return
    if (kept.length === 0) delete params.include
    else params.include = kept
  }
  return {
    ...options,
    onPayload: async (params, model) => {
      if (inner === undefined) {
        scrub(params)
        return undefined
      }
      const replaced = await inner(params, model)
      if (replaced === undefined) {
        scrub(params)
        return undefined
      }
      scrub(replaced)
      return replaced
    },
  }
}

// Live switch for the strip (module-level so the per-request stream closures
// below always see current settings; synced from Config in apply()).
let stripEncryptedContentEnabled = true

// Strip first, then mark: kept thinking blocks with a cleared signature get
// the reasoning_content marker below via the undefined-signature path.
export const prepareZenContext = (context: PiContext, enabled: boolean = stripEncryptedContentEnabled): PiContext =>
  enabled ? normalizeReasoningContext(stripReasoningEncryptedContent(context)) : normalizeReasoningContext(context)

export const maybeStripResponsesInclude = (options: SimpleStreamOptions, enabled: boolean = stripEncryptedContentEnabled): SimpleStreamOptions =>
  enabled ? withStrippedResponsesInclude(options) : options

// The anonymous free tier only serves agent-shaped streaming requests: the
// cloned transports always send `stream: true`, but the core agent tools must
// also be present — anything else is rejected with 403 FreeTierError. Mirror
// opencode2api: synthesize minimal defs for whichever core tools the caller
// did not declare; declared tools are left untouched. Key-tier requests keep
// their original bodies (gated by userKeyPresent below).
const ANONYMOUS_CORE_TOOLS = ['bash', 'edit', 'glob', 'grep', 'read'] as const

const agentToolFor = (name: string): Tool => ({
  name,
  description: `Agent tool ${name}`,
  parameters: { type: 'object', properties: {} } as unknown as TSchema,
})

export const ensureAgentTools = (context: PiContext): PiContext => {
  const present = new Set((context.tools ?? []).map(tool => tool.name))
  const missing = ANONYMOUS_CORE_TOOLS.filter(name => !present.has(name))
  if (missing.length === 0) return context
  return { ...context, tools: [...(context.tools ?? []), ...missing.map(agentToolFor)] }
}

// Latched by resolveApiKey once a real user credential resolves: from then on
// this mount serves the key tier, which must keep original bodies.
let userKeyPresent = false

export const maybeEnsureAgentTools = (context: PiContext): PiContext =>
  userKeyPresent ? context : ensureAgentTools(context)

// Replayed thinking blocks carry no wire signature; marking them
// `reasoning_content` keeps the transport from mangling history. Never gated on
// `model.reasoning`: a model with no effort control still streams thinking.
const normalizeReasoningContext = (context: PiContext): PiContext => ({
  ...context,
  messages: context.messages.map(message => message.role !== 'assistant' ? message : {
    ...message,
    content: message.content.map(block =>
      block.type === 'thinking' && block.thinking.trim().length > 0 && block.thinkingSignature === undefined
        ? { ...block, thinkingSignature: 'reasoning_content' }
        : block),
  }),
})

// Zen reports non-credential refusals (ended free promotions, region blocks) as
// HTTP 401/403, which the harness classifies as AUTH and masks as "API key is
// invalid". Rewriting the envelope (e.g. `401: {"type":"ModelError",…}`) to
// `[opencode-zen <type>] <message>` gets the real reason past that
// classification; genuine auth envelopes and unparseable text pass through.
const rewriteRefusalMessage = (errorMessage: string): string => {
  const start = errorMessage.indexOf('{')
  const end = errorMessage.lastIndexOf('}')
  if (start < 0 || end <= start) return errorMessage
  let parsed: unknown
  try { parsed = JSON.parse(errorMessage.slice(start, end + 1)) } catch { return errorMessage }
  if (!isRecord(parsed)) return errorMessage
  // Accept both the raw envelope (`{"type":"error","error":{…}}`) and the
  // SDK-unwrapped inner object (`{"type":"ModelError","message":"…"}`).
  const detail = parsed.type === 'error' && isRecord(parsed.error) ? parsed.error : parsed
  const message = [detail.message, isRecord(detail.error) ? detail.error.message : undefined, detail.detail]
    .find((value): value is string => typeof value === 'string')
  if (message === undefined) return errorMessage
  const type = typeof detail.type === 'string' ? detail.type : 'Error'
  const code = typeof detail.code === 'string' ? detail.code : ''
  if (AUTH_ERROR_TYPES.has(type) || AUTH_ERROR_TYPES.has(code)) return errorMessage
  // Dropping the status prefix is what defeats the AUTH classifier.
  return `[opencode-zen ${type}] ${message}`
}

// Required by the adapter, unused by this route: the credential comes from
// `resolveApiKey`, so pi-ai never stores one nor asks an ambient question.
const PI_AUTH: { credentials: CredentialStore, authContext: AuthContext } = {
  credentials: {
    read: async () => undefined,
    list: async () => [],
    modify: async (_providerId, mutate) => mutate(undefined),
    delete: async () => {},
  },
  authContext: { env: async () => undefined, fileExists: async () => false },
}

const sanitizeStream = <S extends { push(event: unknown): void }>(stream: S): S => {
  const originalPush = stream.push.bind(stream)
  stream.push = (event: unknown) => {
    if (isRecord(event) && event.type === 'error' && isRecord(event.error) && typeof event.error.errorMessage === 'string') {
      event.error.errorMessage = rewriteRefusalMessage(event.error.errorMessage)
    }
    originalPush(event)
  }
  return stream
}

type ZenApi = 'openai-completions' | 'openai-responses'

const zenStreamFor = (api: ZenApi): ProviderStreams => api === 'openai-responses'
  ? {
    stream: (model: Model<'openai-responses'>, context: PiContext, options: SimpleStreamOptions) =>
      sanitizeStream(piResponsesStream({ ...model, headers: zenApiHeaders(model, options) }, maybeEnsureAgentTools(prepareZenContext(context)), maybeStripResponsesInclude(options))),
    streamSimple: (model: Model<'openai-responses'>, context: PiContext, options: SimpleStreamOptions) =>
      sanitizeStream(piResponsesStreamSimple({ ...model, headers: zenApiHeaders(model, options) }, maybeEnsureAgentTools(prepareZenContext(context)), maybeStripResponsesInclude(options))),
  } as unknown as ProviderStreams
  : {
    stream: (model: Model<'openai-completions'>, context: PiContext, options: SimpleStreamOptions) =>
      sanitizeStream(piAgentStream({ ...model, headers: zenApiHeaders(model, options) }, maybeEnsureAgentTools(prepareZenContext(context)), options)),
    streamSimple: (model: Model<'openai-completions'>, context: PiContext, options: SimpleStreamOptions) =>
      sanitizeStream(piAgentStreamSimple({ ...model, headers: zenApiHeaders(model, options) }, maybeEnsureAgentTools(prepareZenContext(context)), options)),
  }

const zenApi: Partial<Record<ZenApi, ProviderStreams>> = {
  'openai-completions': zenStreamFor('openai-completions'),
  'openai-responses': zenStreamFor('openai-responses'),
}

async function fetchJson(url: string, headers: Record<string, string>) {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) })
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`)
  const payload: unknown = await response.json()
  if (!isRecord(payload)) throw new Error(`${url}: unexpected response shape`)
  return payload
}

/** pi-ai's standard ladder keys (off = explicit close; the rest are depths). */
const PI_LEVEL_KEYS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

// Only an `effort`-type option's values shape the selector. A `toggle`, an empty
// list or a missing entry declares no level — an honest "takes no effort".
function reasoningLevelsFor(metadata: Record<string, unknown>): string[] {
  const option = (Array.isArray(metadata.reasoning_options) ? metadata.reasoning_options : [])
    .find(value => isRecord(value) && value.type === 'effort')
  return isRecord(option) && Array.isArray(option.values)
    ? option.values.filter((value): value is string => typeof value === 'string')
    : []
}

// `Default` (the harness's "no selection" path) is the *absent key* — leaving
// `reasoning_effort` off the wire and letting the upstream choose. Each ladder
// level the endpoint accepts lands at its own key with its own wire value; the
// `off` key carries the upstream's literal close value when the feed names one
// (e.g. `none`), so the selector's "Off" entry is a real switch rather than a
// `no-op. Responses-model feeds name no close value and `/responses` rejects
// both fabricated ones (`'off'` is an unknown variant, `'none'` unsupported
// for this model). pi-ai sends nothing only when the key is explicitly `null`
// (an absent key falls back to sending `'none'`), so `off: null` is the honest
// "upstream decides" — it also drops "Off" from the selector, which is correct
// because this endpoint offers no way to turn thinking down.
function reasoningMapFor(levels: readonly string[], api: ZenApi): ThinkingLevelMap {
  const map: ThinkingLevelMap = {}
  for (const key of PI_LEVEL_KEYS) {
    if (levels.includes(key)) map[key] = key
  }
  if (api === 'openai-completions') {
    map.off = levels.includes('none') ? 'none' : 'off'
  } else {
    map.off = null
  }
  return map
}

// Turn the live-scanned feeds into pi-ai model descriptors.
function buildModels(
  zenData: readonly unknown[],
  modelsById: Record<string, unknown>,
  userAgent: string,
): Model<ZenApi>[] {
  const baseModels = getBuiltinModels('opencode')
  return zenData
    .filter((entry): entry is Record<string, unknown> =>
      isRecord(entry) && typeof entry.id === 'string' && entry.id.endsWith('-free'))
    .flatMap((entry): Model<ZenApi>[] => {
      const id = entry.id as string
      const metadata = modelsById[id]
      if (!isRecord(metadata)) return []
      if (typeof metadata.status === 'string' && metadata.status === 'deprecated') return []
      // Zen serves muse-spark contributor-free models on the Responses
      // endpoint (`/zen/v1/responses`); chat/completions 500s for them.
      const api: ZenApi = id.includes('muse-spark') ? 'openai-responses' : 'openai-completions'
      const baseCompat = baseModels.find(base => base.id === id)?.compat
      // Models not yet in the pi-ai built-in catalogue still need the Zen-
      // specific maxTokensField ("max_tokens") so the proxy does not reject
      // the request with a 500 when "max_completion_tokens" arrives.
      const compat = baseCompat === undefined
        ? { maxTokensField: 'max_tokens' as const, supportsReasoningEffort: false as const }
        : { ...baseCompat, requiresReasoningContentOnAssistantMessages: false }

      // No ladder upstream ⇒ no selector: `reasoning: false` means "no effort
      // control", never "no thinking".
      const levels = reasoningLevelsFor(metadata)
      const controllable = levels.length > 0

      const limit = isRecord(metadata.limit) ? metadata.limit : undefined
      const input = isRecord(metadata.modalities) && Array.isArray(metadata.modalities.input)
        ? metadata.modalities.input.filter((value): value is 'text' | 'image' => value === 'text' || value === 'image')
        : []
      return [{
        id,
        name: typeof metadata.name === 'string' ? metadata.name : id,
        api,
        provider: PROVIDER,
        baseUrl: 'https://opencode.ai/zen/v1',
        headers: { 'User-Agent': userAgent },
        reasoning: controllable,
        ...(controllable ? { thinkingLevelMap: reasoningMapFor(levels, api) } : {}),
        input: input.length > 0 ? input : ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: id === 'mimo-v2.5-free' ? 1_048_576
          : typeof limit?.context === 'number' ? limit.context : 1_048_576,
        maxTokens: typeof limit?.output === 'number' ? limit.output : 32_768,
        ...(compat ? { compat } : {}),
      }]
    })
}

export async function apply(ctx: Context, config: Config): Promise<void> {
  // One-time: the Zen user-agent the cloned transports force on every request.
  const opencodeVersion = await resolveOpenCodeVersion()
  const opencodeUserAgent = opencodeUserAgentFor(opencodeVersion)
  installZenUserAgent(opencodeUserAgent)
  installZenUserAgentResponses(opencodeUserAgent)

  // Sync the module-level strip switch with settings. Default true so a
  // missing key (e.g. an old settings snapshot) keeps stripping on.
  const syncStripSwitch = (cfg: Config): void => {
    stripEncryptedContentEnabled = cfg.stripReasoningEncryptedContent ?? true
  }
  syncStripSwitch(config)

  let current: () => Config = () => config
  // Outside the settings-backed config, so a settings snapshot cannot clobber a
  // scan.
  let scanned: Model<ZenApi>[] = []

  const buildProfiles = (): ReadonlyMap<string, ResolvedPiAiProviderProfile> => {
    const opts = current()
    const piProvider = createProvider<ZenApi>({
      id: PROVIDER,
      name: 'OpenCodeZenFree',
      baseUrl: 'https://opencode.ai/zen/v1',
      auth: { apiKey: { name: 'OpenCodeZenFree', resolve: ({ credential }) => Promise.resolve({
        auth: credential?.key === undefined ? {} : { apiKey: credential.key },
        source: 'OpenCodeZenFree',
      }) } },
      models: scanned,
      api: zenApi,
    })
    const profiles = new Map<string, ResolvedPiAiProviderProfile>([[PROVIDER, {
      provider: PROVIDER,
      displayName: DISPLAY_NAME,
      apiKeyEnv: credentialRef('OPENCODE_ZEN_FREE_API_KEY'),
      streamIdleTimeoutMs: 300_000,
      maxRequestImageBytes: 20_971_520,
      requestImagePixelBudget: 4_194_304,
      requestImageMaxBytes: 1_048_576,
      retryPolicy: resolveRetryPolicy(opts.retryPolicy, `${name}: retryPolicy`),
      piProvider,
      modelErrors: new Map(),
      configuredMaxTokens: new Map(),
    }]])
    return profiles
  }

  // PiAiAdapter memoizes its snapshot on this Map's identity, so a fresh Map per
  // request would rebuild the whole pi-ai collection: rebuild only on change.
  let profiles = buildProfiles()

  const adapter = new PiAiAdapter({
    resolveAttachments: () => ctx.get('attachments'),
    profiles: () => profiles,
    auth: PI_AUTH,
    resolveApiKey: async (_provider, profile) => {
      const credentials = ctx.get('credentials')
      if (credentials !== undefined) {
        const hit = await credentials.resolve(profile.apiKeyEnv!)
        if (hit !== undefined) {
          const key = assertUsableApiKey(hit.value, name, String(profile.apiKeyEnv))
          userKeyPresent = true
          return key
        }
      }
      // OpenCode Zen accepts the public route without a user API key.
      return 'public'
    },
  })

  ctx.llm.registerConfigurableProviders([
    { provider: PROVIDER, displayName: DISPLAY_NAME, settingsNs: NS, settingsPath: [] },
  ])
  ctx.llm.registerAdapter([PROVIDER], adapter)

  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.installSection(ctx, NS, Config, config, {
      setSource: (source) => {
        current = source
        syncStripSwitch(source())
      },
      onChange: () => {
        syncStripSwitch(current())
        profiles = buildProfiles()
      },
    })
  })

  // The catalog is fetched once at mount. Mount never awaits it: an unreachable
  // upstream must not kill the plugin.
  async function sync(): Promise<void> {
    const [zen, modelsDev] = await Promise.all([
      fetchJson('https://opencode.ai/zen/v1/models', {
        'User-Agent': opencodeUserAgent,
        accept: 'application/json',
      }),
      fetchJson('https://models.dev/api.json', { accept: 'application/json' }),
    ])
    if (!Array.isArray(zen.data)) throw new Error('zen models: unexpected response shape')
    if (!isRecord(modelsDev.opencode) || !isRecord(modelsDev.opencode.models)) {
      throw new Error('models.dev: no "opencode" provider')
    }
    const next = buildModels(zen.data, modelsDev.opencode.models, opencodeUserAgent)
    if (next.length === 0) {
      throw new Error('no OpenCode Zen free models resolved; keeping the previous catalog')
    }
    if (deepEqualJson(next, scanned)) return
    scanned = next
    profiles = buildProfiles()
    ctx.logger.info('[%s] synced %d free model(s): %s', name, scanned.length, scanned.map(model => model.id).join(', '))
  }

  void sync().catch((error: unknown) => {
    ctx.logger.warn('[%s] initial catalog scan failed: %s', name, errorChain(error))
  })
}
