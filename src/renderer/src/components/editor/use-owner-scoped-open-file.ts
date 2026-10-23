import { useMemo } from 'react'
import { useAppStore } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import { openFileOwnerScope } from '@/lib/open-file-owner-scope'
import { activateAndRevealWorkspace } from '@/lib/worktree-activation'
import { toRuntimeExecutionHostId } from '../../../../shared/execution-host'
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
  return useMemo(() => {
    if (ownerFile === viewFile) {
      return documents
    }
    const runtimeOwner = ownerFile.runtimeEnvironmentId?.trim()
    const onOpenDocument: MarkdownDocumentsController['previewProps']['onOpenDocument'] = (
      document,
      options
    ) => {
      activateAndRevealWorkspace(ownerFile.worktreeId, {
        providesInitialSurface: true,
        ...(runtimeOwner ? { executionHostId: toRuntimeExecutionHostId(runtimeOwner) } : {})
      })
      return documents.previewProps.onOpenDocument(document, options)
    }
    return { ...documents, previewProps: { ...documents.previewProps, onOpenDocument } }
  }, [documents, ownerFile, viewFile])
}
