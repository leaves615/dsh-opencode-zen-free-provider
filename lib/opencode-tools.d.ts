export interface OfficialToolDef {
    description: string;
    parameters: {
        type: 'object';
        properties: Record<string, unknown>;
        required?: string[];
        additionalProperties?: boolean;
    };
}
export declare const OFFICIAL_TOOL_DEFS: Record<string, OfficialToolDef>;
