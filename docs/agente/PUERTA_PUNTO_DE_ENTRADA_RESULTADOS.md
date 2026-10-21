# Puerta de implementación: divergencia del punto de entrada — RESULTADOS

**Fecha:** 2026-10-21 · **Rama:** `fix/puerta-punto-de-entrada` (desde master `08c1197`) · **Estado:** completada en local, sin fusionar ni desplegar.

## El fallo real

El proyecto «T-shirts» (`497f482d`) cerró `done` con 6/6 (run `275c9eb3`) y su despliegue (`0a41315f`) quedó `live`, pero la app desplegada es la **app de tareas de la plantilla** («My tasks»). La tienda que el agente construyó existe — `frontend/src/components/ShopScreen.tsx`, `ProductCard.tsx`, `CartItem.tsx`, `OrderItem.tsx` — pero nada la referencia: `frontend/src/App.tsx` quedó byte a byte igual que la de la plantilla (importa `Todo`, pinta su `AuthScreen`), y es App.tsx lo que el punto de entrada renderiza.

## Causa raíz

El criterio 3 de `implementationEvidence` aceptaba como superficie de frontend «`App.tsx` difiere de la plantilla **O** `frontend/src` contiene un fichero que la plantilla no trae». Los componentes nuevos, aunque huérfanos, satisfacían la puerta. Ninguna otra capa lo caza: el flujo autenticado solo ejercita el auth, que la plantilla pasa por construcción, y las huellas por ámbito solo prueban que *algo* cambió en `frontend/src`, no que lo que arranca haya cambiado.

## Criterio implementado (frontend)

La superficie de frontend exige **divergencia del punto de entrada**. Pasa solo si se cumple alguna de:

- **(a)** `frontend/src/App.tsx` difiere de la plantilla.
- **(b)** `frontend/src/main.tsx` difiere de la plantilla **Y** algún componente que importa (resuelto por la cadena de imports relativos) existe en el proyecto y es nuevo o difiere de su homólogo de plantilla — el bypass legítimo de App.tsx.

Los ficheros nuevos no alcanzados desde la cadena de entrada ya no cuentan. La comprobación de la cadena es deliberadamente sencilla: extracción de specifiers relativos por regex (imports estáticos, side-effect, re-exports, `import()`, `require()`), resolución con extensiones `.tsx/.ts/.jsx/.js`, índices y mapeo NodeNext (`.js`→`.ts`, `.jsx`→`.tsx`, `.mjs`→`.ts`), recorrido transitivo acotado (500 ficheros). Imprecisión residual aceptada y documentada en el código: una cadena con forma de import dentro de un comentario podría crear un borde fantasma; un borde perdido solo endurece el check.

**Diagnóstico.** Cuando la superficie falla, `missing` trae, sin ambigüedad: «entry point still renders the untouched template (frontend/src/App.tsx is unchanged); wire the root component so the app renders your implementation (e.g. render your main screen from App.tsx)» (variante cuando App.tsx sí cambió pero main.tsx no cablea ninguna raíz nueva: «…(no new or changed root component is wired from frontend/src/main.tsx); …»). El texto fluye por el cauce existente: `verify()` lo incluye en el `NO_IMPLEMENTATION: …` y selecciona la instrucción **IMPLEMENT FIRST**, sin cambios en `agent.ts`.

## El agujero simétrico en el backend: existía, cerrado

Comprobación previa por **test de caracterización** (temporal, ejecutado antes de tocar el código): un proyecto con el frontend implementado y un `backend/src/routes/products.ts` nuevo **nunca importado por `server.ts`** devolvía `implemented = true` con `missing = []`. El agujero existía tal cual.

Cierre con el criterio análogo: un fichero de rutas solo cuenta si está **cableado** — alcanzable desde `backend/src/server.ts` por la cadena de imports relativos (transitiva: un barrel `routes/index.ts` que re-exporta la ruta la registra). Reglas concretas:

- Fichero de rutas nuevo: cableado **y** declara ≥ 1 handler (un barrel sin handlers no es superficie por sí solo, pero la cadena lo atraviesa).
- Fichero de rutas existente: cableado **y** más handlers que su homólogo de plantilla.
- `server.ts` con más handlers que la plantilla: cuenta por definición (es el punto de entrada).

El mensaje de superficie de backend ahora lo dice: «…add a route file under backend/src/routes and **register it from backend/src/server.ts**, or extend an existing registered route file with new endpoints».

## Tests

**Nuevos (7, en `implementationEvidence.test.ts`; la suite pasa de 6 a 13):**

1. **Caso T-shirts**: App.tsx de plantilla + 4 componentes de tienda no referenciados + backend real registrado → RECHAZA, con `missing` = exactamente el diagnóstico del punto de entrada.
2. Los mismos componentes con App.tsx que los importa/renderiza → pasa.
3. Bypass por `main.tsx`: App.tsx intacta, `main.tsx` reescrito renderizando una raíz nueva (`ShopRoot`) → pasa.
4. `main.tsx` modificado pero que sigue renderizando la App de plantilla → RECHAZA.
5. **Flip de la caracterización backend**: ruta nueva sin registrar → RECHAZA con el mensaje de superficie de backend.
6. La misma ruta registrada en `server.ts` → pasa.
7. Registro transitivo vía barrel (`routes/index.ts`) → pasa.

**Ajustados (cambio de semántica deliberado — codificaban la semántica laxa corregida):**

- `implementationEvidence.test.ts`:
  - «rejects the pristine starter»: la aserción `no new frontend surface` pasa al nuevo diagnóstico de punto de entrada (mismo caso, mensaje nuevo).
  - «rejects backend-only and frontend-only implementations»: la «implementación backend» del caso ahora **registra** la ruta en `server.ts`; antes bastaba crear el fichero, es decir, el test codificaba el agujero simétrico.
  - «accepts endpoints added inside an existing route file plus a new frontend file» → renombrado a «…plus an App.tsx that renders a new component»: antes pasaba con un componente **no referenciado**, es decir, codificaba exactamente el agujero T-shirts; ahora App.tsx importa y renderiza el componente (la extensión de handlers en `todos.ts` no cambia: `todos.ts` ya estaba cableado en el fixture).
- `dynamicGate.test.ts`: el `server.ts` del fixture `makeTemplatedProject` pasa a importar sus rutas (como la plantilla real, cuyo `server.ts` importa las suyas); los guiones de «finishes when the run adds a backend route…» y «annotates contract violations…» añaden la escritura de `server.ts` que registra `products.ts` — antes el run cerraba `done` con la ruta huérfana.
- `malformedCalls.test.ts`: mismo cambio de fixture; `happyTail` registra `products.ts` en `server.ts`; el caso (d) actualiza su cuenta de `write_files` de 5 a 6 (3 rechazadas + 3 bien formadas: ruta, registro y App).

Ningún otro test se ha tocado. La demás evidencia (recibos, huellas por ámbito, puerta de despliegue, guarda de esquema) queda intacta: el diff se limita a `implementationEvidence.ts`, tres ficheros de test y esta documentación.

## Suites (antes → después)

| Suite | Antes | Después |
|---|---|---|
| Worker | 500 ✓ / 18 skipped | **507 ✓ / 18 skipped** (33 ficheros) |
| Server | 121 ✓ | 121 ✓ (sin cambios de código) |
| Studio | 22 ✓ | 22 ✓ (sin cambios de código) |
| Typecheck worker | limpio | limpio |

Nota de medición: la primera corrida «antes» del worker salió contaminada por ediciones concurrentes sobre la misma suite (499 ✓ + 1 fallo cruzado test-viejo/código-nuevo en el propio fichero de la puerta); descontado ese artefacto, la base es la nominal 500 ✓ / 18 skipped, y la suite final de la rama es 507 ✓ / 18 skipped con 0 fallos.

## Alcance y límites

- Esto corrige la **evidencia a futuro**: un run ya no puede cerrar ni desplegar la plantilla sin conectar. No reescribe el proyecto «T-shirts» ni su despliegue live (`0a41315f`): rehacerlo es un run nuevo, que ahora sí tendrá que cablear la tienda desde el punto de entrada para poder cerrar.
- Si App.tsx difiere, la puerta no exige que App importe los componentes concretos (la app que arranca ES App): el criterio es divergencia del punto de entrada, no análisis del grafo de render completo.
