/**
 * Import smoke test: the bundle loads, exports the Cordis plugin shape and its
 * tool factories. No Windows runtime needed — this runs on any platform.
 */
import assert from 'node:assert/strict'
import { apply, inject } from '../index.js'
import { createBrowserTools } from '../lib/browser.js'
import { createComputerTools } from '../lib/computer.js'

assert.equal(typeof apply, 'function', 'apply must be a function')
assert.deepEqual(inject, ['tools'], 'plugin injects the tools service')
assert.equal(typeof createBrowserTools, 'function', 'browser tools factory')
assert.equal(typeof createComputerTools, 'function', 'computer tools factory')

console.log('basic import test passed')
