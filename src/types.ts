// Shared types used across the codebase. Kept deliberately small — add
// types here only when they need to be referenced by two or more modules.
// Local-to-one-module types should stay in that module.

/**
 * Closed set of Claude model IDs that agents are allowed to run as.
 * Narrowing to a union catches typos (`claude-sonnet-4.6`, `gpt-4`) at
 * compile time — neither the DB CHECK layer nor the Zod layer
 * validate model strings otherwise. When Anthropic ships a new model we
 * want to support, add it here. The friction is the feature.
 *
 * Both the seed data (agent_types.model) and the config loader
 * (ai.default_model) reference this as the single source of truth.
 */
export const CLAUDE_MODELS = [
  'claude-opus-4-7',
  'claude-opus-4-6',
  'claude-sonnet-4-6',
  'claude-haiku-4-5-20251001',
] as const;

export type ClaudeModel = (typeof CLAUDE_MODELS)[number];
