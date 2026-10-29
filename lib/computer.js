/**
 * Model-facing desktop automation tools for Windows.
 *
 * Every operation is a round trip to the long-lived PowerShell worker in
 * `windows.ps1`; this module owns the tool contracts, file naming, image
 * attachment, and the recorder that turns captured stills into a GIF.
 */
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { encodeIndexedGif, quantizeFrame } from './gif.js'
import { ensureDir, stamp } from './image-store.js'

const textBlock = (text) => [{ type: 'text', text }]

const IMAGE_VALUE_SCHEMA = {
  type: 'object',
  properties: {
    attachmentId: { type: 'string' },
    mediaType: { type: 'string' },
    bytes: { type: 'integer' },
    width: { type: 'integer' },
    height: { type: 'integer' },
    name: { type: 'string' },
  },
}

/**
 * A screen recording in flight: a capture loop that writes stills, then an
 * encode step that walks them back into one file.
 */
class Recording {
  #worker
  #settings
  #frames = []
  #indexFrames = null
  #width = 0
  #height = 0
  #stopped = false
  #loopDone = null
  #error = null
  #startedAt = Date.now()
  #params

  constructor({ id, dir, params, worker, settings }) {
    this.id = id
    this.dir = dir
    this.#params = params
    this.#worker = worker
    this.#settings = settings
  }

  get stats() {
    return {
      id: this.id,
      dir: this.dir,
      frames: this.#frames.length,
      elapsedMs: Date.now() - this.#startedAt,
      width: this.#width,
      height: this.#height,
      error: this.#error,
    }
  }

  start() {
    const params = this.#params
    const frameDir = ensureDir(join(this.dir, 'frames'))
    const fps = Math.max(1, Math.min(15, params.fps))
    const interval = 1000 / fps
    const maxFrames = Math.max(2, Math.min(900, Math.round(fps * params.maxSeconds)))
    this.#loopDone = (async () => {
      while (!this.#stopped && this.#frames.length < maxFrames) {
        const tick = Date.now()
        const path = join(frameDir, `f${String(this.#frames.length + 1).padStart(5, '0')}.jpg`)
        try {
          const frame = await this.#worker.request(
            'captureFile',
            {
              path,
              format: 'jpeg',
              quality: params.quality,
              maxWidth: params.maxWidth,
              window: params.window,
              region: params.region,
            },
            { timeoutMs: 20000 },
          )
          if (this.#width === 0) {
            this.#width = frame.width
            this.#height = frame.height
          }
          this.#frames.push(path)
        } catch (error) {
          this.#error = error instanceof Error ? error.message : String(error)
          break
        }
        const spent = Date.now() - tick
        const remaining = interval - spent
        if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining))
      }
    })()
    return this
  }

  stop() {
    this.#stopped = true
    return this.#loopDone
  }

  /** Turn the captured stills into palette-indexed frames and write the GIF. */
  async encodeGif() {
    if (this.#frames.length === 0) throw new Error('the recording captured no frames')
    const frames = []
    for (const [index, framePath] of this.#frames.entries()) {
      const rawPath = join(this.dir, 'frames', `raw${String(index).padStart(5, '0')}.rgb`)
      try {
        await this.#worker.request('decodeFrame', {
          src: framePath,
          out: rawPath,
          width: this.#width,
          height: this.#height,
        })
        const raw = readFileSync(rawPath)
        frames.push(quantizeFrame(raw))
      } finally {
        rmSync(rawPath, { force: true })
      }
    }
    const fps = Math.max(1, Math.min(15, this.#params.fps))
    const gif = encodeIndexedGif({
      width: this.#width,
      height: this.#height,
      indexFrames: frames,
      delayCs: Math.max(2, Math.round(100 / fps)),
    })
    const target = join(this.dir, `${this.id}.gif`)
    writeFileSync(target, gif)
    return { path: target, bytes: gif.length, frames: frames.length, width: this.#width, height: this.#height }
  }
}

export class RecordingManager {
  #worker
  #settings
  #sessions = new Map()

  constructor({ worker, settings }) {
    this.#worker = worker
    this.#settings = settings
  }

  start(params) {
    const id = `rec-${stamp()}`
    const dir = ensureDir(join(this.#settings.outputDir, 'recordings', id))
    const recording = new Recording({ id, dir, params, worker: this.#worker, settings: this.#settings }).start()
    this.#sessions.set(id, recording)
    return recording
  }

  get(id) {
    return this.#sessions.get(id)
  }

  list() {
    return [...this.#sessions.values()].map((session) => session.stats)
  }

  remove(id) {
    this.#sessions.delete(id)
  }

  async dispose() {
    for (const [, session] of this.#sessions) await session.stop()
    this.#sessions.clear()
  }
}

/**
 * Build the desktop tool definitions.
 * @param {object} input
 * @param {import('@deepseek-ai/cordis').Context} input.ctx plugin context.
 * @param {object} input.settings resolved plugin config.
 * @param {import('./worker-client.js').ComputerWorker} input.worker the shared worker.
 * @param {RecordingManager} input.recordings the shared recorder registry.
 * @returns {object[]} registry-ready tool definitions.
 */
export function createComputerTools({ settings, worker, recordings, images }) {
  return [
    {
      name: 'computer_screenshot',
      description:
        'Capture the Windows screen (all monitors, one monitor, one window, or a rectangle) and return the image plus its saved file path. Use the returned mapping to convert image pixels into screen coordinates before any mouse action.',
      parameters: {
        type: 'object',
        properties: {
          window: { type: 'string', description: '窗口标题（可部分匹配）。给出时只截该窗口。' },
          monitor: { type: 'integer', description: '从 0 开始的显示器编号；不传则截取整个虚拟桌面。' },
          region: {
            type: 'array',
            items: { type: 'integer' },
            description: '屏幕坐标下的 [x, y, width, height] 区域。',
          },
          max_width: { type: 'integer', description: '图片最大宽度（默认 1600），超过则等比缩小。' },
          format: { type: 'string', enum: ['png', 'jpeg'], description: '图片格式，默认 png。' },
          save_path: { type: 'string', description: '另存路径；默认写入插件输出目录。' },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            path: { type: 'string' },
            width: { type: 'integer' },
            height: { type: 'integer' },
            scale: { type: 'number' },
            captureX: { type: 'integer' },
            captureY: { type: 'integer' },
            captureWidth: { type: 'integer' },
            captureHeight: { type: 'integer' },
            monitors: { type: 'array' },
            image: IMAGE_VALUE_SCHEMA,
            note: { type: 'string' },
          },
        },
        render: (_args, value) => {
          const blocks = textBlock(value.note)
          if (value.image !== undefined) blocks.push({ type: 'image', attachment: value.image })
          return blocks
        },
      },
      presentCall: (args) => ({ card: 'generic', title: 'Screen capture', kind: 'read', rawInput: args }),
      timeoutMs: 60000,
      async execute(args, exec) {
        const format = args.format === 'jpeg' ? 'jpeg' : 'png'
        const shot = await worker.request('screenshot', {
          window: args.window,
          monitor: args.monitor,
          region: args.region,
          format,
          maxWidth: args.max_width ?? settings.maxScreenshotWidth,
          quality: settings.jpegQuality,
        })
        const path = images.save(
          Buffer.from(shot.data, 'base64'),
          format === 'jpeg' ? 'jpg' : 'png',
          args.save_path,
        )
        const image = await images.attach(path, format === 'jpeg' ? 'image/jpeg' : 'image/png', exec)
        const scale = shot.scale
        const mapping =
          Math.abs(scale - 1) < 0.001
            ? `图片像素等于屏幕坐标：屏幕 x = 图 x + ${shot.captureX}，屏幕 y = 图 y + ${shot.captureY}`
            : `图片被缩小了 ${scale} 倍：屏幕 x = 图 x / ${scale} + ${shot.captureX}，屏幕 y = 图 y / ${scale} + ${shot.captureY}`
        const monitorText = (shot.monitors ?? [])
          .map((m) => `${m.index}: ${m.width}x${m.height}${m.primary ? ' (主)' : ''}`)
          .join('; ')
        const note = [
          `<path>${path}</path>`,
          `<image>${shot.width}x${shot.height} px</image>`,
          `<capture>${shot.captureWidth}x${shot.captureHeight} at screen ${shot.captureX},${shot.captureY}</capture>`,
          `<monitors>${monitorText}</monitors>`,
          `<mapping>${mapping}</mapping>`,
          image === undefined
            ? '<note>当前模型不接受图片输入，截图已存为文件：用 read_image 或切换到支持图片的模型查看。</note>'
            : '',
        ]
          .filter(Boolean)
          .join('\n')
        return {
          path,
          width: shot.width,
          height: shot.height,
          scale,
          captureX: shot.captureX,
          captureY: shot.captureY,
          captureWidth: shot.captureWidth,
          captureHeight: shot.captureHeight,
          monitors: shot.monitors ?? [],
          ...(image === undefined ? {} : { image }),
          note,
        }
      },
    },
    {
      name: 'computer_mouse',
      description:
        'Move, click, drag and scroll the Windows pointer using absolute screen coordinates. One call performs one gesture; read the result coordinates to confirm where the pointer ended up.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['move', 'click', 'double_click', 'right_click', 'middle_click', 'drag', 'scroll'],
            description: '手势。',
          },
          x: { type: 'integer', description: '屏幕绝对 x 坐标（物理像素）。' },
          y: { type: 'integer', description: '屏幕绝对 y 坐标（物理像素）。' },
          to_x: { type: 'integer', description: 'drag 的终点 x。' },
          to_y: { type: 'integer', description: 'drag 的终点 y。' },
          amount: { type: 'integer', description: 'scroll 的滚轮格数，正数向上、负数向下，默认 3。' },
        },
        required: ['action'],
      },
      output: {
        schema: { type: 'object', additionalProperties: true, properties: { action: { type: 'string' }, x: { type: 'integer' }, y: { type: 'integer' } } },
        render: (_args, value) => textBlock(`鼠标 ${value.action} 完成，指针位于 ${value.x},${value.y}`),
      },
      presentCall: (args) => ({ card: 'generic', title: `Mouse ${args.action}`, kind: 'other', rawInput: args }),
      async execute(args) {
        return await worker.request('mouse', {
          action: args.action,
          x: args.x,
          y: args.y,
          toX: args.to_x,
          toY: args.to_y,
          amount: args.amount,
        })
      },
    },
    {
      name: 'computer_keyboard',
      description:
        'Type text or press keys in the foreground window. `type` pastes through the clipboard so Unicode and CJK work everywhere; `press` sends real key combinations such as "ctrl+s", "alt+tab" or "enter".',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['type', 'press'], description: 'type 输入文本，press 发送按键。' },
          text: { type: 'string', description: 'action=type 时要输入的文本。' },
          keys: {
            type: 'array',
            items: { type: 'string' },
            description: 'action=press 时的按键或组合键，例如 ["ctrl+s"] 或 ["enter","tab"]。',
          },
        },
        required: ['action'],
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) =>
          textBlock(
            value.action === 'type'
              ? `已输入 ${value.typed} 个字符`
              : `已发送按键 ${Array.isArray(value.keys) ? value.keys.join(' , ') : ''}`,
          ),
      },
      presentCall: (args) => ({ card: 'generic', title: `Keyboard ${args.action}`, kind: 'other', rawInput: args }),
      timeoutMs: 90000,
      async execute(args) {
        return await worker.request('key', { action: args.action, text: args.text, keys: args.keys })
      },
    },
    {
      name: 'computer_window',
      description:
        'List visible windows, then focus, minimize, maximize, restore, move, resize or close one by title or handle. Focusing a window is the reliable way to bring an application to the foreground before typing.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['list', 'focus', 'close', 'minimize', 'maximize', 'restore', 'move', 'info'],
            description: '窗口操作。',
          },
          title: { type: 'string', description: '窗口标题（精确或部分匹配）。' },
          handle: { type: 'integer', description: '窗口句柄，优先于 title。' },
          x: { type: 'integer', description: 'move 的屏幕 x。' },
          y: { type: 'integer', description: 'move 的屏幕 y。' },
          width: { type: 'integer', description: 'move 的宽度。' },
          height: { type: 'integer', description: 'move 的高度。' },
        },
        required: ['action'],
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => {
          if (Array.isArray(value.windows)) {
            const lines = value.windows.map(
              (w) =>
                `${w.active ? '*' : ' '} ${w.state.padEnd(9)} ${String(w.handle).padStart(9)} ${w.x},${w.y} ${w.width}x${w.height}  ${w.title} [${w.process}]`,
            )
            return textBlock(`窗口 ${value.count} 个（* = 前台）：\n${lines.join('\n')}`)
          }
          return textBlock(JSON.stringify(value, null, 1))
        },
      },
      presentCall: (args) => ({ card: 'generic', title: `Window ${args.action}`, kind: 'other', rawInput: args }),
      async execute(args) {
        return await worker.request('window', {
          action: args.action,
          title: args.title,
          handle: args.handle,
          x: args.x,
          y: args.y,
          width: args.width,
          height: args.height,
        })
      },
    },
    {
      name: 'computer_ui',
      description:
        'Read the Windows UI Automation tree of a window and drive it without pixel coordinates: refs from action=tree can be clicked, invoked, focused, or set to a value. Prefer this over guessing coordinates when the target is a normal desktop control.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['tree', 'click', 'invoke', 'focus', 'set_value', 'read'],
            description: 'tree 读取控件树，其余动作针对 tree 返回的 ref。',
          },
          window: { type: 'string', description: '窗口标题；省略则用前台窗口。' },
          handle: { type: 'integer', description: '窗口句柄。' },
          ref: { type: 'integer', description: 'tree 返回的元素编号。' },
          value: { type: 'string', description: 'set_value 要写入的文本。' },
          max_elements: { type: 'integer', description: 'tree 最多返回的元素数，默认 900。' },
        },
        required: ['action'],
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => {
          if (typeof value.tree === 'string') {
            return textBlock(`窗口「${value.title}」控件 ${value.count} 个：\n${value.tree}`)
          }
          return textBlock(`${value.action} ref=${value.ref}: ${value.result ?? value.value ?? ''}`)
        },
      },
      presentCall: (args) => ({ card: 'generic', title: `UI ${args.action}`, kind: 'other', rawInput: args }),
      timeoutMs: 90000,
      async execute(args) {
        return await worker.request('ui', {
          action: args.action,
          window: args.window,
          handle: args.handle,
          ref: args.ref,
          value: args.value,
          maxElements: args.max_elements,
        })
      },
    },
    {
      name: 'computer_app',
      description:
        'Launch an application, document, folder or URL (shell execute), list the running applications that own a window, or close one by pid.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['launch', 'list', 'close'], description: '应用操作。' },
          path: { type: 'string', description: 'launch 的目标：exe 路径、文档、目录或 URL。' },
          arguments: { type: 'string', description: 'launch 的命令行参数。' },
          working_directory: { type: 'string', description: 'launch 的工作目录。' },
          pid: { type: 'integer', description: 'close 的进程号。' },
        },
        required: ['action'],
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => {
          if (Array.isArray(value.processes)) {
            const lines = value.processes.map(
              (p) => `${String(p.pid).padStart(7)}  ${p.process.padEnd(24)} ${p.title}`,
            )
            return textBlock(`运行中的应用 ${value.count} 个：\n${lines.join('\n')}`)
          }
          if (value.launched !== undefined) {
            return textBlock(`已启动 ${value.launched}（pid ${value.pid}，进程 ${value.process}，窗口 ${value.handle}）`)
          }
          return textBlock(`已结束进程 ${value.pid}（${value.process}）`)
        },
      },
      presentCall: (args) => ({ card: 'generic', title: `App ${args.action}`, kind: 'execute', rawInput: args }),
      timeoutMs: 60000,
      async execute(args) {
        return await worker.request('app', {
          action: args.action,
          path: args.path,
          arguments: args.arguments,
          workingDirectory: args.working_directory,
          pid: args.pid,
        })
      },
    },
    {
      name: 'computer_clipboard',
      description: 'Read the Windows clipboard text, or replace it. Useful for moving a large payload into an application.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['read', 'write'], description: '剪贴板操作。' },
          text: { type: 'string', description: 'write 时写入的文本。' },
        },
        required: ['action'],
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (args, value) =>
          textBlock(
            args.action === 'read'
              ? `剪贴板 ${value.length} 个字符：\n${value.text}`
              : `已写入剪贴板 ${value.written} 个字符`,
          ),
      },
      presentCall: (args) => ({ card: 'generic', title: `Clipboard ${args.action}`, kind: 'other', rawInput: args }),
      async execute(args, exec) {
        return await worker.request('clipboard', { action: args.action, text: args.text }, {})
      },
    },
    {
      name: 'screen_record',
      description:
        'Record the screen into a file. action=start begins sampling frames from the whole desktop, one window, or a region and returns a recording id; action=stop finishes it and returns the GIF path (or MP4 when ffmpeg is configured); action=status reports frames captured so far. Keep recordings short and stop them explicitly.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['start', 'stop', 'status'], description: '录制操作。' },
          id: { type: 'string', description: 'stop/status 的录制 id；省略时用于唯一或最近一次录制。' },
          fps: { type: 'integer', description: '起始帧率，默认 6，上限 15。' },
          max_seconds: { type: 'integer', description: '最长录制秒数，默认 30。' },
          max_width: { type: 'integer', description: '帧最大宽度，默认 960。' },
          window: { type: 'string', description: '只录制该标题的窗口。' },
          region: {
            type: 'array',
            items: { type: 'integer' },
            description: '只录制屏幕区域 [x, y, width, height]。',
          },
        },
        required: ['action'],
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => textBlock(value.summary),
      },
      presentCall: (args) => ({ card: 'generic', title: `Screen record ${args.action}`, kind: 'other', rawInput: args }),
      timeoutMs: 180000,
      async execute(args) {
        if (args.action === 'start') {
          const recording = recordings.start({
            fps: args.fps ?? settings.recordFps,
            maxSeconds: args.max_seconds ?? settings.recordMaxSeconds,
            maxWidth: args.max_width ?? settings.recordMaxWidth,
            quality: 70,
            window: args.window,
            region: args.region,
          })
          return {
            id: recording.id,
            summary: `开始录制 ${recording.id}（fps ${args.fps ?? settings.recordFps}，最长 ${args.max_seconds ?? settings.recordMaxSeconds} 秒）。稍后用 action=stop 并带上 id=${recording.id} 结束。`,
          }
        }
        if (args.action === 'status') {
          const all = recordings.list()
          const chosen = args.id === undefined ? all[all.length - 1] : all.find((entry) => entry.id === args.id)
          if (chosen === undefined) throw new Error('没有正在进行的录制')
          return { summary: `录制 ${chosen.id}：已采集 ${chosen.frames} 帧，${Math.round(chosen.elapsedMs / 1000)} 秒` }
        }
        const all = recordings.list()
        const target = args.id === undefined ? all[all.length - 1] : all.find((entry) => entry.id === args.id)
        if (target === undefined) throw new Error(`没有找到录制 ${args.id ?? ''}`.trim())
        const recording = recordings.get(target.id)
        if (recording === undefined) throw new Error(`录制 ${target.id} 已结束`)
        await recording.stop()
        const result = await recording.encodeGif()
        recordings.remove(target.id)
        return {
          path: result.path,
          frames: result.frames,
          bytes: result.bytes,
          summary: `录制完成：${result.frames} 帧，${result.width}x${result.height}，${result.path}（${(result.bytes / 1024).toFixed(0)} KB GIF；原始帧在 ${recording.dir}\\frames）`,
        }
      },
    },
  ]
}
