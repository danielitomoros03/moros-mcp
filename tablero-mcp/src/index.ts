#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

// With arguments (`setup`, `doctor`, ...) this is a command-line tool for humans; without, an MCP client started it.
const args = process.argv.slice(2)
if (args.length > 0) {
  const { runCli } = await import('./cli.js')
  process.exit(await runCli(args))
}

const { loadConfig } = await import('./config.js')
const { connectFromStoredLogin, NotSignedIn } = await import('./session.js')
const { explainError } = await import('./setup-helpers.js')
const { createServer } = await import('./server.js')
const { createService } = await import('./service.js')

// stdout belongs to the MCP protocol, so anything for humans goes to stderr.
let session: Awaited<ReturnType<typeof connectFromStoredLogin>>
try {
  session = await connectFromStoredLogin(loadConfig())
} catch (error) {
  console.error(error instanceof NotSignedIn ? error.message : `No se pudo iniciar tablero-mcp: ${explainError(error)}`)
  process.exit(1)
}

await createServer(createService({ db: session.db, uid: session.uid })).connect(new StdioServerTransport())
console.error(`tablero-mcp listo (sesión de ${session.email}, proyecto ${session.projectId})`)
