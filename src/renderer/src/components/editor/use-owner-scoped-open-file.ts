import { useMemo } from 'react'
import { useAppStore } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import { openFileOwnerScope } from '@/lib/open-file-owner-scope'
import { activateAndRevealWorkspace } from '@/lib/worktree-activation'
import {
  LOCAL_EXECUTION_HOST_ID,
  toRuntimeExecutionHostId
} from '../../../../shared/execution-host'
import type { useMarkdownDocuments } from './useMarkdownDocuments'

/**
 * The open file as the workspace holding it sees it, for its document features (links, index,
 * images). A read-only view of another workspace's file (#32158) takes that workspace's id and path.
 */
export function useOwnerScopedOpenFile(file: OpenFile): OpenFile {
  const worktreeId = useAppStore((s) => openFileOwnerScope(file, s).worktreeId)
  const relativePath = useAppStore((s) => openFileOwnerScope(file, s).relativePath)
  return useMemo(
    () =>
      worktreeId === file.worktreeId && relativePath === file.relativePath
        ? file
        : { ...file, worktreeId, relativePath },
    [file, worktreeId, relativePath]
  )
}

type MarkdownDocumentsController = ReturnType<typeof useMarkdownDocuments>

/** A view's document links open in the workspace holding its file, so that workspace comes forward. */
export function useOwnerWorkspaceDocumentLinks(
  documents: MarkdownDocumentsController,
  viewFile: OpenFile,
  ownerFile: OpenFile
): MarkdownDocumentsController {
  const ownerWorktreeId = ownerFile.worktreeId === viewFile.worktreeId ? null : ownerFile.worktreeId
  const runtimeOwner = ownerFile.runtimeEnvironmentId?.trim()
  const { previewProps } = documents
  // Why keyed on previewProps: the controller object is new each render, and the preview rebuilds
  // its Markdown components whenever onOpenDocument changes.
  const ownerPreviewProps = useMemo(() => {
    if (!ownerWorktreeId) {
      return previewProps
    }
    const onOpenDocument: typeof previewProps.onOpenDocument = (document, options) => {
      activateAndRevealWorkspace(ownerWorktreeId, {
        providesInitialSurface: true,
        executionHostId: runtimeOwner
          ? toRuntimeExecutionHostId(runtimeOwner)
          : LOCAL_EXECUTION_HOST_ID
      })
      return previewProps.onOpenDocument(document, options)
    }
    return { ...previewProps, onOpenDocument }
  }, [ownerWorktreeId, previewProps, runtimeOwner])
  return ownerPreviewProps === previewProps
    ? documents
    : { ...documents, previewProps: ownerPreviewProps }
}
