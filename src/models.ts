// Automatic API routing only writes a postmortem after confirmed Codex failure.
// Keep that report on a generally available API model. Explicit API-engine
// channels also use this model normally.
export const DEFAULT_OPENAI_MODEL = 'gpt-5.6-sol'
export const DEFAULT_CODEX_MODEL = 'gpt-5.6-sol'
// Summarization runs on THIS host's own GPU: a background chore that fires on
// a message threshold. It used to name a 14B so it could coexist with the
// embedder on the 24GB card — but "coexist" meant the 14B and whatever else
// wanted the GPU took turns evicting each other, re-reading gigabytes off the
// SSD every swap. The inference host now pins ONE generative model
// (qwen3.8:27b, 32k ctx) next to bge-m3 and holds both indefinitely, so the
// cheap move is the model already resident, not a second set of weights.
export const DEFAULT_SUMMARIZATION_MODEL = 'qwen3.8:27b'

export const OPENAI_MODELS = [
  'gpt-6-astra',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'gpt-daybreak-blue-latest',
] as const

export type OpenAIModel = typeof OPENAI_MODELS[number]
