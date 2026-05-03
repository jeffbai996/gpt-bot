import { Client, GatewayIntentBits, Partials, ActivityType, REST, Routes, type Message } from 'discord.js'
import path from 'path'
import os from 'os'
import dotenv from 'dotenv'
import { AccessManager } from './access.ts'
import { PersonaLoader } from './persona.ts'
import { chunk } from './chunk.ts'
import { gptCommand, executeGptCommand } from './commands.ts'

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

const DISCORD_TOKEN: string = process.env.DISCORD_BOT_TOKEN
const APP_ID: string = process.env.DISCORD_APP_ID
const ADMIN_USER_ID: string | undefined = process.env.DISCORD_ADMIN_USER_ID

const access = new AccessManager()
const persona = new PersonaLoader()

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
    activities: [{ name: 'echo-only (v0.2)', type: ActivityType.Custom, state: 'echo-only (v0.2)' }]
  })

  // Register the slash command globally on every boot. Discord deduplicates
  // by command name, so this is idempotent — but updates to the schema
  // (new subcommands, changed descriptions) propagate on next restart.
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
  // Bot-vs-bot loop guard: never respond to other bots (or to ourselves).
  // This is what lets gpt-discord-bot and gem-discord-bot coexist in the
  // same channel without triggering each other.
  if (message.author.bot) return

  const channelId = message.channel.id
  const userId = message.author.id
  const isMention = client.user ? message.mentions.users.has(client.user.id) : false

  if (!access.canHandle({ channelId, userId, isMention })) return

  // v0.2: no LLM yet. Echo the message back so we can verify the discord
  // plumbing (gateway, intents, allowlist, mention-rule, chunking) end-to-end
  // before wiring up OpenAI in v0.3.
  const flags = access.channelFlags(channelId)
  const systemPrompt = persona.buildSystemPrompt(channelId)
  const modelDisplay = flags.model ?? process.env.GPT_MODEL ?? 'gpt-5.5'

  const echoBody = [
    `> echo (v0.2 — no LLM wired up yet)`,
    `**you said:** ${message.content || '_(empty)_'}`,
    `**channel model:** \`${modelDisplay}\` · reasoning=\`${flags.reasoning}\` · showCode=\`${flags.showCode}\` · verbose=\`${flags.verbose}\``,
    `**system prompt length:** ${systemPrompt.length} chars`,
  ].join('\n')

  const parts = chunk(echoBody)
  for (let i = 0; i < parts.length; i++) {
    if (i === 0) {
      await message.reply(parts[i])
    } else if (message.channel.isSendable()) {
      await message.channel.send(parts[i])
    }
  }
})

client.login(DISCORD_TOKEN)
