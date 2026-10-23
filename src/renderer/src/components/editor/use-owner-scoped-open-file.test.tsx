// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { OpenFile } from '@/store/slices/editor'

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) => selector({})
}))
// Why: the catalog says workspace wt-b holds /b/docs/guide.md.
vi.mock('@/lib/runtime-workspace-file-route', () => ({
  findWorkspaceFileRoute: (_state: unknown, _hostId: string, absolutePath: string) =>
    absolutePath === '/b/docs/guide.md'
      ? { worktreeId: 'wt-b', relativePath: 'docs/guide.md', executionHostId: 'local' }
      : null
}))

import { useOwnerScopedOpenFile } from './use-owner-scoped-open-file'

function openFile(extra: Partial<OpenFile>): OpenFile {
  return {
    id: 'tab',
    worktreeId: 'wt-a',
    filePath: '/a/readme.md',
    relativePath: 'readme.md',
    language: 'markdown',
    mode: 'markdown-preview',
    isDirty: false,
    ...extra
  }
}

describe('useOwnerScopedOpenFile', () => {
  it("scopes a read-only view's document features to the workspace holding the file", () => {
    const view = openFile({
      filePath: '/b/docs/guide.md',
      relativePath: '/b/docs/guide.md',
      readOnly: true
    })
    const { result } = renderHook(() => useOwnerScopedOpenFile(view))

    expect(result.current).toMatchObject({
      id: 'tab',
      worktreeId: 'wt-b',
      relativePath: 'docs/guide.md'
    })
  })

  it('returns an ordinary tab unchanged', () => {
    const tab = openFile({})
    const { result } = renderHook(() => useOwnerScopedOpenFile(tab))

    expect(result.current).toBe(tab)
  })
})
