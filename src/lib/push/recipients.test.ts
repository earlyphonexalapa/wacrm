import { describe, expect, it } from 'vitest'
import { pushRecipients } from './recipients'

const members = [
  { user_id: 'owner', account_role: 'owner' },
  { user_id: 'admin', account_role: 'admin' },
  { user_id: 'closer1', account_role: 'agent' },
  { user_id: 'closer2', account_role: 'agent' },
  { user_id: 'viewer', account_role: 'viewer' },
]

describe('pushRecipients', () => {
  it('notifies only the closer who owns the chat', () => {
    expect(pushRecipients({ owner_agent_id: 'closer1' }, members, false)).toEqual(['closer1'])
  })

  it('notifies owner and assignee once each', () => {
    expect(
      pushRecipients(
        { owner_agent_id: 'closer1', assigned_agent_id: 'closer2' },
        members,
        true,
      ),
    ).toEqual(['closer1', 'closer2'])
    expect(
      pushRecipients({ owner_agent_id: 'closer1', assigned_agent_id: 'closer1' }, members, true),
    ).toEqual(['closer1'])
  })

  it('notifies every non-viewer for an unclaimed chat when isolation is off', () => {
    expect(pushRecipients({}, members, false)).toEqual(['owner', 'admin', 'closer1', 'closer2'])
  })

  it('notifies only admins and the owner for an unclaimed chat when isolation is on', () => {
    expect(pushRecipients({ owner_agent_id: null }, members, true)).toEqual(['owner', 'admin'])
  })

  it('ignores an owner who is no longer a member', () => {
    expect(pushRecipients({ owner_agent_id: 'gone' }, members, true)).toEqual(['owner', 'admin'])
  })
})
