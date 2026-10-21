import { createBrowserLinkHostMatcher } from './browser-link-owner'
export {
  canOpenWorkspaceBrowserTabOnRuntime,
  canOpenWorkspaceBrowserTabOnSsh
} from './workspace-browser-route-eligibility'
import {
  isExpectedRuntimeBrowserRoute,
  isSshDeploymentClientBrowserRoute,
  isExpectedSshBrowserRoute
} from './workspace-browser-route-eligibility'
import type { BrowserLinkOpenContext, BrowserOpenOutcome } from './browser-link-destination'
import {
  workspaceBrowserLinkDestination,
  openClientWorkspaceBrowserLink,
  prepareRuntimeBrowserLink,
  materializedBrowserLinkOutcome
} from './workspace-browser-link-open'
import { createWebRuntimeSessionBrowserTab } from '@/runtime/web-runtime-browser-creation'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { resolveNewBrowserTabProfile } from '@/store/slices/browser/browser-new-tab-profile'
import {
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import type { SearchEngine } from '../../../shared/browser-url'
import type { BrowserClientHostPlacementPreference } from '../../../shared/browser-client-host-placement'
import {
  getClientCreationActionPolicy,
  type ClientCreationActionAvailability
} from './client-creation-action-policy'
import { resolveWorktreeOperationRoute } from './worktree-operation-route'
import {
  intentPresentation,
  openFailure,
  validateTarget
} from './workspace-browser-tab-presentation'

export type WorkspaceBrowserTabIntent = { kind: 'url' } | { kind: 'search'; engine: SearchEngine }

export type OpenWorkspaceBrowserTabRequest = {
  workspaceId: string
  linkContext?: BrowserLinkOpenContext
  onLinkOutcome?: (outcome: BrowserOpenOutcome) => void
  targetGroupId?: string
  /** Client-local unified tab id of the source; a source-following open omits targetGroupId. */
  afterTabId?: string
  url: string
  intent: WorkspaceBrowserTabIntent
  /** Keep the caller's current terminal/task surface selected while creating the tab. */
  focusOnCreate?: boolean
  /** Keep the caller's current workspace selected while creating the tab. */
  selectWorktree?: boolean
  expectedRuntimeEnvironmentId?: string
  expectedSshConnectionId?: string
  /** Override placement for links whose pane explicitly requires server ownership. */
  placementPreference?: BrowserClientHostPlacementPreference
}

function createClientBrowserTab(
  state: AppState,
  request: OpenWorkspaceBrowserTabRequest,
  hostId: ExecutionHostId,
  presentation: { error: string; title: string },
  // Why: a desktop-hosted page in a runtime workspace stays owned by that runtime, or the
  // unified tab is disowned from its worktree (palette and activation skip it).
  ownerHostId: ExecutionHostId = hostId
): void {
  if (request.linkContext) {
    const destination = workspaceBrowserLinkDestination(request, ownerHostId, null, hostId)
    const outcome = openClientWorkspaceBrowserLink(request, destination, presentation.title)
    request.onLinkOutcome?.(outcome)
    return
  }
  try {
    state.createBrowserTab(request.workspaceId, request.url, {
      activate: request.focusOnCreate !== false,
      browserRuntimeEnvironmentId: null,
      focusAddressBar: false,
      executionHostId: ownerHostId,
      ...resolveNewBrowserTabProfile(state, request.workspaceId, hostId),
      targetGroupId: request.targetGroupId,
      ...(request.afterTabId ? { afterTabId: request.afterTabId } : {}),
      title: presentation.title
    })
  } catch (error) {
    throw openFailure(presentation.error, 'client tab creation rejected', error)
  }
}

function assertManagedBrowserEnabled(
  availability: ClientCreationActionAvailability,
  presentation: { error: string }
): asserts availability is Extract<ClientCreationActionAvailability, { state: 'enabled' }> {
  if (availability.state !== 'enabled') {
    throw openFailure(presentation.error, availability.reason)
  }
}

export async function openWorkspaceBrowserTab(
  request: OpenWorkspaceBrowserTabRequest
): Promise<void> {
  if (request.linkContext?.isCurrentRequest?.() === false) {
    request.onLinkOutcome?.({ status: 'superseded' })
    return
  }
  const presentation = intentPresentation(request.intent, request.url)
  if (!validateTarget(request.url)) {
    throw openFailure(presentation.error, 'target is not an http(s) URL')
  }
  const state = useAppStore.getState()
  const availability = getClientCreationActionPolicy(state, request.workspaceId)['managed-browser']
  assertManagedBrowserEnabled(availability, presentation)
  const route = resolveWorktreeOperationRoute(state, request.workspaceId)
  if (!route) {
    throw openFailure(presentation.error, 'no active worktree route')
  }
  const capturedHost = request.linkContext?.linkIntent?.hostId
  if (
    capturedHost &&
    (!route.executionHostId ||
      !createBrowserLinkHostMatcher(
        state,
        request.workspaceId,
        route.executionHostId
      )(capturedHost))
  ) {
    request.onLinkOutcome?.({ status: 'refused' })
    return
  }
  const environmentId = route.runtimeEnvironmentId?.trim() || null
  const expectedEnvironmentId =
    request.expectedRuntimeEnvironmentId === undefined
      ? null
      : request.expectedRuntimeEnvironmentId.trim()
  const expectedSshConnectionId =
    request.expectedSshConnectionId === undefined ? null : request.expectedSshConnectionId.trim()
  if (expectedEnvironmentId !== null && expectedSshConnectionId !== null) {
    throw openFailure(presentation.error, 'browser owner assertion is ambiguous')
  }
  const runtimeOwnerRoute =
    expectedEnvironmentId !== null &&
    isExpectedRuntimeBrowserRoute(
      state,
      availability,
      route,
      request.workspaceId,
      expectedEnvironmentId
    )
  const sshDeploymentClientRoute =
    expectedEnvironmentId !== null &&
    !runtimeOwnerRoute &&
    isSshDeploymentClientBrowserRoute(
      state,
      availability,
      route,
      request.workspaceId,
      expectedEnvironmentId
    )
  if (expectedEnvironmentId !== null && !runtimeOwnerRoute && !sshDeploymentClientRoute) {
    throw openFailure(presentation.error, 'asserted runtime cannot provide this managed browser')
  }
  if (
    expectedSshConnectionId !== null &&
    !isExpectedSshBrowserRoute(
      state,
      availability,
      route,
      request.workspaceId,
      expectedSshConnectionId
    )
  ) {
    throw openFailure(presentation.error, 'asserted SSH connection cannot provide this browser')
  }
  const host = parseExecutionHostId(route.executionHostId)
  if (!environmentId) {
    if (!host || host.kind === 'runtime') {
      throw openFailure(presentation.error, `unresolved client host: ${route.executionHostId}`)
    }
    createClientBrowserTab(state, request, host.id, presentation)
    return
  }
  if (
    route.executionHostId &&
    (!host || (host.kind === 'runtime' && host.environmentId !== environmentId))
  ) {
    throw openFailure(
      presentation.error,
      `host ${route.executionHostId} does not own runtime ${environmentId}`
    )
  }
  // An asserted runtime owns links opened from remote panes; provider policy may describe the
  // viewing client's generic browser surface rather than that pane's execution host. The one
  // exception is an SSH-deployed server, whose links this desktop hosts on the SSH route.
  if (
    (expectedEnvironmentId === null || sshDeploymentClientRoute) &&
    availability.provider === 'local-client'
  ) {
    const localHostId = host && host.kind !== 'runtime' ? host.id : LOCAL_EXECUTION_HOST_ID
    const ownerHostId =
      host?.kind === 'runtime' && route.executionHostId ? route.executionHostId : localHostId
    createClientBrowserTab(state, request, localHostId, presentation, ownerHostId)
    return
  }
  const destination =
    request.linkContext && route.executionHostId
      ? workspaceBrowserLinkDestination(
          request,
          route.executionHostId,
          environmentId,
          route.executionHostId
        )
      : null
  const placement = destination
    ? prepareRuntimeBrowserLink(request, destination)
    : { status: 'create' as const, groupId: request.targetGroupId }
  if (placement.status !== 'create') {
    request.onLinkOutcome?.(placement)
    return
  }
  const targetGroupId = placement.groupId
  let created = false
  try {
    created = await createWebRuntimeSessionBrowserTab({
      worktreeId: request.workspaceId,
      environmentId,
      url: request.url,
      targetGroupId,
      ...(destination ? { profileId: destination.sessionProfileId } : {}),
      ...(request.linkContext ? { isCurrentRequest: request.linkContext.isCurrentRequest } : {}),
      ...(destination
        ? {
            onMaterialized: (pageId: string) =>
              request.onLinkOutcome?.(materializedBrowserLinkOutcome(request, destination, pageId))
          }
        : {}),
      // Client placement survives older hosts publishing a page before the create response.
      ...(targetGroupId ? { clientTargetGroupId: targetGroupId } : {}),
      ...(request.afterTabId ? { clientAfterTabId: request.afterTabId } : {}),
      // Owner-pinned links need the host tab published before client reconciliation.
      ...(expectedEnvironmentId !== null ? { waitForRegistration: true } : {}),
      ...(request.placementPreference !== undefined
        ? { placementPreference: request.placementPreference }
        : {}),
      // Why: the tab is opened from this workspace's tab bar, so surface that
      // workspace — otherwise a background worktree looks like nothing happened.
      ...(request.focusOnCreate !== undefined ? { focusOnCreate: request.focusOnCreate } : {}),
      selectWorktree: request.selectWorktree !== false,
      stagedTitle: presentation.title,
      stagedFocusAddressBar: false,
      failureLogMode: 'operation-only'
    })
  } catch (error) {
    throw openFailure(presentation.error, 'runtime browser tab creation failed', error)
  }
  if (!created) {
    throw openFailure(presentation.error, 'runtime browser tab creation was unavailable')
  }
}

/** Detailed link results are additive; generic callers retain the void contract. */
export async function openWorkspaceBrowserTabForLink(
  request: OpenWorkspaceBrowserTabRequest & { linkContext: BrowserLinkOpenContext }
): Promise<BrowserOpenOutcome> {
  let outcome: BrowserOpenOutcome = { status: 'failed' }
  try {
    await openWorkspaceBrowserTab({
      ...request,
      onLinkOutcome: (result) => {
        outcome = result
      }
    })
  } catch {
    return { status: request.linkContext.isCurrentRequest?.() === false ? 'superseded' : 'failed' }
  }
  return outcome
}
