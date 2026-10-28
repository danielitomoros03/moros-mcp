# tablero-mcp

Servidor [MCP](https://modelcontextprotocol.io) que permite a Claude leer y actualizar tu tablero Kanban de **tablero**
(una app web de tableros, en su propio repositorio). Con él puedes pedirle a Claude cosas como:

- "¿Qué tarjetas me quedan pendientes en el tablero del proyecto?"
- "Toma la tarjeta de mayor prioridad, impleméntala y muévela a Hecho con un comentario de qué cambió."
- "Anota como tarjeta estas tres ideas que acabamos de hablar."

Corre en tu máquina por stdio y habla directamente con tu base de datos de Firestore con una cuenta de servicio.
No necesita servidor propio, Cloud Functions ni plan de pago.

## Requisitos

| Qué | Detalle |
|---|---|
| **Un tablero desplegado** | El MCP lee y escribe los datos de la app `tablero`, así que primero necesitas tu propia copia funcionando en tu proyecto de Firebase. La app vive en un repositorio aparte y trae su propia guía de puesta en marcha. |
| **Node.js 22 o superior** | Lo exige `firebase-admin`. Comprueba con `node -v`. |
| **Claude Code o Claude Desktop** | Cualquier cliente MCP que soporte servidores locales por stdio sirve. |
| **Acceso a tu proyecto de Google Cloud** | Para crear la cuenta de servicio (paso 1). |
| **Haber iniciado sesión una vez en tu tablero** | La cuenta que uses con el MCP necesita su perfil, que se crea al entrar por primera vez en la web. |

## Instalación

### 1. Crear la cuenta de servicio

La cuenta de servicio es la identidad con la que el servidor accede a tu Firestore. Dale el mínimo permiso posible.

1. Abre `https://console.cloud.google.com/iam-admin/serviceaccounts?project=TU_PROYECTO` (el ID de tu proyecto de Firebase).
2. **Crear cuenta de servicio**. Nombre: `tablero-mcp`. Pulsa **Crear y continuar**.
3. En el rol elige **Usuario de Cloud Datastore** (*Cloud Datastore User*, `roles/datastore.user`). Pulsa **Continuar** y **Listo**.
   Ese rol basta para leer y escribir Firestore y no da acceso a nada más. Si te saltas este paso, Claude recibirá `PERMISSION_DENIED`: puedes añadirlo después en **IAM, Otorgar acceso**.
4. Abre la cuenta creada, pestaña **Claves**, **Agregar clave**, **Crear clave nueva**, tipo **JSON**. Se descarga un archivo.
5. Guárdalo en un lugar privado, fuera de cualquier repositorio, y restringe sus permisos:

   ```bash
   mkdir -p ~/.config/tablero-mcp
   mv ~/Downloads/TU_PROYECTO-*.json ~/.config/tablero-mcp/service-account.json
   chmod 600 ~/.config/tablero-mcp/service-account.json
   ```

   Esta llave da acceso a toda tu base de datos. No la subas a git, no la pegues en chats ni la compartas.

> Si tu organización bloquea la creación de claves de cuentas de servicio (política `iam.disableServiceAccountKeyCreation`),
> pide a un administrador que la permita para este proyecto.

### 2. Descargar y compilar

```bash
git clone https://github.com/danielitomoros03/moros-mcp.git
cd moros-mcp/tablero-mcp
npm install
npm run build
```

Esto genera `dist/index.js`, que es lo que ejecuta el cliente MCP.

### 3. Registrarlo en tu cliente

Necesitas la ruta **absoluta** a `dist/index.js`, la ruta a tu llave y el correo de tu cuenta del tablero.

#### Claude Code

```bash
claude mcp add tablero --scope user \
  -e GOOGLE_APPLICATION_CREDENTIALS="$HOME/.config/tablero-mcp/service-account.json" \
  -e TABLERO_USER_EMAIL=tu-correo@gmail.com \
  -- node /ruta/absoluta/a/tablero-mcp/dist/index.js
```

`--scope user` lo deja disponible en todos tus proyectos. Para quitarlo: `claude mcp remove tablero -s user`.

#### Claude Desktop

Edita `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/`, Windows: `%APPDATA%\Claude\`) y añade:

```json
{
  "mcpServers": {
    "tablero": {
      "command": "node",
      "args": ["/ruta/absoluta/a/tablero-mcp/dist/index.js"],
      "env": {
        "GOOGLE_APPLICATION_CREDENTIALS": "/ruta/absoluta/a/service-account.json",
        "TABLERO_USER_EMAIL": "tu-correo@gmail.com"
      }
    }
  }
}
```

En Windows escribe las rutas con barras dobles (`C:\\Users\\tu-usuario\\...`). Reinicia Claude Desktop después de guardar.

### 4. Comprobar que funciona

Abre una **sesión nueva** (las herramientas se cargan al iniciar) y pregunta: *"Lista mis tableros"*.
Claude debería llamar a `list_boards` y mostrarte tus tableros con sus columnas. En Claude Code también puedes ejecutar
`claude mcp get tablero` y ver el estado `Connected`.

## Variables de entorno

| Variable | Obligatoria | Descripción |
|---|---|---|
| `TABLERO_USER_EMAIL` | sí | Correo de la cuenta cuyos tableros puede usar Claude. Solo verá y editará los tableros donde esa cuenta es miembro. |
| `GOOGLE_APPLICATION_CREDENTIALS` | sí | Ruta absoluta al JSON de la cuenta de servicio. |
| `TABLERO_PROJECT_ID` | no | ID del proyecto de Firebase. Por defecto se toma de la llave; úsalo solo si necesitas forzar otro. |
| `TABLERO_ACTOR` | no | Nombre con el que se firma lo que escribe Claude en el historial y los comentarios. Por defecto `claude` (se muestra como "Claude"). |

## Herramientas

| Herramienta | Uso |
|---|---|
| `list_boards` | Tus tableros, con sus columnas (id, nombre, tipo) y etiquetas. |
| `get_board` | Columnas con conteo de tarjetas, etiquetas y miembros. |
| `list_cards` | Tarjetas activas de un tablero. Filtra por tipo de columna (`todo`, `doing`, `done`), columna, prioridad o responsable. |
| `get_card` | Descripción completa, comentarios e historial. |
| `create_card` | Crea una tarjeta al final de una columna (por defecto, la primera de tipo `todo`). |
| `update_card` | Título, descripción, prioridad, etiquetas, responsable, fecha límite. |
| `move_card` | Cambia de columna, por `columnId` o por tipo (`kind`). |
| `add_comment` | Añade un comentario firmado por Claude. |
| `archive_card` | Archiva la tarjeta. No hay herramienta de borrado. |

Las columnas del tablero tienen un **tipo** (`todo`, `doing`, `done`) además de un nombre. Claude decide qué está pendiente y qué
está listo por el tipo, así puedes renombrar las columnas como quieras.

## Úsalo en tus proyectos

Añade esto al `CLAUDE.md` de cada proyecto (o a tus instrucciones), con el ID que devuelve `list_boards`:

```markdown
## Tablero de trabajo
Este proyecto usa el tablero `<boardId>` (servidor MCP `tablero`).
- Antes de implementar, consulta `list_cards` con tipo `todo` y `doing`.
- Al empezar una tarjeta, muévela a tipo `doing`. Al terminar, a `done`, con un comentario de qué cambió (archivos o commit).
- El trabajo nuevo que surja se anota con `create_card`, con los criterios de aceptación en la descripción.
```

## Seguridad

- **Solo tus tableros.** El servidor únicamente opera en tableros donde `TABLERO_USER_EMAIL` es miembro. Un tablero ajeno o archivado responde como si no existiera, y un miembro con rol lector no puede escribir.
- **Las reglas de Firestore no aplican aquí.** El Admin SDK las ignora, así que el servidor repite las validaciones de la app (longitudes, prioridad, etiquetas, responsable que sea miembro).
- **Nada se borra.** No hay herramienta de borrado; `archive_card` solo oculta la tarjeta.
- **Todo queda firmado.** Lo que escribe Claude aparece en el historial como "Claude".
- **Protege la llave.** Quien la tenga puede leer y escribir toda tu base de datos. Si se filtra, elimínala en la consola (cuenta de servicio, pestaña Claves) y crea otra.
- **Para revocar el acceso** sin borrar nada: `claude mcp remove tablero -s user` o elimina la llave de la cuenta de servicio.

## Solución de problemas

| Síntoma | Causa probable y arreglo |
|---|---|
| `PERMISSION_DENIED: Missing or insufficient permissions` | La cuenta de servicio no tiene el rol **Usuario de Cloud Datastore**, o acaba de asignarse y tarda unos minutos en aplicarse. Revísalo en IAM. |
| `No profile found for ...` | Esa cuenta nunca ha iniciado sesión en la web del tablero. Entra una vez y vuelve a intentarlo. |
| `Board ... not found or not accessible` | El tablero no existe, está archivado o tu cuenta no es miembro. Usa `list_boards` para ver los disponibles. |
| `Falta TABLERO_USER_EMAIL` / `Falta GOOGLE_APPLICATION_CREDENTIALS` | Falta una variable en el registro del servidor. Revisa el comando de registro o el JSON de Claude Desktop. |
| El cliente da error de tiempo al conectar | En carpetas con lectura lenta (por ejemplo `/mnt/c` en WSL) el arranque puede tardar unos 14 segundos. En Claude Code arranca con `MCP_TIMEOUT=60000 claude`, o instala el proyecto en el disco de Linux. |
| `engine "node" is incompatible` al instalar | Necesitas Node 22 o superior. |
| No aparecen las herramientas | Abre una sesión nueva: las herramientas se cargan al iniciar. En Claude Code, `claude mcp get tablero` muestra el estado. |

## Desarrollo y pruebas

```bash
npm test
```

Levanta el emulador de Firestore (puerto 8081) y ejecuta 22 pruebas: la lógica del servicio, que los documentos escritos
cumplan lo que aceptan las reglas del cliente web y el protocolo MCP completo con un cliente real.
Necesita Java 21 o superior y la CLI de Firebase (`npm i -g firebase-tools`).

Estructura:

- `src/service.ts`: toda la lógica y las validaciones.
- `src/server.ts`: registro de herramientas MCP e instrucciones de uso para Claude.
- `src/index.ts`: punto de entrada por stdio.
- `src/ordering.ts`: cálculo de posiciones; mantenlo igual al `src/ordering.ts` de la app tablero.
