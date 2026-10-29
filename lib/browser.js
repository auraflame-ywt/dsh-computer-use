/**
 * Chromium automation over the DevTools Protocol.
 *
 * A real Edge or Chrome window is launched with an ephemeral debugging port, so
 * the page is driven through CDP: no extra npm dependency, and the browser the
 * user already has. The model works against a text snapshot with `[ref=eN]`
 * handles; clicks are dispatched as real input events at the element's center,
 * so hover state, pointer handlers and canvas hit testing all behave like a
 * person clicking.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { ensureDir, stamp } from './image-store.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Reserve an ephemeral loopback port for the DevTools endpoint. */
function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

function resolveBrowser(settings, requested) {
  const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files'
  const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
  const localAppData = process.env.LOCALAPPDATA ?? ''
  // Google Chrome is preferred; Microsoft Edge is the fallback for machines
  // without it.
  const all = [
    { name: 'chrome', exe: join(programFiles, 'Google\\Chrome\\Application\\chrome.exe') },
    { name: 'chrome', exe: join(programFilesX86, 'Google\\Chrome\\Application\\chrome.exe') },
    { name: 'chrome', exe: join(localAppData, 'Google\\Chrome\\Application\\chrome.exe') },
    { name: 'edge', exe: join(programFilesX86, 'Microsoft\\Edge\\Application\\msedge.exe') },
    { name: 'edge', exe: join(programFiles, 'Microsoft\\Edge\\Application\\msedge.exe') },
  ]
  if (typeof settings.browserExecutable === 'string' && settings.browserExecutable.length > 0) {
    all.unshift({ name: 'custom', exe: settings.browserExecutable })
  }
  const wanted = requested ?? settings.browser ?? 'auto'
  const pool = wanted === 'auto' ? all : all.filter((entry) => entry.name === wanted)
  for (const candidate of pool) {
    if (candidate.exe.length > 0 && existsSync(candidate.exe)) return candidate
  }
  throw new Error(
    `没有找到可用的 Chromium 浏览器（请求：${wanted}）。请安装 Google Chrome 或 Microsoft Edge，或在插件配置里把 browserExecutable 指向 chrome.exe / msedge.exe。`,
  )
}

/**
 * Read a DevTools JSON endpoint, retrying while the HTTP server finishes
 * starting.
 */
async function fetchDevToolsJson(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(5000) })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return await response.json()
    } catch (error) {
      lastError = error
      await sleep(150)
    }
  }
  throw new Error(`无法读取 ${url}：${lastError?.message ?? '未知错误'}`)
}

class Cdp {
  #socket
  #nextId = 1
  #pending = new Map()
  #handlers = new Map()
  #closed = false

  static open(url, timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url)
      const timer = setTimeout(() => {
        try {
          socket.close()
        } catch {}
        reject(new Error(`DevTools WebSocket 在 ${timeoutMs} ms 内没有连上`))
      }, timeoutMs)
      socket.addEventListener(
        'open',
        () => {
          clearTimeout(timer)
          resolve(new Cdp(socket))
        },
        { once: true },
      )
      socket.addEventListener(
        'error',
        () => {
          clearTimeout(timer)
          reject(new Error('DevTools WebSocket 连接失败'))
        },
        { once: true },
      )
    })
  }

  constructor(socket) {
    this.#socket = socket
    socket.addEventListener('message', (event) => this.#onMessage(event))
    socket.addEventListener('close', () => {
      this.#closed = true
      for (const [, entry] of this.#pending) {
        clearTimeout(entry.timer)
        entry.reject(new Error('浏览器连接已断开'))
      }
      this.#pending.clear()
    })
  }

  get closed() {
    return this.#closed
  }

  #onMessage(event) {
    const data = typeof event.data === 'string' ? event.data : Buffer.from(event.data).toString('utf8')
    let message
    try {
      message = JSON.parse(data)
    } catch {
      return
    }
    if (message.id !== undefined) {
      const entry = this.#pending.get(message.id)
      if (entry === undefined) return
      this.#pending.delete(message.id)
      clearTimeout(entry.timer)
      if (message.error) {
        entry.reject(new Error(`${message.error.message}${message.error.data ? ` (${message.error.data})` : ''}`))
      } else {
        entry.resolve(message.result)
      }
      return
    }
    const key = `${message.sessionId ?? ''}\u0000${message.method}`
    const listeners = this.#handlers.get(key)
    if (listeners === undefined) return
    for (const listener of [...listeners]) {
      try {
        listener(message.params)
      } catch {}
    }
  }

  on(method, handler, sessionId = '') {
    const key = `${sessionId}\u0000${method}`
    const listeners = this.#handlers.get(key) ?? new Set()
    listeners.add(handler)
    this.#handlers.set(key, listeners)
    return () => listeners.delete(handler)
  }

  send(method, params = {}, sessionId, timeoutMs = 30000) {
    if (this.#closed) return Promise.reject(new Error('浏览器连接已断开'))
    const id = this.#nextId++
    const payload = { id, method, params }
    if (sessionId !== undefined) payload.sessionId = sessionId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new Error(`CDP ${method} 在 ${timeoutMs} ms 内没有响应`))
      }, timeoutMs)
      this.#pending.set(id, { resolve, reject, timer })
      try {
        this.#socket.send(JSON.stringify(payload))
      } catch (error) {
        clearTimeout(timer)
        this.#pending.delete(id)
        reject(error)
      }
    })
  }

  close() {
    try {
      this.#socket.close()
    } catch {}
  }
}

/** Serialize a function with its arguments into one self-contained expression. */
function call(fn, args) {
  return `(${fn.toString()}).apply(null, ${JSON.stringify(args)})`
}

/** Build the model-facing snapshot of the current document. */
function snapshotDocument(maxChars) {
  const out = []
  let used = 0
  let refCounter = 0
  const ACTION = new Set([
    'link',
    'button',
    'textbox',
    'searchbox',
    'checkbox',
    'radio',
    'combobox',
    'slider',
    'switch',
    'tab',
    'menuitem',
    'menuitemcheckbox',
    'option',
    'spinbutton',
  ])
  const SKIP = new Set(['script', 'style', 'noscript', 'template', 'head', 'meta', 'link', 'svg', 'path'])
  const roleOf = (el) => {
    const explicit = el.getAttribute('role')
    if (explicit) return explicit
    const tag = el.tagName.toLowerCase()
    if (tag === 'a') return el.hasAttribute('href') ? 'link' : ''
    if (tag === 'button') return 'button'
    if (tag === 'select') return 'combobox'
    if (tag === 'textarea') return 'textbox'
    if (tag === 'input') {
      const type = (el.getAttribute('type') || 'text').toLowerCase()
      if (type === 'button' || type === 'submit' || type === 'reset' || type === 'image') return 'button'
      if (type === 'checkbox') return 'checkbox'
      if (type === 'radio') return 'radio'
      if (type === 'search') return 'searchbox'
      if (type === 'range') return 'slider'
      if (type === 'hidden') return ''
      return 'textbox'
    }
    if (/^h[1-6]$/.test(tag)) return 'heading'
    if (tag === 'img') return 'img'
    if (tag === 'ul' || tag === 'ol') return 'list'
    if (tag === 'li') return 'listitem'
    if (tag === 'table') return 'table'
    if (tag === 'tr') return 'row'
    if (tag === 'th' || tag === 'td') return 'cell'
    if (tag === 'nav') return 'navigation'
    if (tag === 'main') return 'main'
    if (tag === 'form') return 'form'
    if (tag === 'dialog') return 'dialog'
    if (tag === 'iframe') return 'iframe'
    if (tag === 'label') return 'label'
    if (tag === 'summary') return 'button'
    return ''
  }
  const nameOf = (el) => {
    const aria = el.getAttribute('aria-label')
    if (aria && aria.trim()) return aria.trim()
    const labelledBy = el.getAttribute('aria-labelledby')
    if (labelledBy) {
      const source = document.getElementById(labelledBy)
      if (source && source.innerText) return source.innerText.trim()
    }
    if (el.tagName === 'IMG') return (el.getAttribute('alt') || '').trim()
    const placeholder = el.getAttribute('placeholder')
    if (placeholder && placeholder.trim()) return placeholder.trim()
    const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim()
    if (text) return text
    return (el.getAttribute('title') || '').trim()
  }
  const visible = (el) => {
    const style = getComputedStyle(el)
    if (style.display === 'none' || style.visibility === 'hidden') return false
    const rect = el.getBoundingClientRect()
    return rect.width > 1 && rect.height > 1
  }
  const walk = (el, depth) => {
    if (used >= maxChars || out.length >= 900) return
    const tag = el.tagName ? el.tagName.toLowerCase() : ''
    if (SKIP.has(tag)) return
    const role = roleOf(el)
    const actionable = ACTION.has(role)
    let emitted = false
    if (role && visible(el)) {
      const name = nameOf(el).slice(0, 150)
      const structural =
        role === 'heading' || role === 'dialog' || role === 'table' || role === 'navigation' || role === 'main'
      if (actionable || name || structural) {
        const parts = [role]
        if (name) parts.push(JSON.stringify(name))
        if (actionable) {
          const ref = `e${++refCounter}`
          el.setAttribute('data-dsh-ref', ref)
          parts.push(`[ref=${ref}]`)
        }
        if (tag === 'input' || tag === 'textarea' || tag === 'select') {
          if (typeof el.value === 'string' && el.value.length > 0) {
            parts.push(`value=${JSON.stringify(el.value.slice(0, 80))}`)
          }
        }
        if (tag === 'input' && (el.type === 'checkbox' || el.type === 'radio')) {
          parts.push(el.checked ? 'checked' : 'unchecked')
        }
        if (el.disabled) parts.push('disabled')
        const line = `${'  '.repeat(Math.min(depth, 8))}- ${parts.join(' ')}`
        out.push(line)
        used += line.length + 1
        emitted = true
      }
    }
    for (const child of el.children) walk(child, depth + (emitted ? 1 : 0))
  }
  if (document.body) walk(document.body, 0)
  const header = `url: ${location.href}\ntitle: ${document.title}`
  let body = out.join('\n')
  if (used >= maxChars) body += '\n... (snapshot 已截断)'
  return `${header}\n${body}`
}

/** Locate one element, scroll it into view, and report its viewport center. */
function elementGeometry(ref, selector) {
  const el = ref
    ? document.querySelector(`[data-dsh-ref="${ref}"]`)
    : selector
      ? document.querySelector(selector)
      : null
  if (!el) return null
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
  const rect = el.getBoundingClientRect()
  return {
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2,
    width: rect.width,
    height: rect.height,
    tag: el.tagName.toLowerCase(),
    text: (el.innerText || el.value || '').replace(/\s+/g, ' ').slice(0, 80),
  }
}

/** Focus a field and select everything already in it, ready for insertText. */
function prepareField(ref, selector) {
  const el = ref
    ? document.querySelector(`[data-dsh-ref="${ref}"]`)
    : selector
      ? document.querySelector(selector)
      : null
  if (!el) return null
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
  el.focus({ preventScroll: true })
  if (typeof el.setSelectionRange === 'function' && typeof el.value === 'string') {
    el.setSelectionRange(0, el.value.length)
  } else if (typeof el.select === 'function') {
    el.select()
  } else {
    document.execCommand('selectAll')
  }
  return { tag: el.tagName.toLowerCase(), readOnly: el.readOnly === true, disabled: el.disabled === true }
}

/** Choose one option of a native select and notify the page. */
function selectOptionValue(ref, selector, value) {
  const el = ref
    ? document.querySelector(`[data-dsh-ref="${ref}"]`)
    : selector
      ? document.querySelector(selector)
      : null
  if (!el) return { ok: false, reason: '元素不存在' }
  if (el.tagName !== 'SELECT') return { ok: false, reason: `目标是 ${el.tagName}，不是 select` }
  const options = [...el.options]
  const match =
    options.find((option) => option.value === value) ??
    options.find((option) => (option.textContent ?? '').trim() === value) ??
    options.find((option) => (option.textContent ?? '').includes(value))
  if (match === undefined) {
    return {
      ok: false,
      reason: '没有匹配的选项',
      options: options.slice(0, 25).map((option) => (option.textContent ?? '').trim()),
    }
  }
  el.value = match.value
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
  return { ok: true, selected: (match.textContent ?? '').trim(), value: match.value }
}

const KEY_DEFINITIONS = {
  enter: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
  tab: { key: 'Tab', code: 'Tab', vk: 9 },
  escape: { key: 'Escape', code: 'Escape', vk: 27 },
  backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
  delete: { key: 'Delete', code: 'Delete', vk: 46 },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  up: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  down: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  left: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  right: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  home: { key: 'Home', code: 'Home', vk: 36 },
  end: { key: 'End', code: 'End', vk: 35 },
  pageup: { key: 'PageUp', code: 'PageUp', vk: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', vk: 34 },
  space: { key: ' ', code: 'Space', vk: 32, text: ' ' },
}

/** Map "ctrl+shift+t" onto a CDP key event. */
function parseKeyCombination(combination) {
  const parts = combination
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean)
  let modifiers = 0
  const main = parts[parts.length - 1] ?? ''
  for (const modifier of parts.slice(0, -1)) {
    const lower = modifier.toLowerCase()
    if (lower === 'alt') modifiers |= 1
    else if (lower === 'ctrl' || lower === 'control') modifiers |= 2
    else if (lower === 'meta' || lower === 'cmd') modifiers |= 4
    else if (lower === 'shift') modifiers |= 8
  }
  const known = KEY_DEFINITIONS[main.toLowerCase()]
  if (known !== undefined) return { ...known, modifiers }
  if (main.length === 1) {
    const upper = main.toUpperCase()
    const isDigit = /^[0-9]$/.test(main)
    const code = isDigit ? `Digit${main}` : /^[a-zA-Z]$/.test(main) ? `Key${upper}` : ''
    return {
      key: main,
      code,
      vk: upper.charCodeAt(0),
      modifiers,
      text: modifiers === 0 || modifiers === 8 ? main : undefined,
    }
  }
  throw new Error(`不认识的按键 "${combination}"`)
}

export class BrowserSession {
  #settings
  #images
  #proc = null
  #cdp = null
  #targetId = null
  #sessionId = null
  #console = []
  #info = { browser: '', version: '' }

  constructor({ settings, images }) {
    this.#settings = settings
    this.#images = images
  }

  get connected() {
    return this.#cdp !== null && !this.#cdp.closed && this.#sessionId !== null
  }

  get info() {
    return this.#info
  }

  #recordConsole(params) {
    const level = params.type === 'error' ? 'error' : params.type === 'warning' ? 'warn' : 'log'
    if (level === 'log') return
    const text = (params.args ?? [])
      .map((arg) => arg.value ?? arg.description ?? arg.preview?.description ?? '')
      .join(' ')
      .slice(0, 400)
    if (text.trim().length === 0) return
    this.#console.push(`[${level}] ${text}`)
    if (this.#console.length > 40) this.#console.shift()
  }

  #recordException(params) {
    const details = params.exceptionDetails ?? {}
    const text = details.exception?.description ?? details.text ?? '未知页面异常'
    this.#console.push(`[error] ${String(text).split('\n')[0].slice(0, 400)}`)
    if (this.#console.length > 40) this.#console.shift()
  }

  /** Pop the console errors collected since the last snapshot. */
  drainConsole() {
    const entries = [...this.#console]
    this.#console = []
    return entries.slice(-6)
  }

  async launch(options = {}) {
    if (this.connected) {
      if (options.url) await this.navigate(options.url)
      return this.describe()
    }
    try {
      return await this.#launchOnce(options)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const lockedProfile = message.includes('退出') || message.includes('调试端口')
      await this.close()
      if (!lockedProfile || options.fresh_profile === true) throw error
      // A browser left running on the shared profile hands the request to itself
      // and exits; a fresh profile still gives the model a usable session.
      const result = await this.#launchOnce({ ...options, fresh_profile: true })
      this.#info = { ...this.#info, note: `共用配置被占用，已改用临时配置：${message}` }
      return result
    }
  }

  async #launchOnce(options = {}) {
    const browser = resolveBrowser(this.#settings, options.browser)
    const userDataDir = options.fresh_profile
      ? join(ensureDir(join(this.#settings.outputDir, 'browser')), `profile-${stamp()}`)
      : ensureDir(join(this.#settings.outputDir, 'browser', 'profile'))
    ensureDir(userDataDir)
    const width = options.width ?? this.#settings.browserWidth
    const height = options.height ?? this.#settings.browserHeight
    const extra = Array.isArray(this.#settings.browserArgs) ? this.#settings.browserArgs : []
    const port = await findFreePort()
    const args = [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-features=Translate,MediaRouter',
      `--window-size=${width},${height}`,
      ...(options.headless ? ['--headless=new', '--disable-gpu', '--hide-scrollbars'] : []),
      ...extra,
      'about:blank',
    ]
    this.#proc = spawn(browser.exe, args, { stdio: 'ignore', windowsHide: false })
    let exited = false
    this.#proc.on('exit', () => {
      exited = true
      this.#proc = null
      this.#cdp?.close()
      this.#cdp = null
      this.#sessionId = null
      this.#targetId = null
    })
    const endpoint = `http://127.0.0.1:${port}/json/version`
    const startedAt = Date.now()
    let version
    for (;;) {
      try {
        version = await fetchDevToolsJson(endpoint, 1500)
        break
      } catch (error) {
        if (exited) throw new Error(`浏览器启动后立即退出：${browser.exe}（${error.message}）`)
        if (Date.now() - startedAt > 30000) throw new Error(`浏览器在 30 秒内没有响应调试端口：${error.message}`)
      }
    }
    this.#cdp = await Cdp.open(version.webSocketDebuggerUrl)
    this.#info = { browser: browser.name, version: version.Browser ?? '', exe: browser.exe, port }
    await this.#ensurePage()
    if (options.url) await this.navigate(options.url)
    return this.describe()
  }

  async #ensurePage() {
    if (this.#sessionId !== null) return this.#sessionId
    const { targetInfos } = await this.#cdp.send('Target.getTargets')
    const pages = targetInfos.filter((target) => target.type === 'page')
    const page = pages.find((target) => target.url === 'about:blank') ?? pages[0]
    const targetId = page?.targetId ?? (await this.#cdp.send('Target.createTarget', { url: 'about:blank' })).targetId
    await this.#attach(targetId)
    return this.#sessionId
  }

  async #attach(targetId) {
    const { sessionId } = await this.#cdp.send('Target.attachToTarget', { targetId, flatten: true })
    this.#targetId = targetId
    this.#sessionId = sessionId
    await this.#cdp.send('Page.enable', {}, sessionId)
    await this.#cdp.send('Runtime.enable', {}, sessionId)
    this.#cdp.on('Runtime.consoleAPICalled', (params) => this.#recordConsole(params), sessionId)
    this.#cdp.on('Runtime.exceptionThrown', (params) => this.#recordException(params), sessionId)
    return sessionId
  }

  async ensure() {
    if (!this.connected) await this.launch({})
    return this
  }

  async #evaluate(expression, timeoutMs = 30000) {
    await this.#ensurePage()
    const result = await this.#cdp.send(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true, userGesture: true },
      this.#sessionId,
      timeoutMs,
    )
    if (result.exceptionDetails) {
      const description = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text
      throw new Error(`页面脚本失败：${String(description).split('\n')[0]}`)
    }
    return result.result?.value
  }

  async state() {
    return (await this.#evaluate('({ url: location.href, title: document.title, ready: document.readyState })')) ?? {}
  }

  async #waitReady(timeoutMs = 25000) {
    const deadline = Date.now() + timeoutMs
    let stable = 0
    while (Date.now() < deadline) {
      try {
        const state = await this.#evaluate('document.readyState')
        if (state === 'complete') {
          stable += 1
          if (stable >= 2) {
            await sleep(250)
            return
          }
        } else {
          stable = 0
        }
      } catch {
        stable = 0
      }
      await sleep(150)
    }
    throw new Error('页面在 25 秒内没有加载完成')
  }

  async navigate(url) {
    await this.#ensurePage()
    const normalized = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url) ? url : `https://${url}`
    await this.#cdp.send('Page.navigate', { url: normalized }, this.#sessionId)
    await this.#waitReady()
    return this.state()
  }

  describe() {
    return { connected: this.connected, targetId: this.#targetId, ...this.#info }
  }

  async snapshot(maxChars = 12000) {
    await this.#ensurePage()
    const text = await this.#evaluate(call(snapshotDocument, [maxChars]))
    const state = await this.state()
    return { ...state, snapshot: text ?? '' }
  }

  async #geometry(ref, selector) {
    const geometry = await this.#evaluate(call(elementGeometry, [ref ?? null, selector ?? null]))
    if (geometry === null) throw new Error(`找不到元素：${ref ? `ref=${ref}` : `selector=${selector}`}`)
    return geometry
  }

  async #mouse(geometry, button = 'left', clickCount = 1) {
    const base = { x: geometry.x, y: geometry.y, button, clickCount }
    await this.#cdp.send(
      'Input.dispatchMouseEvent',
      { type: 'mouseMoved', x: geometry.x, y: geometry.y, button: 'none' },
      this.#sessionId,
    )
    await this.#cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base }, this.#sessionId)
    await sleep(30)
    await this.#cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base }, this.#sessionId)
    if (clickCount > 1) {
      await sleep(40)
      await this.#cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base }, this.#sessionId)
      await sleep(30)
      await this.#cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base }, this.#sessionId)
    }
  }

  async click(ref, selector, doubleClick = false) {
    const geometry = await this.#geometry(ref, selector)
    await this.#mouse(geometry, 'left', doubleClick ? 2 : 1)
    await sleep(220)
    return { ran: true, target: geometry.tag, text: geometry.text }
  }

  async hover(ref, selector) {
    const geometry = await this.#geometry(ref, selector)
    await this.#cdp.send(
      'Input.dispatchMouseEvent',
      { type: 'mouseMoved', x: geometry.x, y: geometry.y, button: 'none' },
      this.#sessionId,
    )
    await sleep(180)
    return { ran: true, target: geometry.tag, text: geometry.text }
  }

  async fill(ref, selector, value) {
    const field = await this.#evaluate(call(prepareField, [ref ?? null, selector ?? null]))
    if (field === null) throw new Error(`找不到输入框：${ref ? `ref=${ref}` : `selector=${selector}`}`)
    if (field.disabled) throw new Error('该输入框处于 disabled 状态')
    if (field.readOnly) throw new Error('该输入框是只读的')
    await this.#cdp.send('Input.insertText', { text: value }, this.#sessionId)
    await sleep(120)
    return { ran: true, target: field.tag, length: value.length }
  }

  async press(combination) {
    const key = parseKeyCombination(combination)
    const base = {
      modifiers: key.modifiers,
      key: key.key,
      code: key.code,
      windowsVirtualKeyCode: key.vk,
      nativeVirtualKeyCode: key.vk,
    }
    await this.#cdp.send(
      'Input.dispatchKeyEvent',
      { type: key.text ? 'keyDown' : 'rawKeyDown', ...base, ...(key.text ? { text: key.text } : {}) },
      this.#sessionId,
    )
    await sleep(20)
    await this.#cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base }, this.#sessionId)
    await sleep(120)
    return { ran: true, key: combination }
  }

  async scroll(amount, ref, selector) {
    const geometry = ref || selector ? await this.#geometry(ref, selector) : { x: 400, y: 400 }
    await this.#cdp.send(
      'Input.dispatchMouseEvent',
      { type: 'mouseWheel', x: geometry.x, y: geometry.y, deltaX: 0, deltaY: amount },
      this.#sessionId,
    )
    await sleep(200)
    return { ran: true, deltaY: amount }
  }

  async selectOption(ref, selector, value) {
    const result = await this.#evaluate(call(selectOptionValue, [ref ?? null, selector ?? null, value]))
    if (!result?.ok) {
      throw new Error(
        `选择选项失败：${result?.reason ?? '未知原因'}${result?.options ? `；可选：${result.options.join(' | ')}` : ''}`,
      )
    }
    return { ran: true, selected: result.selected }
  }

  async evaluate(expression) {
    const value = await this.#evaluate(`(async () => { return (${expression}) })()`)
    const serialized = typeof value === 'string' ? value : JSON.stringify(value)
    return { ran: true, result: (serialized ?? 'undefined').slice(0, 6000) }
  }

  async waitFor({ selector, text, ms }) {
    if (typeof ms === 'number' && ms > 0 && selector === undefined && text === undefined) {
      await sleep(ms)
      return { ran: true, waited: ms }
    }
    const deadline = Date.now() + (ms ?? 15000)
    while (Date.now() < deadline) {
      if (selector !== undefined) {
        const found = await this.#evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`).catch(
          () => false,
        )
        if (found) return { ran: true, matched: `selector ${selector}` }
      } else if (text !== undefined) {
        const found = await this.#evaluate(
          `(document.body?.innerText ?? '').includes(${JSON.stringify(text)})`,
        ).catch(() => false)
        if (found) return { ran: true, matched: `text ${text}` }
      } else break
      await sleep(250)
    }
    throw new Error(`等待超时：${selector ?? text ?? `${ms} ms`}`)
  }

  async screenshot(fullPage = false) {
    await this.#ensurePage()
    let params = { format: 'png' }
    if (fullPage) {
      const metrics = await this.#cdp.send('Page.getLayoutMetrics', {}, this.#sessionId)
      const size = metrics.cssContentSize ?? metrics.contentSize
      params = {
        format: 'png',
        captureBeyondViewport: true,
        clip: {
          x: 0,
          y: 0,
          width: Math.max(1, Math.min(Math.ceil(size.width), 2400)),
          height: Math.max(1, Math.min(Math.ceil(size.height), 7000)),
          scale: 1,
        },
      }
    }
    const { data } = await this.#cdp.send('Page.captureScreenshot', params, this.#sessionId, 60000)
    return Buffer.from(data, 'base64')
  }

  async tabs() {
    const { targetInfos } = await this.#cdp.send('Target.getTargets')
    return targetInfos
      .filter((target) => target.type === 'page')
      .map((target, index) => ({
        index,
        targetId: target.targetId,
        current: target.targetId === this.#targetId,
        title: target.title,
        url: target.url,
      }))
  }

  async useTab(index) {
    const tabs = await this.tabs()
    const tab = tabs[index]
    if (tab === undefined) throw new Error(`没有第 ${index} 个标签页；共 ${tabs.length} 个`)
    await this.#attach(tab.targetId)
    return tab
  }

  async openTab(url) {
    const target = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url) ? url : `https://${url}`
    const { targetId } = await this.#cdp.send('Target.createTarget', { url: target })
    const tabs = await this.tabs()
    const index = tabs.findIndex((tab) => tab.targetId === targetId)
    await this.useTab(index)
    await this.#waitReady()
    return index
  }

  async closeTab(index) {
    const tabs = await this.tabs()
    const tab = tabs[index ?? tabs.findIndex((entry) => entry.current)]
    if (tab === undefined) throw new Error('要关闭的标签页不存在')
    await this.#cdp.send('Target.closeTarget', { targetId: tab.targetId })
    if (tab.current) {
      this.#sessionId = null
      this.#targetId = null
      await this.#ensurePage()
    }
    return tab
  }

  async reload() {
    await this.#ensurePage()
    await this.#cdp.send('Page.reload', {}, this.#sessionId)
    await this.#waitReady()
    return this.state()
  }

  async goBack() {
    await this.#evaluate('history.back()')
    await sleep(600)
  }

  async goForward() {
    await this.#evaluate('history.forward()')
    await sleep(600)
  }

  async close() {
    const proc = this.#proc
    this.#cdp?.close()
    this.#cdp = null
    this.#sessionId = null
    this.#targetId = null
    this.#proc = null
    if (proc !== null) {
      try {
        proc.kill()
      } catch {}
      // Released so a browser that outlives the kill cannot keep the host's
      // event loop alive on shutdown.
      try {
        proc.unref()
      } catch {}
    }
  }
}

/**
 * Build the browser tool definitions.
 * @param {{ settings: object, images: object, session: BrowserSession }} input
 * @returns {object[]} registry-ready tool definitions.
 */
export function createBrowserTools({ settings, images, session }) {
  const textBlock = (text) => [{ type: 'text', text }]

  async function captureValue(args, exec) {
    const buffer = await session.screenshot(args.full_page === true)
    const path = images.save(buffer, 'png', undefined, 'page')
    const image = await images.attach(path, 'image/png', exec)
    return { path, image }
  }

  return [
    {
      name: 'browser_open',
      description:
        "Launch the user's own Google Chrome (falling back to Microsoft Edge) through the DevTools protocol and optionally load a URL. Later browser_* calls reuse this window and its saved logins; only one browser session is managed at a time.",
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '要打开的地址；省略则停在空白页。' },
          browser: {
            type: 'string',
            enum: ['auto', 'chrome', 'edge'],
            description: '使用哪个浏览器，默认 auto（优先 Google Chrome，缺失时回退 Microsoft Edge）。',
          },
          headless: {
            type: 'boolean',
            description: '无窗口运行；省略时用插件配置的 headless（默认 false，即真的弹出浏览器窗口）。',
          },
          width: { type: 'integer', description: '窗口宽度，默认 1440。' },
          height: { type: 'integer', description: '窗口高度，默认 900。' },
          fresh_profile: { type: 'boolean', description: 'true 时使用全新临时配置（不带已保存的登录）。' },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: { url: { type: 'string' }, title: { type: 'string' } },
        },
        render: (_args, value) =>
          textBlock(
            `浏览器已就绪（${value.browser || 'chromium'}）。当前页面：${value.title || '(空白)'} — ${value.url || 'about:blank'}`,
          ),
      },
      presentCall: (args) => ({
        card: 'generic',
        title: `Open browser${args.url ? ` ${args.url}` : ''}`,
        kind: 'fetch',
        rawInput: args,
      }),
      timeoutMs: 120000,
      async execute(args) {
        await session.launch({ ...args, headless: args.headless ?? settings.headless })
        return { ...session.describe(), ...(await session.state()) }
      },
    },
    {
      name: 'browser_snapshot',
      description:
        'Return the current page as an indented text tree of roles, names and [ref=eN] handles for interactive elements, plus recent console errors. Read it before clicking so refs are fresh; refs are reassigned on every snapshot.',
      parameters: {
        type: 'object',
        properties: {
          max_chars: { type: 'integer', description: '快照最大字符数，默认 12000。' },
          screenshot: { type: 'boolean', description: '同时返回一张页面截图。' },
          full_page: { type: 'boolean', description: 'screenshot 时截取整页而不是可视区域。' },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: { url: { type: 'string' }, title: { type: 'string' }, snapshot: { type: 'string' } },
        },
        render: (_args, value) => {
          const blocks = textBlock(`<url>${value.url}</url>\n<title>${value.title}</title>\n${value.snapshot}`)
          if (value.image !== undefined) blocks.push({ type: 'image', attachment: value.image })
          return blocks
        },
      },
      presentCall: () => ({ card: 'generic', title: 'Page snapshot', kind: 'read' }),
      timeoutMs: 90000,
      async execute(args, exec) {
        await session.ensure()
        const state = await session.snapshot(args.max_chars ?? settings.snapshotMaxChars)
        const errors = session.drainConsole()
        const extra = errors.length > 0 ? `\n\n<console>\n${errors.join('\n')}\n</console>` : ''
        const value = { ...state, snapshot: `${state.snapshot}${extra}` }
        if (args.screenshot === true) {
          const shot = await captureValue({ full_page: args.full_page === true }, exec)
          value.image = shot.image
          value.path = shot.path
        }
        return value
      },
    },
    {
      name: 'browser_act',
      description:
        'Act on the current page: click, double_click, hover, fill, press a key combination, select an option, scroll, navigate, go back/forward, reload, evaluate JavaScript, wait for a selector or text, take a screenshot, manage tabs, or close the browser. Target elements with a `ref` from the latest snapshot or a CSS `selector`.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: [
              'goto',
              'click',
              'double_click',
              'hover',
              'fill',
              'press',
              'select',
              'scroll',
              'eval',
              'wait',
              'back',
              'forward',
              'reload',
              'screenshot',
              'tabs',
              'use_tab',
              'open_tab',
              'close_tab',
              'close',
            ],
            description: '要执行的动作。',
          },
          ref: { type: 'string', description: '快照里的元素引用，如 e12。' },
          selector: { type: 'string', description: 'CSS 选择器，ref 不存在时使用。' },
          value: { type: 'string', description: 'fill 的文本、select 的选项、eval 的表达式或 wait 的文本。' },
          key: { type: 'string', description: 'press 的按键组合，如 "ctrl+enter"。' },
          url: { type: 'string', description: 'goto / open_tab 的目标地址。' },
          index: { type: 'integer', description: 'use_tab / close_tab 的标签页编号。' },
          amount: { type: 'integer', description: 'scroll 的像素数，正数向下。' },
          timeout_ms: { type: 'integer', description: 'wait 的超时毫秒数。' },
          full_page: { type: 'boolean', description: 'screenshot 时截取整页。' },
        },
        required: ['action'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: { action: { type: 'string' }, summary: { type: 'string' } },
        },
        render: (_args, value) => {
          const blocks = textBlock(value.summary)
          if (value.image !== undefined) blocks.push({ type: 'image', attachment: value.image })
          return blocks
        },
      },
      presentCall: (args) => ({ card: 'generic', title: `Browser ${args.action}`, kind: 'other', rawInput: args }),
      timeoutMs: 120000,
      async execute(args, exec) {
        await session.ensure()
        const action = args.action
        if (action === 'goto') {
          if (typeof args.url !== 'string') throw new Error('goto 需要 url')
          const state = await session.navigate(args.url)
          return { action, summary: `已打开 ${state.url}（${state.title}）`, ...state }
        }
        if (action === 'click' || action === 'double_click') {
          const result = await session.click(args.ref, args.selector, action === 'double_click')
          return { action, summary: `${action} 命中 <${result.target}> ${result.text ?? ''}`.trim() }
        }
        if (action === 'hover') {
          const result = await session.hover(args.ref, args.selector)
          return { action, summary: `已悬停 <${result.target}> ${result.text ?? ''}`.trim() }
        }
        if (action === 'fill') {
          if (typeof args.value !== 'string') throw new Error('fill 需要 value')
          const result = await session.fill(args.ref, args.selector, args.value)
          return { action, summary: `已在 <${result.target}> 填入 ${result.length} 个字符` }
        }
        if (action === 'press') {
          if (typeof args.key !== 'string') throw new Error('press 需要 key，如 "ctrl+enter"')
          const result = await session.press(args.key)
          return { action, summary: `已按下 ${result.key}` }
        }
        if (action === 'select') {
          if (typeof args.value !== 'string') throw new Error('select 需要 value')
          const result = await session.selectOption(args.ref, args.selector, args.value)
          return { action, summary: `已选择「${result.selected}」` }
        }
        if (action === 'scroll') {
          const result = await session.scroll(args.amount ?? 600, args.ref, args.selector)
          return { action, summary: `已滚动 ${result.deltaY} 像素` }
        }
        if (action === 'eval') {
          if (typeof args.value !== 'string') throw new Error('eval 需要 value 作为表达式')
          const result = await session.evaluate(args.value)
          return { action, summary: `执行结果：\n${result.result}` }
        }
        if (action === 'wait') {
          const result = await session.waitFor({ selector: args.selector, text: args.value, ms: args.timeout_ms })
          return { action, summary: `等待完成：${result.matched ?? `${result.waited} ms`}` }
        }
        if (action === 'back') {
          await session.goBack()
          return { action, summary: '已后退', ...(await session.state()) }
        }
        if (action === 'forward') {
          await session.goForward()
          return { action, summary: '已前进', ...(await session.state()) }
        }
        if (action === 'reload') {
          const state = await session.reload()
          return { action, summary: `已重新加载 ${state.url}` }
        }
        if (action === 'screenshot') {
          const shot = await captureValue({ full_page: args.full_page === true }, exec)
          return { action, path: shot.path, image: shot.image, summary: `截图已保存：${shot.path}` }
        }
        if (action === 'tabs') {
          const tabs = await session.tabs()
          const lines = tabs.map((tab) => `${tab.current ? '*' : ' '} [${tab.index}] ${tab.title} — ${tab.url}`)
          return { action, tabs, summary: `标签页 ${tabs.length} 个：\n${lines.join('\n')}` }
        }
        if (action === 'use_tab') {
          const tab = await session.useTab(args.index ?? 0)
          return { action, summary: `已切换到标签页 ${args.index ?? 0}：${tab.title}` }
        }
        if (action === 'open_tab') {
          const index = await session.openTab(args.url ?? 'about:blank')
          return { action, summary: `已打开新标签页 ${index}：${args.url ?? 'about:blank'}` }
        }
        if (action === 'close_tab') {
          const tab = await session.closeTab(args.index)
          return { action, summary: `已关闭标签页：${tab.title}` }
        }
        if (action === 'close') {
          await session.close()
          return { action, summary: '浏览器已关闭' }
        }
        throw new Error(`未知的浏览器动作 "${action}"`)
      },
    },
  ]
}
