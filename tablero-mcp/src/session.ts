import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { deleteApp, initializeApp } from 'firebase/app'
import { connectAuthEmulator, getAuth, GoogleAuthProvider, signInWithCredential, type Auth, type UserCredential } from 'firebase/auth'
import { connectFirestoreEmulator, doc, getDoc, getFirestore, serverTimestamp, setDoc, terminate, type Firestore } from 'firebase/firestore'
import type { Config } from './config.js'
import { refreshIdToken, ReauthRequired, type Endpoints } from './oauth.js'
import { credentialsPath } from './setup-helpers.js'

export interface StoredLogin {
  refreshToken: string
  email: string
  uid: string
}

export interface Session {
  db: Firestore
  uid: string
  email: string
  displayName: string | null
  photoURL: string | null
  emailVerified: boolean
  projectId: string
  close(): Promise<void>
}

/** There is no saved sign-in: the user has to run `setup` (or `login`). */
export class NotSignedIn extends Error {}

export async function loadLogin(path = credentialsPath()): Promise<StoredLogin | undefined> {
  try {
    const data = JSON.parse(await readFile(path, 'utf8')) as Partial<StoredLogin>
    return data.refreshToken && data.email && data.uid ? (data as StoredLogin) : undefined
  } catch {
    return undefined
  }
}

export async function saveLogin(login: StoredLogin, path = credentialsPath()) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await writeFile(path, JSON.stringify(login, null, 2), { mode: 0o600 })
  await chmod(path, 0o600).catch(() => undefined) // no-op on Windows
}

export const clearLogin = (path = credentialsPath()) => rm(path, { force: true })

/** Signs in to Firebase with whatever `signIn` provides and connects Firestore as that user, so the rules apply to everything. */
export async function openSession(config: Config, signIn: (auth: Auth) => Promise<UserCredential>): Promise<Session> {
  const app = initializeApp(config.firebase, `tablero-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  const auth = getAuth(app)
  // The emulator variables are the ones the Firebase tools export; unset in normal use.
  const authEmulator = process.env.FIREBASE_AUTH_EMULATOR_HOST
  if (authEmulator) connectAuthEmulator(auth, `http://${authEmulator}`, { disableWarnings: true })
  const db = getFirestore(app)
  const firestoreEmulator = process.env.FIRESTORE_EMULATOR_HOST
  if (firestoreEmulator) {
    const [host, port] = firestoreEmulator.split(':')
    connectFirestoreEmulator(db, host, Number(port))
  }
  try {
    const { user } = await signIn(auth)
    return {
      db,
      uid: user.uid,
      email: (user.email ?? '').toLowerCase(),
      displayName: user.displayName,
      photoURL: user.photoURL,
      emailVerified: user.emailVerified,
      projectId: config.firebase.projectId,
      close: async () => {
        await terminate(db).catch(() => undefined)
        await deleteApp(app).catch(() => undefined)
      },
    }
  } catch (error) {
    await deleteApp(app).catch(() => undefined)
    throw error
  }
}

export const signInWithGoogleIdToken = (idToken: string) => (auth: Auth) =>
  signInWithCredential(auth, GoogleAuthProvider.credential(idToken))

/** Opens a session from the sign-in saved by `setup`, the way the MCP server does at startup. */
export async function connectFromStoredLogin(
  config: Config,
  options: { path?: string; endpoints?: Endpoints } = {},
): Promise<Session> {
  const path = options.path ?? credentialsPath()
  const login = await loadLogin(path)
  if (!login) throw new NotSignedIn('Aún no has iniciado sesión. Ejecuta `npx tablero-mcp setup`.')
  if (!config.oauth.clientId) throw new NotSignedIn('Esta copia no tiene configurado el acceso con Google (falta el cliente OAuth).')
  let idToken: string
  try {
    idToken = await refreshIdToken(config.oauth, login.refreshToken, options.endpoints)
  } catch (error) {
    if (error instanceof ReauthRequired) throw new NotSignedIn('Tu sesión caducó. Ejecuta `npx tablero-mcp login` para volver a entrar.')
    throw error
  }
  return openSession(config, signInWithGoogleIdToken(idToken))
}

/** Creates the user's profile the first time, exactly like the web app does, so others can add them to a board by email. */
export async function ensureProfile(session: Session) {
  if (!session.emailVerified) return false
  const ref = doc(session.db, 'users', session.uid)
  if ((await getDoc(ref)).exists()) return false
  await setDoc(ref, {
    displayName: session.displayName ?? session.email,
    email: session.email,
    photoURL: session.photoURL,
    createdAt: serverTimestamp(),
  })
  return true
}
