import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { buildAuthUrl, createPkce, exchangeCode, LoginError, loginWithBrowser, ReauthRequired, refreshIdToken } from '../src/oauth.js'
import { startFakeGoogle } from './fake-google.js'

const client = { clientId: 'fake-client', clientSecret: 'fake-secret' }
let google: Awaited<ReturnType<typeof startFakeGoogle>> | undefined

afterEach(async () => {
  await google?.close()
  google = undefined
})

describe('PKCE y URL de acceso', () => {
  it('el desafío es el SHA-256 del verificador, y cada intento es distinto', () => {
    const a = createPkce()
    expect(a.challenge).toBe(createHash('sha256').update(a.verifier).digest('base64url'))
    expect(createPkce().verifier).not.toBe(a.verifier)
  })

  it('pide solo identidad, un refresh token y el redirect local', () => {
    const url = new URL(buildAuthUrl({ clientId: 'cid', redirectUri: 'http://127.0.0.1:5555', challenge: 'ch', state: 'st', loginHint: 'yo@correo.com' }))
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: 'cid', redirect_uri: 'http://127.0.0.1:5555', response_type: 'code', scope: 'openid email profile',
      code_challenge: 'ch', code_challenge_method: 'S256', state: 'st', access_type: 'offline', login_hint: 'yo@correo.com',
    })
  })
})

describe('inicio de sesión en el navegador', () => {
  it('completa el flujo: abre la URL, recibe el código en el puerto local y lo canjea con PKCE', async () => {
    google = await startFakeGoogle({ sub: 'g-1', email: 'uno@example.com' })
    const tokens = await loginWithBrowser({ client, endpoints: google.endpoints, openUrl: google.browser() })
    expect(tokens.refreshToken).toBe('refresh-1')
    expect(tokens.idToken.split('.')).toHaveLength(3)
    expect(google.requests[0]).toMatchObject({ grant_type: 'authorization_code', client_id: 'fake-client' })
  })

  it('ignora una respuesta con state ajeno y no entrega tokens por ella', async () => {
    google = await startFakeGoogle({ sub: 'g-1', email: 'uno@example.com' })
    const forged = google.browser({ state: 'otro' })
    await expect(
      loginWithBrowser({ client, endpoints: google.endpoints, timeoutMs: 400, openUrl: forged }),
    ).rejects.toThrow(/Pasaron varios minutos/)
    expect(google.requests).toHaveLength(0)
  })

  it('si la persona cancela, lo dice con claridad', async () => {
    google = await startFakeGoogle({ sub: 'g-1', email: 'uno@example.com' })
    await expect(
      loginWithBrowser({ client, endpoints: google.endpoints, openUrl: google.browser({ error: 'access_denied' }) }),
    ).rejects.toThrow('Cancelaste el inicio de sesión.')
  })

  it('si nadie termina el inicio de sesión, vence en vez de quedarse colgado', async () => {
    google = await startFakeGoogle({ sub: 'g-1', email: 'uno@example.com' })
    await expect(loginWithBrowser({ client, endpoints: google.endpoints, timeoutMs: 200, openUrl: () => undefined })).rejects.toBeInstanceOf(LoginError)
  })

  it('un secreto de cliente equivocado se explica, no se traga', async () => {
    google = await startFakeGoogle({ sub: 'g-1', email: 'uno@example.com' })
    await expect(
      loginWithBrowser({ client: { ...client, clientSecret: 'mal' }, endpoints: google.endpoints, openUrl: google.browser() }),
    ).rejects.toThrow(/Google no aceptó/)
  })
})

describe('renovar la sesión', () => {
  it('con el refresh token guardado devuelve una identidad nueva', async () => {
    google = await startFakeGoogle({ sub: 'g-1', email: 'uno@example.com' })
    expect(await refreshIdToken(client, 'refresh-1', google.endpoints)).toMatch(/\./)
  })

  it('un token revocado exige volver a iniciar sesión', async () => {
    google = await startFakeGoogle({ sub: 'g-1', email: 'uno@example.com' })
    await expect(refreshIdToken(client, 'revocado', google.endpoints)).rejects.toBeInstanceOf(ReauthRequired)
  })

  it('un código inválido al canjear no entrega tokens', async () => {
    google = await startFakeGoogle({ sub: 'g-1', email: 'uno@example.com' })
    await expect(exchangeCode(client, { code: 'x', verifier: 'v', redirectUri: 'http://127.0.0.1:1' }, google.endpoints)).rejects.toThrow(/Bad code/)
  })
})
