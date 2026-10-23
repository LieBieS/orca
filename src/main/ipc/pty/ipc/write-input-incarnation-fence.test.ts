import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ptyIncarnationById, ptyOwnership } from '../provider/ownership-state'
import type { PtyRendererDelivery } from '../session'
import { createPtyWriteInput } from './write-input'

const { provider } = vi.hoisted(() => ({
  provider: {
    hasPty: vi.fn(() => true),
    write: vi.fn()
  }
}))
vi.mock('../provider/registry', () => ({ tryGetProviderForPty: () => provider }))

const id = 'pty-incarnation-fenced'
const send = vi.fn()
const mainWindow: PtyRendererDelivery = {
  isDestroyed: () => false,
  isFocused: () => true,
  isVisible: () => true,
  isMinimized: () => false,
  webContents: { id: 1, isDestroyed: () => false, send, on: vi.fn(), removeListener: vi.fn() }
}
const input = () => createPtyWriteInput({ mainWindow })
const write = (incarnationId?: string) =>
  input().writePtyInput({ id, data: 'x', inputKind: 'driving', incarnationId })
const writeAccepted = (incarnationId?: string) =>
  input().writePtyInputAccepted({ id, data: 'x', inputKind: 'driving', incarnationId })

beforeEach(() => {
  vi.clearAllMocks()
  provider.hasPty.mockReturnValue(true)
  provider.write.mockReturnValue(true)
})
afterEach(() => {
  ptyOwnership.delete(id)
  ptyIncarnationById.delete(id)
})

describe('pty write incarnation fence', () => {
  it('drops a local write pinned to a prior incarnation of a reissued id', () => {
    ptyOwnership.set(id, 'local')
    ptyIncarnationById.set(id, 'incarnation-new')
    expect(write('incarnation-old')).toBe(false)
    expect(writeAccepted('incarnation-old')).toBe(false)
    expect(provider.write).not.toHaveBeenCalled()
  })

  it('delivers a write naming the current incarnation', () => {
    ptyOwnership.set(id, 'local')
    ptyIncarnationById.set(id, 'incarnation-new')
    expect(write('incarnation-new')).toBe(true)
    expect(writeAccepted('incarnation-new')).toBe(true)
    expect(provider.write).toHaveBeenCalledWith(id, 'x')
  })

  it('stays permissive for writers that never bound an incarnation', () => {
    ptyOwnership.set(id, 'local')
    ptyIncarnationById.set(id, 'incarnation-new')
    expect(write()).toBe(true)
    // A claimed incarnation with no recorded lifetime is admissible, matching exit fencing.
    ptyIncarnationById.delete(id)
    expect(write('incarnation-any')).toBe(true)
  })

  it('leaves ssh-owned ids to their own epoch fencing', () => {
    ptyOwnership.set(id, 'ssh:connection-1')
    ptyIncarnationById.set(id, 'incarnation-new')
    expect(write('incarnation-old')).toBe(true)
    expect(provider.write).toHaveBeenCalledWith(id, 'x')
  })
})
