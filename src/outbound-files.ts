/**
 * Which local files a reply is asking Discord to carry.
 *
 * This lived inline in claude.ts as a screenshot auto-attacher: three regexes,
 * all ending in (png|jpe?g|gif|webp), variables named `shots`. It worked, and
 * it meant the bot could not attach anything else — a `.md` never matched, so
 * `files` stayed empty and the reply went out as plain text. Jeff 2026-09-08:
 * "claude-bot seems to be unable to attach a discord .md, all the other bots
 * can". The other bots pass files as a tool parameter; this one only ever had
 * a text channel and a grep.
 *
 * Images and documents get DIFFERENT rules on purpose.
 *
 * An image may be named bare — `shot.png` — and is resolved by basename against
 * the screenshot directories, because that is how a CLI reports a capture it
 * just took. A document may not. Models write "see README.md" in ordinary prose
 * constantly, and the image rule searches $HOME by basename, so applying it to
 * documents would delete those words from the message and upload whatever
 * happened to match. A document therefore needs an explicit form AND an
 * absolute path that exists: nothing is guessed.
 *
 * Everything is size-capped. Discord rejects oversized uploads and the send
 * throws, which previously took the whole reply with it.
 */
export const IMAGE_EXT = 'png|jpe?g|gif|webp'
export const DOC_EXT = 'md|markdown|txt|csv|tsv|json|ya?ml|xml|log|pdf|rtf'

/** Discord's default per-file ceiling. */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024
/** Discord's per-message attachment ceiling. */
export const MAX_FILES = 10

export interface ScanDeps {
  shotDirs: string[]
  /** absolute-path existence check; also used for the basename candidates */
  isFile: (p: string) => boolean
  sizeOf: (p: string) => number
  join: (a: string, b: string) => string
  basename: (p: string) => string
  isAbsolute: (p: string) => boolean
  maxBytes?: number
}

export interface ScanResult {
  /** the reply with image tokens removed (documents keep their prose) */
  reply: string
  /** absolute paths to attach, de-duped and capped */
  files: string[]
  /** paths that matched but were refused, with why — for logging */
  skipped: { path: string, reason: 'too-large' }[]
}

export function scanOutboundFiles(reply: string, deps: ScanDeps): ScanResult {
  const max = deps.maxBytes ?? MAX_UPLOAD_BYTES
  const files: string[] = []
  const skipped: { path: string, reason: 'too-large' }[] = []

  const accept = (p: string): boolean => {
    let size = 0
    try { size = deps.sizeOf(p) } catch { return false }
    if (size > max) { skipped.push({ path: p, reason: 'too-large' }); return false }
    files.push(p)
    return true
  }

  // Images: literal path, else basename under a known screenshot dir.
  const resolveImage = (raw: string): string | null => {
    const cands = [raw, ...deps.shotDirs.map(d => deps.join(d, deps.basename(raw)))]
    for (const c of cands) { try { if (deps.isFile(c)) return c } catch {} }
    return null
  }
  // Documents: the literal path only, and only if absolute. No basename search.
  const resolveDoc = (raw: string): string | null => {
    if (!deps.isAbsolute(raw)) return null
    try { return deps.isFile(raw) ? raw : null } catch { return null }
  }

  const grabImage = (m: string, p: string): string => {
    const real = resolveImage(p)
    return real && accept(real) ? '' : m          // image token is replaced BY the image
  }

  let out = reply
    .replace(new RegExp(`!?\\[[^\\]]*\\]\\(([^)\\s]+\\.(?:${IMAGE_EXT}))\\)`, 'gi'),
             (m, p) => grabImage(m, p))
    .replace(new RegExp('`([^`\\s]+\\.(?:' + IMAGE_EXT + '))`', 'gi'),
             (m, p) => grabImage(m, p))
    .replace(new RegExp(`(?<![\\w/])((?:\\/[^\\s)]+|[\\w.-]+)\\.(?:${IMAGE_EXT}))(?![\\w])`, 'gi'),
             (m, p) => grabImage(m, p))

  // Documents. A markdown link collapses to its label — Discord renders no link
  // for a local path, so leaving the parenthesised path shows raw text.
  out = out.replace(
    new RegExp(`\\[([^\\]]*)\\]\\((\\/[^)\\s]+\\.(?:${DOC_EXT}))\\)`, 'gi'),
    (m, label, p) => {
      const real = resolveDoc(p)
      return real && accept(real) ? String(label) : m
    })
  // A backticked absolute path keeps its prose: the sentence usually reads
  // "it is at `/path`", and deleting the path leaves it dangling.
  out = out.replace(
    new RegExp('`(\\/[^`\\s]+\\.(?:' + DOC_EXT + '))`', 'gi'),
    (m, p) => {
      const real = resolveDoc(p)
      if (real) accept(real)
      return m
    })

  const uniq = [...new Set(files)].slice(0, MAX_FILES)
  const cleaned = uniq.length
    ? out.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim()
    : reply
  return { reply: cleaned, files: uniq, skipped }
}
