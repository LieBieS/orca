import {
  findWorkspaceFileRoute,
  type RuntimeWorkspaceFileRoute
} from '@/lib/runtime-workspace-file-route'
import { useAppStore } from '@/store'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { isFloatingWorkspaceId } from '../../../../shared/floating-workspace-worktree'
import type { HostWorkspaceFile } from './terminal-host-workspace-file'

/**
 * Another workspace on the same host that holds a link's path. The link still opens in the
 * workspace it was clicked in (#32158); this names the owner for the read and the hint.
 */
export function otherWorkspaceFileOwner(
  executionHostId: ExecutionHostId,
  absolutePath: string,
  sourceWorktreeId: string
): RuntimeWorkspaceFileRoute | null {
  // Why: floating-workspace files stay in their panel even when a project also contains the path.
  if (isFloatingWorkspaceId(sourceWorktreeId)) {
    return null
  }
  const owner = findWorkspaceFileRoute(useAppStore.getState(), executionHostId, absolutePath)
  return owner && owner.worktreeId !== sourceWorktreeId ? owner : null
}

/**
 * A paired or managed host named another workspace for the link: viewable here only when this
 * client's catalog agrees, since the editor reads it through that workspace's scope on the host.
 */
export function hostNamedOtherWorkspaceOwner(
  linkOwner: HostWorkspaceFile,
  sourceWorktreeId: string
): RuntimeWorkspaceFileRoute | null {
  if (linkOwner.isDirectory) {
    return null
  }
  const owner = otherWorkspaceFileOwner(
    linkOwner.executionHostId,
    linkOwner.absolutePath,
    sourceWorktreeId
  )
  return owner?.worktreeId === linkOwner.worktreeId ? owner : null
}
