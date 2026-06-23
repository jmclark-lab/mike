-- Migration: add provider_metadata to chat_messages
-- Stores which LLM provider and model generated each assistant response.
-- Apply before deploying the Sakana Fugu provider swap.

ALTER TABLE chat_messages
  ADD COLUMN IF NOT EXISTS provider_metadata JSONB DEFAULT NULL;

COMMENT ON COLUMN chat_messages.provider_metadata IS
  'LLM provenance: { provider_name, model_name, provider_response_id? }. '
  'Populated for every assistant message after the Sakana Fugu migration.';
