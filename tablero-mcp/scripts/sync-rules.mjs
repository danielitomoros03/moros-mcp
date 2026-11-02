// The tests run against the same Firestore rules as the web app. Firebase only reads rules inside the project folder,
// so keep a copy in tests/ and refresh it from ../tablero whenever that app is next to this package.
import { copyFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = join(root, '..', 'tablero', 'firestore.rules')
const target = join(root, 'tests', 'firestore.rules')
if (existsSync(source)) {
  copyFileSync(source, target)
  console.log('Reglas de Firestore sincronizadas desde ../tablero')
} else if (!existsSync(target)) {
  throw new Error('No encuentro las reglas de Firestore: ni ../tablero/firestore.rules ni tests/firestore.rules.')
}
