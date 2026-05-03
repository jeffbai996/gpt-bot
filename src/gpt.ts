import { Client, GatewayIntentBits, Partials, ActivityType, REST, Routes, type Message, type TextChannel, type DMChannel, type ThreadChannel } from 'discord.js'
import path from 'path'
import os from 'os'
import dotenv from 'dotenv'
import { AccessManager } from './access.ts'
import { PersonaLoader } from './persona.ts'
import { chunk } from './chunk.ts'
import { gptCommand, executeGptCommand } from './commands.ts'
import { OpenAIClient, OpenAIRequestRejected } from './openai.ts'
import type { LifecycleEvent } from './openai.ts'
import { fetchHistory, formatHistoryForOpenAI } from './history.ts'
import { processAttachments } from './attachments.ts'
import { applyLifecycle } from './reactions/lifecycle.ts'
import { buildDefaultRegistry } from './tools/index.ts'
import { MemoryStore, embed } from './memory.ts'
import { PinnedFactsStore } from './pinned-facts.ts'
import { PendingEditsStore } from './reactions/pending-edits.ts'
import { handleReaction } from './reactions/handler.ts'
import OpenAI from 'openai'

const STATE_DIR = process.env.GPT_STATE_DIR || path.join(os.homedir(), '.gpt', 'channels', 'discord')
dotenv.config({ path: path.join(STATE_DIR, '.env') })

if (!process.env.DISCORD_BOT_TOKEN) {
  console.error(`FATAL: DISCORD_BOT_TOKEN missing. Set in ${path.join(STATE_DIR, '.env')}`)
  process.exit(1)
}
if (!process.env.DISCORD_APP_ID) {
  console.error(`FATAL: DISCORD_APP_ID missing. Set in ${path.join(STATE_DIR, '.env')}`)
  process.exit(1)
}
if (!process.env.OPENAI_API_KEY) {
  console.error(`FATAL: OPENAI_API_KEY missing. Set in ${path.join(STATE_DIR, '.env')}`)
  process.exit(1)
}

const DISCORD_TOKEN: string = process.env.DISCORD_BOT_TOKEN
const APP_ID: string = process.env.DISCORD_APP_ID
const OPENAI_KEY: string = process.env.OPENAI_API_KEY
const DEFAULT_MODEL: string = process.env.GPT_MODEL || 'gpt-5.5'
const ADMIN_USER_ID: string | undefined = process.env.DISCORD_ADMIN_USER_ID

const access = new AccessManager()
const persona = new PersonaLoader()
const pendingEdits = new PendingEditsStore()
const pinnedFacts = new PinnedFactsStore(path.join(STATE_DIR, 'pinned-facts.md'))
persona.setPinnedFactsStore(pinnedFacts)
const openai = new OpenAIClient(OPENAI_KEY, DEFAULT_MODEL)
// Raw SDK client for non-chat endpoints (audio.transcriptions, embeddings,
// web-search side-call). Sharing the same key/instance avoids spinning up two
// HTTP pools.
const openaiRaw = new OpenAI({ apiKey: OPENAI_KEY })

// Memory store may be null if the native sqlite-vss / better-sqlite3 modules
// fail to load on this Node version. The bot still runs; search_memory just
// isn't registered, and passive ingestion is skipped.
const memoryStore = await MemoryStore.open()
if (!memoryStore) {
  console.error('memory: RAG disabled (native module load failed); set up Node 22+ to enable')
}
const toolRegistry = buildDefaultRegistry(openaiRaw, memoryStore)

await access.load()
await persona.load()

process.on('SIGHUP', async () => {
  console.error('SIGHUP received — reloading access.json and persona.md')
  try {
    await access.load()
    await persona.load()
    console.error('reload complete')
  } catch (e) {
    console.error('reload failed:', e)
  }
})

process.on('unhandledRejection', err => console.error('unhandledRejection:', err))
process.on('uncaughtException', err => console.error('uncaughtException:', err))

// Embed + persist a single message in the background. Errors are logged but
// never thrown — ingestion failures shouldn't impact the reply flow.
async function ingestMessage(message: Message): Promise<void> {
  if (!memoryStore) return
  try {
    const emb = await embed(openaiRaw, message.content)
    if (!emb) return
    memoryStore.insertMessage({
      id: message.id,
      channel_id: message.channel.id,
      author_id: message.author.id,
      author_name: message.author.username,
      content: message.content,
      timestamp: new Date(message.createdTimestamp).toISOString()
    }, emb)
  } catch (e) {
    console.error('ingestMessage failed:', e instanceof Error ? e.message : e)
  }
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.DirectMessageReactions,
    GatewayIntentBits.DirectMessageTyping,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel, Partials.Message, Partials.User, Partials.Reaction]
})

client.once('ready', async () => {
  console.error(`gpt online as ${client.user?.tag} (${client.user?.id})`)
  client.user?.setPresence({
    status: 'online',
    activities: [{ name: 'thinking', type: ActivityType.Custom, state: 'thinking' }]
  })

  try {
    const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN)
    await rest.put(Routes.applicationCommands(APP_ID), { body: [gptCommand.toJSON()] })
    console.error('slash commands registered')
  } catch (e) {
    console.error('slash command registration failed:', e)
  }
})

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return
  if (interaction.commandName !== 'gpt') return
  await executeGptCommand(interaction, access, persona, ADMIN_USER_ID)
})

// Core message-handling pipeline. Reused by:
//   - messageCreate (normal user message → fresh reply)
//   - regenerate reaction (re-runs against the same user message, edits the
//     bot's existing reply rather than posting again)
//   - expand reaction (re-runs with a "go deeper" preamble; new reply)
//   - markForEdit pending-edit consumer (next user message edits the marked
//     bot message in place)
//
// targetMessage non-null → edit that bot message instead of posting fresh.
// expansion=true → prepend an "expand on your prior reply" instruction.
async function handleUserMessage(
  message: Message,
  targetMessage: Message | null,
  expansion: boolean
): Promise<void> {
  const channelId = message.channel.id
  const userId = message.author.id
  const flags = access.channelFlags(channelId)
  const model = flags.model ?? DEFAULT_MODEL
  const systemPrompt = persona.buildSystemPrompt(channelId)
  const selfId = client.user?.id ?? ''

  let history: ReturnType<typeof formatHistoryForOpenAI> = []
  try {
    if (
      message.channel.type === 0 /* GuildText */ ||
      message.channel.type === 1 /* DM */ ||
      message.channel.type === 11 /* PublicThread */ ||
      message.channel.type === 12 /* PrivateThread */ ||
      message.channel.type === 5 /* GuildAnnouncement */
    ) {
      const raw = await fetchHistory(message.channel as TextChannel | DMChannel | ThreadChannel, message.id)
      history = formatHistoryForOpenAI(raw, selfId)
    }
  } catch (e) {
    console.error('history fetch failed:', e)
  }

  await applyLifecycle(message, 'received')

  const attachments = [...message.attachments.values()]
  let imageParts: NonNullable<Parameters<typeof openai.respond>[0]['imageParts']> = []
  let extraText = ''
  if (attachments.length > 0) {
    await applyLifecycle(message, 'ingesting')
    try {
      const processed = await processAttachments(attachments, openaiRaw)
      imageParts = processed.imageParts
      extraText = processed.text
    } catch (e) {
      console.error('attachment processing failed:', e)
    }
  }

  // The expansion preamble is just a small steer appended to extraText so
  // the model knows to add detail rather than re-roll the same answer. Lives
  // here rather than in the persona so it only fires for the 🔍 path.
  if (expansion) {
    extraText = (extraText ? extraText + '\n\n' : '') +
      '[Expansion request: the user wants you to go deeper on your most recent reply in this channel — add detail, examples, or counter-points. Don\'t repeat what you already said; build on it.]'
  }

  let workMessage: Message | null = targetMessage
  if (!workMessage) {
    try {
      workMessage = await message.reply('💭 thinking…')
    } catch (e) {
      console.error('placeholder reply failed:', e)
    }
  }

  // Throttle Discord edits during streaming.
  let lastEditAt = 0
  let lastEditedText = ''
  const EDIT_INTERVAL_MS = 700

  const onEvent = (event: LifecycleEvent) => {
    if (event.type === 'thinking_start') { void applyLifecycle(message, 'thinking'); return }
    if (event.type === 'searching') { void applyLifecycle(message, 'searching'); return }
    if (event.type === 'tool_start') { void applyLifecycle(message, 'tooling'); return }
    if (event.type === 'partial' && workMessage) {
      const now = Date.now()
      if (now - lastEditAt < EDIT_INTERVAL_MS) return
      const display = event.reply.trim()
      if (!display || display === lastEditedText) return
      const max = 1900
      const truncated = display.length > max ? display.slice(0, max) + '…' : display
      lastEditAt = now
      lastEditedText = display
      workMessage.edit(truncated).catch(() => { /* fire-and-forget */ })
    }
  }

  try {
    const result = await openai.respond({
      systemPrompt,
      history,
      userMessage: message.content,
      userName: message.author.username,
      model,
      reasoningEffort: flags.reasoning,
      imageParts,
      extraText,
      toolRegistry,
      channelId,
      userId,
      onEvent
    })

    if (result.react) {
      try { await message.react(result.react) } catch (e) { console.error('react failed:', e) }
    }

    const verbose = flags.verbose && result.usage
      ? `\n-# \`↑ ${result.usage.inputTokens.toLocaleString('en-US')} · ↓ ${result.usage.outputTokens.toLocaleString('en-US')} · » ${(result.durationMs / 1000).toFixed(1)}s · ${result.modelUsed}\``
      : ''

    const body = (result.reply ?? '').trim() + verbose

    if (!body.trim()) {
      await applyLifecycle(message, 'silenced')
      if (workMessage && !targetMessage) {
        try { await workMessage.delete() } catch {}
      }
      return
    }

    const parts = chunk(body)
    for (let i = 0; i < parts.length; i++) {
      if (i === 0 && workMessage) {
        await workMessage.edit(parts[i])
      } else if (i === 0) {
        await message.reply(parts[i])
      } else if (message.channel.isSendable()) {
        await message.channel.send(parts[i])
      }
    }

    if (result.finishReason === 'length') {
      await applyLifecycle(message, 'truncated')
    } else {
      await applyLifecycle(message, 'replied')
    }
  } catch (e: any) {
    const isRejected = e instanceof OpenAIRequestRejected
    if (isRejected && e.reason === 'content_policy') {
      await applyLifecycle(message, 'blocked')
    } else if (isRejected) {
      await applyLifecycle(message, 'denied')
    } else {
      await applyLifecycle(message, 'errored')
    }
    const errMsg = isRejected ? `⚠️ ${e.reason}` : `❌ error: ${e?.message ?? String(e)}`
    console.error('respond failed:', e)
    try {
      if (workMessage) await workMessage.edit(errMsg)
      else await message.reply(errMsg)
    } catch {}
  }
}

client.on('messageCreate', async (message: Message) => {
  if (message.author.bot) return

  const channelId = message.channel.id
  const userId = message.author.id
  const isMention = client.user ? message.mentions.users.has(client.user.id) : false

  if (memoryStore && message.content.trim() && access.isAllowedAndEnabled(userId, channelId)) {
    void ingestMessage(message)
  }

  if (!access.canHandle({ channelId, userId, isMention })) return

  // Pending-edit consumer: if a prior bot message in this channel was marked
  // for edit (✏️), this user message edits it in place rather than spawning
  // a fresh reply. Resolves the marker either way.
  let target: Message | null = null
  const pendingEditId = pendingEdits.get(channelId)
  if (pendingEditId) {
    pendingEdits.clear(channelId)
    try {
      target = await message.channel.messages.fetch(pendingEditId)
    } catch (e) {
      console.error('pending-edit fetch failed:', e)
      target = null
    }
  }

  await handleUserMessage(message, target, false)
})

client.on('messageReactionAdd', async (reaction, user) => {
  await handleReaction(reaction, user, {
    client,
    access,
    buildContext: (msg, reactor) => ({
      message: msg,
      reactor,
      client,
      access,
      persona,
      pendingEdits,
      pinnedFacts,
      rerunHandler: handleUserMessage
    })
  })
})

client.login(DISCORD_TOKEN)
