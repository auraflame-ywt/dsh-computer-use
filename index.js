/**
 * DSH computer-use bundle: Windows desktop control, screenshots, screen
 * recording and Chromium automation, exposed as model-facing tools.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BrowserSession, createBrowserTools } from './lib/browser.js'
import { RecordingManager, createComputerTools } from './lib/computer.js'
import { createImageStore } from './lib/image-store.js'
import { ComputerWorker } from './lib/worker-client.js'

export const inject = ['tools']

const DEFAULTS = {
  maxScreenshotWidth: 1600,
  jpegQuality: 82,
  attachScreenshots: true,
  recordFps: 6,
  recordMaxSeconds: 30,
  recordMaxWidth: 960,
  snapshotMaxChars: 12000,
  browser: 'auto',
  browserExecutable: null,
  headless: false,
  browserWidth: 1440,
  browserHeight: 900,
  browserArgs: [],
  commandTimeoutMs: 30000,
}

function resolveSettings(config) {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const outputDir = typeof config.outputDir === 'string' && config.outputDir.length > 0
    ? config.outputDir
    : join(home, 'computer-use')
  return {
    ...DEFAULTS,
    ...config,
    outputDir,
    shotDir: join(outputDir, 'shots'),
  }
}

export function apply(ctx, config = {}) {
  const settings = resolveSettings(config)
  const scriptPath = fileURLToPath(new URL('./lib/windows.ps1', import.meta.url))
  const worker = new ComputerWorker({ scriptPath, timeoutMs: settings.commandTimeoutMs })
  const images = createImageStore({ ctx, settings })
  const recordings = new RecordingManager({ worker, settings })
  const browser = new BrowserSession({ settings, images })
  const tools = [
    ...createComputerTools({ settings, worker, recordings, images }),
    ...createBrowserTools({ settings, images, session: browser }),
  ]

  ctx.effect(() => {
    const disposers = tools.map((tool) => ctx.tools.register(tool))
    return async () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {}
      }
      await browser.close()
      await recordings.dispose()
      await worker.dispose()
    }
  })
}
