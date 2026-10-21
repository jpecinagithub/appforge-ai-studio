# Diagnóstico del flujo autenticado — resultados

**Fecha:** 2026-10-21 · **Rama:** `fix/authflow-diagnostico` (desde `master` a95df14) · Sin fusionar ni desplegar.

## El problema

En el run real de «PcBox online» que llegó a 5/6, `test_authenticated_flow`
murió en la fase de navegador y el agente intentó parchear `App.tsx` dos
veces sin ancla (`PATCH_NOT_FOUND`): el diagnóstico que recibía no le decía
qué paso falló, ni si el selector buscado existía, ni qué mostraba la
página. Solo recogía (`apps/worker/src/browser.ts`, `checkBrowserAtUrl`):

- mensajes de `pageerror` sin stack;
- respuestas ≥400 únicamente de recursos estáticos (document/script/
  stylesheet/image) — los fallos xhr/fetch de `/api/*` eran invisibles;
- el mensaje crudo de Playwright del paso que fallaba, sin índice de paso.

Y encima `testAuthenticatedFlow` (`authFlow.ts`) recortaba el error a
2000 caracteres al componer el `fail`.

## Antes / después (ejemplo reconstruido y anonimizado del fallo real)

**Antes** — todo lo que veía el modelo:

```
Cannot read properties of undefined (reading 'toFixed')
locator.getByText: Timeout 5000ms exceeded.
Call log:
  - waiting for getByText('flow-ui-…@example.com', { exact: true })
```

**Después** — la misma situación con el diagnóstico nuevo:

```
step 5/9 (expect_text "[data-testid="user-email"]") failed: locator.getByText: Timeout 5000ms exceeded. …
PAGE ERRORS:
Cannot read properties of undefined (reading 'toFixed')
    at renderPrice (…/assets/index-….js:1:…)
    at …
selector [data-testid="user-email"]: NOT PRESENT in DOM
NETWORK FAILURES:
HTTP 401 GET /a/<proyecto>/api/auth/me
PAGE: https://…/a/<proyecto>/ — title: "PC Computers"
DATA-TESTID INVENTORY: auth-screen, auth-email, auth-password, auth-submit, product-card, …
VISIBLE TEXT: Sign in … (la pantalla de login, porque el render principal crasheó antes)
```

Con eso, el agente distingue en un vistazo «la app crasheó al renderizar»
(pageerror + el testid nunca llegó al DOM) de «el selector cambió» (veredicto
`present, text: "…"` con el texto real ≠ esperado) o de «el backend devolvió
500 en el login» (línea de red `/api/`).

## Cambios

Todo en `apps/worker/src/browser.ts`, compartido por `checkBrowserAtUrl`
(flujo autenticado y preview dinámica) y `checkBrowser` (vía estática), que
ya ejecutaban pasos y listeners en paralelo:

1. **Paso identificado.** Los pasos se ejecutan con índice (`runSteps`); si
   uno falla, el diagnóstico empieza por
   `step N/M (action "selector") failed: <mensaje original de Playwright>`.
2. **Pageerror con stack.** El listener guarda el mensaje más las ~6
   primeras líneas del stack cuando el navegador lo expone (deduplicado,
   máx. 5 errores de página).
3. **Consola.** Se capturan los mensajes de consola de tipo `error`
   (deduplicados, máx. 10, ≤300 caracteres cada uno).
4. **Red completa.** Respuestas ≥400 y `requestfailed` de **todos** los
   tipos de recurso, en formato compacto sin query string:
   `HTTP 500 POST /a/<id>/api/auth/login`, `FAILED GET /ruta (net::…)`.
   Al componer, las líneas `/api/` van siempre primero y el total capa a
   ~12 líneas (con línea resumen de las omitidas).
5. **Foto del fallo** (`collectFailureDiagnostics`, compartido): antes de
   cerrar el navegador se lee en una sola evaluación — URL actual y
   `title`; veredicto explícito del selector del paso fallido cuando es un
   `data-testid` (`selector [data-testid="user-email"]: NOT PRESENT in DOM`
   o `present, text: "<textContent recortado>"`); inventario de
   `data-testid` presentes (deduplicado, máx. 40); extracto del texto
   visible del body (≤800 caracteres). Lectura con timeout de 3 s y sin
   lanzar nunca: una página colgada produce una foto parcial.
6. **Composición y tamaño** (`composeFailureDiagnostic`): texto etiquetado
   por secciones con lo accionable primero (paso fallido → page errors →
   veredicto del selector → fallos de red → consola → URL/title →
   inventario → texto visible) y tope total de ~6000 caracteres; al
   recortar, encogen primero el extracto de texto y el inventario.
   En `authFlow.ts`, el recorte del error de `testAuthenticatedFlow` sube
   de 2000 a 6000 para que el diagnóstico llegue entero al modelo,
   manteniendo el prefijo `authenticated flow failed at "<step>":`.

## Límites (deliberados)

- **La semántica pasa/falla no cambia.** Hacen fallar la comprobación los
  de siempre: pageerrors, recursos estáticos caídos (≥400 o `requestfailed`
  de document/script/stylesheet/image), imágenes rotas, pasos fallidos y
  body vacío. Los fallos de red `/api/` y los errores de consola son
  **contexto diagnóstico**: no hacen fallar por sí solos, porque un 401 de
  `/api/auth/me` al cargar la SPA es parte normal del flujo y un `error`
  de consola benigno no debe tumbar una verificación que hoy pasa. La
  salida de éxito es byte a byte la de antes.
- El stack del pageerror es el del bundle servido (minificado, sin source
  maps): orienta por mensaje y función, no por línea de fuente.
- Sin paso fallido con selector `data-testid` no hay veredicto de selector
  (no aplica); el resto de la foto se incluye igual.
- La foto se toma sobre la página tal como quedó tras el fallo; en
  `checkBrowser` eso puede ser ya el viewport móvil si el fallo ocurre en
  la segunda pasada.

## Tests

Los tests de navegador **corren** en este entorno (Chromium headless real,
sin skips; los únicos skipped de la suite son los 18 de integración Docker,
preexistentes). Nuevos en `apps/worker/src/browser.test.ts` (+4):

- Página fixture que lanza un `TypeError` reconocible (`toFixed` sobre
  `undefined`) y carece de `[data-testid="user-email"]` teniendo otros
  testids → el fallo de `checkBrowserAtUrl` contiene la etiqueta
  `step 1/1 (expect_text …) failed:`, el mensaje del pageerror bajo
  `PAGE ERRORS:`, el veredicto `NOT PRESENT in DOM` y el inventario con
  los testids presentes.
- Página que hace `fetch` a un endpoint que responde 500 → el diagnóstico
  lista `HTTP 500 GET /api/boom` bajo `NETWORK FAILURES:` (antes invisible
  por ser xhr).
- Flujo que sí pasa → `ok` sin ninguna sección del bloque de diagnóstico
  de fallo en la salida (sin regresión del camino de éxito).
- Unidad pura de `composeFailureDiagnostic`: con texto visible e
  inventario sobredimensionados, la salida capa en 6000 caracteres y
  conserva primero el paso fallido, el pageerror, el veredicto y la línea
  de red `/api/`.

Los 11 tests de `authFlow.test.ts` (incluido el flujo completo API +
navegador contra el fixture) pasan sin cambios.

## Resultados

- Worker: **460 ✓ / 0 ✗** (baseline 456 + 4 nuevos; 18 skipped de
  integración Docker, como en el baseline).
- Server: **113 ✓ / 0 ✗** (sin tocar ningún fichero del server).
- Typecheck del worker (`npx tsc --noEmit -p tsconfig.json` dentro de
  `apps/worker`): limpio. Nota: el callback de `page.evaluate` accede a
  `document`/`location` vía `globalThis` con tipos locales mínimos porque
  la lib del tsconfig del worker no incluye DOM.
- Ficheros: `apps/worker/src/browser.ts` (reescritura de la capa de
  diagnóstico), `apps/worker/src/browser.test.ts` (+4 tests),
  `apps/worker/src/authFlow.ts` (1 línea: recorte 2000 → 6000).
- Sin tocar producción, ni el checkout del servidor, ni la plantilla.
