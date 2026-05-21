import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import type { PinnedFactsStore } from './pinned-facts.ts'
import type { SummaryStore } from './summarization/store.ts'

const DEFAULT_PERSONA = `You are gpt, a Discord bot backed by an OpenAI model. Be helpful, concise, and match the channel's tone. You can respond with text, an emoji reaction, or both.`

function stateDir(): string {
  return process.env.GPT_STATE_DIR || path.join(os.homedir(), '.gpt', 'channels', 'discord')
}

export class PersonaLoader {
  private persona: string = DEFAULT_PERSONA
  private activePersonaFile: string = 'persona.md'
  // Per-guild persona overrides discovered from `persona.<guildId>.md`
  // sibling files in the state dir. Loaded once at boot via load() and
  // refreshed on subsequent reloads.
  private guildPersonas: Map<string, string> = new Map()
  private pinnedFacts: PinnedFactsStore | null = null
  private summaryStore: SummaryStore | null = null

  setPinnedFactsStore(store: PinnedFactsStore): void {
    this.pinnedFacts = store
  }

  setSummaryStore(store: SummaryStore): void {
    this.summaryStore = store
  }

  async load(filename?: string): Promise<void> {
    if (filename) this.activePersonaFile = filename
    this.persona = await this.readPersona(this.activePersonaFile)
    await this.discoverGuildPersonas()
  }

  private async discoverGuildPersonas(): Promise<void> {
    this.guildPersonas.clear()
    try {
      const entries = await fs.readdir(stateDir())
      for (const name of entries) {
        // Discord snowflakes are 17-20 digits. Tolerant filename match so
        // we don't accidentally pick up persona.md.bak or similar.
        const m = name.match(/^persona\.(\d{17,20})\.md$/)
        if (!m) continue
        const text = await this.readPersona(name)
        this.guildPersonas.set(m[1], text)
      }
    } catch (e: any) {
      if (e.code !== 'ENOENT') throw e
    }
  }

  private async readPersona(filename: string): Promise<string> {
    const file = path.join(stateDir(), filename)
    try {
      const text = (await fs.readFile(file, 'utf8')).trim()
      return text || DEFAULT_PERSONA
    } catch (e: any) {
      if (e.code === 'ENOENT') return DEFAULT_PERSONA
      throw e
    }
  }

  buildSystemPrompt(channelId: string, guildId?: string | null): string {
    // Per-guild persona overrides the default when one is set for this guild
    // (DM channels have no guildId — fall through to default). Lookup is
    // O(1) on the in-memory Map populated at load() time.
    const persona = (guildId && this.guildPersonas.get(guildId)) || this.persona
    const pinned = this.pinnedFacts?.readForChannelSync(channelId) ?? ''
    const summary = this.summaryStore?.get(channelId)?.summary ?? ''
    const sections: string[] = [persona]
    if (summary) {
      sections.push(`## Conversation summary (older context)\n\n${summary}`)
    }
    if (pinned) {
      sections.push(`## Pinned facts for this channel\n\n${pinned}`)
    }
    return sections.join('\n\n---\n\n')
  }
}
