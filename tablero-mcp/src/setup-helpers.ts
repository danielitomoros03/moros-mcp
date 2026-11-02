import { homedir } from 'node:os'
import { join } from 'node:path'

// Pure helpers for the setup command: no I/O here, so they are easy to test.

export const SERVER_NAME = 'tablero'

export interface Launcher {
  command: string
  args: string[]
}

export const isValidEmail = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)

export const configDir = (home = homedir()) => join(home, '.config', 'tablero-mcp')
export const credentialsPath = (home = homedir()) => join(configDir(home), 'credentials.json')

export function claudeDesktopConfigPath(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, home = homedir()) {
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
  if (platform === 'win32') return env.APPDATA ? join(env.APPDATA, 'Claude', 'claude_desktop_config.json') : undefined
  return join(home, '.config', 'Claude', 'claude_desktop_config.json')
}

/** How the MCP client should start us: through npx when we were run by npx, otherwise by absolute path. */
export function resolveLauncher(scriptPath: string, platform: NodeJS.Platform): Launcher {
  if (/[\\/]_npx[\\/]/.test(scriptPath)) {
    return platform === 'win32'
      ? { command: 'cmd', args: ['/c', 'npx', '-y', 'tablero-mcp'] }
      : { command: 'npx', args: ['-y', 'tablero-mcp'] }
  }
  return { command: 'node', args: [scriptPath] }
}

/** The sign-in lives in a file, so the client needs no keys or environment variables. */
export function claudeCodeAddArgs(launcher: Launcher) {
  return ['mcp', 'add', SERVER_NAME, '--scope', 'user', '--', launcher.command, ...launcher.args]
}

export const desktopEntry = (launcher: Launcher) => ({ command: launcher.command, args: launcher.args })

/** Adds the server to an existing claude_desktop_config.json without touching the rest of it. */
export function mergeDesktopConfig(existingText: string | undefined, entry: ReturnType<typeof desktopEntry>) {
  let config: Record<string, unknown> = {}
  if (existingText?.trim()) {
    try {
      config = JSON.parse(existingText)
    } catch {
      throw new Error('El archivo de configuración de Claude Desktop no es un JSON válido; no lo toco.')
    }
    if (typeof config !== 'object' || config === null || Array.isArray(config)) {
      throw new Error('El archivo de configuración de Claude Desktop tiene un formato inesperado; no lo toco.')
    }
  }
  const servers = (config.mcpServers ?? {}) as Record<string, unknown>
  return JSON.stringify({ ...config, mcpServers: { ...servers, [SERVER_NAME]: entry } }, null, 2) + '\n'
}

/** The command that opens a URL in the user's browser on this system (WSL included, where the browser lives in Windows). */
export function browserCommand(url: string, platform: NodeJS.Platform, isWsl: boolean): { command: string; args: string[] } {
  if (platform === 'darwin') return { command: 'open', args: [url] }
  if (platform === 'win32') return { command: 'rundll32', args: ['url.dll,FileProtocolHandler', url] }
  if (isWsl) return { command: 'wslview', args: [url] }
  return { command: 'xdg-open', args: [url] }
}

/** Turns a failure into what the user should do next. */
export function explainError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  const code = (error as { code?: string })?.code ?? ''
  if (code === 'permission-denied' || /PERMISSION_DENIED|Missing or insufficient permissions/.test(text)) {
    return 'Firestore rechazó el acceso. Si acabas de entrar por primera vez, abre la web del tablero una vez con esta cuenta y vuelve a intentarlo.'
  }
  if (code === 'auth/invalid-credential' || code === 'auth/invalid-idp-response' || /audience|invalid_idp_response/i.test(text)) {
    return 'Firebase no aceptó el inicio de sesión de Google. Quien administra el tablero debe añadir el cliente OAuth a la lista de clientes permitidos del proveedor Google (ver README, "Puesta en marcha").'
  }
  if (code === 'auth/operation-not-allowed') return 'El inicio de sesión con Google no está activado en el proyecto de Firebase.'
  if (code === 'auth/network-request-failed' || code === 'unavailable' || /ENOTFOUND|ECONNREFUSED|fetch failed/.test(text)) {
    return 'No hay conexión con Google o Firebase. Revisa tu internet e inténtalo de nuevo.'
  }
  return text
}

/** The CLAUDE.md block with the real board id, so nobody has to hunt for it. */
export function claudeMdSnippet(boardId: string) {
  return [
    '## Tablero de trabajo',
    `Este proyecto usa el tablero \`${boardId}\` (servidor MCP \`tablero\`).`,
    '- Antes de implementar, consulta `list_cards` con tipo `todo` y `doing`.',
    '- Al empezar una tarjeta, muévela a tipo `doing`. Al terminar, a `done`, con un comentario de qué cambió (archivos o commit).',
    '- El trabajo nuevo que surja se anota con `create_card`, con los criterios de aceptación en la descripción.',
  ].join('\n')
}
