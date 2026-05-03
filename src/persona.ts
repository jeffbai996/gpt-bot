import fs from 'fs/promises'
import path from 'path'
import os from 'os'

const DEFAULT_PERSONA = `You are gpt, a Discord bot backed by an OpenAI model. Be helpful, concise, and match the channel's tone. You can respond with text, an emoji reaction, or both.`

function stateDir(): string {
  return process.env.GPT_STATE_DIR || path.join(os.homedir(), '.gpt', 'channels', 'discord')
}

export class PersonaLoader {
  private persona: string = DEFAULT_PERSONA
  private activePersonaFile: string = 'persona.md'

  async load(filename?: string): Promise<void> {
    if (filename) this.activePersonaFile = filename
    this.persona = await this.readPersona(this.activePersonaFile)
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

  buildSystemPrompt(_channelId: string): string {
    // v0.2: persona only. Pinned-facts + summaries hooked in later versions.
    return this.persona
  }
}
