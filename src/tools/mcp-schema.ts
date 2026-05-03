// Convert an MCP tool's JSON Schema to the OpenAI function-calling shape.
//
// OpenAI's `function.parameters` is plain JSON Schema, so this is mostly a
// pass-through — but MCP servers occasionally produce shapes OpenAI rejects:
//   - `anyOf`/`oneOf` at the top level (model gets confused)
//   - `type: ["string", "null"]` arrays (we collapse to the non-null primitive)
//   - properties whose type can't be represented (skip + log)
//   - extra keys like `additionalProperties` (allowed but trimmed for clarity)
//
// Returns null when the entire schema can't be represented; callers fall
// back to an empty object schema.

type JSONSchema = Record<string, any>

export type OpenAIToolParameters = {
  type: 'object'
  properties: Record<string, unknown>
  required?: string[]
  description?: string
}

export function mcpSchemaToOpenAI(schema: unknown): OpenAIToolParameters | null {
  const inner = convertNode(schema)
  if (!inner || (inner as any).type !== 'object') return null
  return inner as OpenAIToolParameters
}

function convertNode(schema: unknown): Record<string, unknown> | null {
  if (!schema || typeof schema !== 'object') return null
  const s = schema as JSONSchema

  if (s.anyOf || s.oneOf) return null

  let type = s.type
  if (Array.isArray(type)) {
    const nonNull = type.filter((t: string) => t !== 'null')
    if (nonNull.length !== 1) return null
    type = nonNull[0]
  }
  if (typeof type !== 'string') return null

  const out: Record<string, unknown> = { type }

  switch (type) {
    case 'string':
    case 'number':
    case 'integer':
    case 'boolean':
      break
    case 'array': {
      const itemSchema = s.items ? convertNode(s.items) : null
      if (itemSchema) out.items = itemSchema
      break
    }
    case 'object': {
      const props: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(s.properties ?? {})) {
        const converted = convertNode(v)
        if (converted) {
          props[k] = converted
        } else {
          console.error(`[mcp-schema] skipping unrepresentable property "${k}"`)
        }
      }
      out.properties = props
      const required: string[] = Array.isArray(s.required) ? s.required.filter((r: string) => r in props) : []
      out.required = required
      break
    }
    default:
      return null
  }

  if (typeof s.description === 'string') out.description = s.description
  if (Array.isArray(s.enum)) out.enum = s.enum
  return out
}
