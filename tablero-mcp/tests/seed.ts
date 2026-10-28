import { getApps, initializeApp } from 'firebase-admin/app'
import { getFirestore, Timestamp, type Firestore } from 'firebase-admin/firestore'

// Without this the Google auth library waits on a metadata server that does not exist on a dev machine.
process.env.METADATA_SERVER_DETECTION ??= 'none'

export const PROJECT = 'demo-tablero-mcp'

export function testDb(): Firestore {
  const app = getApps()[0] ?? initializeApp({ projectId: PROJECT })
  return getFirestore(app)
}

export async function clearAll() {
  const host = process.env.FIRESTORE_EMULATOR_HOST
  await fetch(`http://${host}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' })
}

const COLUMNS = [
  { id: 'c1', name: 'Por hacer', kind: 'todo' },
  { id: 'c2', name: 'En curso', kind: 'doing' },
  { id: 'c3', name: 'Hecho', kind: 'done' },
]

function card(overrides: Record<string, unknown>) {
  const now = Timestamp.now()
  return {
    title: 'Tarjeta',
    description: '',
    columnId: 'c1',
    position: 1024,
    assigneeId: null,
    labelIds: [],
    dueDate: null,
    priority: 'none',
    archived: false,
    commentCount: 0,
    createdBy: 'me',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

// me = the configured user; ana = another member; other = someone with their own board.
export async function seed(db: Firestore) {
  const now = Timestamp.now()
  for (const [uid, name] of [['me', 'Daniel'], ['ana', 'Ana'], ['other', 'Otra persona']]) {
    await db.collection('users').doc(uid).set({ displayName: name, email: `${uid}@example.com`, photoURL: null, createdAt: now })
  }
  const board = (extra: Record<string, unknown>) => ({
    description: '',
    columns: COLUMNS,
    labels: [],
    archived: false,
    createdAt: now,
    updatedAt: now,
    ...extra,
  })
  await db.collection('boards').doc('b1').set(
    board({
      name: 'Proyecto',
      description: 'Tablero principal',
      ownerId: 'me',
      members: { me: 'owner', ana: 'editor' },
      memberIds: ['me', 'ana'],
      labels: [
        { id: 'l1', name: 'backend', color: '#1d6fd1' },
        { id: 'l2', name: 'diseño', color: '#0b8a7f' },
      ],
    }),
  )
  await db.collection('boards').doc('b2').set(board({ name: 'Ajeno', ownerId: 'other', members: { other: 'owner' }, memberIds: ['other'] }))
  await db.collection('boards').doc('b3').set(board({ name: 'Archivado', ownerId: 'me', members: { me: 'owner' }, memberIds: ['me'], archived: true }))
  await db.collection('boards').doc('b4').set(
    board({ name: 'Solo lectura', ownerId: 'other', members: { other: 'owner', me: 'viewer' }, memberIds: ['other', 'me'] }),
  )

  const cards = db.collection('boards').doc('b1').collection('cards')
  await cards.doc('A').set(card({ title: 'Definir reglas', description: 'Reglas estrictas', position: 1024, priority: 'high', assigneeId: 'ana', labelIds: ['l1'] }))
  await cards.doc('B').set(card({ title: 'Boceto de pantallas', position: 2048, priority: 'low' }))
  await cards.doc('C').set(card({ title: 'Modelo de datos', columnId: 'c2', priority: 'urgent' }))
  await cards.doc('D').set(card({ title: 'Elegir stack', columnId: 'c3' }))
  await cards.doc('E').set(card({ title: 'Vieja', archived: true }))
  await db.collection('boards').doc('b4').collection('cards').doc('V').set(card({ title: 'Tarjeta de lectura' }))
}

// What the Firestore rules of the web app accept for a card, so cards written here stay editable there.
export function expectClientValidCard(data: FirebaseFirestore.DocumentData) {
  const allowed = ['title', 'description', 'columnId', 'position', 'assigneeId', 'labelIds', 'dueDate', 'priority', 'archived', 'commentCount', 'createdBy', 'createdAt', 'updatedAt']
  const required = ['title', 'columnId', 'position', 'priority', 'archived', 'createdBy', 'createdAt', 'updatedAt']
  const problems: string[] = []
  for (const key of Object.keys(data)) if (!allowed.includes(key)) problems.push(`unexpected field ${key}`)
  for (const key of required) if (!(key in data)) problems.push(`missing ${key}`)
  if (typeof data.title !== 'string' || data.title.length < 1 || data.title.length > 200) problems.push('title')
  if (typeof (data.description ?? '') !== 'string' || (data.description ?? '').length > 5000) problems.push('description')
  if (typeof data.columnId !== 'string') problems.push('columnId')
  if (typeof data.position !== 'number') problems.push('position')
  if (!['none', 'low', 'medium', 'high', 'urgent'].includes(data.priority)) problems.push('priority')
  if (!Array.isArray(data.labelIds ?? []) || (data.labelIds ?? []).length > 10) problems.push('labelIds')
  if (data.assigneeId != null && typeof data.assigneeId !== 'string') problems.push('assigneeId')
  if (data.dueDate != null && !(data.dueDate instanceof Timestamp)) problems.push('dueDate')
  if (typeof data.archived !== 'boolean') problems.push('archived')
  if (!Number.isInteger(data.commentCount ?? 0)) problems.push('commentCount')
  if (!(data.createdAt instanceof Timestamp) || !(data.updatedAt instanceof Timestamp)) problems.push('timestamps')
  return problems
}
