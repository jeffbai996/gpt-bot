import { redactTraceSensitiveData } from './tool-trace.ts'

export function narrationBlocks(text: string): string[] {
  const safe = redactTraceSensitiveData(text).replace(/`{3,}/g, run => [...run].join('\u200b'))
  const blocks: string[] = []
  for (let offset = 0; offset < safe.length; offset += 1892) {
    blocks.push('```\n' + safe.slice(offset, offset + 1892) + '\n```')
  }
  return blocks
}

/** The render owner serializes advance/finish with Discord edits. */
export class NarrationHistory {
  current = ''
  private pending: string[] = []
  private last = ''
  private operation: Promise<void> = Promise.resolve()

  accept(raw: string): boolean {
    const text = raw.trim()
    const envelope = text.replace(/^```(?:json)?\s*/i, '')
    if (!text || /^\{\s*"image_request/.test(envelope) || text === this.last) return false
    this.last = text
    this.pending.push(text)
    return true
  }

  private serialize(action: () => Promise<void>): Promise<void> {
    const next = this.operation.then(action)
    this.operation = next.catch(() => {})
    return next
  }

  advance(retire: (text: string) => Promise<void>): Promise<void> {
    return this.serialize(() => this.drain(retire))
  }

  private async drain(retire: (text: string) => Promise<void>): Promise<void> {
    while (this.pending.length) {
      if (this.current) await retire(this.current)
      this.current = this.pending.shift()!
    }
  }

  finish(retire: (text: string) => Promise<void>): Promise<void> {
    return this.serialize(async () => {
      await this.drain(retire)
      if (this.current) {
        await retire(this.current)
        this.current = ''
      }
    })
  }
}
