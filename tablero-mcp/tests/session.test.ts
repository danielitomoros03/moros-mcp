import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { loginWithBrowser } from '../src/oauth.js'
import { createService } from '../src/service.js'
import {
  clearLogin, connectFromStoredLogin, ensureProfile, loadLogin, NotSignedIn, openSession, saveLogin, signInWithGoogleIdToken,
} from '../src/session.js'
import { startFakeGoogle } from './fake-google.js'
import { clearAll, ensureAuthUsers, seed, testConfig, testDb } from './seed.js'

const db = testDb()
let google: Awaited<ReturnType<typeof startFakeGoogle>> | undefined
let path: string

beforeAll(ensureAuthUsers)
beforeEach(async () => {
  await clearAll()
  await seed(db)
  path = join(await mkdtemp(join(tmpdir(), 'tablero-mcp-')), 'sub', 'credentials.json')
})
afterEach(async () => {
  await google?.close()
  google = undefined
})

describe('persona nueva, de principio a fin', () => {
  it('inicia sesión con Google, queda guardada, se reabre sin navegador y solo ve lo suyo', async () => {
    google = await startFakeGoogle({ sub: 'g-nueva', email: 'nueva@example.com', name: 'Nueva Persona' })

    // 1. `setup`: browser sign-in, then Firebase, then profile and the saved login.
    const tokens = await loginWithBrowser({ client: testConfig.oauth, endpoints: google.endpoints, openUrl: google.browser() })
    const first = await openSession(testConfig, signInWithGoogleIdToken(tokens.idToken))
    expect(first.email).toBe('nueva@example.com')
    expect(first.emailVerified).toBe(true)
    expect(await ensureProfile(first)).toBe(true)
    expect(await ensureProfile(first)).toBe(false) // second time there is nothing to do
    const profile = (await db.doc(`users/${first.uid}`).get()).data()
    expect(profile).toMatchObject({ email: 'nueva@example.com', displayName: 'Nueva Persona' })
    await saveLogin({ refreshToken: tokens.refreshToken, email: first.email, uid: first.uid }, path)
    const firstUid = first.uid
    await first.close()

    // The refresh token is a secret: only its owner can read the file.
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ email: 'nueva@example.com' })

    // 2. What the MCP server does every time Claude starts: no browser, same person.
    const second = await connectFromStoredLogin(testConfig, { path, endpoints: google.endpoints })
    expect(second.uid).toBe(firstUid)

    // 3. A person with no boards sees none, and cannot reach anyone else's.
    const service = createService({ db: second.db, uid: second.uid })
    expect(await service.listBoards()).toEqual([])
    await expect(service.getBoard({ boardId: 'b1' })).rejects.toThrow(/not found or not accessible/)
    await second.close()
  })

  it('sin sesión guardada, explica qué hacer', async () => {
    await expect(connectFromStoredLogin(testConfig, { path })).rejects.toThrow(NotSignedIn)
    await expect(connectFromStoredLogin(testConfig, { path })).rejects.toThrow(/setup/)
  })

  it('si Google revocó la sesión, pide volver a iniciar sesión en vez de fallar a medias', async () => {
    google = await startFakeGoogle({ sub: 'g-x', email: 'x@example.com' })
    await saveLogin({ refreshToken: 'revocado', email: 'x@example.com', uid: 'u' }, path)
    await expect(connectFromStoredLogin(testConfig, { path, endpoints: google.endpoints })).rejects.toThrow(/login/)
  })

  it('cerrar sesión borra lo guardado', async () => {
    await saveLogin({ refreshToken: 'r', email: 'x@example.com', uid: 'u' }, path)
    expect(await loadLogin(path)).toBeDefined()
    await clearLogin(path)
    expect(await loadLogin(path)).toBeUndefined()
  })

  it('un archivo de sesión dañado se trata como sin sesión', async () => {
    await saveLogin({ refreshToken: 'r', email: 'x@example.com', uid: 'u' }, path)
    const { writeFile } = await import('node:fs/promises')
    await writeFile(path, '{no es json')
    expect(await loadLogin(path)).toBeUndefined()
  })
})
