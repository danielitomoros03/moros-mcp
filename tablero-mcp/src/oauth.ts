import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { OAuthClient } from './config.js'

// Google sign-in for an installed app: authorization-code flow with PKCE over a loopback redirect
// (https://developers.google.com/identity/protocols/oauth2/native-app). No codes for the user to copy.

export const GOOGLE_ENDPOINTS = {
  auth: 'https://accounts.google.com/o/oauth2/v2/auth',
  token: 'https://oauth2.googleapis.com/token',
}
export type Endpoints = typeof GOOGLE_ENDPOINTS

/** The saved sign-in is no longer valid (revoked, expired or removed): the user has to sign in again. */
export class ReauthRequired extends Error {}
export class LoginError extends Error {}

const base64url = (buffer: Buffer) => buffer.toString('base64url')

export function createPkce() {
  const verifier = base64url(randomBytes(48))
  return { verifier, challenge: base64url(createHash('sha256').update(verifier).digest()) }
}

export function buildAuthUrl(
  options: { clientId: string; redirectUri: string; challenge: string; state: string; loginHint?: string },
  endpoints: Endpoints = GOOGLE_ENDPOINTS,
) {
  const url = new URL(endpoints.auth)
  const params: Record<string, string> = {
    client_id: options.clientId,
    redirect_uri: options.redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    code_challenge: options.challenge,
    code_challenge_method: 'S256',
    state: options.state,
    access_type: 'offline', // asks for a refresh token, so signing in is needed once and not every session
    prompt: 'consent',
  }
  if (options.loginHint) params.login_hint = options.loginHint
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
  return url.toString()
}

async function tokenRequest(endpoints: Endpoints, body: Record<string, string>, fetchImpl: typeof fetch) {
  const response = await fetchImpl(endpoints.token, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  })
  const data = (await response.json().catch(() => ({}))) as Record<string, string>
  return { ok: response.ok, data }
}

export async function exchangeCode(
  client: OAuthClient,
  input: { code: string; verifier: string; redirectUri: string },
  endpoints: Endpoints = GOOGLE_ENDPOINTS,
  fetchImpl: typeof fetch = fetch,
) {
  const { ok, data } = await tokenRequest(
    endpoints,
    {
      client_id: client.clientId,
      client_secret: client.clientSecret,
      code: input.code,
      code_verifier: input.verifier,
      redirect_uri: input.redirectUri,
      grant_type: 'authorization_code',
    },
    fetchImpl,
  )
  if (!ok || !data.id_token) throw new LoginError(`Google no aceptó el inicio de sesión (${data.error_description ?? data.error ?? 'sin detalle'}).`)
  if (!data.refresh_token) throw new LoginError('Google no entregó permiso para mantener la sesión. Vuelve a intentarlo y acepta todos los permisos.')
  return { idToken: data.id_token, refreshToken: data.refresh_token }
}

export async function refreshIdToken(
  client: OAuthClient,
  refreshToken: string,
  endpoints: Endpoints = GOOGLE_ENDPOINTS,
  fetchImpl: typeof fetch = fetch,
) {
  const { ok, data } = await tokenRequest(
    endpoints,
    { client_id: client.clientId, client_secret: client.clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' },
    fetchImpl,
  )
  if (!ok) {
    if (data.error === 'invalid_grant') throw new ReauthRequired('La sesión de Google caducó o fue revocada.')
    throw new LoginError(`No se pudo renovar la sesión (${data.error_description ?? data.error ?? 'sin detalle'}).`)
  }
  if (!data.id_token) throw new LoginError('Google no devolvió la identidad al renovar la sesión.')
  return data.id_token
}

const PAGE = (title: string, body: string) =>
  `<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>tablero-mcp</title>` +
  `<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;line-height:1.5">` +
  `<h1 style="font-size:1.4rem">${title}</h1><p>${body}</p></body></html>`

/**
 * Opens the browser at Google, waits for the redirect on a local port and trades the code for tokens.
 * `openUrl` is injected so tests can play the part of the browser.
 */
export async function loginWithBrowser(options: {
  client: OAuthClient
  openUrl: (url: string) => void | Promise<void>
  loginHint?: string
  timeoutMs?: number
  endpoints?: Endpoints
  fetchImpl?: typeof fetch
}) {
  const { client, endpoints = GOOGLE_ENDPOINTS } = options
  const { verifier, challenge } = createPkce()
  const state = base64url(randomBytes(16))

  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const redirectUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  const code = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new LoginError('Pasaron varios minutos sin completar el inicio de sesión. Vuelve a ejecutar el comando.')),
      options.timeoutMs ?? 5 * 60_000,
    )
    server.on('request', (request, response) => {
      const url = new URL(request.url ?? '/', redirectUri)
      // The browser also asks for /favicon.ico and similar; only the redirect carries state.
      if (!url.searchParams.has('state') && !url.searchParams.has('error')) {
        response.writeHead(404).end()
        return
      }
      response.setHeader('content-type', 'text/html; charset=utf-8')
      const denied = url.searchParams.get('error')
      if (url.searchParams.get('state') !== state && !denied) {
        response.writeHead(400).end(PAGE('Enlace no válido', 'Este inicio de sesión no corresponde al que se abrió desde tu terminal. Vuelve a intentarlo.'))
        return
      }
      clearTimeout(timer)
      if (denied) {
        response.writeHead(200).end(PAGE('No se dio acceso', 'Puedes cerrar esta pestaña y volver a la terminal.'))
        reject(new LoginError(denied === 'access_denied' ? 'Cancelaste el inicio de sesión.' : `Google respondió con un error: ${denied}.`))
        return
      }
      response.writeHead(200).end(PAGE('Listo', 'Ya puedes cerrar esta pestaña y volver a la terminal.'))
      resolve(url.searchParams.get('code') ?? '')
    })
  })

  // The browser may answer before we start waiting below; without this a fast rejection would crash the process.
  code.catch(() => undefined)

  try {
    await options.openUrl(buildAuthUrl({ clientId: client.clientId, redirectUri, challenge, state, loginHint: options.loginHint }, endpoints))
    const authorizationCode = await code
    if (!authorizationCode) throw new LoginError('Google no devolvió un código de autorización.')
    return await exchangeCode(client, { code: authorizationCode, verifier, redirectUri }, endpoints, options.fetchImpl)
  } finally {
    server.closeAllConnections()
    server.close()
  }
}
