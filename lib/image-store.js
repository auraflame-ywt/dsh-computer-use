/**
 * Screenshot files and their model-facing image attachments.
 *
 * Captures always land on disk so a human can open them, and are additionally
 * attached as an `ImageBlock` when the deployment has an attachment store and
 * the calling model route declares image input. A text-only route still gets a
 * usable path, which keeps desktop and browser automation honest about what the
 * model can actually see.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Filesystem-safe local timestamp used by every generated artifact name. */
export function stamp() {
  return new Date().toISOString().replace('T', '-').replace(/[:.]/g, '').replace('Z', '')
}

export function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

/** Whether the calling route declares image input. */
async function routeAcceptsImages(ctx, exec) {
  try {
    const llm = ctx.get('llm')
    if (llm === undefined) return true
    const routed = exec.agent?.session?.requestHeader?.()?.config
    const provider = routed?.provider ?? exec.agent?.options?.provider
    const model = routed?.model ?? exec.agent?.options?.model
    if (provider === undefined || model === undefined) return true
    const info = await llm.resolveModelInfo(provider, model, exec.signal)
    const modalities = info?.inputModalities
    if (!Array.isArray(modalities)) return true
    return modalities.includes('image')
  } catch {
    return true
  }
}

export function createImageStore({ ctx, settings }) {
  return {
    /** Write image bytes to `requestedPath`, or to a generated name. */
    save(buffer, extension, requestedPath, prefix = 'shot') {
      const target =
        typeof requestedPath === 'string' && requestedPath.trim().length > 0
          ? requestedPath
          : join(ensureDir(settings.shotDir), `${prefix}-${stamp()}.${extension}`)
      const cut = Math.max(target.lastIndexOf('\\'), target.lastIndexOf('/'))
      if (cut > 0) ensureDir(target.slice(0, cut))
      writeFileSync(target, buffer)
      return target
    },

    /**
     * Attach an on-disk image to the tool result.
     * @returns {Promise<object|undefined>} the ImageBlock payload, or undefined
     *   when the deployment or the calling route cannot carry images.
     */
    async attach(path, mediaType, exec) {
      if (settings.attachScreenshots === false) return undefined
      if (!(await routeAcceptsImages(ctx, exec))) return undefined
      const attachments = ctx.get('attachments')
      if (attachments === undefined) return undefined
      const ref = await attachments.saveImage({
        data: readFileSync(path),
        mediaType,
        name: path.split(/[\\/]/).pop(),
      })
      return {
        attachmentId: ref.attachmentId,
        mediaType: ref.mediaType,
        bytes: ref.bytes,
        width: ref.width,
        height: ref.height,
        ...(ref.name === undefined ? {} : { name: ref.name }),
      }
    },
  }
}
