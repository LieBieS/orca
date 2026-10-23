// @vitest-environment happy-dom
import { createRef } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { TooltipProvider } from '@/components/ui/tooltip'
import type * as I18n from '@/i18n/i18n'
import type { Tab, TabGroup } from '../../../../shared/tab-types'
import { createGlobalSettingsFixture } from '../../../../shared/global-settings-test-fixture'
import { useStructuredNativeChatPaneCommands } from './use-structured-native-chat-pane-commands'
import { emptyNativeChatContextMenuActions } from './use-native-chat-context-menu'
import { runNativeChatSplitTarget } from './native-chat-layout-actions'

vi.mock('./native-chat-layout-actions', () => ({ runNativeChatSplitTarget: vi.fn(() => true) }))
vi.mock('./NativeChatSelectionQuote', () => ({ NativeChatSelectionQuote: () => null }))
vi.mock('@/i18n/i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof I18n>()),
  translate: (_key: string, fallback: string) => fallback
}))

let reads = 0
let renders = 0
let revision = 0
const initial = useAppStore.getState()
afterEach(() => {
  cleanup()
  useAppStore.setState(initial, true)
  vi.clearAllMocks()
})
const target = { kind: 'local' } as const
const keybindings = { 'terminal.splitRight': ['Ctrl+Alt+Right'] }
function Host({ index }: { index: number }) {
  renders++
  const rootRef = createRef<HTMLDivElement>()
  const { menu, ...commands } = useStructuredNativeChatPaneCommands({
    tabId: `chat-${index}`,
    groupId: 'group',
    ownerWorktreeId: 'owner',
    isVisible: index % 3 !== 1,
    terminalPaneActions: index % 3 === 2 ? emptyNativeChatContextMenuActions : undefined,
    rootRef,
    composerRef: createRef(),
    questionAnswerInputRef: createRef(),
    sessionId: '4a1f6c2e-8b3d-4e7a-9c15-0d2b6e8f1a37',
    target
  })
  return (
    <div ref={rootRef} data-testid={`host-${index}`} {...commands}>
      {menu}
    </div>
  )
}
function seed(size: number) {
  const tabs: Tab[] = Array.from({ length: size }, (_, index) => ({
    id: `chat-${index}`,
    entityId: `session-${index}`,
    worktreeId: 'owner',
    groupId: 'group',
    contentType: 'agent-session',
    agentSessionAgent: 'codex',
    label: 'Chat',
    customLabel: null,
    color: null,
    createdAt: 0,
    sortOrder: index
  }))
  const group: TabGroup = {
    id: 'group',
    worktreeId: 'owner',
    activeTabId: tabs[0].id,
    tabOrder: tabs.map((t) => t.id)
  }
  useAppStore.setState({
    keybindings,
    unifiedTabsByWorktree: {
      owner: tabs,
      other: [{ ...tabs[0], id: 'other', worktreeId: 'other' }]
    },
    tabsByWorktree: {},
    groupsByWorktree: {
      owner: [group],
      other: [{ ...group, worktreeId: 'other', tabOrder: ['other'] }]
    }
  })
}
function measure(write: () => void) {
  for (const tabs of Object.values(useAppStore.getState().unifiedTabsByWorktree)) {
    for (const tab of tabs) {
      for (const key of ['id', 'groupId'] as const) {
        const value = tab[key]
        Object.defineProperty(tab, key, {
          configurable: true,
          enumerable: true,
          get: () => (reads++, value)
        })
      }
    }
  }
  reads = 0
  act(write)
  return reads
}

it.each([6, 60])(
  'does only writer work with %i retained closed/hidden/terminal menus; one open menu stays live and tears down',
  async (size) => {
    seed(size)
    const writes = [
      () => useAppStore.getState().setTabLabel('chat-1', `Title ${++revision}`),
      () => useAppStore.getState().activateTab('chat-1'),
      () => useAppStore.getState().setTabLabel('other', `Other ${++revision}`),
      () => useAppStore.getState().activateTab('other'),
      () => useAppStore.setState({ activeWorktreeId: 'unrelated' })
    ]
    const baseline = writes.map(measure)
    seed(size)
    const mounted = render(
      <TooltipProvider>
        {Array.from({ length: size }, (_, index) => (
          <Host key={index} index={index} />
        ))}
      </TooltipProvider>
    )
    const before = renders
    expect(writes.map(measure)).toEqual(baseline)
    expect(renders).toBe(before)
    fireEvent.keyDown(screen.getByTestId('host-0'), {
      key: 'ArrowRight',
      ctrlKey: true,
      altKey: true
    })
    expect(runNativeChatSplitTarget).toHaveBeenLastCalledWith(
      { kind: 'workspace-tab', unifiedTabId: 'chat-0', groupId: 'group' },
      'right'
    )
    fireEvent.contextMenu(screen.getByTestId('host-1'))
    expect(screen.queryByRole('menu')).toBeNull()
    fireEvent.contextMenu(screen.getByTestId('host-0'))
    await screen.findByRole('menuitem', { name: /Split Chat Right/ })
    expect(screen.queryByRole('menuitem', { name: 'Close Pane' })).toBeNull()
    const opened = renders
    const extra = measure(writes[0]) - baseline[0]
    expect(extra).toBeGreaterThanOrEqual(size - 1)
    expect(extra).toBeLessThanOrEqual(size * 2)
    expect(renders).toBe(opened)
    // The real content unmounts on close; retain only writer work afterward.
    await new Promise((resolve) => setTimeout(resolve, 110))
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    const closed = renders
    seed(size)
    expect(writes.map(measure)).toEqual(baseline)
    expect(renders).toBe(closed)
    fireEvent.contextMenu(screen.getByTestId('host-2'))
    await screen.findByRole('menu')
    expect(screen.queryByRole('menuitem', { name: /Split Chat/ })).toBeNull()
    seed(size)
    expect(writes.map(measure)).toEqual(baseline)
    mounted.unmount()
    seed(size)
    expect(writes.map(measure)).toEqual(baseline)
  }
)

it('keeps live sibling labels and the shared displayed-tab pinned-close guard', async () => {
  seed(6)
  const close = vi.fn()
  act(() =>
    useAppStore.setState((state) => ({
      closeUnifiedTab: close,
      settings: createGlobalSettingsFixture({ confirmClosePinnedTab: true }),
      groupsByWorktree: {
        ...state.groupsByWorktree,
        owner: [
          ...state.groupsByWorktree.owner,
          { ...state.groupsByWorktree.owner[0], id: 'split' }
        ]
      },
      unifiedTabsByWorktree: {
        ...state.unifiedTabsByWorktree,
        owner: state.unifiedTabsByWorktree.owner.map((tab) =>
          tab.id === 'chat-0' ? { ...tab, isPinned: true } : tab
        )
      }
    }))
  )
  render(
    <TooltipProvider>
      <Host index={0} />
    </TooltipProvider>
  )
  fireEvent.contextMenu(screen.getByTestId('host-0'))
  await screen.findByRole('menuitem', { name: 'Close tab' })
  expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
    expect.stringContaining('Split Chat Right'),
    expect.stringContaining('Split Chat Down'),
    'Copy Orca Session ID',
    'Close tab'
  ])
  for (const [direction, label] of [
    ['right', 'Split Chat Right'],
    ['down', 'Split Chat Down']
  ] as const) {
    await new Promise((resolve) => setTimeout(resolve, 110))
    fireEvent.click(screen.getByRole('menuitem', { name: new RegExp(label) }))
    expect(runNativeChatSplitTarget).toHaveBeenLastCalledWith(
      { kind: 'workspace-tab', unifiedTabId: 'chat-0', groupId: 'group' },
      direction
    )
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    fireEvent.contextMenu(screen.getByTestId('host-0'))
    await screen.findByRole('menuitem', { name: 'Close tab' })
  }
  const siblings = useAppStore.getState().unifiedTabsByWorktree.owner
  act(() =>
    useAppStore.setState((state) => ({
      unifiedTabsByWorktree: { ...state.unifiedTabsByWorktree, owner: [siblings[0]] }
    }))
  )
  expect(screen.getByRole('menuitem', { name: 'Close Pane' })).toBeTruthy()
  act(() =>
    useAppStore.setState((state) => ({
      unifiedTabsByWorktree: { ...state.unifiedTabsByWorktree, owner: siblings }
    }))
  )
  await new Promise((resolve) => setTimeout(resolve, 110))
  fireEvent.click(screen.getByRole('menuitem', { name: 'Close tab' }))
  expect(close).not.toHaveBeenCalled()
  expect(useAppStore.getState().pinnedTabCloseConfirm).not.toBeNull()
  act(() => useAppStore.getState().confirmPinnedTabClose())
  expect(close).toHaveBeenCalledExactlyOnceWith('chat-0')
  expect(useAppStore.getState().unifiedTabsByWorktree.owner).toEqual(siblings)
})
