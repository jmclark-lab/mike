import { providerForModel } from "./llm/models";

/**
 * Models the Mike MCP ask path may pin for one request.
 * Gemini is the council seat (`gemini-4-carbon`), not a new client.
 * Aliases resolve to those ids; an unknown value is rejected.
 */
export const CONNECTOR_MODEL_CHOICES = [
  { id: "claude-fable-5-2", provider: "anthropic", aliases: ["claude"] },
  { id: "claude-opus-5-5", provider: "anthropic", aliases: [] as string[] },
  { id: "gpt-6-astra", provider: "openai", aliases: ["openai", "gpt"] },
  { id: "gemini-4-carbon", provider: "google", aliases: ["gemini"] },
  { id: "grok-4.7", provider: "xai", aliases: ["grok"] },
] as const;

export type ConnectorModelChoice = (typeof CONNECTOR_MODEL_CHOICES)[number];

export function connectorModelAllowedValues(): string[] {
  const values: string[] = [];
  for (const choice of CONNECTOR_MODEL_CHOICES) {
    values.push(choice.id);
    for (const alias of choice.aliases) values.push(alias);
  }
  return values;
}

export function connectorModelAllowedText(): string {
  return connectorModelAllowedValues().join(", ");
}

export function connectorProviderForModel(model: string): string {
  const id = model.trim();
  if (!id || id === "unknown") return "unknown";
  const pinned = CONNECTOR_MODEL_CHOICES.find((choice) => choice.id === id);
  if (pinned) return pinned.provider;
  try {
    const provider = providerForModel(id);
    if (provider === "claude") return "anthropic";
    if (provider === "gemini") return "google";
    if (provider === "openai") return "openai";
    if (provider === "xai") return "xai";
    return provider;
  } catch {
    return "unknown";
  }
}

export type ConnectorModelParse =
  | { ok: true; model: undefined; provider: undefined }
  | { ok: true; model: string; provider: string }
  | { ok: false; detail: string; allowed: string[] };

/**
 * `undefined` / `null` means the default chat chain.
 * A present but unknown value is an error that lists the allowed values.
 */
export function parseConnectorModelChoice(value: unknown): ConnectorModelParse {
  const allowed = connectorModelAllowedValues();
  if (value === undefined || value === null) {
    return { ok: true, model: undefined, provider: undefined };
  }
  if (typeof value !== "string") {
    return {
      ok: false,
      detail: `model must be a string. Allowed values: ${connectorModelAllowedText()}.`,
      allowed,
    };
  }
  const key = value.trim().toLowerCase();
  if (!key) {
    return {
      ok: false,
      detail: `model must be a non-empty string. Allowed values: ${connectorModelAllowedText()}.`,
      allowed,
    };
  }
  for (const choice of CONNECTOR_MODEL_CHOICES) {
    if (choice.id === key || (choice.aliases as readonly string[]).includes(key)) {
      return { ok: true, model: choice.id, provider: choice.provider };
    }
  }
  return {
    ok: false,
    detail: `Unknown model "${value.trim()}". Allowed values: ${connectorModelAllowedText()}.`,
    allowed,
  };
}
