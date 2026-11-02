# tablero-mcp

Servidor [MCP](https://modelcontextprotocol.io) que permite a Claude leer y actualizar tus tableros Kanban de **tablero**
(la app web en [tablero-moros.web.app](https://tablero-moros.web.app)). Con él puedes pedirle a Claude cosas como:

- "¿Qué tarjetas me quedan pendientes en el tablero del proyecto?"
- "Toma la tarjeta de mayor prioridad, impleméntala y muévela a Hecho con un comentario de qué cambió."
- "Anota como tarjeta estas tres ideas que acabamos de hablar."

Corre en tu equipo y entra con **tu propia cuenta de Google**, la misma con la que usas el tablero. No necesitas Firebase,
claves, servidores ni conocer ningún código.

## Instalación

Necesitas **Node.js 22 o superior** y haber entrado al menos una vez en la web del tablero con tu cuenta de Google
(ahí creas tus tableros). Después, una sola orden:

```bash
npx tablero-mcp setup
```

El asistente:

1. Abre tu navegador para que elijas tu cuenta de Google y aceptes. Nada que copiar ni pegar.
2. Comprueba la conexión y te muestra tus tableros.
3. Registra el servidor en **Claude Code** y/o **Claude Desktop**, el que tengas instalado.
4. Imprime el bloque para tu `CLAUDE.md` con el **ID real de tu tablero** ya puesto.

Abre una **sesión nueva** de Claude (las herramientas se cargan al iniciar) y pregunta: *"Lista mis tableros"*.

| Comando | Para qué |
|---|---|
| `npx tablero-mcp setup` | Todo el proceso anterior. Si ya habías iniciado sesión, la reutiliza. |
| `npx tablero-mcp login` | Volver a iniciar sesión (sesión caducada o cambio de cuenta). |
| `npx tablero-mcp logout` | Cierra la sesión y borra lo guardado en el equipo. |
| `npx tablero-mcp doctor` | Comprueba Node, la sesión y la conexión, y dice qué falla. |

Solo funciona con cuentas que entran al tablero con **Google** (o con un correo de Gmail, que Firebase une a la misma cuenta).

**Desde el repositorio** (para desarrollar, o si el paquete aún no está publicado):

```bash
git clone https://github.com/danielitomoros03/moros-mcp.git
cd moros-mcp/tablero-mcp
npm install && npm run build
node dist/index.js setup
```

## Puesta en marcha (para quien publica el tablero)

Los usuarios no hacen nada de esto. Es una sola vez, y solo si publicas tu propia instancia: el MCP entra con Google desde una aplicación
de escritorio y Google exige registrarla. **La guía paso a paso, con enlaces y los errores habituales, está en
[`docs/puesta-en-marcha.md`](docs/puesta-en-marcha.md).** En resumen:

1. Publicar la **pantalla de consentimiento** de Google (tipo Externo, en producción).
2. Crear un **cliente OAuth de tipo "Aplicación de escritorio"**.
3. En Firebase, añadir ese cliente a los **permitidos del proveedor Google**.
4. Copiar el ID y el secreto en `HOSTED_OAUTH` de `src/config.ts`, probar con `setup` y publicar con `npm publish`.

Las reglas de Firestore y la app web no cambian: el MCP se rige por las mismas reglas que la web.

## Cómo funciona

- `setup` hace un inicio de sesión de Google para aplicaciones de escritorio (código de autorización con PKCE sobre `127.0.0.1`) y guarda el
  *refresh token* en `~/.config/tablero-mcp/credentials.json`, legible solo por ti.
- Cada vez que Claude arranca el servidor, se renueva la sesión sin abrir el navegador y se entra a Firebase **como tú**.
- Como Claude actúa con tu identidad, **las reglas de Firestore aplican igual que en la web**: solo ve y edita tableros donde eres miembro,
  y un lector no puede escribir.

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

- **Tu identidad, tus permisos.** El servidor no tiene acceso especial: hace lo que tu cuenta puede hacer en la web, y las reglas de Firestore
  lo hacen cumplir en el servidor de Google, no en este programa. Un tablero ajeno o archivado responde como si no existiera.
- **Nada se borra.** No hay herramienta de borrado; `archive_card` solo oculta la tarjeta.
- **Lo que hace Claude queda a tu nombre**, porque las reglas exigen que el autor sea quien escribe. Para distinguirlo, el historial de cada
  tarjeta marca esas acciones como hechas *vía Claude*.
- **Protege tu sesión.** Quien tenga `credentials.json` puede actuar como tú en tus tableros. No lo subas a git ni lo compartas.
- **Para revocar el acceso:** `npx tablero-mcp logout` (borra el archivo y avisa a Google), y `claude mcp remove tablero -s user` para quitar
  el registro. También puedes revocarlo desde [tu cuenta de Google](https://myaccount.google.com/permissions).

## Para usar tu propio Firebase

Si prefieres tu propia copia de la app tablero, apunta el servidor a tu proyecto con estas
variables de entorno al registrarlo y repite los pasos de la [puesta en marcha](docs/puesta-en-marcha.md) en tu proyecto:

| Variable | Descripción |
|---|---|
| `TABLERO_FIREBASE_API_KEY`, `TABLERO_FIREBASE_AUTH_DOMAIN`, `TABLERO_FIREBASE_PROJECT_ID`, `TABLERO_FIREBASE_APP_ID` | Configuración web de tu proyecto de Firebase (la misma de tu app). |
| `TABLERO_OAUTH_CLIENT_ID`, `TABLERO_OAUTH_CLIENT_SECRET` | Tu cliente OAuth de tipo aplicación de escritorio. |
| `TABLERO_WEB_URL` | Dirección de tu tablero, que se muestra a quien aún no tiene ninguno. |

## Solución de problemas

| Síntoma | Causa probable y arreglo |
|---|---|
| No sé qué falla | Ejecuta `npx tablero-mcp doctor`: revisa Node, la sesión y la conexión. |
| "Aún no has iniciado sesión" / "Tu sesión caducó" | Ejecuta `npx tablero-mcp login`. |
| El navegador no se abre | El asistente imprime el enlace: cópialo en el navegador. En WSL, si falla, instala `wslu` o abre el enlace a mano. |
| "Firebase no aceptó el inicio de sesión de Google" | Falta el paso 3 de la [puesta en marcha](docs/puesta-en-marcha.md): añadir el cliente OAuth a los permitidos del proveedor Google. |
| "Firestore rechazó el acceso" | Entra una vez en la web del tablero con esa cuenta para crear tu perfil. |
| `Board ... not found or not accessible` | El tablero no existe, está archivado o tu cuenta no es miembro. Usa `list_boards` para ver los disponibles. |
| `engine "node" is incompatible` | Necesitas Node 22 o superior. |
| No aparecen las herramientas | Abre una sesión nueva: las herramientas se cargan al iniciar. En Claude Code, `claude mcp get tablero` muestra el estado. |
| Venías de la versión con llave de cuenta de servicio | Ya no se usa. Ejecuta `npx tablero-mcp setup`; ofrece reemplazar el registro anterior. Puedes borrar esa llave y su cuenta de servicio. |

## Desarrollo y pruebas

```bash
npm test
```

Levanta los emuladores de Auth y Firestore (con las **mismas reglas** que la web, en `tests/firestore.rules`; se refrescan solas desde
`../tablero/firestore.rules` cuando la app está junto a este paquete) y corre las pruebas: la lógica del servicio con un usuario que inicia sesión de verdad,
que las reglas bloqueen lo ajeno, el protocolo MCP completo con un cliente real, el inicio de sesión de Google contra un Google simulado
(PKCE, state, renovación y revocación) y las funciones del asistente. Necesita Java 21 o superior y la CLI de Firebase (`npm i -g firebase-tools`).

Estructura:

- `src/service.ts`: toda la lógica y las validaciones.
- `src/server.ts`: registro de herramientas MCP e instrucciones de uso para Claude.
- `src/index.ts`: punto de entrada: sin argumentos arranca el servidor por stdio; con `setup`, `login`, `logout` o `doctor` ejecuta la CLI.
- `src/cli.ts` y `src/setup-helpers.ts`: los comandos (E/S) y sus funciones puras.
- `src/oauth.ts`: inicio de sesión de Google con PKCE y renovación.
- `src/session.ts`: sesión guardada, conexión a Firebase como el usuario y creación del perfil.
- `src/config.ts`: identificadores públicos de la instancia y variables para cambiarlos.
- `src/ordering.ts`: cálculo de posiciones; mantenlo igual al `src/ordering.ts` de la app tablero.
- `docs/puesta-en-marcha.md`: registro del cliente OAuth y publicación, paso a paso.
