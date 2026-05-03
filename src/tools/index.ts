import OpenAI from 'openai'
import { ToolRegistry } from './registry.ts'
import { fetchUrlTool } from './fetch-url.ts'
import { makeWebSearchTool } from './web-search.ts'

export { ToolRegistry } from './registry.ts'
export type { Tool, ToolContext } from './registry.ts'

export function buildDefaultRegistry(client: OpenAI): ToolRegistry {
  const registry = new ToolRegistry()
  registry.register(fetchUrlTool)
  registry.register(makeWebSearchTool(client))
  return registry
}
