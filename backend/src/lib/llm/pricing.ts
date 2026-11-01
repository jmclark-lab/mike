/**
 * Published token prices for models this repo can select.
 *
 * Rates are USD per 1M tokens and come from the provider's pricing page.
 * Gemini 4 Argon has a scheduled change on 2026-12-01. Other entries are the
 * base (short-context) rate; see `note` when a model has a second band.
 */

export type TokenPrice = {
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  /** Inclusive UTC date (YYYY-MM-DD). Omit when the rate has no start. */
  effectiveFrom?: string;
  /** Inclusive UTC date (YYYY-MM-DD). Omit when the rate has no scheduled end. */
  effectiveUntil?: string;
  note?: string;
};

export const MODEL_TOKEN_PRICES: Record<string, readonly TokenPrice[]> = {
  "gemini-4-argon": [
    {
      inputUsdPerMillion: 2,
      outputUsdPerMillion: 10,
      effectiveUntil: "2026-11-30",
      note: "Introductory rate through November 30, 2026. Implicit cache only.",
    },
    {
      inputUsdPerMillion: 4,
      outputUsdPerMillion: 20,
      effectiveFrom: "2026-12-01",
      note: "Standard rate from December 1, 2026. Implicit cache only.",
    },
  ],
  "gpt-6.1-sol": [
    {
      inputUsdPerMillion: 2,
      outputUsdPerMillion: 10,
      note: "Standard text rate. Cached input is $0.10 / 1M. Requests over 272K input tokens are priced higher for the full request.",
    },
  ],
  "claude-sonnet-5-5": [
    {
      inputUsdPerMillion: 2,
      outputUsdPerMillion: 10,
    },
  ],
  "claude-haiku-5-5": [
    {
      inputUsdPerMillion: 0.1,
      outputUsdPerMillion: 0.5,
      note: "Prompts up to 100,000 tokens. Above that, input is $0.50 and output is $2.50 per 1M tokens.",
    },
  ],
  "kimi-k3.1-pro": [
    {
      inputUsdPerMillion: 2,
      outputUsdPerMillion: 10,
      note: "Moonshot standard rate. Cache read is $0.20 / 1M. No key is wired for this model.",
    },
  ],
};

function utcDay(on: Date): string {
  return on.toISOString().slice(0, 10);
}

/** Rate in effect on `on`. Null when this repo has no published price for the id. */
export function tokenPriceForModel(
  model: string,
  on: Date = new Date(),
): TokenPrice | null {
  const rates = MODEL_TOKEN_PRICES[model];
  if (!rates?.length) return null;
  const day = utcDay(on);
  return (
    rates.find((rate) => {
      if (rate.effectiveFrom && day < rate.effectiveFrom) return false;
      if (rate.effectiveUntil && day > rate.effectiveUntil) return false;
      return true;
    }) ?? null
  );
}
