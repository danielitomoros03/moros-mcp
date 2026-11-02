import { addDoc, collection, doc, getDoc, getDocs, setDoc, serverTimestamp } from 'firebase/firestore'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createService, ToolError } from '../src/service.js'
import type { Session } from '../src/session.js'
import { clearAll, ensureAuthUsers, seed, signInAs, testDb } from './seed.js'

// `db` (admin) seeds and inspects the data; the service under test runs as a signed-in person, so the real rules apply.
const db = testDb()
let me: Session
let nobody: Session
const service = () => createService({ db: me.db, uid: me.uid })

beforeAll(async () => {
  await ensureAuthUsers()
  me = await signInAs('me')
  nobody = await signInAs('nobody')
})

afterAll(async () => {
  await me.close()
  await nobody.close()
})

beforeEach(async () => {
  await clearAll()
  await seed(db)
})

describe('acceso', () => {
  it('lista solo los tableros del usuario, sin archivados ni ajenos', async () => {
    const boards = await service().listBoards()
    expect(boards.map((b) => b.id).sort()).toEqual(['b1', 'b4'])
    expect(boards.find((b) => b.id === 'b1')?.columns.map((c) => c.kind)).toEqual(['todo', 'doing', 'done'])
    expect(boards.find((b) => b.id === 'b4')?.yourRole).toBe('viewer')
  })

  it('un tablero ajeno o archivado parece no existir', async () => {
    await expect(service().getBoard({ boardId: 'b2' })).rejects.toThrow(/not found or not accessible/)
    await expect(service().listCards({ boardId: 'b3' })).rejects.toThrow(ToolError)
  })

  it('quien no es miembro de nada ve una lista vacía y los tableros de otros no existen para él', async () => {
    const stranger = createService({ db: nobody.db, uid: nobody.uid })
    expect(await stranger.listBoards()).toEqual([])
    await expect(stranger.getBoard({ boardId: 'b1' })).rejects.toThrow(/not found or not accessible/)
    await expect(stranger.createCard({ boardId: 'b1', title: 'Intruso' })).rejects.toThrow(/not found or not accessible/)
  })

  it('las reglas de Firestore bloquean lo ajeno aunque se salten las validaciones del servicio', async () => {
    await expect(getDoc(doc(me.db, 'boards/b2'))).rejects.toMatchObject({ code: 'permission-denied' })
    await expect(getDocs(collection(me.db, 'boards/b2/cards'))).rejects.toMatchObject({ code: 'permission-denied' })
    const card = { title: 'x', columnId: 'c1', position: 1, priority: 'none', archived: false, createdBy: 'me', createdAt: serverTimestamp(), updatedAt: serverTimestamp() }
    await expect(addDoc(collection(me.db, 'boards/b4/cards'), card)).rejects.toMatchObject({ code: 'permission-denied' }) // solo lectura
    await expect(setDoc(doc(me.db, 'boards/b1/cards/falsa'), { ...card, createdBy: 'ana' })).rejects.toMatchObject({ code: 'permission-denied' }) // firma ajena
  })

  it('un lector no puede escribir, pero sí leer', async () => {
    const s = service()
    expect((await s.listCards({ boardId: 'b4' })).map((c) => c.id)).toEqual(['V'])
    await expect(s.createCard({ boardId: 'b4', title: 'Nueva' })).rejects.toThrow(/read access/)
    await expect(s.moveCard({ boardId: 'b4', cardId: 'V', kind: 'done' })).rejects.toThrow(/read access/)
    await expect(s.addComment({ boardId: 'b4', cardId: 'V', text: 'hola' })).rejects.toThrow(/read access/)
  })
})

describe('lectura', () => {
  it('getBoard muestra columnas con conteo, etiquetas y miembros', async () => {
    const board = await service().getBoard({ boardId: 'b1' })
    expect(board.columns.map((c) => [c.name, c.cards])).toEqual([['Por hacer', 2], ['En curso', 1], ['Hecho', 1]])
    expect(board.members).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'Daniel', email: 'me@example.com', role: 'owner' }),
        expect.objectContaining({ name: 'Ana', role: 'editor' }),
      ]),
    )
  })

  it('listCards ordena por columna y posición y excluye archivadas', async () => {
    const cards = await service().listCards({ boardId: 'b1' })
    expect(cards.map((c) => c.id)).toEqual(['A', 'B', 'C', 'D'])
    expect(cards[0]).toMatchObject({ title: 'Definir reglas', priority: 'high', labels: ['backend'], assignee: { name: 'Ana' }, descriptionPreview: 'Reglas estrictas' })
  })

  it('listCards filtra por tipo, prioridad y responsable', async () => {
    const s = service()
    expect((await s.listCards({ boardId: 'b1', kind: 'doing' })).map((c) => c.id)).toEqual(['C'])
    expect((await s.listCards({ boardId: 'b1', priority: 'low' })).map((c) => c.id)).toEqual(['B'])
    expect((await s.listCards({ boardId: 'b1', assignee: 'ana@example.com' })).map((c) => c.id)).toEqual(['A'])
    await expect(s.listCards({ boardId: 'b1', assignee: 'otro@example.com' })).rejects.toThrow(/not a member/)
  })

  it('getCard incluye comentarios e historial', async () => {
    const s = service()
    await s.addComment({ boardId: 'b1', cardId: 'A', text: 'Hecho en el commit abc123' })
    const card = await s.getCard({ boardId: 'b1', cardId: 'A' })
    expect(card.comments).toEqual([expect.objectContaining({ author: 'Daniel', text: 'Hecho en el commit abc123' })])
    expect(card.history[0]).toMatchObject({ type: 'comment_added', by: 'Daniel', via: 'claude' })
    await expect(s.getCard({ boardId: 'b1', cardId: 'E' })).rejects.toThrow(/not found/)
  })
})

describe('escritura', () => {
  it('createCard va al final de la primera columna todo y deja historial', async () => {
    const created = await service().createCard({
      boardId: 'b1',
      title: '  Conectar con Claude  ',
      description: 'Criterios: lista y mueve tarjetas',
      priority: 'high',
      labels: ['Backend'],
      assignee: 'ana@example.com',
      dueDate: '2026-11-12',
    })
    expect(created).toMatchObject({ title: 'Conectar con Claude', column: { kind: 'todo' }, priority: 'high', labels: ['backend'], dueDate: '2026-11-12', assignee: { name: 'Ana' } })
    const stored = (await db.doc(`boards/b1/cards/${created.id}`).get()).data()!
    expect(stored.position).toBe(3072)
    expect(stored.createdBy).toBe('me')
    const log = await db.collection('boards/b1/activity').where('cardId', '==', created.id).get()
    expect(log.docs[0].data()).toMatchObject({ type: 'card_created', actorId: 'me', data: { columnName: 'Por hacer', via: 'claude' } })
  })

  it('createCard valida entradas', async () => {
    const s = service()
    await expect(s.createCard({ boardId: 'b1', title: '   ' })).rejects.toThrow(/title/)
    await expect(s.createCard({ boardId: 'b1', title: 'x'.repeat(201) })).rejects.toThrow(/title/)
    await expect(s.createCard({ boardId: 'b1', title: 'ok', labels: ['inexistente'] })).rejects.toThrow(/Available labels: backend, diseño/)
    await expect(s.createCard({ boardId: 'b1', title: 'ok', dueDate: '12/11/2026' })).rejects.toThrow(/YYYY-MM-DD/)
    await expect(s.createCard({ boardId: 'b1', title: 'ok', dueDate: '2026-02-31' })).rejects.toThrow(/Invalid dueDate/)
    await expect(s.createCard({ boardId: 'b1', title: 'ok', columnId: 'zzz' })).rejects.toThrow(/Column zzz not found/)
    await expect(s.createCard({ boardId: 'b1', title: 'ok', priority: 'critical' as never })).rejects.toThrow(/priority/)
  })

  it('updateCard cambia solo lo pedido, registra cada campo y no hace nada si no cambia', async () => {
    const s = service()
    const result = await s.updateCard({ boardId: 'b1', cardId: 'B', title: 'Boceto v2', priority: 'urgent', dueDate: '2026-12-01', labels: ['diseño'], assignee: 'me@example.com' })
    expect(result.changed).toBe(true)
    expect(result.card).toMatchObject({ title: 'Boceto v2', priority: 'urgent', dueDate: '2026-12-01', labels: ['diseño'], assignee: { name: 'Daniel' } })
    const log = await db.collection('boards/b1/activity').where('cardId', '==', 'B').get()
    expect(log.docs.map((d) => d.data().data.field).sort()).toEqual(['assigneeId', 'dueDate', 'labelIds', 'priority', 'title'])

    const again = await s.updateCard({ boardId: 'b1', cardId: 'B', priority: 'urgent' })
    expect(again.changed).toBe(false)
    const cleared = await s.updateCard({ boardId: 'b1', cardId: 'B', assignee: null, dueDate: null, labels: [] })
    expect(cleared.card).toMatchObject({ assignee: null, dueDate: null, labels: [] })
  })

  it('updateCard rechaza responsables que no son miembros', async () => {
    await expect(service().updateCard({ boardId: 'b1', cardId: 'B', assignee: 'other@example.com' })).rejects.toThrow(/not a member/)
  })

  it('moveCard por tipo va al final de la columna, con historial y nombres', async () => {
    const moved = await service().moveCard({ boardId: 'b1', cardId: 'A', kind: 'doing' })
    expect(moved.column).toMatchObject({ id: 'c2', kind: 'doing' })
    expect((await db.doc('boards/b1/cards/A').get()).data()!.position).toBe(2048)
    const log = await db.collection('boards/b1/activity').where('cardId', '==', 'A').get()
    expect(log.docs[0].data()).toMatchObject({ type: 'card_moved', actorId: 'me', data: { fromName: 'Por hacer', toName: 'En curso', via: 'claude' } })
  })

  it('moveCard por columnId, al inicio, y reordenar en la misma columna no deja historial', async () => {
    const s = service()
    await s.moveCard({ boardId: 'b1', cardId: 'B', columnId: 'c1', position: 'start' })
    expect((await db.doc('boards/b1/cards/B').get()).data()!.position).toBe(0)
    expect((await s.listCards({ boardId: 'b1', kind: 'todo' })).map((c) => c.id)).toEqual(['B', 'A'])
    expect((await db.collection('boards/b1/activity').where('cardId', '==', 'B').get()).empty).toBe(true)
    await expect(s.moveCard({ boardId: 'b1', cardId: 'B' })).rejects.toThrow(/columnId or kind/)
  })

  it('addComment suma al contador y firma con la cuenta del usuario', async () => {
    const s = service()
    await s.addComment({ boardId: 'b1', cardId: 'C', text: 'Primero' })
    const result = await s.addComment({ boardId: 'b1', cardId: 'C', text: 'Segundo' })
    expect(result.commentCount).toBe(2)
    const stored = (await db.doc('boards/b1/cards/C').get()).data()!
    expect(stored.commentCount).toBe(2)
    const comments = await db.collection('boards/b1/cards/C/comments').get()
    expect(comments.docs.every((d) => d.data().authorId === 'me' && d.data().editedAt === null)).toBe(true)
    await expect(s.addComment({ boardId: 'b1', cardId: 'C', text: '' })).rejects.toThrow(/text/)
  })

  it('archiveCard saca la tarjeta del tablero sin borrarla', async () => {
    const s = service()
    await s.archiveCard({ boardId: 'b1', cardId: 'D' })
    expect((await s.listCards({ boardId: 'b1' })).map((c) => c.id)).toEqual(['A', 'B', 'C'])
    expect((await db.doc('boards/b1/cards/D').get()).data()!.archived).toBe(true)
    await expect(s.archiveCard({ boardId: 'b1', cardId: 'D' })).rejects.toThrow(/not found/)
  })

  it('limpia al responsable que ya no es miembro al escribir en la tarjeta', async () => {
    await db.doc('boards/b1/cards/B').update({ assigneeId: 'gone' })
    await service().updateCard({ boardId: 'b1', cardId: 'B', title: 'Sigue editable' })
    expect((await db.doc('boards/b1/cards/B').get()).data()!.assigneeId).toBeNull()
  })
})
