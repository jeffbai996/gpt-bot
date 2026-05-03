import type { Tool } from './registry.ts'

// Registered only when MCP connect fails at boot. Gives the model a valid
// function-call target so it can explain the situation instead of having no
// MCP-shaped tool available.
export function makeUnreachableStub(serverLabel: string, toolName: string = 'mcp_unreachable'): Tool {
  return {
    name: toolName,
    description: `Stub for ${serverLabel} — currently UNREACHABLE. Calling this tool returns an error string explaining the situation.`,
    parameters: { type: 'object', properties: {}, required: [] },
    async execute() {
      return `${serverLabel} is not reachable. Tell the user the MCP server is offline and they should start it.`
    }
  }
}
