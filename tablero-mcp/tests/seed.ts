import { getApps, initializeApp } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'
import { getFirestore, Timestamp, type Firestore } from 'firebase-admin/firestore'
import { signInWithCustomToken } from 'firebase/auth'
import type { Config } from '../src/config.js'
import { openSession, type Session } from '../src/session.js'

// Without this the Google auth library waits on a metadata server that does not exist on a dev machine.
process.env.METADATA_SERVER_DETECTION ??= 'none'

export const PROJECT = 'demo-tablero-mcp'

export function testDb(): Firestore {
  const app = getApps()[0] ?? initializeApp({ projectId: PROJECT })
  return getFirestore(app)
}

export const testConfig: Config = {
  firebase: { apiKey: 'fake-key', authDomain: 'localhost', projectId: PROJECT, appId: 'fake-app' },
  oauth: { clientId: 'fake-client', clientSecret: 'fake-secret' },
  webUrl: 'http://localhost',
}

const USERS: [string, string][] = [['me', 'Daniel'], ['ana', 'Ana'], ['other', 'Otra persona'], ['nobody', 'Nadie']]

/** Auth accounts with fixed uids, so the seeded boards point at people who can really sign in. */
export async function ensureAuthUsers() {
  for (const [uid, name] of USERS) {
    await getAuth(getApps()[0]).createUser({ uid, email: `${uid}@example.com`, emailVerified: true, displayName: name }).catch(() => undefined)
  }
}

/** A real client session (what the MCP server uses) signed in as one of the seeded people; the rules apply to it. */
export async function signInAs(uid: string): Promise<Session> {
  testDb()
  const token = await getAuth(getApps()[0]).createCustomToken(uid)
  return openSession(testConfig, (auth) => signInWithCustomToken(auth, token))
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
  for (const [uid, name] of USERS.slice(0, 3)) {
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
