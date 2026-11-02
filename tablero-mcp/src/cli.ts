import { spawn, spawnSync } from 'node:child_process'
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { parseArgs } from 'node:util'
import { loadConfig, type Config } from './config.js'
import { loginWithBrowser } from './oauth.js'
import { createService } from './service.js'
import {
  clearLogin, connectFromStoredLogin, ensureProfile, loadLogin, NotSignedIn, openSession, saveLogin, signInWithGoogleIdToken,
  type Session,
} from './session.js'
import {
  browserCommand, claudeCodeAddArgs, claudeDesktopConfigPath, claudeMdSnippet, desktopEntry, explainError, mergeDesktopConfig,
  resolveLauncher, SERVER_NAME,
} from './setup-helpers.js'

const HELP = `tablero-mcp: conecta Claude con tu tablero.

Uso:
  npx tablero-mcp setup     Inicia sesión con Google y deja Claude conectado. Es lo único que necesitas.
  npx tablero-mcp login     Vuelve a iniciar sesión (si tu sesión caducó o quieres cambiar de cuenta).
  npx tablero-mcp logout    Cierra la sesión y borra lo guardado en este equipo.
  npx tablero-mcp doctor    Comprueba que todo sigue funcionando.

Opciones de setup:
  --client <cual>           claude-code, claude-desktop o none (por defecto, el que se detecte).
  -y, --yes                 Acepta las respuestas por defecto sin preguntar.
`

const ok = (text: string) => console.log(`  ✔ ${text}`)
const warn = (text: string) => console.log(`  ! ${text}`)
const fail = (text: string) => console.log(`  ✖ ${text}`)
const step = (text: string) => console.log(`\n${text}`)

function run(command: string, args: string[], timeout?: number) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    shell: process.platform === 'win32', // claude is a .cmd shim on Windows
    stdio: 'pipe',
    timeout,
  })
  return { ok: result.status === 0, stderr: result.stderr ?? '' }
}
const hasCommand = (name: string) => run(name, ['--version'], 15000).ok

const isWsl = () => {
  try {
    return /microsoft/i.test(readFileSync('/proc/version', 'utf8'))
  } catch {
    return false
  }
}

/** Best effort: the URL is always printed too, so a failure here costs the user one copy and paste. */
function openBrowser(url: string) {
  const { command, args } = browserCommand(url, process.platform, isWsl())
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true })
    child.on('error', () => undefined)
    child.unref()
  } catch {
    // printed by the caller
  }
}

function createPrompter(assumeYes: boolean) {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  return {
    async confirm(question: string, fallback = true) {
      if (assumeYes) return fallback
      const answer = (await rl.question(`${question} ${fallback ? '[S/n]' : '[s/N]'} `)).trim().toLowerCase()
      return answer ? ['s', 'si', 'sí', 'y', 'yes'].includes(answer) : fallback
    },
    close: () => rl.close(),
  }
}
type Prompter = ReturnType<typeof createPrompter>

// ---------- sign in ----------

function requireOAuth(config: Config) {
  if (config.oauth.clientId && config.oauth.clientSecret) return
  throw new Error(
    'Esta copia de tablero-mcp aún no tiene configurado el acceso con Google (falta el cliente OAuth). ' +
      'Quien la publica debe completarlo; ver "Puesta en marcha" en el README.',
  )
}

async function signIn(config: Config): Promise<Session> {
  requireOAuth(config)
  console.log('  Se abrirá tu navegador para que elijas tu cuenta de Google.')
  const tokens = await loginWithBrowser({
    client: config.oauth,
    openUrl: (url) => {
      openBrowser(url)
      console.log(`  Si no se abre solo, copia este enlace en el navegador:\n\n    ${url}\n`)
      console.log('  Esperando a que termines en el navegador...')
    },
  })
  const session = await openSession(config, signInWithGoogleIdToken(tokens.idToken))
  if (!session.emailVerified) {
    await session.close()
    throw new Error('Google no confirma que ese correo sea tuyo, así que no puedo usarlo. Prueba con otra cuenta.')
  }
  await saveLogin({ refreshToken: tokens.refreshToken, email: session.email, uid: session.uid })
  ok(`Sesión iniciada como ${session.email}`)
  if (await ensureProfile(session).catch(() => false)) ok('Perfil creado')
  return session
}

async function reuseOrSignIn(config: Config, prompt: Prompter): Promise<Session> {
  const saved = await loadLogin()
  if (saved && (await prompt.confirm(`Ya iniciaste sesión como ${saved.email}. ¿Usas esa cuenta?`))) {
    try {
      const session = await connectFromStoredLogin(config)
      ok(`La sesión de ${session.email} sigue vigente`)
      return session
    } catch (error) {
      if (!(error instanceof NotSignedIn)) throw error
      warn(error.message)
    }
  }
  return signIn(config)
}

// ---------- register in the client ----------

const launcher = () => resolveLauncher(realpathSync(process.argv[1]), process.platform)

async function registerClaudeCode(prompt: Prompter) {
  if (run('claude', ['mcp', 'get', SERVER_NAME], 30000).ok) {
    if (!(await prompt.confirm('Claude Code ya tiene un servidor "tablero". ¿Lo reemplazo con esta configuración?'))) return false
    run('claude', ['mcp', 'remove', SERVER_NAME, '-s', 'user'], 30000)
  }
  const added = run('claude', claudeCodeAddArgs(launcher()), 60000)
  if (!added.ok) {
    warn(`No pude registrarlo en Claude Code: ${added.stderr.trim().split('\n')[0]}`)
    return false
  }
  ok('Registrado en Claude Code (disponible en todos tus proyectos)')
  return true
}

async function registerClaudeDesktop(path: string) {
  const existing = await readFile(path, 'utf8').catch(() => undefined)
  try {
    const merged = mergeDesktopConfig(existing, desktopEntry(launcher()))
    if (existing !== undefined) await copyFile(path, `${path}.bak`)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, merged)
  } catch (error) {
    warn(error instanceof Error ? error.message : String(error))
    console.log(`  Añade esto a mcpServers en ${path}:\n${JSON.stringify({ [SERVER_NAME]: desktopEntry(launcher()) }, null, 2)}`)
    return false
  }
  ok(`Registrado en Claude Desktop (${path}). Reinícialo para que lo cargue.`)
  return true
}

// ---------- commands ----------

const listBoards = (session: Session) => createService({ db: session.db, uid: session.uid }).listBoards()

export async function runSetup(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      client: { type: 'string', default: 'auto' },
      yes: { type: 'boolean', short: 'y', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  })
  if (values.help) {
    console.log(HELP)
    return 0
  }
  if (!process.stdin.isTTY && !values.yes) {
    console.error('El asistente necesita una terminal interactiva. En scripts usa --yes.')
    return 1
  }

  const config = loadConfig()
  const prompt = createPrompter(values.yes)
  let session: Session | undefined
  try {
    console.log('tablero-mcp: configuración guiada')

    step('1/3 Inicia sesión con Google')
    session = await reuseOrSignIn(config, prompt)

    step('2/3 Comprobando la conexión')
    const boards = await listBoards(session)
    ok(`Conectado a tu tablero como ${session.email}`)
    console.log(boards.length ? `  Tus tableros: ${boards.map((b) => b.name).join(', ')}` : `  Aún no tienes tableros. Crea el primero en ${config.webUrl}`)

    step('3/3 Conectando con Claude')
    const wanted = values.client
    const desktopPath = claudeDesktopConfigPath(process.platform, process.env)
    const desktopInstalled = desktopPath !== undefined && (await stat(dirname(desktopPath)).then(() => true, () => false))
    const claudeCode = hasCommand('claude')
    let registered = false
    if (wanted !== 'none') {
      if ((wanted === 'auto' || wanted === 'claude-code') && claudeCode && (await prompt.confirm('¿Lo registro en Claude Code?'))) {
        registered = (await registerClaudeCode(prompt)) || registered
      } else if (wanted === 'claude-code' && !claudeCode) warn('No encuentro el comando `claude`.')
      if ((wanted === 'auto' || wanted === 'claude-desktop') && desktopInstalled && desktopPath && (await prompt.confirm('¿Lo registro en Claude Desktop?'))) {
        registered = (await registerClaudeDesktop(desktopPath)) || registered
      } else if (wanted === 'claude-desktop' && !desktopInstalled) warn('No encuentro Claude Desktop instalado.')
    }
    if (!registered && wanted !== 'none') {
      const { command, args } = launcher()
      console.log('  Para cualquier otro cliente MCP, registra este comando (no necesita claves ni variables):')
      console.log(`    ${[command, ...args].join(' ')}`)
    }

    console.log('\nListo. Abre una sesión nueva de Claude y pídele: "Lista mis tableros".')
    if (boards.length) {
      console.log('\nPara que Claude use un tablero en un proyecto, pega esto en su CLAUDE.md:\n')
      console.log(claudeMdSnippet(boards[0].id))
      if (boards.length > 1) console.log(`\n(IDs de tus tableros: ${boards.map((b) => `${b.name} = ${b.id}`).join(', ')})`)
    }
    return 0
  } catch (error) {
    console.error(`\n✖ ${explainError(error)}`)
    return 1
  } finally {
    prompt.close()
    await session?.close()
  }
}

export async function runLogin() {
  try {
    const session = await signIn(loadConfig())
    await session.close()
    return 0
  } catch (error) {
    console.error(`\n✖ ${explainError(error)}`)
    return 1
  }
}

export async function runLogout() {
  const saved = await loadLogin()
  if (!saved) {
    console.log('No había ninguna sesión guardada en este equipo.')
    return 0
  }
  // Best effort: tell Google the token is no longer needed; deleting the local file is what matters.
  await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(saved.refreshToken)}`, { method: 'POST' }).catch(() => undefined)
  await clearLogin()
  console.log(`Sesión de ${saved.email} cerrada y borrada de este equipo.`)
  if (run('claude', ['mcp', 'get', SERVER_NAME], 30000).ok) console.log('Para quitar también el registro en Claude Code: claude mcp remove tablero -s user')
  return 0
}

export async function runDoctor() {
  console.log('tablero-mcp: diagnóstico\n')
  const major = Number(process.versions.node.split('.')[0])
  ;(major >= 22 ? ok : fail)(`Node ${process.versions.node}${major >= 22 ? '' : ': se necesita 22 o superior'}`)
  const saved = await loadLogin()
  if (!saved) {
    fail('No hay sesión guardada: ejecuta `npx tablero-mcp setup`')
    return 1
  }
  ok(`Sesión guardada de ${saved.email}`)
  let session: Session | undefined
  try {
    session = await connectFromStoredLogin(loadConfig())
    ok('Google y Firebase aceptan la sesión')
    ok(`${(await listBoards(session)).length} tablero(s) accesible(s)`)
    return 0
  } catch (error) {
    fail(explainError(error))
    return 1
  } finally {
    await session?.close()
  }
}

export async function runCli([command, ...rest]: string[]) {
  if (command === 'setup') return runSetup(rest)
  if (command === 'login') return runLogin()
  if (command === 'logout') return runLogout()
  if (command === 'doctor') return runDoctor()
  if (command === '--version' || command === '-v') {
    const pkg = JSON.parse(await readFile(join(dirname(realpathSync(process.argv[1])), '..', 'package.json'), 'utf8').catch(() => '{}'))
    console.log(pkg.version ?? 'desconocida')
    return 0
  }
  console.log(HELP)
  return command === '--help' || command === '-h' || command === 'help' ? 0 : 1
}
