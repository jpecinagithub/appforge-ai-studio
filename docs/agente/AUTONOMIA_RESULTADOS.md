# Autonomía del agente — RESULTADOS

**Fecha:** 2026-10-21 · **Rama:** `fix/agente-autonomia` (desde `master d33033c`) · **Encargo:** corregir el backend de AppForge para que el agente resuelva por sí mismo la clase de fallo del run `a9864671`, sin prompt humano de continuación.

## El fallo (verificado en producción)

Run `a9864671` («PcBox online», 2026-10-21): el agente escribió products/cart/orders contra contratos de la plantilla que desconocía y descubrió los desajustes tarde y caro:

1. `sendError(reply, 'INSUFFICIENT_STOCK', …)`: el código no existe en la unión cerrada `ErrorCode` de `backend/src/lib/errors.ts` — que **no** estaba entre los ficheros de contrato del contexto inicial.
2. `db.transaction(...)`: API de better-sqlite3; el backend usa `DatabaseSync` de node:sqlite, que no la tiene.
3. Tipos de fila (`OrderWithItems`) aplicados a consultas que devuelven filas planas.

El typecheck inmediato de la Fase 1 no pudo avisar: necesita los `node_modules` del backend, que no existen hasta el primer `run_backend_build`. El agente gastó su presupuesto de reparación en *descubrir* los contratos (leyó `lib/errors.ts` en la llamada 11 de 12) y nunca llegó al frontend.

## Qué se ha construido (todo en el backend)

1. **Contratos completos en el contexto inicial** (`agent.ts`): la lista «DYNAMIC TEMPLATE CONTRACTS» incluye ahora `backend/src/lib/errors.ts` y `backend/src/routes/todos.ts` (la ruta canónica de ejemplo), además de los que ya estaban.
2. **Hechos duros de API en la sección dinámica del prompt del sistema** (`agent.ts`): implementar antes de verificar (las comprobaciones pasan sobre la plantilla intacta; ejecutarlas primero no prueba nada) y `run_backend_build` justo tras escribir el backend; en node:sqlite no existe `.transaction()` (patrón `BEGIN IMMEDIATE`/`COMMIT`/`ROLLBACK` o el helper `withTransaction`); la unión `ErrorCode` es cerrada y se extiende en un único fichero; registrar rutas siguiendo el patrón `register*Routes` de `server.ts`.
3. **Lint de contratos al escribir** (`apps/worker/src/backendContracts.ts`, nuevo): escaneo mecánico sin dependencias, conectado a `write_file`/`write_files`/`patch_file` junto a la nota de typecheck (`withBackendNotes` en `tools.ts`). Detecta en el mismo turno de la escritura: códigos `sendError` fuera de la unión del proyecto (nombrando el conjunto válido y el fichero a extender) y usos de `.transaction(` (con el patrón correcto). Nunca bloquea la escritura: anota el resultado, como la nota de typecheck a la que complementa (y a diferencia de ella, funciona antes de instalar dependencias).
4. **Inyección de contratos al fallar `run_backend_build`** (`agent.ts`, en `perform`): si el build del backend falla, el resultado que recibe el modelo incorpora los extractos de `lib/errors.ts` y `db/index.ts` del proyecto, para reparar contra las APIs reales en el turno siguiente en vez de ir a buscarlas.
5. **Diagnóstico «implement-first» en `verify()`** (`agent.ts`): cuando el hueco es de implementación (`NO_IMPLEMENTATION`), la instrucción ya no es «ejecuta las herramientas que faltan en este orden» (que enseña a girar sobre la verificación) sino «IMPLEMENT FIRST: escribe las rutas y el frontend ahora; no re-ejecutes las comprobaciones hasta que la implementación exista».
6. **Helper en la plantilla** (`templates/dynamic-react-node/backend/src/db/index.ts`): nuevo `withTransaction(db, fn)` con el patrón explícito, para que los proyectos nuevos nazcan con la pieza que el agente fue a inventarse. Los proyectos existentes no lo tienen; los hechos del punto 2 cubren el patrón manual.

### Lo que NO se ha tocado

El desajuste de tipos de fila (punto 3 del fallo) no tiene lint mecánico barato: lo cubren el typecheck inmediato (tras el primer build) y la inyección de contratos del punto 4. Los límites del bucle (firma ×3, reparación 12, tope duro 60) no cambian: con los contratos conocidos desde el principio, el presupuesto alcanza para reparar en vez de descubrir.

## Tests (9 nuevos)

- `backendContracts.test.ts` (8): extracción de la unión; código inventado detectado con el conjunto válido; códigos válidos aceptados; unión extendida por el propio proyecto respetada; `.transaction(` detectado con el patrón; ambas violaciones juntas; sin `lib/errors.ts` la comprobación de códigos se salta y la de transacciones sigue activa.
- `dynamicGate.test.ts` (+1 de bucle): el modelo escribe una ruta con `INSUFFICIENT_STOCK` y `db.transaction(...)` y el resultado de esa misma `write_files` contiene ya la nota «Backend contract check» con el código y el patrón `BEGIN IMMEDIATE`; el run completa después con normalidad.

## Verificación

- Worker: **424 ✓ / 0 ✗** (master: 415; +9 nuevos), 18 skipped preexistentes. Server: **110 ✓ / 0 ✗**. Typechecks de worker y server limpios.
- La plantilla compila con su propio build (`npm ci && npm run build` en copia limpia) y `withTransaction` aparece en el `dist` generado.
- Sin fusionar ni desplegar: pendiente de la decisión del usuario, como las fases anteriores.
