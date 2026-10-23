import { useMemo } from 'react'
import { useAppStore } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import { openFileOwnerScope } from '@/lib/open-file-owner-scope'

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
