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
import { applyLifecycle } from './reactions/lifecycle.ts'

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
const openai = new OpenAIClient(OPENAI_KEY, DEFAULT_MODEL)

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

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
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

client.on('messageCreate', async (message: Message) => {
  // Bot-vs-bot loop guard.
  if (message.author.bot) return

  const channelId = message.channel.id
  const userId = message.author.id
  const isMention = client.user ? message.mentions.users.has(client.user.id) : false

  if (!access.canHandle({ channelId, userId, isMention })) return

  const flags = access.channelFlags(channelId)
  const model = flags.model ?? DEFAULT_MODEL
  const systemPrompt = persona.buildSystemPrompt(channelId)
  const selfId = client.user?.id ?? ''

  // History fetch is best-effort — if it fails, we still try to respond using
  // just the current message. Channel-type narrowing: text/DM/thread channels
  // have a fetchable messages collection; nothing else we care about does.
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

  // 👀 received — fires before any work, so the user knows the bot saw their
  // message even if the model call takes a while.
  await applyLifecycle(message, 'received')

  let placeholder: Message | null = null
  try {
    placeholder = await message.reply('💭 thinking…')
  } catch (e) {
    console.error('placeholder reply failed:', e)
  }

  // Throttle Discord edits during streaming. Discord rate-limits message edits
  // and frequent edits also feel jittery — every ~700ms is the sweet spot.
  let lastEditAt = 0
  let lastEditedText = ''
  const EDIT_INTERVAL_MS = 700

  const onEvent = (event: LifecycleEvent) => {
    if (event.type === 'thinking_start') {
      void applyLifecycle(message, 'thinking')
      return
    }
    if (event.type === 'partial' && placeholder) {
      const now = Date.now()
      if (now - lastEditAt < EDIT_INTERVAL_MS) return
      const display = event.reply.trim()
      if (!display || display === lastEditedText) return
      // Truncate to a single chunk for streaming display — we'll do the
      // proper multi-chunk split at the end. Reserve a few chars for the
      // ellipsis suffix so we don't blow past the limit on the next tick.
      const max = 1900
      const truncated = display.length > max ? display.slice(0, max) + '…' : display
      lastEditAt = now
      lastEditedText = display
      placeholder.edit(truncated).catch(() => { /* fire-and-forget */ })
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
      // Silent-exit. No emoji tombstone — clear transients, drop placeholder.
      await applyLifecycle(message, 'silenced')
      if (placeholder) {
        try { await placeholder.delete() } catch {}
      }
      return
    }

    const parts = chunk(body)
    for (let i = 0; i < parts.length; i++) {
      if (i === 0 && placeholder) {
        await placeholder.edit(parts[i])
      } else if (i === 0) {
        await message.reply(parts[i])
      } else if (message.channel.isSendable()) {
        await message.channel.send(parts[i])
      }
    }

    // Terminal lifecycle. `length` (truncated) wins over `replied` because
    // the user should see the cut-off marker.
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
    const errMsg = isRejected
      ? `⚠️ ${e.reason}`
      : `❌ error: ${e?.message ?? String(e)}`
    console.error('respond failed:', e)
    try {
      if (placeholder) await placeholder.edit(errMsg)
      else await message.reply(errMsg)
    } catch {}
  }
})

client.login(DISCORD_TOKEN)
