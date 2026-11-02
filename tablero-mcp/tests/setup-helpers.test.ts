import { describe, expect, it } from 'vitest'
import {
  browserCommand, claudeCodeAddArgs, claudeDesktopConfigPath, claudeMdSnippet, credentialsPath, desktopEntry, explainError,
  isValidEmail, mergeDesktopConfig, resolveLauncher,
} from '../src/setup-helpers.js'

describe('rutas y validaciones', () => {
  it('guarda la sesión en un archivo privado dentro de ~/.config', () => {
    expect(credentialsPath('/home/u')).toBe('/home/u/.config/tablero-mcp/credentials.json')
    expect(isValidEmail('yo@correo.com')).toBe(true)
    expect(isValidEmail('yo@')).toBe(false)
  })
  it('ubica la config de Claude Desktop por sistema', () => {
    expect(claudeDesktopConfigPath('win32', { APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }, '/h')).toMatch(/Claude.claude_desktop_config\.json$/)
    expect(claudeDesktopConfigPath('win32', {}, '/h')).toBeUndefined()
    expect(claudeDesktopConfigPath('darwin', {}, '/Users/u')).toBe('/Users/u/Library/Application Support/Claude/claude_desktop_config.json')
  })
  it('abre el navegador con el comando de cada sistema, también desde WSL', () => {
    expect(browserCommand('https://x', 'darwin', false).command).toBe('open')
    expect(browserCommand('https://x', 'win32', false).command).toBe('rundll32')
    expect(browserCommand('https://x', 'linux', false).command).toBe('xdg-open')
    expect(browserCommand('https://x', 'linux', true).command).toBe('wslview')
  })
})

describe('registro en el cliente', () => {
  it('usa npx cuando el asistente corre desde npx y la ruta absoluta si no', () => {
    expect(resolveLauncher('/home/u/.npm/_npx/abc/node_modules/tablero-mcp/dist/index.js', 'linux')).toEqual({
      command: 'npx', args: ['-y', 'tablero-mcp'],
    })
    expect(resolveLauncher('C:\\Users\\u\\.npm\\_npx\\abc\\node_modules\\tablero-mcp\\dist\\index.js', 'win32')).toEqual({
      command: 'cmd', args: ['/c', 'npx', '-y', 'tablero-mcp'],
    })
    expect(resolveLauncher('/repo/tablero-mcp/dist/index.js', 'linux')).toEqual({ command: 'node', args: ['/repo/tablero-mcp/dist/index.js'] })
  })
  it('registra en Claude Code sin claves ni variables de entorno', () => {
    expect(claudeCodeAddArgs({ command: 'npx', args: ['-y', 'tablero-mcp'] })).toEqual([
      'mcp', 'add', 'tablero', '--scope', 'user', '--', 'npx', '-y', 'tablero-mcp',
    ])
  })
  it('añade el servidor a la config de Claude Desktop sin tocar lo demás', () => {
    const entry = desktopEntry({ command: 'npx', args: ['-y', 'tablero-mcp'] })
    expect(entry).toEqual({ command: 'npx', args: ['-y', 'tablero-mcp'] })
    const existing = JSON.stringify({ theme: 'dark', mcpServers: { otro: { command: 'x' } } })
    const merged = JSON.parse(mergeDesktopConfig(existing, entry))
    expect(merged.theme).toBe('dark')
    expect(merged.mcpServers.otro).toEqual({ command: 'x' })
    expect(merged.mcpServers.tablero.command).toBe('npx')
    expect(JSON.parse(mergeDesktopConfig(undefined, entry)).mcpServers.tablero.args).toEqual(['-y', 'tablero-mcp'])
  })
  it('no sobrescribe una config de Claude Desktop que no se puede leer', () => {
    const entry = desktopEntry({ command: 'node', args: ['x'] })
    expect(() => mergeDesktopConfig('{roto', entry)).toThrow('no lo toco')
    expect(() => mergeDesktopConfig('[]', entry)).toThrow('no lo toco')
  })
})

describe('errores y texto para el usuario', () => {
  it('traduce los fallos más comunes a qué hacer', () => {
    expect(explainError({ code: 'permission-denied', message: 'Missing or insufficient permissions.' })).toMatch(/abre la web/)
    expect(explainError({ code: 'auth/invalid-credential', message: 'x' })).toMatch(/clientes permitidos/)
    expect(explainError({ code: 'auth/network-request-failed', message: 'x' })).toMatch(/conexión/)
    expect(explainError(new Error('algo raro'))).toBe('algo raro')
  })
  it('genera el bloque de CLAUDE.md con el ID real del tablero', () => {
    expect(claudeMdSnippet('abc123')).toContain('`abc123`')
  })
})
