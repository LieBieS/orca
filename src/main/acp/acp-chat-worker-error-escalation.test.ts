import { afterEach, expect, it, vi } from 'vitest'
import { closeProviderTimelineRigs } from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { CALLER } from '../native-chat/agent-session-wire/structured-agent-session-host-test-harness'
import { HOST_TEST_SESSION as SESSION } from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import type { StructuredAgentSessionSinkAdmission } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { readAgentJournalTurn } from '../../shared/agent-session-turn-record'
import { OrchestrationDb } from '../runtime/orchestration/db'
import { createRootDispatch } from '../runtime/orchestration/db/root-dispatch-test-fixture'
import { escalateChatWorkerError } from '../runtime/orchestration/chat-worker-error-escalation'
import {
  mintStructuredWorkerHandle,
  mintStructuredWorkerPaneKey,
  structuredWorkerIdentities,
  structuredWorkerProcessIncarnation
} from '../runtime/structured-worker-identity'
import {
  attachParams,
  hello,
  openHostRig,
  promptIdOf,
  send
} from './acp-structured-host.test-support'
import { PROVIDER_SESSION, replyChunk, waitFor } from './acp-structured-adapter.test-support'

const databases: OrchestrationDb[] = []
const deliveries: Promise<void>[] = []
afterEach(async () => {
  await Promise.all(deliveries.splice(0))
  vi.restoreAllMocks()
  await closeProviderTimelineRigs()
  structuredWorkerIdentities.clear()
  for (const db of databases.splice(0)) {
    db.close()
  }
})

async function assigned() {
  const db = new OrchestrationDb(':memory:')
  databases.push(db)
  const identity = structuredWorkerIdentities.register({
    handle: mintStructuredWorkerHandle(),
    sessionId: SESSION,
    agent: 'grok',
    paneKey: mintStructuredWorkerPaneKey(SESSION),
    processIncarnation: structuredWorkerProcessIncarnation(SESSION),
    worktreeId: 'workspace-1',
    hostScope: { kind: 'local', hostId: 'local' }
  })
  const run = db.createRun({
    objective: 'ship',
    coordinatorHandle: 'term_coordinator',
    coordinatorPaneKey: 'tab_coordinator:11111111-1111-4111-8111-111111111111'
  })
  const dispatch = createRootDispatch(
    db,
    db.createTask({ spec: 'work', runId: run.id }).id,
    identity.handle,
    identity.paneKey
  )
  let enabled = true
  const failure = vi.fn((request: Parameters<typeof escalateChatWorkerError>[0]) => {
    deliveries.push(
      escalateChatWorkerError(request, { db: () => db, enabled: () => enabled, notify: () => {} })
    )
  })
  const h = await openHostRig({ onRequestFailure: failure })
  const acquire = h.rig.adapter.acquire.bind(h.rig.adapter)
  let allowed = Infinity
  vi.spyOn(h.rig.adapter, 'acquire').mockImplementation((input) => {
    const events = input.events
    const append = events?.tryAppendTransition?.bind(events)
    if (!events || !append) {
      throw new Error('transition sink missing')
    }
    vi.spyOn(events, 'tryAppendTransition').mockImplementation(
      (transition): StructuredAgentSessionSinkAdmission =>
        allowed-- > 0 ? append(transition) : { accepted: false, reason: 'backpressure' }
    )
    return acquire(input)
  })
  expect(await h.host.attach(CALLER, attachParams())).toMatchObject({ ok: true })
  await h.ready()
  const journal = h.host.collaboratorsForTests().sessions.get(SESSION)!.journal
  const start = async (id?: string) => {
    if (id) {
      await journal.appendSubmission({
        clientMessageId: id,
        payloadFingerprint: id,
        body: hello,
        fence: h.fence()
      })
      await h.rig.adapter.dispatch({
        sessionId: SESSION,
        clientMessageId: id,
        body: hello,
        fence: h.fence()
      })
    } else {
      id = await send(h.host, 'A')
    }
    const frame = await h.rig.frame('session/prompt')
    h.rig.child().agent.notify('session/update', replyChunk(promptIdOf(frame), 'started'))
    await h.rig.settle()
    return { id, frame }
  }
  const end = (prompt: string, detail?: string) =>
    h.rig.child().agent.notify('_x.ai/session_notification', {
      sessionId: PROVIDER_SESSION,
      update: {
        sessionUpdate: 'turn_completed',
        prompt_id: prompt,
        stop_reason: 'error',
        ...(detail ? { agent_result: detail } : {})
      }
    })
  return {
    ...h,
    db,
    run,
    dispatch,
    journal,
    failure,
    start,
    end,
    allow: (n: number) => {
      allowed = n
    },
    enabled: (value: boolean) => {
      enabled = value
    },
    mail: () => db.getUnreadRunMailbox(run.id, 100, ['escalation'])
  }
}

async function usingAssigned(test: (r: Awaited<ReturnType<typeof assigned>>) => Promise<void>) {
  const r = await assigned()
  try {
    await test(r)
  } finally {
    r.allow(Infinity)
    r.rig.child().exit()
    await r.host.flushAllStreamedEvents()
    await Promise.all(deliveries)
  }
}
const scenario = (name: string, test: Parameters<typeof usingAssigned>[0]) =>
  it(name, () => usingAssigned(test))

scenario(
  'waits for A’s late saved answer, including A finished before failure capture, without waiting for B',
  async (r) => {
    const { frame } = await r.start()
    r.allow(0)
    r.end(promptIdOf(frame))
    await send(r.host, 'B')
    r.rig.child().agent.fail(frame, -32603, 'Internal error', { details: 'precise A failure' })
    await r.rig.frame('session/prompt', 1)
    expect(r.failure).not.toHaveBeenCalled()
    r.allow(3) // Admit A’s generic diagnostic and end; keep its precise revision queued.
    await waitFor(() => expect(r.failure).toHaveBeenCalledTimes(1))
    expect(r.mail()).toHaveLength(0)
    r.allow(1) // Admit A’s precise revision only; B’s output remains backpressured.
    await waitFor(() => expect(r.mail()).toHaveLength(1))
    expect(r.mail()[0]?.body).toContain('Error: precise A failure')
    expect(r.db.getDispatchContextById(r.dispatch.id)?.status).toBe('dispatched')
    expect(r.rig.sent('session/prompt')).toHaveLength(2)
    r.allow(Infinity)
  }
)

it.each(['result', 'identical error'] as const)(
  'releases on a %s with no new diagnostic and retains the original saved input identity',
  async (answer) =>
    usingAssigned(async (r) => {
      const { frame } = await r.start(`input-${'x'.repeat(1100)}-尾`)
      r.end(promptIdOf(frame), 'saved A words')
      await waitFor(() => expect(r.failure).toHaveBeenCalledTimes(1))
      await new Promise((resolve) => setTimeout(resolve, 75))
      expect(r.mail()).toHaveLength(0)
      if (answer === 'result') {
        r.rig.child().agent.reply(frame, { stopReason: 'end_turn' })
      } else {
        r.rig.child().agent.fail(frame, -32603, 'saved A words')
      }
      await waitFor(() => expect(r.mail()).toHaveLength(1))
      expect(r.mail()[0]?.body).toContain('Error: saved A words')
    })
)

scenario(
  'bounds a prompt still pending after managed stdout EOF, sends once, and permits the next send',
  async (r) => {
    const { frame } = await r.start()
    r.end(promptIdOf(frame))
    await waitFor(() => expect(r.failure).toHaveBeenCalledTimes(1))
    r.rig.child().agent.stdout.end()
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(r.mail()).toHaveLength(0)
    await vi.waitFor(() => expect(r.mail()).toHaveLength(1), { timeout: 3000 })
    expect(r.mail()[0]?.body).toContain('Grok ended this turn with an error.')
    expect(r.rig.child().exited).toBe(false)
    expect(await send(r.host, 'next')).toBeTypeOf('string')
  }
)

scenario(
  'ends observation on actual connection loss without waiting for process-exit cleanup',
  async (r) => {
    const { frame } = await r.start()
    r.end(promptIdOf(frame), 'failure before close')
    await waitFor(() => expect(r.failure).toHaveBeenCalledTimes(1))
    r.rig.child().proveClose = async () => false
    r.rig.child().agent.stdout.emit('error', new Error('transport lost'))
    await waitFor(() => expect(r.mail()).toHaveLength(1))
    expect(r.mail()[0]?.body).toContain('Error: failure before close')
    expect(r.rig.child().exited).toBe(false)
    r.rig.child().exit()
  }
)

it.each(['dispatch', 'setting', 'history', 'clear'] as const)(
  'preserves %s authority/lifetime behavior during the pending answer',
  async (change) =>
    usingAssigned(async (r) => {
      const { frame } = await r.start()
      r.end(promptIdOf(frame), 'captured A words')
      await waitFor(() => expect(r.failure).toHaveBeenCalledTimes(1))
      if (change === 'dispatch') {
        r.db.completeDispatch(r.dispatch.id)
        createRootDispatch(
          r.db,
          r.db.createTask({ spec: 'B', runId: r.run.id }).id,
          r.dispatch.assignee_handle!,
          r.dispatch.assignee_pane_key ?? undefined
        )
      } else if (change === 'setting') {
        r.enabled(false)
      } else if (change === 'history') {
        r.host
          .collaboratorsForTests()
          .sessions.set(SESSION, r.host.collaboratorsForTests().sessions.get(SESSION)!)
      } else {
        await r.journal.context.clear(
          { operationId: 'clear-during-wait', afterFence: r.fence(), clearedAt: 1 },
          { write: () => {}, committed: () => {} },
          'clear'
        )
      }
      r.rig.child().agent.reply(frame, { stopReason: 'end_turn' })
      await Promise.all(deliveries)
      expect(r.mail()).toHaveLength(change === 'clear' ? 1 : 0)
      if (change === 'clear') {
        expect(r.mail()[0]?.body).toContain('captured A words')
      }
      expect(
        (await r.host.journalSnapshot(SESSION)).items.some((item) =>
          readAgentJournalTurn(item.body)
        )
      ).toBe(true)
    })
)
