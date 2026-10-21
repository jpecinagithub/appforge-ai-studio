# Vista y contrato frontend: sourcemaps, lint de cliente API, aviso de prefijo y carpetas de imágenes

**Fecha:** 2026-10-21 · **Rama:** `feat/agente-vista-contrato` (desde `master` ceaf741) · Sin fusionar ni desplegar.

Paquete motivado por el run `977a3ab8` (proyecto «T-shirts» `8863cc94`), el
primer run con el bucle flexible ya desplegado: la escalera funcionó (45
llamadas, tres intervenciones, fin honesto `LOOP_EXHAUSTED`) y aun así el
agente no arregló el bug. La causa, verificada en las fuentes y en el
diagnóstico del propio flujo: `frontend/src/App.tsx` pedía las camisetas con
un `fetch('/api/shirts')` absoluto escrito a mano en vez del cliente API de
la plantilla → la petición escapó del prefijo `/a/<id>/` → 404 →
`data.items` undefined → `setShirts(undefined)` → crash de React
«Cannot read properties of undefined (reading 'map')» al pintar la parrilla.
El diagnóstico listaba el 404, pero el stack de página era minificado (sin
fichero:línea) y el agente no conectó ambas cosas en tres intervenciones.
El mismo run gastó dos llamadas de `acquire_image` en `INVALID_PATH` con un
`create_directory` manual entre ambas. Este paquete ataca las cuatro
superficies: que el agente **vea** dónde se rompe (pieza 1), que el contrato
del frontend esté **dicho y vigilado al escribir** (pieza 2), que el
diagnóstico **nombre la conclusión** cuando una petición escapa del
prefijo (pieza 3) y que una carpeta que no existe deje de ser un error
(pieza 4). La evidencia (recibos, huellas, puertas) no se toca.

Commits (atómicos por pieza, todos en la rama):

| Commit | Pieza |
| --- | --- |
| `85b0e23` | 1 — sourcemaps en la build de verificación + stacks resueltos en el diagnóstico |
| `f429129` | 2 — contrato frontend: cliente API en contexto, hecho duro en el prompt y lint en escritura |
| `8a5014e` | 3 — aviso de escape de prefijo en el diagnóstico del flujo |
| `7251716` | 4 — `acquire_image` crea la carpeta destino y valida la ruta |
| este documento | documentación |

## Pieza 1 — Sourcemaps y resolución de stacks

- **Dónde se activan (decisión):** solo en la build de verificación del
  worker. `run_frontend_build` pasa a ejecutar `npm run build -- --sourcemap`
  (npm añade el flag al final del script de la plantilla:
  `tsc -p tsconfig.json && vite build --sourcemap`). **La plantilla no
  cambia**: ni `frontend/vite.config.ts` ni `frontend/package.json` se
  tocan, y las imágenes de producción de las apps se siguen construyendo
  dentro de Docker con el script plano — **sin mapas**. El flag vive en
  `runStackBuild` como `buildArgs` fijo del caller (nunca del modelo); la
  build de backend no lo recibe.
- **Resolución:** nuevo `apps/worker/src/stackResolve.ts`. Parsea los frames
  http(s) de un stack V8 (con nombre y anónimos, deduplicados), localiza el
  `//# sourceMappingURL=` del bundle servido (externo o `data:` en base64;
  con fallback a `<bundle>.map`), carga el mapa con `source-map-js` y anota
  los dos primeros frames resolubles con una línea
  `↳ original: frontend/src/App.tsx:300:5` insertada tras el frame. Las
  rutas de los `sources` se normalizan al árbol del proyecto
  (`../../src/App.tsx` → `frontend/src/App.tsx`; `node_modules/…` se muestra
  tal cual). Columnas: la del stack es 1-based, la del mapa 0-based; se
  convierte en ambos sentidos.
- **Dependencia:** `source-map-js@^1.2.2` pasa a dependencia directa del
  worker (`apps/worker/package.json` + lockfile; ya estaba en el árbol como
  transitiva de Vite, el diff del lockfile es mínimo). Sus tipos viajan en el
  propio paquete (`source-map.d.ts`), sin `@types` adicional.
- **Cableado:** `browser.ts` enriquece `diag.pageErrors` en los catch de
  `checkBrowser` y `checkBrowserAtUrl` antes de componer el diagnóstico,
  con caché de consumidores por diagnóstico y fetch acotado (2,5 s por
  recurso, 24 MB por texto). Es decoración best-effort por construcción:
  sin mapa, bundle inalcanzable o frame sin correspondencia, el texto del
  error queda **exactamente** como se recogió; la semántica pasa/falla no
  cambia. Alcance: la build estática (`run_build`) no emite mapas de
  momento — el resolvedor simplemente no actúa cuando no hay mapa.
- **Tests:** `stackResolve.test.ts` (9: parseo de frames, normalización de
  rutas, enriquecido con fixture bundle+map sintéticos generados con
  `SourceMapGenerator`, mapas `data:`, bundle sin mapa y mapa corrupto),
  un e2e nuevo en `browser.test.ts` con Chromium real (bundle que explota
  al cargar; el diagnóstico contiene `↳ original: frontend/src/App.tsx:300`)
  y uno en `dynamicTools.test.ts` (el fixture de build registra sus argv:
  el frontend recibe `--sourcemap`, el backend no).

## Pieza 2 — Contrato frontend en contexto + lint en escritura

Espejo de lo que ya existía para el backend (`backendContracts.ts` y los
contratos de contexto), aplicado al cliente API:

- **(a) Contexto inicial:** `frontend/src/api.ts` y `frontend/src/api-url.ts`
  ya se inyectaban, pero enterrados al final de la lista genérica
  `DYNAMIC TEMPLATE CONTRACTS`. Ahora forman su propio bloque,
  **FRONTEND API CLIENT CONTRACT**, enmarcado como la única vía soportada
  de llamar a la API, con el porqué (resolución contra `document.baseURI`,
  prefijo `/a/<projectId>/` en preview y producción). La lista genérica
  conserva los contratos de backend.
- **(b) Hecho duro en el prompt:** «TEMPLATE API FACTS» gana el punto (5):
  toda llamada a la API pasa por el cliente del proyecto; prohibido
  `fetch('/api/...')`/`axios('/api/...')` absoluto escrito a mano fuera de
  él, con la cadena de consecuencias (escape del prefijo → 404 de la API de
  la plataforma → datos undefined → crash al pintar) y el aviso de que las
  herramientas de ficheros lo señalan al escribirlo.
- **(c) Lint en escritura:** nuevo `apps/worker/src/frontendContracts.ts`,
  escaneo de texto puro en el mismo estilo no bloqueante del de backend.
  Al escribir/parchear ficheros de frontend (`write_file`, `write_files`,
  `patch_file`, a través de `withFrontendNote` en `tools.ts`) detecta el
  literal `/api…` entregado directamente como primer argumento a `fetch()`
  o `axios[.get/.post/…]()` — comillas simples, dobles y template literals —
  y añade al resultado la nota «Frontend contract check (…)» con el fichero,
  la llamada detectada, el porqué y la alternativa (cliente API o URL
  relativa). Alcance deliberadamente estrecho:
  - el propio cliente (`src/api.ts`, `src/api-url.ts`) se excluye por ruta:
    los literales `/api/…` son su materia prima;
  - `fetch(resolveApiUrl('/api/...', document.baseURI))` NO se marca: es el
    patrón soportado (el literal no es el primer argumento de `fetch`);
  - URLs relativas (`./api/…`, `api/…`) y externas (`https://…`) NO se
    marcan.
- **Tests:** `frontendContracts.test.ts` (5: el caso T-shirts literal,
  variantes de comillas y de axios, una violación por fichero, exclusión
  del cliente, y la batería de patrones limpios) + 4 de cableado en
  `tools.test.ts` (write_file anota, el cliente no se anota, patch_file
  anota el reemplazo, write_files anota el fichero malo y no el limpio).

## Pieza 3 — Aviso de prefijo en el diagnóstico del flujo

- `PageDiagnostics` guarda también las **URLs completas** de los fallos de
  red (`networkUrls`, paralelas a las líneas compactas existentes), sin
  cambiar qué se lista ni la semántica pasa/falla (los fallos xhr/fetch
  siguen siendo contexto, no criterio).
- Nueva función pura exportada `escapedBasePathWarnings(pageUrl, failedUrls)`:
  calcula la ruta base de la página (su directorio: `/a/<id>/`,
  `/p/<id>/`, …) y nombra cada petición fallida **del mismo origen** cuya
  ruta no empieza por la base — la firma determinista del escape de
  prefijo. Orígenes externos ignorados; una app servida en la raíz no
  puede escapar y no genera avisos; la base sin slash final cuenta como
  dentro.
- `composeFailureDiagnostic` añade, tras NETWORK FAILURES, la sección
  **BASE PATH WARNING** con líneas del tipo: «request escaped the app base
  path: /api/shirts is outside the page base /a/<id>/ — likely an absolute
  /api path in the code; route API calls through the project API client or
  a relative URL so they stay below the base path». El 401 in-prefix de
  `/a/<id>/api/auth/me` se sigue listando como contexto y **nunca** genera
  aviso.
- **Tests:** 2 nuevos en `browser.test.ts` — unidad de la función pura
  (escape, ruta hermana de prefijo, base sin slash, origen externo, raíz) y
  e2e con Chromium: página bajo `/a/shop1/` que pide `/api/shirts` (404) y
  `/a/shop1/api/auth/me` (401); el diagnóstico contiene el aviso para la
  primera y no para la segunda.

## Pieza 4 — `acquire_image` crea la carpeta destino

En `tools.ts`, al validar la ruta destino, antes de buscar:

- La ruta se **normaliza** (`path.posix.normalize`) y se re-comprueba la
  contención bajo `public/`: `public/../src/evil.jpg` es ahora
  `INVALID_PATH` (antes la escritura final lo resolvía dentro de
  `frontend/` pero fuera de `public/`: un escape silencioso que esta
  pieza cierra).
- Extensiones de destino fuera de `.jpg/.jpeg/.png/.webp` →
  `INVALID_PATH` con motivo, antes de cualquier llamada de red (sin
  extensión sigue siendo la opción preferida: decide la descarga).
- La **carpeta destino se crea recursivamente** en ese momento
  (`mkdirSync(..., { recursive: true })` sobre el directorio de la ruta):
  que no exista deja de producir error ni rodeo por `create_directory`.
  El `mkdirSync` previo a la escritura se mantiene como segunda red.
  `INVALID_PATH` se conserva para lo que sí es inválido: fuera de
  `public/`, escapes con `..` y extensiones no admitidas.
- La descripción de la herramienta lo dice ahora explícitamente («the
  destination directory is created (recursively) when missing»).
- **Tests:** 3 nuevos en `tools.test.ts` — la carpeta se crea aunque la
  búsqueda no encuentre nada (y el resultado sigue siendo
  `IMAGE_NOT_FOUND`), extensión no admitida rechazada sin tocar la red, y
  escape con `..` rechazado sin escribir fuera de `public/`.

## Suites (antes → después)

| Suite | Antes (master ceaf741, recontado) | Después (rama) |
| --- | --- | --- |
| Worker | 475 ✓ / 18 skipped | **500 ✓ / 18 skipped** (+25 nuevos: 9 stackResolve, 5 frontendContracts, 4 cableado en tools, 3 acquire_image, 3 browser, 1 dynamicTools) |
| Server | 121 ✓ | 121 ✓ (sin cambios en esta rama) |
| Studio | 22 ✓ + build | 22 ✓ + build (sin cambios en esta rama) |
| Typecheck worker | limpio | limpio |

Sin fusionar ni desplegar: la fusión y el despliegue quedan para la
verificación del mantenedor.
