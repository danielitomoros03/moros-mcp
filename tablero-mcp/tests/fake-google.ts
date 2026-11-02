import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Endpoints } from '../src/oauth.js'

const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url')

/** The Auth emulator accepts unsigned tokens as Google identities. */
export const fakeIdToken = (claims: { sub: string; email: string; name?: string }) =>
  `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ iss: 'https://accounts.google.com', aud: 'fake-client', email_verified: true, ...claims })}.`

/** A stand-in for Google's token endpoint that enforces what the real one does: PKCE, client secret and redirect uri. */
export async function startFakeGoogle(person: { sub: string; email: string; name?: string }) {
  const challenges = new Map<string, { challenge: string; redirectUri: string }>()
  const requests: Record<string, string>[] = []
  const server: Server = createServer(async (request, response) => {
    let raw = ''
    for await (const chunk of request) raw += chunk
    const body = Object.fromEntries(new URLSearchParams(raw))
    requests.push(body)
    const send = (status: number, data: object) => response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(data))
    if (body.client_secret !== 'fake-secret') return send(401, { error: 'invalid_client' })
    if (body.grant_type === 'authorization_code') {
      const issued = challenges.get(body.code)
      const verifierHash = createHash('sha256').update(body.code_verifier ?? '').digest('base64url')
      if (!issued || issued.challenge !== verifierHash || issued.redirectUri !== body.redirect_uri) {
        return send(400, { error: 'invalid_grant', error_description: 'Bad code or verifier' })
      }
      return send(200, { id_token: fakeIdToken(person), refresh_token: 'refresh-1', access_token: 'unused' })
    }
    if (body.grant_type === 'refresh_token') {
      return body.refresh_token === 'refresh-1' ? send(200, { id_token: fakeIdToken(person) }) : send(400, { error: 'invalid_grant' })
    }
    return send(400, { error: 'unsupported_grant_type' })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const endpoints: Endpoints = { auth: `${origin}/auth`, token: `${origin}/token` }

  /** Plays the browser: reads the sign-in URL, "the person approves" and Google redirects back with a code. */
  const browser = (options: { state?: string; error?: string } = {}) => async (authUrl: string) => {
    const url = new URL(authUrl)
    const redirectUri = url.searchParams.get('redirect_uri')!
    const state = options.state ?? url.searchParams.get('state')!
    if (options.error) {
      await fetch(`${redirectUri}/?error=${options.error}&state=${state}`)
      return
    }
    challenges.set('code-1', { challenge: url.searchParams.get('code_challenge')!, redirectUri })
    await fetch(`${redirectUri}/?code=code-1&state=${state}`)
  }

  return { endpoints, requests, browser, close: () => new Promise<void>((resolve) => server.close(() => resolve())) }
}
