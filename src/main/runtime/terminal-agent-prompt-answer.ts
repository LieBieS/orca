// The host's own answer to a hook-reported terminal agent's prompt: the keys the phone's and the
// window's cards send (the shared approval envelope and question key builders), written through
// the runtime's raw writer as `terminal.send` writes the phone's, but fenced on the exact prompt
// and process it was asked about, so a late answer cannot land in whatever the pane shows next.
import { createHash } from 'node:crypto'
import { readAgentPromptAnswers, type PendingPrompt } from '../../shared/agent-pending-prompt'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-ipc-payload'
import type { OrcaRuntimeService } from './orca-runtime'
import type { AgentPromptExpectedBinding } from './runtime-terminal-contracts'

export type TerminalAgentPromptAnswerRuntime = Pick<
  OrcaRuntimeService,
  'getTerminalHandleForPaneKey' | 'getTerminalPromptRequestBinding' | 'sendTerminal'
>

export type PanePromptTarget = {
  paneKey: string
  agent: string
  /** The agent's status hooks are on, so its rows say what it waits on. */
  answerable: boolean
}

type PanePrompt = {
  prompt: PendingPrompt
  keysByOption: ReadonlyMap<string, string>
  handle: string
  binding: AgentPromptExpectedBinding
}

export type PromptAnswerOutcome =
  | { outcome: 'accepted' }
  | {
      outcome: 'refused'
      reason:
        | 'prompt_not_pending'
        | 'prompt_unsupported'
        | 'option_not_offered'
        | 'agent_not_reachable'
    }
  | { outcome: 'unknown' }

const ANSWERED_MEMORY = 256

/** One prompt occurrence in one process: a later prompt, or the same one in a new process, differs. */
function promptIdentity(binding: AgentPromptExpectedBinding, row: AgentStatusIpcPayload): string {
  const facts = [
    binding.ptyId,
    binding.processIncarnation,
    row.stateStartedAt,
    row.interactivePrompt ?? '',
    row.toolName ?? ''
  ]
  return `p_${createHash('sha256').update(JSON.stringify(facts)).digest('hex').slice(0, 20)}`
}

class PromptNoLongerPendingError extends Error {
  constructor() {
    super('prompt_not_pending')
  }
}

/**
 * Answers prompts on this host. Remembers what it answered, so a second answer to one prompt
 * refuses even while the agent has not yet reported moving on.
 */
export class TerminalAgentPromptAnswers {
  private readonly answered = new Set<string>()

  constructor(private readonly readHookRow: (paneKey: string) => AgentStatusIpcPayload | null) {}

  pending(
    runtime: TerminalAgentPromptAnswerRuntime,
    target: PanePromptTarget
  ): PendingPrompt | null {
    return this.read(runtime, target)?.prompt ?? null
  }

  async answer(
    runtime: TerminalAgentPromptAnswerRuntime,
    target: PanePromptTarget,
    answer: {
      promptId: string
      optionId: string
      /** The caller's own check before the keys go in (its agent-in-front guard). */
      beforeWrite?: (ptyId: string) => Promise<void>
      signal: AbortSignal
    }
  ): Promise<PromptAnswerOutcome> {
    const asked = this.read(runtime, target)
    if (!asked || asked.prompt.promptId !== answer.promptId) {
      return { outcome: 'refused', reason: 'prompt_not_pending' }
    }
    if (asked.prompt.kind === 'unsupported') {
      return { outcome: 'refused', reason: 'prompt_unsupported' }
    }
    const keys = asked.keysByOption.get(answer.optionId)
    if (keys === undefined) {
      return { outcome: 'refused', reason: 'option_not_offered' }
    }
    let claimed = false
    try {
      const sent = await runtime.sendTerminal(
        asked.handle,
        { text: keys, enter: false },
        {
          inputKind: 'driving',
          signal: answer.signal,
          requireWriteSettlement: true,
          beforeWrite: async (ptyId) => {
            await answer.beforeWrite?.(ptyId)
            // Last and synchronous, so nothing moves between this read and the write.
            const now = this.read(runtime, target)
            if (
              ptyId !== asked.binding.ptyId ||
              now?.prompt.promptId !== answer.promptId ||
              now.binding.processIncarnation !== asked.binding.processIncarnation
            ) {
              throw new PromptNoLongerPendingError()
            }
            this.remember(answer.promptId)
            claimed = true
          }
        }
      )
      const settlement = sent.writeSettlement
      if (!settlement || settlement.outcome === 'accepted') {
        return { outcome: 'accepted' }
      }
      if (settlement.outcome === 'refused') {
        this.answered.delete(answer.promptId)
        return { outcome: 'refused', reason: 'agent_not_reachable' }
      }
      return { outcome: 'unknown' }
    } catch (error) {
      if (claimed) {
        return { outcome: 'unknown' }
      }
      return {
        outcome: 'refused',
        reason:
          error instanceof PromptNoLongerPendingError ? 'prompt_not_pending' : 'agent_not_reachable'
      }
    }
  }

  private read(
    runtime: TerminalAgentPromptAnswerRuntime,
    target: PanePromptTarget
  ): PanePrompt | null {
    const handle = runtime.getTerminalHandleForPaneKey(target.paneKey)
    const row = handle ? this.readHookRow(target.paneKey) : null
    if (!handle || !row) {
      return null
    }
    let binding: AgentPromptExpectedBinding
    try {
      const { ptyId, processIncarnation } = runtime.getTerminalPromptRequestBinding(handle)
      binding = { ptyId, processIncarnation }
    } catch {
      return null
    }
    const promptId = promptIdentity(binding, row)
    if (this.answered.has(promptId)) {
      return null
    }
    const read = readAgentPromptAnswers(row, target.agent, promptId, target.answerable)
    return read ? { ...read, handle, binding } : null
  }

  private remember(promptId: string): void {
    this.answered.add(promptId)
    if (this.answered.size > ANSWERED_MEMORY) {
      const oldest = this.answered.values().next().value
      if (oldest !== undefined) {
        this.answered.delete(oldest)
      }
    }
  }
}
