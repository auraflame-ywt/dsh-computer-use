/**
 * Long-lived Windows PowerShell worker.
 *
 * The sibling `windows.ps1` process speaks newline-delimited JSON over stdio:
 * requests go in as `{ id, op, params }`, responses come back as
 * `{ id, ok: true, result }` or `{ id, ok: false, error }`. Keeping one process
 * alive makes a screenshot or an input event cost one round trip instead of a
 * fresh interpreter start, and lets screen recording sample frames quickly.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const STDERR_LIMIT = 8192

function resolvePowerShell() {
  const root = process.env.SystemRoot ?? 'C:\\Windows'
  const ps51 = join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  if (existsSync(ps51)) {
    return {
      exe: ps51,
      prefix: ['-NoProfile', '-NonInteractive', '-Sta', '-ExecutionPolicy', 'Bypass', '-File'],
    }
  }
  return {
    exe: 'powershell.exe',
    prefix: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File'],
  }
}

export class ComputerWorker {
  #scriptPath
  #timeoutMs
  #proc = null
  #ready = null
  #readyResolve = null
  #readyReject = null
  #pending = new Map()
  #seq = 0
  #buffer = ''
  #stderr = ''
  #disposed = false
  #starts = 0

  constructor({ scriptPath, timeoutMs = 30000 }) {
    this.#scriptPath = scriptPath
    this.#timeoutMs = timeoutMs
  }

  get running() {
    return this.#proc !== null && !this.#disposed
  }

  get stderrTail() {
    return this.#stderr.slice(-2000)
  }

  async ensure() {
    if (this.#disposed) throw new Error('the computer-use worker has been shut down')
    if (this.#proc === null) this.#start()
    return this.#ready
  }

  #start() {
    const { exe, prefix } = resolvePowerShell()
    this.#starts += 1
    this.#stderr = ''
    const proc = spawn(exe, [...prefix, this.#scriptPath], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.#proc = proc
    this.#buffer = ''
    this.#ready = new Promise((resolve, reject) => {
      this.#readyResolve = resolve
      this.#readyReject = reject
    })
    // A rejected readiness promise is consumed by the caller of ensure().
    this.#ready.catch(() => {})

    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (chunk) => this.#onStdout(chunk))
    proc.stderr.setEncoding('utf8')
    proc.stderr.on('data', (chunk) => {
      this.#stderr = (this.#stderr + chunk).slice(-STDERR_LIMIT)
    })
    proc.on('error', (error) => this.#fail(`could not start ${exe}: ${error.message}`))
    proc.on('exit', (code) => {
      const tail = this.#stderr.trim()
      this.#fail(
        `the PowerShell worker exited (code ${code})` + (tail ? `: ${tail.split('\n').slice(-4).join(' | ')}` : ''),
      )
    })
    proc.stdin.on('error', () => {})
  }

  #onStdout(chunk) {
    this.#buffer += chunk
    let index = this.#buffer.indexOf('\n')
    while (index >= 0) {
      const line = this.#buffer.slice(0, index).trim()
      this.#buffer = this.#buffer.slice(index + 1)
      if (line.length > 0) this.#onLine(line)
      index = this.#buffer.indexOf('\n')
    }
  }

  #onLine(line) {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      // A stray line from a cmdlet must not poison the protocol; keep it for diagnostics.
      this.#stderr = (this.#stderr + line + '\n').slice(-STDERR_LIMIT)
      return
    }
    if (message.ready === true) {
      this.#readyResolve?.()
      this.#readyResolve = null
      return
    }
    if (typeof message.id !== 'number') return
    const entry = this.#pending.get(message.id)
    if (entry === undefined) return
    this.#pending.delete(message.id)
    clearTimeout(entry.timer)
    if (message.ok) entry.resolve(message.result)
    else entry.reject(new Error(String(message.error ?? 'unknown worker failure')))
  }

  #fail(reason) {
    const proc = this.#proc
    this.#proc = null
    this.#readyReject?.(new Error(reason))
    this.#readyResolve = null
    this.#readyReject = null
    for (const [, entry] of this.#pending) {
      clearTimeout(entry.timer)
      entry.reject(new Error(reason))
    }
    this.#pending.clear()
    if (proc !== null) {
      try {
        proc.stdin.destroy()
        proc.kill()
      } catch {}
    }
  }

  /**
   * Run one operation and resolve with its `result` object.
   * @param {string} op the worker operation name.
   * @param {object} params operation parameters.
   * @param {{ timeoutMs?: number }} [options] per-call timeout override.
   */
  async request(op, params = {}, options = {}) {
    await this.ensure()
    const proc = this.#proc
    if (proc === null) throw new Error('the PowerShell worker is not running')
    const id = (this.#seq += 1)
    const timeoutMs = options.timeoutMs ?? this.#timeoutMs
    const payload = JSON.stringify({ id, op, params }) + '\n'
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        this.#fail(`the "${op}" operation did not answer within ${timeoutMs} ms`)
      }, timeoutMs)
      this.#pending.set(id, { resolve, reject, timer })
      proc.stdin.write(payload, 'utf8', (error) => {
        if (error) {
          this.#pending.delete(id)
          clearTimeout(timer)
          reject(new Error(`could not send "${op}" to the PowerShell worker: ${error.message}`))
        }
      })
    })
  }

  async dispose() {
    this.#disposed = true
    const proc = this.#proc
    this.#proc = null
    this.#fail('the computer-use worker was shut down')
    if (proc !== null) {
      try {
        proc.stdin.end()
      } catch {}
      try {
        proc.kill()
      } catch {}
      try {
        proc.unref()
      } catch {}
    }
  }
}
