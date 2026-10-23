// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { OpenFile } from '@/store/slices/editor'

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) => selector({})
}))
vi.mock('@/lib/worktree-activation', () => ({ activateAndRevealWorkspace: vi.fn() }))
// Why: the catalog says workspace wt-b holds /b/docs/guide.md.
vi.mock('@/lib/runtime-workspace-file-route', () => ({
  findWorkspaceFileRoute: (_state: unknown, _hostId: string, absolutePath: string) =>
    absolutePath === '/b/docs/guide.md'
      ? { worktreeId: 'wt-b', relativePath: 'docs/guide.md', executionHostId: 'local' }
      : null
}))

import { activateAndRevealWorkspace } from '@/lib/worktree-activation'
import {
  useOwnerScopedOpenFile,
  useOwnerWorkspaceDocumentLinks
} from './use-owner-scoped-open-file'

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

describe('useOwnerWorkspaceDocumentLinks', () => {
  const documents = {
    markdownDocuments: [],
    openMarkdownDocument: vi.fn(),
    onOpenDocLink: vi.fn(),
    previewProps: { markdownDocuments: [], onOpenDocument: vi.fn(async () => {}) },
    mdSave: vi.fn()
  }
  const target = {
    filePath: '/b/docs/other.md',
    relativePath: 'docs/other.md',
    basename: 'other.md',
    name: 'other'
  }

  it("brings the owning workspace forward before a view's link opens there", async () => {
    const view = openFile({
      filePath: '/b/docs/guide.md',
      relativePath: '/b/docs/guide.md',
      readOnly: true
    })
    const owner = { ...view, worktreeId: 'wt-b', relativePath: 'docs/guide.md' }
    const { result } = renderHook(() => useOwnerWorkspaceDocumentLinks(documents, view, owner))

    await result.current.previewProps.onOpenDocument(target)

    expect(activateAndRevealWorkspace).toHaveBeenCalledWith('wt-b', {
      providesInitialSurface: true,
      executionHostId: 'local'
    })
    expect(documents.previewProps.onOpenDocument).toHaveBeenCalledWith(target, undefined)
  })

  it('keeps the same link handler across re-renders of a view', () => {
    const view = openFile({
      filePath: '/b/docs/guide.md',
      relativePath: '/b/docs/guide.md',
      readOnly: true
    })
    const owner = { ...view, worktreeId: 'wt-b', relativePath: 'docs/guide.md' }
    const { result, rerender } = renderHook(() =>
      useOwnerWorkspaceDocumentLinks({ ...documents }, view, owner)
    )
    const first = result.current.previewProps.onOpenDocument
    rerender()

    expect(result.current.previewProps.onOpenDocument).toBe(first)
  })

  it("leaves an ordinary tab's links alone", () => {
    const tab = openFile({})
    const { result } = renderHook(() => useOwnerWorkspaceDocumentLinks(documents, tab, tab))

    expect(result.current).toBe(documents)
  })
})
