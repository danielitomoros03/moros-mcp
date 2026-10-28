import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createServer } from '../src/server.js'
import { createService } from '../src/service.js'
import { clearAll, seed, testDb } from './seed.js'

const db = testDb()
let client: Client

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const result = await client.callTool({ name, arguments: args })
  const first = (result.content as { type: string; text: string }[])[0]
  return { isError: Boolean(result.isError), text: first.text }
}

beforeAll(async () => {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await createServer(createService({ db, userEmail: 'me@example.com' })).connect(serverSide)
  client = new Client({ name: 'test', version: '1.0.0' })
  await client.connect(clientSide)
})

afterAll(async () => {
  await client.close()
})

beforeEach(async () => {
  await clearAll()
  await seed(db)
})

describe('protocolo MCP', () => {
  it('publica las nueve herramientas con descripción y las instrucciones de uso', async () => {
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual([
      'add_comment', 'archive_card', 'create_card', 'get_board', 'get_card', 'list_boards', 'list_cards', 'move_card', 'update_card',
    ])
    expect(tools.every((t) => (t.description ?? '').length > 20)).toBe(true)
    expect(tools.find((t) => t.name === 'list_cards')?.annotations?.readOnlyHint).toBe(true)
    expect(client.getInstructions()).toMatch(/kind/)
  })

  it('flujo completo: ver pendientes, empezar, comentar y terminar', async () => {
    const boards = JSON.parse((await call('list_boards')).text)
    expect(boards.map((b: { id: string }) => b.id)).toContain('b1')

    const todo = JSON.parse((await call('list_cards', { boardId: 'b1', kind: 'todo' })).text)
    expect(todo.map((c: { id: string }) => c.id)).toEqual(['A', 'B'])

    await call('move_card', { boardId: 'b1', cardId: 'A', kind: 'doing' })
    await call('add_comment', { boardId: 'b1', cardId: 'A', text: 'Implementado en el commit abc123' })
    await call('move_card', { boardId: 'b1', cardId: 'A', kind: 'done' })

    const done = JSON.parse((await call('list_cards', { boardId: 'b1', kind: 'done' })).text)
    expect(done.map((c: { id: string }) => c.id)).toEqual(['D', 'A'])
    const card = JSON.parse((await call('get_card', { boardId: 'b1', cardId: 'A' })).text)
    expect(card.history.map((h: { type: string }) => h.type)).toEqual(['card_moved', 'comment_added', 'card_moved'])
  })

  it('los errores de negocio llegan como resultado con isError', async () => {
    const result = await call('get_card', { boardId: 'b2', cardId: 'X' })
    expect(result.isError).toBe(true)
    expect(result.text).toMatch(/not found or not accessible/)
  })

  it('rechaza entradas que no cumplen el esquema', async () => {
    const bad = await call('create_card', { boardId: 'b1', title: 'x', priority: 'critical' })
    expect(bad.isError).toBe(true)
    const missing = await call('move_card', { boardId: 'b1' })
    expect(missing.isError).toBe(true)
  })
})
