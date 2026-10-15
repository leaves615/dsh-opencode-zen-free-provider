import type { Context } from '@deepseek-ai/cordis'
import { assertUsableApiKey, errorChain, resolveRetryPolicy, RetryPolicySchema } from '@deepseek-ai/dsh-llm'
import type { RetryPolicyConfig } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter, type ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { deepEqualJson } from '@deepseek-ai/dsh-util-values'
import type {} from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import { createHash, randomBytes } from 'node:crypto'
import { createProvider, getCurrentTools, type AuthContext, type Context as PiContext, type CredentialStore, type Model, type SimpleStreamOptions, type ThinkingLevelMap, type ProviderStreams, type Tool, type TranscriptContext, type TSchema } from '@earendil-works/pi-ai'
import { getBuiltinModels } from '@earendil-works/pi-ai/providers/all'
// Cloned (and minimized) from @earendil-works/pi-ai's openai-completions module.
// See src/openai-completions.ts for the source URL + the only change (zenFetch).
// The cloned copy re-declares AssistantMessageEventStream as a separate class
// identity, so its stream functions are cast back to the package's types here.
// Runtime behavior is identical; only the (private) class identity differs.
import { stream as _piAgentStream, streamSimple as _piAgentStreamSimple, installZenUserAgent } from './openai-completions.js'
import { stream as _piResponsesStream, streamSimple as _piResponsesStreamSimple, installZenUserAgent as installZenUserAgentResponses } from './openai-responses.js'
import { OFFICIAL_TOOL_DEFS } from './opencode-tools.js'
const piAgentStream = _piAgentStream as unknown as ProviderStreams['stream']
const piAgentStreamSimple = _piAgentStreamSimple as unknown as ProviderStreams['streamSimple']
const piResponsesStream = _piResponsesStream as unknown as ProviderStreams['stream']
const piResponsesStreamSimple = _piResponsesStreamSimple as unknown as ProviderStreams['streamSimple']

export const name = 'opencode-zen-free-provider'
export const inject = ['llm']

const PROVIDER = name
const DISPLAY_NAME = 'OpenCode Zen Free'
const NS = 'opencode-zen-free-provider'
// Inference moved to a new backend on 2026-10-14
// (`https://opencode.ai/inference/openai`, was `https://opencode.ai/zen`)
// and the free-tier gate now wants the 2.x CLI fingerprint
// `opencode/<channel>/<version>/cli`. The npm `opencode-ai` feed still
// tracks the 1.x line, so there is no feed to resolve a 2.x version from;
// like opencode2api (internal/httpx/client.go) this pins the release.
// Upstream does not validate the version number itself.
const OPENCODE_VERSION = '2.0.29'
const OPENCODE_CHANNEL = 'latest'

export const opencodeUserAgentFor = (version: string): string =>
  `opencode/${OPENCODE_CHANNEL}/${version}/cli`

export const OPENCODE_USER_AGENT = opencodeUserAgentFor(OPENCODE_VERSION)

// Chat/completions + responses traffic goes to the inference backend. The
// models listing is NOT exposed there, so the catalog sync below still reads
// the legacy Zen console origin.
const ZEN_INFERENCE_BASE_URL = 'https://opencode.ai/inference/openai/v1'
const ZEN_MODELS_URL = 'https://opencode.ai/zen/v1/models'

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

const OPENCODE_ID_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

// opencode's Identifier.create: the 12 hex chars are the low 48 bits of
// `Date.now() * 0x1000 + counter` as six big-endian bytes, and the counter is
// shared by every id kind and reset whenever the millisecond changes — so it
// counts only the ids minted in the same millisecond and stays tiny.
let opencodeLastTimestamp = 0
let opencodeTimestampCounter = 0
const opencodeTimePart = (descending: boolean): string => {
  const timestamp = Date.now()
  opencodeTimestampCounter = timestamp === opencodeLastTimestamp ? opencodeTimestampCounter + 1 : 1
  opencodeLastTimestamp = timestamp
  const current = BigInt(timestamp) * 0x1000n + BigInt(opencodeTimestampCounter)
  const value = (descending ? ~current : current) & 0xFFFFFFFFFFFFn
  let time = ''
  for (let index = 0; index < 6; index += 1) {
    time += Number((value >> BigInt(40 - 8 * index)) & 0xffn).toString(16).padStart(2, '0')
  }
  return time
}

// `msg_`: opencode's ascending request id — the time part as-is, then 14 random
// base62 chars. Generated fresh per request.
export const opencodeRequestId = (): string => {
  const random = [...randomBytes(14)].map(byte => OPENCODE_ID_ALPHABET[byte % 62]).join('')
  return `msg_${opencodeTimePart(false)}${random}`
}

// opencode's canonical session shape: `ses_` + 12 hex + 14 base62.
const CANONICAL_SESSION_PATTERN = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/

// `ses_`: opencode's *descending* id — same layout, time part bitwise-inverted.
// The Zen free tier decodes that half and refuses a session it cannot derive
// from the clock with 403 FreeTierError, so a digest-derived prefix (which is
// what this provider used to send) is read as "not an OpenCode client" and
// every free model is refused. The clock value cannot come from the dsh session
// id, so the first request of a conversation mints the id and the cache keeps
// every later turn on it. The 14-char random half stays digest-derived, so an
// evicted conversation re-mints with the same random half and only loses the
// timestamp (i.e. upstream prompt-cache affinity) until it is used again.
const OPENCODE_SESSION_CACHE_LIMIT = 8192
const opencodeSessionCache = new Map<string, string>()

export const opencodeSessionId = (sessionId: string): string => {
  // A caller that already carries an official OpenCode session keeps it
  // verbatim, preserving upstream prompt-cache affinity.
  if (CANONICAL_SESSION_PATTERN.test(sessionId)) return sessionId
  const digest = createHash('sha256').update(`dsh-opencode-ses\0${sessionId}`).digest()
  const key = digest.toString('hex')
  const cached = opencodeSessionCache.get(key)
  if (cached !== undefined) return cached
  const random = [...digest.subarray(6, 20)].map(byte => OPENCODE_ID_ALPHABET[byte % 62]).join('')
  const minted = `ses_${opencodeTimePart(true)}${random}`
  if (opencodeSessionCache.size >= OPENCODE_SESSION_CACHE_LIMIT) {
    const oldest = opencodeSessionCache.keys().next().value
    if (oldest !== undefined) opencodeSessionCache.delete(oldest)
  }
  opencodeSessionCache.set(key, minted)
  return minted
}

export const zenApiHeaders = (model: Pick<Model<ZenApi>, 'headers'>, options: SimpleStreamOptions) => {
  const sessionId = options.sessionId ?? 'dsh-session-unknown'
  // Match the 2.x opencode CLI header set exactly:
  // - no HTTP-Referer (actively stripped: model defs may still carry one)
  // - both session headers carry the same descending id (required as a pair
  //   since 2026-10-14; either one missing is a 403 FreeTierError)
  // - x-opencode-request is NEVER sent: the gate rejects the correlation
  //   header with 403 since 2026-10-14, tracing stays local
  // - x-opencode-project stays the literal "global" every official client
  //   sends (any non-canonical value passes; canonical prj_* ids 403)
  const { 'HTTP-Referer': _droppedReferer, ...modelHeaders } = model.headers ?? {}
  void _droppedReferer
  const minted = opencodeSessionId(sessionId)
  return {
    ...modelHeaders,
    accept: '*/*',
    'accept-encoding': 'gzip, deflate, br, zstd',
    'x-opencode-project': 'global',
    'x-opencode-session': minted,
    'x-opencode-session-id': minted,
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
// cloned transports always send `stream: true`, and tools must be present —
// a tool-less request is rejected with 403 FreeTierError. Since 2026-10-14
// name presence is not enough: the gate compares every recognised tool's
// description and parameter schema against the official CLI definitions
// byte-for-byte, so a synthesised stand-in 403s even under the right name.
// Mirror opencode2api: recognised names always ship the genuine definitions
// (OFFICIAL_TOOL_DEFS); unknown names pass through exactly as declared.
// Key-tier requests keep their original bodies (gated by userKeyPresent below).
const ANONYMOUS_CORE_TOOLS = ['shell', 'edit', 'glob', 'grep', 'read'] as const

// Upstream recognises the pre-2.x 'bash' spelling and validates it. There is
// no genuine bash definition to ship (opencode2api never had one either), but
// a bash entry carrying the official shell definition passes (verified live),
// so bash is treated as an alias of shell on the wire.
const officialToolDefFor = (name: string): { description: string; parameters: unknown } | undefined => {
  if (name === 'bash') return OFFICIAL_TOOL_DEFS.shell
  return OFFICIAL_TOOL_DEFS[name]
}

const agentToolFor = (name: string): Tool => {
  const def = officialToolDefFor(name)
  return {
    name,
    description: def?.description ?? `Agent tool ${name}`,
    parameters: (def?.parameters ?? { type: 'object', properties: {} }) as unknown as TSchema,
  }
}

// A declared tool already carrying the genuine definition keeps its object
// identity, so a fully genuine context passes through untouched.
const needsGenuineDef = (tool: Tool, def: { description: string; parameters: unknown }): boolean =>
  tool.description !== def.description || !deepEqualJson(tool.parameters, def.parameters)

export const ensureAgentTools = (context: PiContext): PiContext => {
  const tools = context.tools ?? []
  let changed = false
  const next = tools.map((tool) => {
    const def = officialToolDefFor(tool.name)
    if (def === undefined || !needsGenuineDef(tool, def)) return tool
    changed = true
    return { ...tool, description: def.description, parameters: def.parameters as unknown as TSchema }
  })
  const present = new Set(next.map(tool => tool.name))
  const missing = ANONYMOUS_CORE_TOOLS.filter(name => !present.has(name))
  if (missing.length > 0) {
    next.push(...missing.map(agentToolFor))
    changed = true
  }
  if (!changed) return context
  return { ...context, tools: next }
}

// Latched by resolveApiKey once a real user credential resolves: from then on
// this mount serves the key tier, which must keep original bodies.
let userKeyPresent = false

export const maybeEnsureAgentTools = (context: PiContext): PiContext =>
  userKeyPresent ? context : ensureAgentTools(context)

// The wire tools above wear official OpenCode schemas, but the harness
// executes calls against its own schemas (snake_case file_path, a required
// human description on bash, skill by name instead of id). Rewrite official
// args back to harness args on the way out, in the stream events below.
// 'shell' has no harness counterpart: the injected shell tool and the
// wire-level bash alias both run through the harness bash tool. Mappers accept
// both shapes so a block already rewritten (the done message replays the same
// block objects as toolcall_end) is left stable. History needs no mapping:
// the gate does not inspect tool calls inside messages (verified live).
const synthBashDescription = (command: unknown): string => {
  if (typeof command !== 'string' || command.length === 0) return 'Run shell command'
  const firstLine = command.split('\n', 1)[0]
  return `Run shell command: ${firstLine.slice(0, 120)}`
}

const remapShellArgs = (args: Record<string, unknown>): Record<string, unknown> => {
  const { command, timeout, workdir, background, description, ...rest } = args
  const out: Record<string, unknown> = { ...rest }
  if (command !== undefined) out.command = command
  out.description = typeof description === 'string' && description.length > 0
    ? description
    : synthBashDescription(command)
  if (timeout !== undefined) out.timeoutMs = timeout
  if (workdir !== undefined) out.workdir = workdir
  if (background !== undefined) out.run_in_background = background
  return out
}

const renameArgs = (args: Record<string, unknown>, mapping: Record<string, string>): Record<string, unknown> => {
  const out: Record<string, unknown> = { ...args }
  for (const [from, to] of Object.entries(mapping)) {
    if (out[from] !== undefined) {
      out[to] = out[from]
      delete out[from]
    }
  }
  return out
}

export const remapZenToolCall = (name: string, args: unknown): { name: string; args: unknown } => {
  if (!isRecord(args)) return { name, args }
  switch (name) {
    case 'shell':
      return { name: 'bash', args: remapShellArgs(args) }
    case 'bash':
      return { name, args: remapShellArgs(args) }
    case 'edit':
      return { name, args: renameArgs(args, { path: 'file_path', oldString: 'old_string', newString: 'new_string', replaceAll: 'replace_all' }) }
    case 'read':
      return { name, args: renameArgs(args, { path: 'file_path' }) }
    case 'write':
      return { name, args: renameArgs(args, { path: 'file_path' }) }
    case 'skill': {
      const out: Record<string, unknown> = { ...args }
      if (typeof out.id === 'string') out.name = out.id
      return { name, args: out }
    }
    default:
      return { name, args }
  }
}

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

// Rewrite official tool-call args back to harness args in live events: the
// completions transport pushes toolcall_end with the finished block, and both
// transports replay the same blocks in the done message.
export const remapEventToolCalls = (event: unknown): void => {
  if (!isRecord(event)) return
  if (event.type === 'toolcall_end' && isRecord(event.toolCall) && typeof event.toolCall.name === 'string') {
    const remapped = remapZenToolCall(event.toolCall.name, event.toolCall.arguments)
    event.toolCall.name = remapped.name
    event.toolCall.arguments = remapped.args
    return
  }
  if (event.type === 'done' && isRecord(event.message) && Array.isArray(event.message.content)) {
    for (const block of event.message.content) {
      if (!isRecord(block) || block.type !== 'toolCall' || typeof block.name !== 'string') continue
      const remapped = remapZenToolCall(block.name, block.arguments)
      block.name = remapped.name
      block.arguments = remapped.args
    }
  }
}

const sanitizeStream = <S extends { push(event: unknown): void }>(stream: S): S => {
  const originalPush = stream.push.bind(stream)
  stream.push = (event: unknown) => {
    if (isRecord(event) && event.type === 'error' && isRecord(event.error) && typeof event.error.errorMessage === 'string') {
      event.error.errorMessage = rewriteRefusalMessage(event.error.errorMessage)
    }
    remapEventToolCalls(event)
    originalPush(event)
  }
  return stream
}

type ZenApi = 'openai-completions' | 'openai-responses'

// pi-ai 0.87 normalizes the caller's Context into a TranscriptContext before
// provider dispatch: tools move into the leading system message and the wire
// object carries only messages. The cloned 0.84 transports below still read
// context.tools, so restore the tool list with the canonical reader before
// the strip/shape pipeline runs.
export const transcriptToContext = (context: TranscriptContext): PiContext => ({
  messages: context.messages,
  tools: getCurrentTools(context.messages),
})

// Back to the wire shape: the brand is type-only (erased at runtime), and the
// restored tools field is exactly what the cloned transports read.
const toTranscript = (context: PiContext): TranscriptContext => context as unknown as TranscriptContext

const zenStreamFor = (api: ZenApi): ProviderStreams => api === 'openai-responses'
  ? {
    stream: (model: Model<'openai-responses'>, context: TranscriptContext, options: SimpleStreamOptions) =>
      sanitizeStream(piResponsesStream({ ...model, headers: zenApiHeaders(model, options) }, toTranscript(maybeEnsureAgentTools(prepareZenContext(transcriptToContext(context)))), maybeStripResponsesInclude(options))),
    streamSimple: (model: Model<'openai-responses'>, context: TranscriptContext, options: SimpleStreamOptions) =>
      sanitizeStream(piResponsesStreamSimple({ ...model, headers: zenApiHeaders(model, options) }, toTranscript(maybeEnsureAgentTools(prepareZenContext(transcriptToContext(context)))), maybeStripResponsesInclude(options))),
  } as unknown as ProviderStreams
  : {
    stream: (model: Model<'openai-completions'>, context: TranscriptContext, options: SimpleStreamOptions) =>
      sanitizeStream(piAgentStream({ ...model, headers: zenApiHeaders(model, options) }, toTranscript(maybeEnsureAgentTools(prepareZenContext(transcriptToContext(context)))), options)),
    streamSimple: (model: Model<'openai-completions'>, context: TranscriptContext, options: SimpleStreamOptions) =>
      sanitizeStream(piAgentStreamSimple({ ...model, headers: zenApiHeaders(model, options) }, toTranscript(maybeEnsureAgentTools(prepareZenContext(transcriptToContext(context)))), options)),
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
        baseUrl: ZEN_INFERENCE_BASE_URL,
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
  installZenUserAgent(OPENCODE_USER_AGENT)
  installZenUserAgentResponses(OPENCODE_USER_AGENT)

  // DSH 0.2 removed settings.installSection: plain (non-Volatile) Config
  // fields apply on mount, and a settings edit remounts the plugin, so the
  // module-level switch is synced once here. Default true so a missing key
  // (e.g. an old settings snapshot) keeps stripping on.
  stripEncryptedContentEnabled = config.stripReasoningEncryptedContent ?? true

  // Outside the settings-backed config, so a settings snapshot cannot clobber a
  // scan.
  let scanned: Model<ZenApi>[] = []

  // The profile entry id owns the directory listing; fall back to the bundle
  // id. Fiber.entry is runtime-internal (untyped), so read it structurally.
  const settingsNs = (ctx.fiber as unknown as { entry?: { options?: { id?: string } } } | undefined)?.entry?.options?.id ?? NS

  const buildProfiles = (): ReadonlyMap<string, ResolvedPiAiProviderProfile> => {
    const opts = config
    const piProvider = createProvider<ZenApi>({
      id: PROVIDER,
      name: 'OpenCodeZenFree',
      baseUrl: ZEN_INFERENCE_BASE_URL,
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
    { provider: PROVIDER, displayName: DISPLAY_NAME, settingsNs, settingsPath: [] },
  ])
  ctx.llm.registerAdapter([PROVIDER], adapter)

  // Settings page policy only, registered last: a failure here must never kill
  // the provider registration above (a host without the settings service, or a
  // duplicate page policy on remount, only loses the auto-generated page).
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.effect(() => {
      try {
        return settingsCtx.settings.configure({ auto: true }, ctx.fiber)
      } catch (error) {
        ctx.logger.warn('[%s] settings page unavailable: %s', name, errorChain(error))
        return () => {}
      }
    })
  })

  // The catalog is fetched once at mount. Mount never awaits it: an unreachable
  // upstream must not kill the plugin.
  async function sync(): Promise<void> {
    const [zen, modelsDev] = await Promise.all([
      fetchJson(ZEN_MODELS_URL, {
        'User-Agent': OPENCODE_USER_AGENT,
        accept: 'application/json',
      }),
      fetchJson('https://models.dev/api.json', { accept: 'application/json' }),
    ])
    if (!Array.isArray(zen.data)) throw new Error('zen models: unexpected response shape')
    if (!isRecord(modelsDev.opencode) || !isRecord(modelsDev.opencode.models)) {
      throw new Error('models.dev: no "opencode" provider')
    }
    const next = buildModels(zen.data, modelsDev.opencode.models, OPENCODE_USER_AGENT)
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
