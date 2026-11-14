import assert from "node:assert/strict";
import test from "node:test";
import { MODELS, SETTINGS_MODELS, visiblePickerModels } from "./modelCatalog";

function ids(group: string, models = MODELS): string[] {
  return models.filter((model) => model.group === group).map((model) => model.id);
}

test("ModelToggle list puts the verified frontier ids in picker order", () => {
  assert.equal(MODELS[0]?.id, "claude-fable-5-1");
  assert.equal(ids("Google")[0], "gemini-4-argon");
  assert.deepEqual(ids("OpenAI").slice(0, 3), [
    "gpt-6-astra",
    "gpt-6.1-sol",
    "gpt-6-sol",
  ]);
  const anthropic = ids("Anthropic");
  assert.ok(anthropic.indexOf("claude-sonnet-5-5") < anthropic.indexOf("claude-sonnet-4-6"));
  assert.equal(anthropic.includes("claude-opus-5-5"), true);
  assert.deepEqual(ids("xAI"), ["grok-4.7"]);
  assert.deepEqual(ids("NVIDIA"), ["nvidia/nemotron-3-ultra-550b-a55b"]);
  assert.equal(
    SETTINGS_MODELS.some((model) => model.id === "claude-haiku-5-5"),
    true,
  );
  assert.equal(
    SETTINGS_MODELS.some((model) => model.id === "claude-haiku-4-5"),
    true,
  );
  assert.equal(
    MODELS.some((model) => model.id === "kimi-k3.1-pro"),
    true,
  );
  const shownByDefault = visiblePickerModels(MODELS, false).map((model) => model.id);
  assert.equal(shownByDefault.includes("kimi-k3.1-pro"), false);
  assert.equal(shownByDefault.includes("gemini-4-argon"), true);
  assert.equal(shownByDefault.includes("nvidia/nemotron-3-ultra-550b-a55b"), true);
  const shownWhenEnabled = visiblePickerModels(MODELS, false, true).map(
    (model) => model.id,
  );
  assert.equal(shownWhenEnabled.includes("kimi-k3.1-pro"), true);
  const shownInSponsorCi = visiblePickerModels(MODELS, true, true).map(
    (model) => model.id,
  );
  assert.equal(shownInSponsorCi.includes("kimi-k3.1-pro"), false);
  assert.equal(shownInSponsorCi.includes("gemini-4-argon"), true);
  assert.equal(shownInSponsorCi.includes("nvidia/nemotron-3-ultra-550b-a55b"), true);
});
