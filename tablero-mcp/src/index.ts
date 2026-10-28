#!/usr/bin/env node
import { applicationDefault, initializeApp } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createServer } from './server.js'
import { createService } from './service.js'

// stdout belongs to the MCP protocol, so anything for humans goes to stderr.
const userEmail = process.env.TABLERO_USER_EMAIL
if (!userEmail) {
  console.error('Falta TABLERO_USER_EMAIL: el correo de la cuenta cuyos tableros puede usar Claude.')
  process.exit(1)
}

const usingEmulator = Boolean(process.env.FIRESTORE_EMULATOR_HOST)
if (!usingEmulator && !process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  console.error('Falta GOOGLE_APPLICATION_CREDENTIALS: la ruta al JSON de la cuenta de servicio.')
  process.exit(1)
}

// With a service account key the project id is read from the key; TABLERO_PROJECT_ID only overrides it.
const explicitProject = process.env.TABLERO_PROJECT_ID
const app = initializeApp(
  usingEmulator
    ? { projectId: explicitProject ?? 'demo-tablero' }
    : { credential: applicationDefault(), ...(explicitProject ? { projectId: explicitProject } : {}) },
)

const service = createService({ db: getFirestore(app), userEmail, actor: process.env.TABLERO_ACTOR ?? 'claude' })
await createServer(service).connect(new StdioServerTransport())
console.error(`tablero-mcp listo (proyecto: ${app.options.projectId ?? 'el de la llave'}, usuario ${userEmail}${usingEmulator ? ', emulador' : ''})`)
