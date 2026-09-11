// Automatic API routing only writes a postmortem after confirmed Codex failure.
// Keep that report on a generally available API model. Explicit API-engine
// channels also use this model normally.
export const DEFAULT_OPENAI_MODEL = 'gpt-5.6-sol'
export const DEFAULT_CODEX_MODEL = 'gpt-5.6-sol'
// Summarization runs on THIS host's own GPU, not the remote chat box: it is a
// background chore that fires on a message threshold, and the remote box only
// holds a model when it has been loaded deliberately. A 14B handles history
// compression well and coexists with the embedder on a 24GB card.
export const DEFAULT_SUMMARIZATION_MODEL = 'qwen2.5:14b'

export const OPENAI_MODELS = [
  'gpt-6-astra',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'gpt-daybreak-blue-latest',
] as const

export type OpenAIModel = typeof OPENAI_MODELS[number]
