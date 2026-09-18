import type { Context } from '@deepseek-ai/cordis';
import type { RetryPolicyConfig } from '@deepseek-ai/dsh-llm';
import z from '@deepseek-ai/schemastery';
import { type Context as PiContext, type Model, type SimpleStreamOptions } from '@earendil-works/pi-ai';
export declare const name = "opencode-zen-free-provider";
export declare const inject: string[];
export declare const opencodeUserAgentFor: (version: string) => string;
export interface Config {
    /** Provider-owned model-request retry policy; omission uses normal defaults. */
    retryPolicy?: RetryPolicyConfig;
    /** Strip replayed reasoning.encrypted_content before requests hit the Zen gateway. */
    stripReasoningEncryptedContent?: boolean;
}
export declare const Config: z<Config>;
export declare const opencodeRequestId: () => string;
export declare const opencodeSessionId: (sessionId: string) => string;
export declare const zenApiHeaders: (model: Pick<Model<ZenApi>, "headers">, options: SimpleStreamOptions) => {
    accept: string;
    'accept-encoding': string;
    'x-opencode-project': string;
    'x-opencode-session': string;
    'x-opencode-request': string;
    'x-opencode-client': string;
};
export declare const stripReasoningEncryptedContent: (context: PiContext) => PiContext;
export declare const withStrippedResponsesInclude: (options: SimpleStreamOptions) => SimpleStreamOptions;
export declare const prepareZenContext: (context: PiContext, enabled?: boolean) => PiContext;
export declare const maybeStripResponsesInclude: (options: SimpleStreamOptions, enabled?: boolean) => SimpleStreamOptions;
export declare const ensureAgentTools: (context: PiContext) => PiContext;
export declare const maybeEnsureAgentTools: (context: PiContext) => PiContext;
type ZenApi = 'openai-completions' | 'openai-responses';
export declare function apply(ctx: Context, config: Config): Promise<void>;
export {};
