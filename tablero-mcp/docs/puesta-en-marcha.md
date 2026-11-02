# Puesta en marcha del inicio de sesión

Esta guía es para **quien publica** `tablero-mcp` (quien administra el proyecto de Firebase donde vive el tablero). Se hace **una sola vez**.
Después, cualquier persona con una cuenta de Google conecta Claude con `npx tablero-mcp setup`, sin tocar nada de esto.

## Por qué hace falta

`tablero-mcp` entra al tablero como la persona que lo usa, con su cuenta de Google. Google exige que una aplicación que pide ese acceso esté
registrada y tenga un **cliente OAuth**. Firebase, por su parte, solo acepta inicios de sesión de Google que vengan de clientes que conoce.
Son tres registros (pantalla de consentimiento, cliente, permiso en Firebase) y luego pegar dos valores en el código.

```
 Persona ──▶ Google (cliente OAuth "tablero-mcp") ──▶ tablero-mcp ──▶ Firebase Auth ──▶ Firestore (con las reglas de la web)
```

## Antes de empezar

- Acceso de **propietario o editor** al proyecto de Google Cloud / Firebase donde vive el tablero (el mismo de la app web).
- Node.js 22 o superior y este repositorio clonado.
- Los nombres de los menús de Google cambian de vez en cuando. Si algo no aparece donde se indica, busca el nombre entre comillas en la barra
  de búsqueda de la consola.

En los enlaces, `TU_PROYECTO` es el **ID** de tu proyecto de Firebase (el de `projectId` en `src/config.ts`).

## Paso 1. Pantalla de consentimiento (una vez)

Es lo que ve la persona cuando Google le pregunta "¿permitir que tablero acceda a tu cuenta?".

1. Abre `https://console.cloud.google.com/auth/overview?project=TU_PROYECTO` (sección **Google Auth Platform**).
   En consolas más antiguas es **APIs y servicios, Pantalla de consentimiento de OAuth**.
2. Si es la primera vez, pulsa **Comenzar** y rellena:
   - **Nombre de la aplicación:** `tablero`.
   - **Correo de asistencia:** el tuyo.
   - **Público (Audience): Externo.** Con *Interno* solo entrarían cuentas de tu organización de Google Workspace.
   - **Correo de contacto del desarrollador:** el tuyo.
3. En **Acceso a los datos (Data access)** no añadas nada: los permisos básicos `openid`, `email` y `profile` ya van incluidos y no requieren
   verificación de Google.
4. En **Público (Audience)** pulsa **Publicar aplicación** (*Publish app*) y confirma que el estado pasa a **En producción**.

> **No te saltes el paso 4.** Mientras la app esté en "Prueba", solo pueden entrar las cuentas que añadas a mano como usuarios de prueba, y
> las sesiones caducan a los 7 días. Los usuarios verían el error "Acceso bloqueado" y tendrían que volver a iniciar sesión cada semana.

## Paso 2. Cliente OAuth de tipo "Aplicación de escritorio"

1. Abre `https://console.cloud.google.com/auth/clients/create?project=TU_PROYECTO`
   (o **APIs y servicios, Credenciales, Crear credenciales, ID de cliente de OAuth**).
2. **Tipo de aplicación: Aplicación de escritorio** (*Desktop app*). No elijas "Aplicación web": ese tipo exige registrar la dirección de
   retorno y el MCP usa un puerto local distinto en cada inicio de sesión.
3. **Nombre:** `tablero-mcp`. Pulsa **Crear**.
4. Copia el **ID de cliente** (termina en `.apps.googleusercontent.com`) y el **Secreto del cliente**.

El secreto de un cliente de escritorio **no es confidencial**: Google lo documenta así
([OAuth 2.0 para aplicaciones instaladas](https://developers.google.com/identity/protocols/oauth2/native-app)), porque cualquiera que instala
la aplicación puede leerlo. Por eso puede ir en el código público. No lo confundas con la llave de una cuenta de servicio, que sí es secreta.

## Paso 3. Permitir el cliente en Firebase

Sin este paso Firebase rechaza el inicio de sesión aunque Google lo haya aceptado.

1. Abre `https://console.firebase.google.com/project/TU_PROYECTO/authentication/providers`.
2. En **Método de acceso (Sign-in method)** abre el proveedor **Google**. Debe estar **habilitado** (ya lo está si la web permite entrar con Google).
3. Despliega **Configuración del SDK web (Web SDK configuration)**.
4. En **Permitir ID de cliente de proyectos externos (Whitelist client IDs from external projects)** pega el **ID de cliente** del paso 2.
5. **Guardar.**

## Paso 4. Ponerlo en el código

En `src/config.ts`, rellena `HOSTED_OAUTH` con los dos valores del paso 2:

```ts
export const HOSTED_OAUTH: OAuthClient = {
  clientId: '123456789-abc....apps.googleusercontent.com',
  clientSecret: 'GOCSPX-...',
}
```

Confirma de paso que `HOSTED_FIREBASE` (`apiKey`, `authDomain`, `projectId`, `appId`) es el de tu app web, y `HOSTED_WEB_URL` su dirección.
Estos valores identifican tu proyecto pero **no dan acceso**: la clave de API de Firebase ya viaja en el JavaScript de tu web, y el acceso a los
datos lo deciden las reglas de Firestore y quién inicia sesión.

Haz commit de estos cambios.

## Paso 5. Probarlo antes de publicar

```bash
npm install
npm run build
node dist/index.js setup --client none
```

Debe ocurrir esto:

1. Se abre el navegador con el aviso de Google "tablero quiere acceder a tu cuenta" (sin advertencia de "app no verificada").
2. Al aceptar, el navegador muestra "Listo" y la terminal dice `Sesión iniciada como tu-correo`.
3. Aparece `Conectado a tu tablero` y la lista de tus tableros.

Pruébalo **con una cuenta de Google que no sea la tuya** (o con un perfil de navegador limpio). Es la única forma de comprobar que cualquier
persona puede entrar y no solo el propietario del proyecto. Después ejecuta `node dist/index.js doctor`: todo debe salir con ✔.

Si algo falla, esta tabla cubre los casos habituales:

| Lo que ves | Causa | Arreglo |
|---|---|---|
| "Esta copia ... no tiene configurado el acceso con Google" | `HOSTED_OAUTH` vacío | Paso 4 y volver a compilar (`npm run build`). |
| Google: "Acceso bloqueado: tablero no completó el proceso de verificación" | La app sigue en modo Prueba | Paso 1, punto 4 (o añade esa cuenta como usuario de prueba). |
| Google: `invalid_client` / "Google no aceptó el inicio de sesión (invalid_client)" | ID o secreto mal copiados, o cliente de otro tipo | Revisa el paso 2; el tipo debe ser *Aplicación de escritorio*. |
| "Firebase no aceptó el inicio de sesión de Google" (`auth/invalid-credential`, "audience") | Falta el paso 3 | Añade el ID de cliente a los permitidos del proveedor Google y guarda. |
| "El inicio de sesión con Google no está activado" (`auth/operation-not-allowed`) | Proveedor Google deshabilitado en Firebase | Actívalo en Método de acceso. |
| `Requests from referer <empty> are blocked` | La clave de API de Firebase está restringida a sitios web (HTTP referrers) | En Google Cloud, Credenciales, edita esa clave y quita la restricción de sitios web (o usa "Ninguna"). Una aplicación de terminal no envía referer. Las restricciones por API sí se pueden mantener. |
| "Firestore rechazó el acceso" | La persona aún no tiene perfil | Que entre una vez a la web del tablero, o que repita `setup` (lo crea al iniciar sesión). |
| El navegador no abre | Sin navegador predeterminado, SSH o WSL | El asistente imprime el enlace: se copia al navegador. |

## Paso 6. Publicar en npm

1. Comprueba que el nombre está libre: `npm view tablero-mcp name`. Si responde con un paquete, el nombre es de otra persona: usa un nombre con
   ámbito, por ejemplo `@tu-usuario/tablero-mcp` (cambia `name` en `package.json` y escribe `npx @tu-usuario/tablero-mcp setup` en los README).
2. Inicia sesión: `npm login` (si tienes verificación en dos pasos, te pedirá el código).
3. Revisa qué se subirá: `npm pack --dry-run`. Debe incluir solo `dist/`, `README.md`, `package.json` y la licencia; **nunca** llaves ni archivos `.env`.
4. Publica: `npm publish --access public` (el script `prepublishOnly` compila antes).
5. Verifica desde una carpeta vacía, como lo haría un usuario nuevo: `npx tablero-mcp@latest setup`.

Para publicar cambios futuros, sube la versión con `npm version patch` (o `minor`) y repite `npm publish`.

## Mantenimiento

- **Cambiar el secreto del cliente:** en la consola del cliente OAuth puedes crear uno nuevo; actualiza `HOSTED_OAUTH`, publica una versión nueva
  y las sesiones ya guardadas siguen funcionando con el secreto anterior hasta que lo elimines.
- **Cuentas que dejan de funcionar:** si alguien revoca el acceso desde su cuenta de Google, `doctor` le dice que vuelva a ejecutar `login`.
- **Reglas de Firestore:** no cambian por esto. Si las modificas en la web, copia `firestore.rules` a `tests/firestore.rules` (el script
  `npm test` lo hace solo cuando la app está al lado) para que las pruebas sigan reflejando la realidad.

## Lista de comprobación

- [ ] Pantalla de consentimiento en **Externo** y **En producción**.
- [ ] Cliente OAuth de tipo **Aplicación de escritorio** creado.
- [ ] ID de cliente añadido a los permitidos del proveedor Google en Firebase.
- [ ] `HOSTED_OAUTH` rellenado en `src/config.ts` y compilado.
- [ ] `setup` probado de punta a punta con una cuenta ajena.
- [ ] Clave de API de Firebase sin restricción de sitios web.
- [ ] Paquete publicado y `npx tablero-mcp@latest setup` probado desde una carpeta vacía.
