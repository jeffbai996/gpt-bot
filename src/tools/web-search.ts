import OpenAI from 'openai'
import type { Tool } from './registry.ts'

const SEARCH_MODEL = process.env.GPT_SEARCH_MODEL || 'gpt-4o-mini-search-preview'

// Wraps OpenAI's web-search-enabled model as a function tool. The main model
// can call web_search({query}); we run a side-call to the search-preview
// model, return its response (which includes Bing-grounded snippets and
// citations), and let the main model synthesize from that. Cheaper than
// promoting the main model to a search-preview variant for every turn.
export function makeWebSearchTool(client: OpenAI): Tool {
  return {
    name: 'web_search',
    description: 'Search the web and return summarized results with citations. Use when the user asks about current events, recent news, or anything that requires up-to-date information beyond the model\'s training cutoff.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query — be specific, include relevant entity names, dates, or context terms.' }
      },
      required: ['query']
    },
    async execute(args, _ctx) {
      const query = args.query
      if (typeof query !== 'string' || !query.trim()) {
        return 'web_search: query must be a non-empty string'
      }

      try {
        const resp = await client.chat.completions.create({
          model: SEARCH_MODEL,
          messages: [
            {
              role: 'system',
              content: 'You are a search assistant. Given a user query, search the web and return a concise factual summary with inline citations [n] and a numbered source list. Do not editorialize.'
            },
            { role: 'user', content: query }
          ],
          // search-preview models don't accept temperature or max_tokens in
          // some configurations; keep the call lean.
          max_completion_tokens: 1500
        })
        const text = resp.choices?.[0]?.message?.content ?? ''
        return text || 'web_search: empty result'
      } catch (e: any) {
        return `web_search: ${e?.message ?? String(e)}`
      }
    }
  }
}
