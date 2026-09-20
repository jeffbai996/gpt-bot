interface LiveWorkMessageOptions {
  effortLabel: string
  activity?: 'thinking' | 'compacting'
  headline?: string
  reasoningTrace?: string[]
  detail?: string
  narrationTrace?: string[]
  footer?: string
  spinnerGlyph?: string
  spinnerDots?: string
  maxLength?: number
}

export function appendNarrationTrace(trace: string[], text: string): string[] {
  const clean = text.trim()
  if (!clean || trace.at(-1) === clean) return trace
  return [...trace, clean]
}

function cleanReasoningLine(line: string): string {
  return line
    .trim()
    .replace(/^>\s*/, '')
    .replace(/^#{1,6}\s+/, '')
    .replace(/^🧠\s*/, '')
    .replace(/^\*\*(.+)\*\*$/, '$1')
    .trim()
}

export function reasoningTraceLines(parts: string[]): string[] {
  return parts
    .flatMap(part => part.split(/\r?\n/))
    .map(cleanReasoningLine)
    .filter(Boolean)
}

export function latestReasoningHeadline(text: string): string {
  const line = text.split(/\r?\n/).map(part => part.trim()).filter(Boolean).at(-1) ?? ''
  return cleanReasoningLine(line)
}

export function formatReasoningSnapshot(
  text: string,
  header: string = '💭 **Thinking:**',
): string {
  const headline = latestReasoningHeadline(text).toLocaleLowerCase('en-US')
  return headline
    ? `${header}\n> 🧠 *${headline}*`
    : header
}

export function formatReasoningTraceSnapshot(
  parts: string[],
  header: string = '💭 **Thinking:**',
): string {
  const lines = reasoningTraceLines(parts)
    .map(line => `> 🧠 *${line.toLocaleLowerCase('en-US')}*`)
  return [header, ...lines].join('\n')
}

const HEARTBEAT_VERBS = [
  'cogitating',
  'pondering',
  'mulling',
  'noodling',
  'ruminating',
  'scheming',
] as const

const HEARTBEAT_GLYPHS = ['✻', '✢', '✱', '✶', '✷', '✸'] as const
const HEARTBEAT_VERB_FRAMES = 4
export function pickHeartbeatVerb(random: () => number = Math.random): string {
  return HEARTBEAT_VERBS[Math.floor(random() * HEARTBEAT_VERBS.length)] ?? HEARTBEAT_VERBS[0]
}

export function nextHeartbeatVerb(current: string): string {
  const index = HEARTBEAT_VERBS.indexOf(current as typeof HEARTBEAT_VERBS[number])
  return HEARTBEAT_VERBS[(index + 1) % HEARTBEAT_VERBS.length] ?? HEARTBEAT_VERBS[0]
}

export function pickHeartbeatGlyph(frame: number): string {
  const index = Math.max(0, Math.floor(frame)) % HEARTBEAT_GLYPHS.length
  return HEARTBEAT_GLYPHS[index] ?? HEARTBEAT_GLYPHS[0]
}

export function heartbeatVisual(frame: number, verb: string): { glyph: string; verb: string } {
  return {
    glyph: pickHeartbeatGlyph(frame),
    verb: frame > 0 && frame % HEARTBEAT_VERB_FRAMES === 0
      ? nextHeartbeatVerb(verb)
      : verb,
  }
}

export function shouldRenderHeartbeat(
  elapsedMs: number,
  _idleMs: number,
  delayMs: number,
): boolean {
  return elapsedMs >= delayMs
}

/** Keep the stale-work indicator quiet during normal long-running turns. */
export function resolveHeartbeatDelay(raw: string | undefined): number {
  const parsed = Number.parseInt(raw ?? '', 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 180_000
}

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000)
  return seconds < 60
    ? `${seconds}s`
    : `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

export function formatHeartbeatFooter(
  elapsedMs: number,
  idleMs: number,
  verb: string,
  glyph: string = HEARTBEAT_GLYPHS[0],
  activity?: string,
): string {
  if (activity) {
    const state = idleMs >= 60_000
      ? `waiting · no output for ${formatDuration(idleMs)}`
      : activity
    return `-# \` ${glyph} ${state} · ${formatDuration(elapsedMs)} elapsed \``
  }
  return `-# \` ${glyph} still ${verb} · ${formatDuration(elapsedMs)} \``
}

export function formatLiveWorkMessage({
  effortLabel,
  activity = 'thinking',
  headline = '',
  reasoningTrace = [],
  detail = '',
  narrationTrace = [],
  footer = '',
  spinnerGlyph = HEARTBEAT_GLYPHS[0],
  spinnerDots = '…',
  maxLength = 1900,
}: LiveWorkMessageOptions): string {
  if (activity === 'compacting') {
    return `📝 ${spinnerGlyph} **Compacting context${spinnerDots}**`
  }
  const header = `💭 ${spinnerGlyph} **${effortLabel}${spinnerDots}**`
  const cleanHeadline = headline.trim().toLocaleLowerCase('en-US')
  const accumulated = reasoningTraceLines(reasoningTrace)
    .map(line => `> 🧠 *${line.toLocaleLowerCase('en-US')}*`)
  const reasoning = accumulated.length
    ? `\n${accumulated.join('\n')}`
    : cleanHeadline ? `\n> 🧠 *${cleanHeadline}*` : ''
  const cleanDetail = narrationTrace.length
    ? narrationTrace.map(part => part.trim()).filter(Boolean).join('\n\n')
    : detail.trim()
  const cleanFooter = footer.trim()
  const suffix = cleanFooter ? `\n\n${cleanFooter}` : ''
  const heading = header + reasoning
  if (!cleanDetail) return heading + suffix

  const prefix = `${heading}\n`
  // Live narration is status, not answer text. Keep every line inside Discord's
  // quote treatment so it cannot read like a premature bot reply.
  const quotedDetail = cleanDetail.split(/\r?\n/).map(line => line ? `> ${line}` : '>').join('\n')
  const available = Math.max(1, maxLength - prefix.length - suffix.length)
  const clippedDetail = quotedDetail.length > available
    ? quotedDetail.slice(0, Math.max(0, available - 1)) + '…'
    : quotedDetail
  return prefix + clippedDetail + suffix
}
