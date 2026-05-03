import OpenAI from 'openai'
import type { Tool } from './registry.ts'
import { MemoryStore, embed, type SearchResult } from '../memory.ts'

function formatSearchResults(results: SearchResult[]): string {
  if (results.length === 0) return 'No matching messages found in memory.'
  return results.map(r => `[${r.timestamp}] ${r.author_name}: ${r.content}`).join('\n')
}

export function makeSearchMemoryTool(client: OpenAI, store: MemoryStore): Tool {
  return {
    name: 'search_memory',
    description: 'Search past Discord messages in this channel for context by semantic meaning. Use when asked about past events, previous discussions, or when you need additional context from earlier conversation.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The semantic search query — phrase as natural language describing what you want to recall.' },
        limit: { type: 'number', description: 'Max number of results to return. Default 10.' }
      },
      required: ['query']
    },
    async execute(args, ctx) {
      if (!ctx.channelId) {
        return 'search_memory requires a channel context; none was provided.'
      }
      const query = args.query
      if (typeof query !== 'string' || !query.trim()) {
        return 'search_memory requires a non-empty "query" string argument.'
      }
      const limit = typeof args.limit === 'number' ? Math.max(1, Math.min(50, args.limit)) : 10
      const queryEmb = await embed(client, query)
      if (!queryEmb) return 'search_memory: could not embed query'
      const results = store.searchMessages(ctx.channelId, queryEmb, limit)
      return formatSearchResults(results)
    }
  }
}
