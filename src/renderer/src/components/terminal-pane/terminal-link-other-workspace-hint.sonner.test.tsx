// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Toaster } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { activateAndRevealWorkspace } from '@/lib/worktree-activation'
import { openDetectedFilePath } from './terminal-link-handlers'
import { createTerminalLinkTestDoubles } from './terminal-link-handlers-test-fixtures'

const findWorkspaceFileRouteMock = vi.hoisted(() => vi.fn())
const doubles = createTerminalLinkTestDoubles()
const { storeState, openFileMock, statMock } = doubles

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, string>) =>
    fallback.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => values?.[name] ?? '')
}))

vi.mock('@/store', () => ({ useAppStore: { getState: () => storeState } }))

vi.mock('@/store/selectors', () => ({
  selectKnownWorktreeById: (_state: unknown, worktreeId: string) =>
    worktreeId === 'wt-b' ? { displayName: 'feature-b', branch: '', path: '/b' } : null
}))

vi.mock('@/lib/language-detect', () => ({ detectLanguage: () => 'plaintext' }))

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorkspace: vi.fn(),
  activateAndRevealWorktree: vi.fn()
}))

vi.mock('@/lib/connection-context', () => ({ getConnectionId: vi.fn(() => null) }))

vi.mock('@/lib/runtime-workspace-file-route', () => ({
  findWorkspaceFileRoute: findWorkspaceFileRouteMock
}))

const sourceDeps = { worktreeId: 'wt-a', worktreePath: '/a' }

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  findWorkspaceFileRouteMock.mockReturnValue(null)
  statMock.mockResolvedValue({ isDirectory: false })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      shell: { openFilePath: vi.fn().mockResolvedValue(true) },
      fs: { stat: statMock, pathExists: vi.fn().mockResolvedValue(true) }
    }
  })
  render(<Toaster />)
})

afterEach(() => {
  cleanup()
})

describe('a terminal file link clicked in workspace A', () => {
  it('opens a file inside A in A, with no hint', async () => {
    openDetectedFilePath('/a/src/main.ts', null, null, sourceDeps)
    await settle()

    expect(activateAndRevealWorkspace).toHaveBeenCalledTimes(1)
    expect(activateAndRevealWorkspace).toHaveBeenCalledWith('wt-a', expect.anything())
    expect(openFileMock).toHaveBeenCalledWith(
      expect.objectContaining({ relativePath: 'src/main.ts', worktreeId: 'wt-a' }),
      { forceContentReload: true }
    )
    expect(openFileMock.mock.calls[0][0]).not.toHaveProperty('readOnly')
    expect(screen.queryByText(/This file is in/)).toBeNull()
  })

  it('opens a file workspace B holds in A, and the hint opens it in B', async () => {
    findWorkspaceFileRouteMock.mockReturnValue({
      worktreeId: 'wt-b',
      relativePath: 'report.md',
      executionHostId: 'local'
    })

    openDetectedFilePath('/b/report.md', 7, null, sourceDeps)
    await settle()

    expect(activateAndRevealWorkspace).toHaveBeenCalledTimes(1)
    expect(activateAndRevealWorkspace).toHaveBeenCalledWith('wt-a', expect.anything())
    expect(openFileMock).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: '/b/report.md',
        relativePath: '/b/report.md',
        worktreeId: 'wt-a',
        readOnly: true
      }),
      { forceContentReload: true }
    )
    expect(screen.getByText('This file is in feature-b')).not.toBeNull()
    expect(screen.getByText('Opened here as read-only')).not.toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Open there' }))
    await settle()

    expect(activateAndRevealWorkspace).toHaveBeenLastCalledWith('wt-b', {
      providesInitialSurface: true,
      executionHostId: 'local'
    })
    expect(openFileMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        filePath: '/b/report.md',
        relativePath: 'report.md',
        worktreeId: 'wt-b',
        runtimeEnvironmentId: null
      }),
      { forceContentReload: true }
    )
    expect(openFileMock.mock.lastCall?.[0]).not.toHaveProperty('readOnly')
  })
})
