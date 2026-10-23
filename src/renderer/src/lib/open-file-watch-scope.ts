import type { OpenFile } from '@/store/slices/editor'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { LOCAL_EXECUTION_HOST_ID, toRuntimeExecutionHostId } from '../../../shared/execution-host'
import { isFloatingWorkspaceId } from '../../../shared/floating-workspace-worktree'
import { findWorkspaceFileRoute } from './runtime-workspace-file-route'

type WatchScopedFile = Pick<
  OpenFile,
  | 'worktreeId'
  | 'filePath'
  | 'relativePath'
  | 'readOnly'
  | 'runtimeEnvironmentId'
  | 'terminalArtifactGrantId'
>

/**
 * Where an open file is watched. A read-only view of a file another workspace on its host holds
 * (#32158) lives in one workspace but is watched with the one that holds the file, derived from
 * the catalog so a restored or reused view needs nothing stored.
 */
export function openFileWatchScope(
  file: WatchScopedFile,
  state: AppState = useAppStore.getState()
): { worktreeId: string; relativePath: string } {
  const own = { worktreeId: file.worktreeId, relativePath: file.relativePath }
  // Why: only a read-only absolute view may sit outside the workspace holding its file.
  if (
    file.readOnly !== true ||
    file.relativePath !== file.filePath ||
    file.terminalArtifactGrantId ||
    isFloatingWorkspaceId(file.worktreeId)
  ) {
    return own
  }
  const runtimeOwner = file.runtimeEnvironmentId?.trim()
  const route = findWorkspaceFileRoute(
    state,
    runtimeOwner ? toRuntimeExecutionHostId(runtimeOwner) : LOCAL_EXECUTION_HOST_ID,
    file.filePath
  )
  return route ? { worktreeId: route.worktreeId, relativePath: route.relativePath } : own
}

/** The workspace whose watch covers an open file; see {@link openFileWatchScope}. */
export function openFileWatchWorktreeId(file: WatchScopedFile, state?: AppState): string {
  return openFileWatchScope(file, state).worktreeId
}
