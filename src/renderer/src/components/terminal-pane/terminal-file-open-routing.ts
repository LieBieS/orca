import { absolutePathToFileUri } from '@/components/editor/markdown-internal-links'
import { getWorkspaceFilePreviewPlan, openFileInBrowserTab } from '@/lib/file-preview'
import { downloadAndOpenRemoteTerminalFile } from './terminal-remote-file-download-open'
import type { RuntimeWorkspaceFileRoute } from '@/lib/runtime-workspace-file-route'
import { isPathInsideWorktree, toWorktreeRelativePath } from '@/lib/terminal-links'
import { canClientOsOpenWorkspaceFile } from '@/lib/workspace-file-host-routing'
import { isMissingRuntimePathError } from '@/runtime/runtime-file-metadata-client'
import { useAppStore } from '@/store'
import { activateAndRevealWorkspace, activateAndRevealWorktree } from '@/lib/worktree-activation'
import { resolveKnownWorktreeRootPathLink } from './terminal-worktree-path-link'
import {
  getTerminalFileContext,
  mapTerminalFilePath,
  terminalLinkWslDistro,
  type TerminalFileContext
} from './terminal-file-path-mapping'
import {
  LOCAL_EXECUTION_HOST_ID,
  getConnectionExecutionHostId,
  toRuntimeExecutionHostId
} from '../../../../shared/execution-host'
import { statUserOpenedPath } from '@/lib/user-opened-local-path'
import {
  CLIENT_LOCAL_FILE_TARGET,
  resolveHostWorkspaceFile,
  type HostWorkspaceFile
} from './terminal-host-workspace-file'
import { captureEditorOpenLinkIntent } from '@/store/slices/editor/tabs/editor-open-target-group'
import { reserveDetectedFilePathOpenTurn } from './terminal-file-open-turn'
import { showOpenInGroupRefusedToast } from './terminal-file-open-in-group-toast'
import {
  dismissFileInOtherWorkspaceHint,
  showFileInOtherWorkspaceHint
} from './terminal-file-other-workspace-hint'
import {
  hostNamedOtherWorkspaceOwner,
  otherWorkspaceViewFields,
  siblingWorkspaceLink
} from './terminal-file-other-workspace-owner'
import { isExplicitEditorScopeKept, openLinkedFileInEditor } from './terminal-file-link-editor-open'

export {
  getTerminalFileContext,
  mapTerminalFilePath,
  terminalLinkWslDistro,
  terminalPathWslDistro,
  type TerminalFileContext
} from './terminal-file-path-mapping'
import { runtimeTargetEnvironmentId } from '@/runtime/runtime-client-target'

export type FileOpenFailure = {
  /** `missing` is a verified absence; `unverifiable` means the host could not answer (dropped SSH, timeout, denied path). */
  verdict: 'missing' | 'unverifiable'
  error: unknown
}

type TerminalFileOpenDeps = {
  worktreeId: string
  worktreePath: string
  runtimeEnvironmentId?: string | null
  wslDistro?: string | null
  openWithSystemDefault?: boolean
  /** The paired-server terminal that printed the link; lets its host grant a file outside workspaces. */
  terminalHandle?: string | null
  /** Reports a path that could not be verified before opening; skipped once a later open supersedes it. */
  onOpenFailure?: (failure: FileOpenFailure) => void
  /** The tab that owns the link; editor opens place themselves relative to its group. */
  sourceTabId?: string | null
  /** "Open in this group": pins the source tab's group at activation, or refuses. */
  openInSourceGroup?: boolean
}

export function isHtmlFilePath(filePath: string): boolean {
  return /\.html?$/i.test(filePath)
}

function openHtmlFileInBrowser(filePath: string, worktreeId: string, clientLocal: boolean): void {
  const store = useAppStore.getState()
  if (worktreeId) {
    // Why: following an HTML file link changes which worktree is foregrounded,
    // so it must record a history visit before opening the browser tab — but the
    // browser tab is the surface, so an emptied workspace must not gain a shell.
    activateAndRevealWorktree(worktreeId, { providesInitialSurface: true })
  }
  const fileUrl = absolutePathToFileUri(filePath)
  const title = filePath.split(/[/\\]/).pop() ?? filePath
  store.createBrowserTab(worktreeId, fileUrl, {
    title,
    activate: true,
    // Why: the file is on this computer, so the workspace's paired-server runtime must not adopt the page.
    ...(clientLocal ? { browserRuntimeEnvironmentId: null } : {})
  })
}

export function shouldOpenTerminalFileWithSystemDefault(fileContext: TerminalFileContext): boolean {
  // Why: an unresolved owner has no connectionId either, which would otherwise read as local.
  return fileContext.sourceHostResolved && canClientOsOpenWorkspaceFile(fileContext)
}

export function openDetectedFilePath(
  filePath: string,
  line: number | null,
  column: number | null,
  deps: TerminalFileOpenDeps
): void {
  const { openWithSystemDefault = false, runtimeEnvironmentId } = deps
  let { worktreeId, worktreePath } = deps
  let mappedFilePath = mapTerminalFilePath(
    filePath,
    worktreePath,
    terminalLinkWslDistro(deps.wslDistro, runtimeEnvironmentId)
  )
  const isCurrentOpen = reserveDetectedFilePathOpenTurn()
  dismissFileInOtherWorkspaceHint()
  // Why: capture at activation; focus may move while the host resolves the path.
  const linkIntent = captureEditorOpenLinkIntent(
    useAppStore.getState(),
    deps.worktreeId,
    deps.sourceTabId,
    { explicitSourceGroup: deps.openInSourceGroup === true }
  )
  const explicitGroupRequest = deps.openInSourceGroup === true
  // Why: an explicit group request never substitutes a browser, system app, or download.
  const refuseExplicitNonEditorRoute = (): boolean => {
    if (!explicitGroupRequest) {
      return false
    }
    if (isCurrentOpen()) {
      showOpenInGroupRefusedToast(mappedFilePath)
    }
    return true
  }

  void (async () => {
    let statResult
    let fileContext = getTerminalFileContext(worktreeId, worktreePath, runtimeEnvironmentId)
    const sourceRuntimeOwnerId = runtimeTargetEnvironmentId(fileContext.target)
    let hostWorkspaceFile: HostWorkspaceFile | null = null
    // Why: a file another workspace on this host holds opens here, read-only (#32158).
    let otherWorkspaceOwner: RuntimeWorkspaceFileRoute | null = null
    let hostGrantId: string | null = null
    let clientLocal = false
    if (!fileContext.sourceHostResolved) {
      // Why: with no owner the host is unknown — refuse rather than touch this machine's files.
      deps.onOpenFailure?.({
        verdict: 'unverifiable',
        error: new Error('The terminal workspace host could not be determined')
      })
      return
    }
    if (!openWithSystemDefault) {
      const worktreeRootLink = resolveKnownWorktreeRootPathLink(
        mappedFilePath,
        useAppStore.getState(),
        fileContext
      )
      if (worktreeRootLink) {
        if (refuseExplicitNonEditorRoute()) {
          return
        }
        // Why: root workspace switching must work for SSH/runtime paths without
        // local auth/stat, while still coalescing provider + fallback clicks.
        await Promise.resolve()
        if (!isCurrentOpen()) {
          return
        }
        activateAndRevealWorktree(worktreeRootLink.id, {
          executionHostId: worktreeRootLink.executionHostId
        })
        return
      }
    }

    try {
      const linkOwner = await resolveHostWorkspaceFile(
        fileContext,
        mappedFilePath,
        deps.terminalHandle
      )
      if (linkOwner?.kind === 'grant') {
        hostGrantId = linkOwner.grantId
        mappedFilePath = linkOwner.absolutePath
        statResult = { isDirectory: false, escapesWorktree: true }
      } else if (linkOwner?.kind === 'client') {
        clientLocal = true
        fileContext = {
          ...fileContext,
          target: CLIENT_LOCAL_FILE_TARGET,
          connectionId: undefined
        }
        statResult = { isDirectory: linkOwner.isDirectory, escapesWorktree: false }
      } else if (linkOwner) {
        // Why HTML keeps the switch: its rendered preview reads only inside the workspace it opens in.
        const viewHere = !openWithSystemDefault && !isHtmlFilePath(linkOwner.absolutePath)
        otherWorkspaceOwner = viewHere ? hostNamedOtherWorkspaceOwner(linkOwner, worktreeId) : null
        mappedFilePath = linkOwner.absolutePath
        hostWorkspaceFile = otherWorkspaceOwner ? null : linkOwner
        if (hostWorkspaceFile) {
          // Why: the host already stat'ed the path inside the workspace that holds it; open it there.
          ;({ worktreeId, worktreePath } = hostWorkspaceFile)
          fileContext = { ...fileContext, worktreeId, worktreePath }
        }
        statResult = { isDirectory: linkOwner.isDirectory, escapesWorktree: false }
      } else {
        statResult = await statUserOpenedPath(fileContext, mappedFilePath)
      }
    } catch (error) {
      if (isCurrentOpen() && deps.onOpenFailure) {
        // Why: loss of contact with the host is not evidence the file is gone.
        deps.onOpenFailure({
          verdict: isMissingRuntimePathError(error) ? 'missing' : 'unverifiable',
          error
        })
      }
      return
    }

    if (!isCurrentOpen()) {
      return
    }

    const canOpenWithSystemDefault = shouldOpenTerminalFileWithSystemDefault(fileContext)
    if (openWithSystemDefault && canOpenWithSystemDefault) {
      // Why: Shift+Cmd/Ctrl mirrors URL links by escaping Orca and honoring the
      // user's OS file associations without adding editor-specific settings.
      const openedWithSystemDefault = await window.api.shell.openFilePath(
        mappedFilePath,
        LOCAL_EXECUTION_HOST_ID
      )
      if (openedWithSystemDefault || statResult.isDirectory) {
        return
      }
    }

    if (statResult.isDirectory) {
      if (refuseExplicitNonEditorRoute()) {
        return
      }
      if (canOpenWithSystemDefault) {
        await window.api.shell.openFilePath(mappedFilePath, LOCAL_EXECUTION_HOST_ID)
      }
      return
    }

    // Why: a granted file is readable only through its grant, so it opens in Orca, never as a download.
    if (openWithSystemDefault && !canOpenWithSystemDefault && hostGrantId === null) {
      // Why: the popover names Shift+Cmd/Ctrl "Download & open with default app", and the OS
      // cannot launch a remote path, so the direct gesture must reach the same download.
      await downloadAndOpenRemoteTerminalFile(fileContext, mappedFilePath)
      return
    }

    // Why: local HTML files render in Orca's browser for ordinary Cmd/Ctrl-click,
    // and remain the fallback if Shift+Cmd/Ctrl cannot launch the OS default.
    if (isHtmlFilePath(mappedFilePath) && hostGrantId === null) {
      if (canOpenWithSystemDefault) {
        // Why: Orca's browser has no group placement in v1.
        if (refuseExplicitNonEditorRoute()) {
          return
        }
        openHtmlFileInBrowser(mappedFilePath, worktreeId, clientLocal)
        return
      }
      // Why: the same gesture renders remote HTML too, through the doc preview; only an
      // unsupported plan (e.g. a paired doc outside the worktree) falls back to source.
      const plan = getWorkspaceFilePreviewPlan(useAppStore.getState(), worktreeId, mappedFilePath)
      if (plan.status === 'doc-preview') {
        if (refuseExplicitNonEditorRoute()) {
          return
        }
        activateAndRevealWorktree(worktreeId, { providesInitialSurface: true })
        openFileInBrowserTab({ filePath: mappedFilePath, worktreeId })
        return
      }
    }

    const runtimeOwnerId = runtimeTargetEnvironmentId(fileContext.target) ?? sourceRuntimeOwnerId
    const targetExecutionHostId =
      hostWorkspaceFile?.executionHostId ??
      (runtimeOwnerId
        ? toRuntimeExecutionHostId(runtimeOwnerId)
        : getConnectionExecutionHostId(fileContext.connectionId))
    let relativePath = mappedFilePath
    if (worktreePath && isPathInsideWorktree(mappedFilePath, worktreePath)) {
      const maybeRelative = toWorktreeRelativePath(mappedFilePath, worktreePath)
      // Why: a link out of the project keeps its absolute path, so the tab reads it as the file
      // the user named, before and after a restart, instead of being refused as a project file.
      if (maybeRelative !== null && maybeRelative.length > 0 && !statResult.escapesWorktree) {
        relativePath = maybeRelative
      }
    } else if (!otherWorkspaceOwner && hostGrantId === null && !clientLocal && !hostWorkspaceFile) {
      const sibling = siblingWorkspaceLink(targetExecutionHostId, mappedFilePath, worktreeId)
      otherWorkspaceOwner = sibling.view
      if (sibling.openInOwner) {
        ;({ worktreeId, relativePath } = sibling.openInOwner)
      }
    }

    if (
      explicitGroupRequest &&
      !isExplicitEditorScopeKept(linkIntent, worktreeId, targetExecutionHostId, clientLocal)
    ) {
      // Why: refuse before activating the destination or touching editor state.
      refuseExplicitNonEditorRoute()
      return
    }

    if (worktreeId) {
      // Why: the route may name a folder-workspace key, and the same worktree id can exist
      // on several hosts — dispatch by workspace shape and keep the resolved host.
      activateAndRevealWorkspace(worktreeId, {
        providesInitialSurface: true,
        executionHostId: targetExecutionHostId
      })
    }

    const opened = openLinkedFileInEditor(
      {
        filePath: mappedFilePath,
        relativePath,
        worktreeId: worktreeId || '',
        runtimeEnvironmentId: clientLocal ? null : runtimeEnvironmentId,
        // Why: a tab's owner must match its workspace's to be editable; this one is this computer's,
        // or another workspace's, which "Open there" edits under its own owner.
        ...(clientLocal
          ? { readOnly: true }
          : otherWorkspaceViewFields(otherWorkspaceOwner, runtimeOwnerId)),
        // Why: the grant is the only authority to read a host file outside its workspaces.
        ...(hostGrantId !== null ? { readOnly: true, terminalArtifactGrantId: hostGrantId } : {}),
        // Why: absolute SSH paths outside the worktree otherwise look identical
        // to client-local external files when the editor reloads or restores.
        ...(relativePath === filePath &&
        fileContext.target.kind === 'local' &&
        fileContext.connectionId
          ? { externalSshTargetId: fileContext.connectionId }
          : {})
      },
      linkIntent,
      { line, column },
      isCurrentOpen
    )
    if (!opened) {
      refuseExplicitNonEditorRoute()
    } else if (otherWorkspaceOwner && isCurrentOpen()) {
      showFileInOtherWorkspaceHint({
        fileId: opened.fileId,
        filePath: mappedFilePath,
        owner: otherWorkspaceOwner,
        runtimeEnvironmentId: runtimeOwnerId,
        position: { line, column }
      })
    }
  })()
}
