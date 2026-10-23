import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { resolveWorktreeDisplayName } from '@/lib/worktree-default-display-name'
import { activateAndRevealWorkspace } from '@/lib/worktree-activation'
import type { RuntimeWorkspaceFileRoute } from '@/lib/runtime-workspace-file-route'
import { useAppStore } from '@/store'
import { selectKnownWorktreeById } from '@/store/selectors'
import { openLinkedFileInEditor } from './terminal-file-link-editor-open'

const OTHER_WORKSPACE_HINT_TOAST_ID = 'terminal-file-other-workspace'

export type FileInOtherWorkspace = {
  filePath: string
  owner: RuntimeWorkspaceFileRoute
  runtimeEnvironmentId: string | null | undefined
  line: number | null
  column: number | null
}

/** Opens the file as its owning workspace's own file, with that workspace in front. */
export function openFileInOwningWorkspace(file: FileInOtherWorkspace): void {
  const { owner } = file
  activateAndRevealWorkspace(owner.worktreeId, {
    providesInitialSurface: true,
    executionHostId: owner.executionHostId
  })
  openLinkedFileInEditor(
    {
      filePath: file.filePath,
      relativePath: owner.relativePath,
      worktreeId: owner.worktreeId,
      runtimeEnvironmentId: file.runtimeEnvironmentId
    },
    null,
    { line: file.line, column: file.column },
    () => true
  )
}

/** A newer link click supersedes the hint, so its action never opens an older link's file. */
export function dismissFileInOtherWorkspaceHint(): void {
  toast.dismiss(OTHER_WORKSPACE_HINT_TOAST_ID)
}

/** The link opened here; this names the workspace that holds the file and offers to go there. */
export function showFileInOtherWorkspaceHint(file: FileInOtherWorkspace): void {
  const worktree = selectKnownWorktreeById(
    useAppStore.getState(),
    file.owner.worktreeId,
    file.owner.executionHostId
  )
  const workspaceName = worktree ? resolveWorktreeDisplayName(worktree) : ''
  if (!workspaceName) {
    return
  }
  toast(
    translate(
      'auto.components.terminal.pane.TerminalLinkActionPopover.fileInOtherWorkspace',
      'This file is in {{value0}}',
      { value0: workspaceName }
    ),
    {
      id: OTHER_WORKSPACE_HINT_TOAST_ID,
      duration: 8000,
      description: translate(
        'auto.components.terminal.pane.TerminalLinkActionPopover.openedHereReadOnly',
        'Opened here as read-only'
      ),
      action: {
        label: translate(
          'auto.components.terminal.pane.TerminalLinkActionPopover.openInOwningWorkspace',
          'Open there'
        ),
        onClick: () => openFileInOwningWorkspace(file)
      }
    }
  )
}
