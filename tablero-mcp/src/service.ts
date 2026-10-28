import { FieldValue, Timestamp, type DocumentData, type Firestore, type WriteBatch } from 'firebase-admin/firestore'
import { positionAtEnd, positionBetween } from './ordering.js'

// Thrown for problems the caller can fix (bad input, no access); shown to Claude as the tool result.
export class ToolError extends Error {}

export const PRIORITIES = ['none', 'low', 'medium', 'high', 'urgent'] as const
export const KINDS = ['todo', 'doing', 'done'] as const
export type Priority = (typeof PRIORITIES)[number]
export type Kind = (typeof KINDS)[number]
type Role = 'owner' | 'editor' | 'viewer'

interface Column {
  id: string
  name: string
  kind: Kind
}

interface Label {
  id: string
  name: string
  color: string
}

interface BoardDoc {
  id: string
  name: string
  description: string
  ownerId: string
  members: Record<string, Role>
  memberIds: string[]
  columns: Column[]
  labels: Label[]
}

interface CardDoc {
  id: string
  title: string
  description: string
  columnId: string
  position: number
  assigneeId: string | null
  labelIds: string[]
  dueDate: Timestamp | null
  priority: Priority
  commentCount: number
  createdBy: string
  createdAt: Timestamp
  updatedAt: Timestamp
}

interface ActivityDraft {
  type: 'card_created' | 'card_moved' | 'card_updated' | 'card_archived' | 'comment_added'
  data: Record<string, string | number | null>
}

interface Profile {
  uid: string
  displayName: string
  email: string
}

// Same limits the Firestore rules enforce for the web app; the Admin SDK skips the rules, so they are checked here.
const LIMITS = { title: 200, description: 5000, comment: 2000, labelsPerCard: 10 }

export interface ServiceOptions {
  db: Firestore
  userEmail: string
  actor?: string
}

export type Service = ReturnType<typeof createService>

const iso = (value: Timestamp | undefined | null) => (value ? value.toDate().toISOString() : null)
const dateOnly = (value: Timestamp | null) => (value ? value.toDate().toISOString().slice(0, 10) : null)

function parseDate(value: string): Timestamp {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  const date = new Date(`${value}T12:00:00Z`)
  if (!match || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new ToolError(`Invalid dueDate "${value}". Use YYYY-MM-DD, for example 2026-11-12.`)
  }
  const year = Number(match[1])
  if (year < 2000 || year > 2100) throw new ToolError(`dueDate year must be between 2000 and 2100, got ${year}.`)
  // Noon UTC shows the same calendar day in every timezone the web app is likely to be used from.
  return Timestamp.fromDate(date)
}

function toCard(id: string, data: DocumentData): CardDoc {
  return {
    id,
    title: data.title,
    description: data.description ?? '',
    columnId: data.columnId,
    position: data.position,
    assigneeId: data.assigneeId ?? null,
    labelIds: data.labelIds ?? [],
    dueDate: data.dueDate ?? null,
    priority: data.priority ?? 'none',
    commentCount: data.commentCount ?? 0,
    createdBy: data.createdBy,
    createdAt: data.createdAt,
    updatedAt: data.updatedAt,
  }
}

function toBoard(id: string, data: DocumentData): BoardDoc {
  return {
    id,
    name: data.name,
    description: data.description ?? '',
    ownerId: data.ownerId,
    members: data.members ?? {},
    memberIds: data.memberIds ?? [],
    columns: data.columns ?? [],
    labels: data.labels ?? [],
  }
}

export function createService({ db, userEmail, actor = 'claude' }: ServiceOptions) {
  let uidPromise: Promise<string> | undefined
  const profileCache = new Map<string, Profile | null>()

  const boardRef = (boardId: string) => db.collection('boards').doc(boardId)
  const cardRef = (boardId: string, cardId: string) => boardRef(boardId).collection('cards').doc(cardId)

  async function findUid() {
    const snapshot = await db.collection('users').where('email', '==', userEmail.trim().toLowerCase()).limit(1).get()
    if (snapshot.empty) {
      throw new ToolError(
        `No profile found for ${userEmail}. Sign in once at the tablero web app with that email, then try again.`,
      )
    }
    return snapshot.docs[0].id
  }
  const getUid = () => (uidPromise ??= findUid().catch((error) => {
    uidPromise = undefined
    throw error
  }))

  async function profile(uid: string): Promise<Profile | null> {
    if (!profileCache.has(uid)) {
      const snap = await db.collection('users').doc(uid).get()
      const data = snap.data()
      profileCache.set(uid, data ? { uid, displayName: data.displayName ?? '', email: data.email ?? '' } : null)
    }
    return profileCache.get(uid) ?? null
  }

  async function nameOf(uid: string) {
    if (uid === actor) return 'Claude'
    const found = await profile(uid)
    return found?.displayName || found?.email || 'Unknown user'
  }

  // Boards where the configured user is a member. Anything else looks like it does not exist.
  async function loadBoard(boardId: string, access: 'read' | 'write'): Promise<BoardDoc> {
    const uid = await getUid()
    const snap = await boardRef(boardId).get()
    const data = snap.data()
    if (!snap.exists || !data || data.archived || !data.members?.[uid]) {
      throw new ToolError(`Board ${boardId} not found or not accessible. Use list_boards to see the available boards.`)
    }
    if (access === 'write' && data.members[uid] === 'viewer') {
      throw new ToolError(`You only have read access to board "${data.name}".`)
    }
    return toBoard(snap.id, data)
  }

  async function loadCard(boardId: string, cardId: string): Promise<CardDoc> {
    const snap = await cardRef(boardId, cardId).get()
    const data = snap.data()
    if (!snap.exists || !data || data.archived) {
      throw new ToolError(`Card ${cardId} not found in board ${boardId}. Use list_cards to see the available cards.`)
    }
    return toCard(snap.id, data)
  }

  async function activeCards(boardId: string): Promise<CardDoc[]> {
    const snapshot = await boardRef(boardId).collection('cards').where('archived', '==', false).get()
    return snapshot.docs.map((doc) => toCard(doc.id, doc.data()))
  }

  function pickColumn(board: BoardDoc, input: { columnId?: string; kind?: Kind }, fallbackKind?: Kind): Column {
    if (input.columnId) {
      const column = board.columns.find((item) => item.id === input.columnId)
      if (!column) {
        const options = board.columns.map((item) => `${item.id} (${item.name})`).join(', ')
        throw new ToolError(`Column ${input.columnId} not found. Columns: ${options}.`)
      }
      return column
    }
    const kind = input.kind ?? fallbackKind
    const column = kind ? board.columns.find((item) => item.kind === kind) : board.columns[0]
    if (!column) throw new ToolError(`The board has no column of kind "${kind}". Pass columnId instead.`)
    return column
  }

  function resolveLabels(board: BoardDoc, labels: string[]): string[] {
    if (labels.length > LIMITS.labelsPerCard) throw new ToolError(`A card supports at most ${LIMITS.labelsPerCard} labels.`)
    const ids = labels.map((value) => {
      const wanted = value.trim().toLowerCase()
      const found = board.labels.find((label) => label.id === value || label.name.toLowerCase() === wanted)
      if (!found) {
        const options = board.labels.map((label) => label.name).join(', ') || '(none defined)'
        throw new ToolError(`Label "${value}" does not exist in this board. Available labels: ${options}.`)
      }
      return found.id
    })
    return [...new Set(ids)]
  }

  async function resolveAssignee(board: BoardDoc, value: string): Promise<string> {
    const wanted = value.trim().toLowerCase()
    for (const uid of board.memberIds) {
      const person = await profile(uid)
      if (uid === value || (person && person.email.toLowerCase() === wanted)) return uid
    }
    const emails = (await Promise.all(board.memberIds.map(profile))).map((person) => person?.email).filter(Boolean)
    throw new ToolError(`"${value}" is not a member of this board. Members: ${emails.join(', ')}.`)
  }

  const assigneeFix = (board: BoardDoc, card: CardDoc) =>
    card.assigneeId && !board.members[card.assigneeId] ? { assigneeId: null } : {}

  function addActivity(batch: WriteBatch, boardId: string, card: { id: string; title: string }, draft: ActivityDraft) {
    batch.set(boardRef(boardId).collection('activity').doc(), {
      type: draft.type,
      cardId: card.id,
      cardTitle: card.title,
      actorId: actor,
      at: FieldValue.serverTimestamp(),
      data: draft.data,
    })
  }

  async function describeCard(board: BoardDoc, card: CardDoc) {
    const column = board.columns.find((item) => item.id === card.columnId)
    const assignee = card.assigneeId && board.members[card.assigneeId] ? card.assigneeId : null
    return {
      id: card.id,
      title: card.title,
      column: column ? { id: column.id, name: column.name, kind: column.kind } : null,
      priority: card.priority,
      assignee: assignee ? { uid: assignee, name: await nameOf(assignee) } : null,
      labels: board.labels.filter((label) => card.labelIds.includes(label.id)).map((label) => label.name),
      dueDate: dateOnly(card.dueDate),
      commentCount: card.commentCount,
      updatedAt: iso(card.updatedAt),
    }
  }

  return {
    async listBoards() {
      const uid = await getUid()
      const snapshot = await db
        .collection('boards')
        .where('memberIds', 'array-contains', uid)
        .orderBy('updatedAt', 'desc')
        .get()
      return snapshot.docs
        .filter((doc) => !doc.data().archived)
        .map((doc) => {
          const board = toBoard(doc.id, doc.data())
          return {
            id: board.id,
            name: board.name,
            description: board.description,
            yourRole: board.members[uid],
            columns: board.columns,
            labels: board.labels.map((label) => label.name),
          }
        })
    },

    async getBoard(input: { boardId: string }) {
      const board = await loadBoard(input.boardId, 'read')
      const cards = await activeCards(board.id)
      const members = await Promise.all(
        board.memberIds.map(async (uid) => {
          const person = await profile(uid)
          return { uid, name: person?.displayName ?? null, email: person?.email ?? null, role: board.members[uid] }
        }),
      )
      return {
        id: board.id,
        name: board.name,
        description: board.description,
        columns: board.columns.map((column) => ({
          ...column,
          cards: cards.filter((card) => card.columnId === column.id).length,
        })),
        labels: board.labels,
        members,
      }
    },

    async listCards(input: {
      boardId: string
      kind?: Kind
      columnId?: string
      priority?: Priority
      assignee?: string
    }) {
      const board = await loadBoard(input.boardId, 'read')
      const assigneeId = input.assignee ? await resolveAssignee(board, input.assignee) : undefined
      const order = new Map(board.columns.map((column, index) => [column.id, index]))
      const cards = (await activeCards(board.id))
        .filter((card) => order.has(card.columnId))
        .filter((card) => {
          const column = board.columns[order.get(card.columnId)!]
          if (input.kind && column.kind !== input.kind) return false
          if (input.columnId && card.columnId !== input.columnId) return false
          if (input.priority && card.priority !== input.priority) return false
          if (assigneeId && card.assigneeId !== assigneeId) return false
          return true
        })
        .sort((a, b) => order.get(a.columnId)! - order.get(b.columnId)! || a.position - b.position)
      return Promise.all(
        cards.map(async (card) => ({
          ...(await describeCard(board, card)),
          descriptionPreview: card.description.length > 160 ? `${card.description.slice(0, 160)}…` : card.description,
        })),
      )
    },

    async getCard(input: { boardId: string; cardId: string }) {
      const board = await loadBoard(input.boardId, 'read')
      const card = await loadCard(board.id, input.cardId)
      const commentsSnap = await cardRef(board.id, card.id).collection('comments').orderBy('createdAt', 'asc').get()
      const activitySnap = await boardRef(board.id)
        .collection('activity')
        .where('cardId', '==', card.id)
        .orderBy('at', 'desc')
        .limit(30)
        .get()
      return {
        ...(await describeCard(board, card)),
        description: card.description,
        createdBy: await nameOf(card.createdBy),
        createdAt: iso(card.createdAt),
        comments: await Promise.all(
          commentsSnap.docs.map(async (doc) => ({
            id: doc.id,
            author: await nameOf(doc.data().authorId),
            text: doc.data().text,
            createdAt: iso(doc.data().createdAt),
            edited: Boolean(doc.data().editedAt),
          })),
        ),
        history: await Promise.all(
          activitySnap.docs.map(async (doc) => ({
            type: doc.data().type,
            by: await nameOf(doc.data().actorId),
            at: iso(doc.data().at),
            data: doc.data().data ?? {},
          })),
        ),
      }
    },

    async createCard(input: {
      boardId: string
      title: string
      description?: string
      columnId?: string
      kind?: Kind
      priority?: Priority
      labels?: string[]
      assignee?: string
      dueDate?: string
    }) {
      const board = await loadBoard(input.boardId, 'write')
      const title = input.title.trim()
      if (!title || title.length > LIMITS.title) throw new ToolError(`title must have 1 to ${LIMITS.title} characters.`)
      const description = input.description ?? ''
      if (description.length > LIMITS.description) throw new ToolError(`description is longer than ${LIMITS.description} characters.`)
      if (input.priority && !PRIORITIES.includes(input.priority)) throw new ToolError(`priority must be one of ${PRIORITIES.join(', ')}.`)

      const column = pickColumn(board, input, 'todo')
      const labelIds = input.labels ? resolveLabels(board, input.labels) : []
      const assigneeId = input.assignee ? await resolveAssignee(board, input.assignee) : null
      const dueDate = input.dueDate ? parseDate(input.dueDate) : null
      const siblings = (await activeCards(board.id)).filter((card) => card.columnId === column.id)

      const ref = boardRef(board.id).collection('cards').doc()
      const batch = db.batch()
      batch.set(ref, {
        title,
        description,
        columnId: column.id,
        position: positionAtEnd(siblings.map((card) => card.position)),
        assigneeId,
        labelIds,
        dueDate,
        priority: input.priority ?? 'none',
        archived: false,
        commentCount: 0,
        createdBy: actor,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      })
      addActivity(batch, board.id, { id: ref.id, title }, {
        type: 'card_created',
        data: { columnId: column.id, columnName: column.name },
      })
      await batch.commit()
      return describeCard(board, await loadCard(board.id, ref.id))
    },

    async updateCard(input: {
      boardId: string
      cardId: string
      title?: string
      description?: string
      priority?: Priority
      labels?: string[]
      assignee?: string | null
      dueDate?: string | null
    }) {
      const board = await loadBoard(input.boardId, 'write')
      const card = await loadCard(board.id, input.cardId)
      const patch: Record<string, unknown> = {}
      const drafts: ActivityDraft[] = []

      if (input.title !== undefined) {
        const title = input.title.trim()
        if (!title || title.length > LIMITS.title) throw new ToolError(`title must have 1 to ${LIMITS.title} characters.`)
        if (title !== card.title) {
          patch.title = title
          drafts.push({ type: 'card_updated', data: { field: 'title', from: card.title, to: title } })
        }
      }
      if (input.description !== undefined && input.description !== card.description) {
        if (input.description.length > LIMITS.description) throw new ToolError(`description is longer than ${LIMITS.description} characters.`)
        patch.description = input.description
        drafts.push({ type: 'card_updated', data: { field: 'description' } })
      }
      if (input.priority !== undefined && input.priority !== card.priority) {
        if (!PRIORITIES.includes(input.priority)) throw new ToolError(`priority must be one of ${PRIORITIES.join(', ')}.`)
        patch.priority = input.priority
        drafts.push({ type: 'card_updated', data: { field: 'priority', from: card.priority, to: input.priority } })
      }
      if (input.assignee !== undefined) {
        const next = input.assignee === null || input.assignee === '' ? null : await resolveAssignee(board, input.assignee)
        if (next !== card.assigneeId) {
          patch.assigneeId = next
          drafts.push({ type: 'card_updated', data: { field: 'assigneeId', from: card.assigneeId, to: next } })
        }
      }
      if (input.dueDate !== undefined) {
        const next = input.dueDate === null || input.dueDate === '' ? null : parseDate(input.dueDate)
        if (dateOnly(next) !== dateOnly(card.dueDate)) {
          patch.dueDate = next
          drafts.push({ type: 'card_updated', data: { field: 'dueDate', from: dateOnly(card.dueDate), to: dateOnly(next) } })
        }
      }
      if (input.labels !== undefined) {
        const next = resolveLabels(board, input.labels)
        if ([...next].sort().join() !== [...card.labelIds].sort().join()) {
          patch.labelIds = next
          drafts.push({ type: 'card_updated', data: { field: 'labelIds' } })
        }
      }

      if (drafts.length === 0) return { changed: false, card: await describeCard(board, card) }

      const title = (patch.title as string | undefined) ?? card.title
      const batch = db.batch()
      batch.update(cardRef(board.id, card.id), {
        ...assigneeFix(board, card),
        ...patch,
        updatedAt: FieldValue.serverTimestamp(),
      })
      for (const draft of drafts) addActivity(batch, board.id, { id: card.id, title }, draft)
      await batch.commit()
      return { changed: true, card: await describeCard(board, await loadCard(board.id, card.id)) }
    },

    async moveCard(input: { boardId: string; cardId: string; columnId?: string; kind?: Kind; position?: 'start' | 'end' }) {
      const board = await loadBoard(input.boardId, 'write')
      const card = await loadCard(board.id, input.cardId)
      if (!input.columnId && !input.kind) throw new ToolError('Pass columnId or kind to say where the card goes.')
      const column = pickColumn(board, input)
      const siblings = (await activeCards(board.id))
        .filter((item) => item.columnId === column.id && item.id !== card.id)
        .map((item) => item.position)
      const position =
        input.position === 'start' ? positionBetween(undefined, siblings.length ? Math.min(...siblings) : undefined)! : positionAtEnd(siblings)

      const batch = db.batch()
      batch.update(cardRef(board.id, card.id), {
        ...assigneeFix(board, card),
        columnId: column.id,
        position,
        updatedAt: FieldValue.serverTimestamp(),
      })
      if (column.id !== card.columnId) {
        const from = board.columns.find((item) => item.id === card.columnId)
        addActivity(batch, board.id, card, {
          type: 'card_moved',
          data: { from: card.columnId, to: column.id, fromName: from?.name ?? null, toName: column.name },
        })
      }
      await batch.commit()
      return describeCard(board, await loadCard(board.id, card.id))
    },

    async addComment(input: { boardId: string; cardId: string; text: string }) {
      const board = await loadBoard(input.boardId, 'write')
      const card = await loadCard(board.id, input.cardId)
      const text = input.text.trim()
      if (!text || text.length > LIMITS.comment) throw new ToolError(`text must have 1 to ${LIMITS.comment} characters.`)
      const ref = cardRef(board.id, card.id).collection('comments').doc()
      const batch = db.batch()
      batch.set(ref, { authorId: actor, text, createdAt: FieldValue.serverTimestamp(), editedAt: null })
      batch.update(cardRef(board.id, card.id), {
        ...assigneeFix(board, card),
        commentCount: FieldValue.increment(1),
        updatedAt: FieldValue.serverTimestamp(),
      })
      addActivity(batch, board.id, card, { type: 'comment_added', data: {} })
      await batch.commit()
      return { commentId: ref.id, commentCount: card.commentCount + 1 }
    },

    async archiveCard(input: { boardId: string; cardId: string }) {
      const board = await loadBoard(input.boardId, 'write')
      const card = await loadCard(board.id, input.cardId)
      const batch = db.batch()
      batch.update(cardRef(board.id, card.id), {
        ...assigneeFix(board, card),
        archived: true,
        updatedAt: FieldValue.serverTimestamp(),
      })
      addActivity(batch, board.id, card, { type: 'card_archived', data: {} })
      await batch.commit()
      return { archived: true, id: card.id, title: card.title }
    },
  }
}
