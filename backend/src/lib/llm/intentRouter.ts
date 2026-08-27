/**
 * Intent-based first-model routing for Mike.
 *
 * Tools and message shape already name the job (draft_redlines, ingest,
 * "what does this resolution say"). This module classifies that signal with
 * a deterministic heuristic — not an LLM router — then picks the FIRST model.
 *
 * Default / cheap / unsure stay on Sakana Fugu Ultra (Julio: priced well
 * below Fable 5 at the same intelligence class; Fugu is an orchestrator).
 * Only high-stakes paste-into-contract work starts on Opus. Council remains
 * an explicit tool, never the default path.
 *
 * Output is decision-support for internal review, not a licensed attorney.
 */

import { DEFAULT_SAKANA_MODEL } from "./models";

export type RouteBucket = "high" | "cheap" | "default";

export const DEFAULT_ROUTE_MODEL = DEFAULT_SAKANA_MODEL;
export const HIGH_ROUTE_MODEL = "claude-opus-4-8";

export const HIGH_STAKES_TOOLS = [
    "draft_redlines",
    "review_against_playbook",
    "draft_contract",
] as const;

export const CHEAP_JOB_TOOLS = [
    "search_knowledge",
    "ingest_document",
    "list_obligations",
    "save_obligations",
    "list_playbooks",
] as const;

const HIGH_TOOL_RE = new RegExp(
    `\\b(${HIGH_STAKES_TOOLS.join("|")})\\b`,
    "i",
);
const CHEAP_TOOL_RE = new RegExp(
    `\\b(${CHEAP_JOB_TOOLS.join("|")})\\b`,
    "i",
);

// Ready-to-paste / signed-document work only — not general legal research.
const HIGH_TEXT_RE =
    /\b(redlines?|review(?:ing)?\b[\s\S]{0,80}\bplaybook|replacement\s+clauses?|ready[- ]to[- ]paste|paste\s+into)\b/i;
const HIGH_DRAFT_AGREEMENT_RE =
    /\bdraft(?:ing)?\s+(?:a|an|the|our|this)?\s*(nda|cda|msa|cta|wo|ica|work\s*orders?|independent\s+contractor|services\s+agreement|contract|agreement)\b/i;
const HIGH_AGREEMENT_EDIT_RE =
    /\b(nda|cda|msa|cta|wo|work\s*orders?)\b[\s\S]{0,80}\b(draft|redline|revise|amend|replacement\s+clause|paste)\b/i;
// Novel pathway that will be signed — not a general LATAM research question.
const HIGH_SIGNED_PATHWAY_RE =
    /\b((?:novel\s+)?(?:latam|latin[- ]american?|invima|anvisa|cofepris|digemid)?\s*(?:regulatory\s+)?pathway)\b[\s\S]{0,80}\b(sign(?:ed|ing)?|for\s+signature|ready\s+to\s+sign|draft|agreement|contract|cta|cda|nda|msa)\b/i;

const CHEAP_GROUNDED_RE =
    /\bwhat\s+does\s+(this|the)\s+(resolution|decree|document|clause|article|section|contract|guidance)\s+say\b/i;
const CHEAP_KB_RE =
    /\b(search|look\s+up|find)\s+(?:in\s+)?(?:the\s+)?(?:knowledge\s+base|kb|our\s+standard\s+terms)\b/i;
const CHEAP_INGEST_RE =
    /\b(ingest(?:ing)?|add\s+to\s+(?:the\s+)?knowledge\s+base)\b/i;
const CHEAP_OBLIGATION_RE =
    /\b(list\s+obligations|upcoming\s+renewals|what(?:'s|s|\s+is)\s+(?:coming\s+)?due|obligations?\s+(?:due|upcoming|overdue|tracker))\b/i;

export type IntentClassification = {
    bucket: RouteBucket;
    reason: string;
};

export type IntentInput = {
    userText?: string | null;
    requestedTools?: string[] | null;
};

function normalizeText(value: string | null | undefined): string {
    return (value ?? "").replace(/\s+/g, " ").trim();
}

function defaultRouteModel(): string {
    return process.env.SAKANA_MODEL?.trim() || DEFAULT_ROUTE_MODEL;
}

function hasHighSignal(text: string, tools: string[]): boolean {
    if (tools.some((t) => (HIGH_STAKES_TOOLS as readonly string[]).includes(t))) {
        return true;
    }
    return (
        HIGH_TOOL_RE.test(text) ||
        HIGH_TEXT_RE.test(text) ||
        HIGH_DRAFT_AGREEMENT_RE.test(text) ||
        HIGH_AGREEMENT_EDIT_RE.test(text) ||
        HIGH_SIGNED_PATHWAY_RE.test(text)
    );
}

function hasCheapSignal(text: string, tools: string[]): boolean {
    if (tools.some((t) => (CHEAP_JOB_TOOLS as readonly string[]).includes(t))) {
        return true;
    }
    return (
        CHEAP_TOOL_RE.test(text) ||
        CHEAP_GROUNDED_RE.test(text) ||
        CHEAP_KB_RE.test(text) ||
        CHEAP_INGEST_RE.test(text) ||
        CHEAP_OBLIGATION_RE.test(text)
    );
}

/**
 * Classify a request into high / cheap / default.
 * Unsure stays on Fugu Ultra — do not escalate just because the
 * classifier is timid. High wins when both high and cheap match.
 */
export function classifyIntent(input: IntentInput = {}): IntentClassification {
    const userText = normalizeText(input.userText);
    const requestedTools = (input.requestedTools ?? [])
        .map((t) => t.trim())
        .filter(Boolean);

    const high = hasHighSignal(userText, requestedTools);
    const cheap = hasCheapSignal(userText, requestedTools);

    if (high) {
        return { bucket: "high", reason: "signed_document_or_playbook_work" };
    }
    if (cheap) {
        return { bucket: "cheap", reason: "grounded_lookup_or_ingest" };
    }
    return { bucket: "default", reason: "unsure_stay_on_fugu" };
}

export function firstModelForBucket(bucket: RouteBucket): string {
    return bucket === "high" ? HIGH_ROUTE_MODEL : defaultRouteModel();
}

export function lastUserText(
    messages:
        | { role?: string; content?: string | null }[]
        | null
        | undefined,
): string {
    if (!messages?.length) return "";
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m?.role === "user" && typeof m.content === "string") {
            return m.content;
        }
    }
    return "";
}

export function buildRoutedChain(opts: {
    bucket: RouteBucket;
    fallbackPool: string[];
    orderByHealth?: (chain: string[]) => string[];
}): { firstModel: string; chain: string[] } {
    const firstModel = firstModelForBucket(opts.bucket);
    const rest = opts.fallbackPool.filter((m) => m !== firstModel);
    const orderedRest = opts.orderByHealth ? opts.orderByHealth(rest) : rest;
    return { firstModel, chain: [firstModel, ...orderedRest] };
}
