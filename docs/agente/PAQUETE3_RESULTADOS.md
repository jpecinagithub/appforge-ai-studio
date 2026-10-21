# Paquete 3 (ajustes + spinner) — resultados

**Fecha:** 2026-10-21 · **Rama:** `fix/paquete3-ajustes-spinner` (desde `master` 99905fd) · Sin fusionar ni desplegar.

Dos arreglos pequeños e independientes, cada uno con su causa raíz
verificada en el código y su test de regresión.

## Arreglo A — PATCH /api/settings descartaba `maxHardIterations` y `maxRepairAttempts`

**Causa raíz (una frase):** el handler de `PATCH /api/settings`
(`apps/server/src/index.ts`) copia los campos del body a la fila
persistida recorriendo una lista fija de claves, y esa lista omitía
`maxHardIterations` y `maxRepairAttempts` — aunque el Zod `SettingsPatch`
los acepta y `toPublicSettings` los expone.

**Síntoma:** el PATCH respondía 200 con los valores por defecto (60/12) y
los valores nuevos se perdían en silencio; la UI de ajustes parecía
guardar unos límites de bucle que el worker nunca recibía por esa vía.

**Fix:** añadir ambas claves a la lista de copia del handler. Nada más
cambia: validación, defaults y salida pública ya eran correctos.

**Tests:** nuevo `apps/server/src/settingsHttp.test.ts` (patrón HTTP de
`server.test.ts`, `buildServer` + `inject`):

- GET inicial expone los defaults 60/12.
- PATCH `{maxHardIterations: 123, maxRepairAttempts: 7}` → la respuesta y
  un GET posterior reflejan ambos valores (persistencia real, no solo eco).
- PATCH de otro campo (`temperature`) no altera los límites guardados.

Control negativo: sin el fix, 2 de los 3 tests fallan; con el fix, pasan.

## Arreglo B — el Studio se quedaba con el spinner «Corrigiendo los errores detectados…»

Visto en producción: un run terminó en error, la cabecera pasó a «Agente
inactivo», pero la barra de estado del chat se quedó en 'running' para
siempre. Había **dos** defectos reales, uno en cada capa, más una red de
seguridad ausente.

### B1 — `finalizeRun` aplicaba el estado del run solo tras refrescar también el proyecto

**Causa raíz:** `finalizeRun` (`apps/studio/src/pages/ProjectView.tsx`)
hacía `await api.getRun(runId)` y `await api.getProject(id)` dentro de un
único `try`, y solo después aplicaba ambos estados — si `getProject`
fallaba o tardaba, `setActiveRun(final)` nunca se ejecutaba aunque el run
ya se conocía terminal, mientras que `setRunStatus(id, null)` sí corría
tras el `catch` (de ahí la cabecera correcta con el spinner colgado).

**Fix:** el estado del run se aplica en cuanto llega (`setActiveRun` justo
tras `getRun`, con su propio `try`) y el proyecto se refresca en un `try`
independiente posterior. El resto de efectos (recarga de mensajes,
`buildsKey`/`previewKey`, `setRunStatus`) no cambia.

### B2 — el parser SSE perdía el evento terminal si el stream cerraba sin el `\n\n` final

**Causa raíz:** `runStream` (`apps/studio/src/api/sse.ts`) solo despachaba
un evento al encontrar el bloque terminado en `\n\n`; si el servidor
cerraba el stream justo tras el evento terminal y el último bloque quedaba
en el buffer sin el doble salto final, el bucle terminaba por `done` y ese
evento (`done`/`error`) nunca se despachaba — sin evento terminal no hay
finalize, y el spinner quedaba vivo.

**Fix:** el parseo de bloque se factoriza a dos funciones puras
exportadas, `parseSseBlock` y `sseBlockToEvent`, y al salir del bucle de
lectura se hace flush del buffer restante: si queda un bloque con
contenido, se despacha antes de llamar a `onClose`.

### B3 — red de seguridad: `onClose` también finaliza, de forma idempotente

**Causa raíz (ausencia):** el handler `onClose` de la suscripción era un
noop que confiaba en que `done`/`error` siempre llegaban; cualquier cierre
sin evento terminal (caída del stream, cierre del servidor) dejaba el run
sin finalizar en la UI.

**Fix:** `onClose` llama ahora a `finalizeOnce(runId)`, compartido con
`onEvent` y `onError`, con dos guardas:

- `finalizedRunRef`: como mucho una finalización por run; el camino normal
  no duplica recargas.
- `subscribedRunRef`: `onClose` solo actúa si su suscripción sigue siendo
  la vigente — un `onClose` tardío de una suscripción abortada (p. ej. al
  lanzar un run nuevo) no pisa el estado del run en curso.

**Tests:** nuevo `apps/studio/src/api/sse.test.ts` (7 tests):

- Unidad del parser puro: extracción de `id`/`event`/`data`, líneas `:`
  ignoradas, `kind` por defecto `message`, datos multi-línea y no-JSON.
- Flush extremo a extremo vía `subscribeRunEvents` con `fetch` simulado:
  bloque terminal sin `\n\n` final se despacha; bloque terminal partido
  entre dos chunks al cierre se despacha; un `:ping` residual no inventa
  eventos. Control negativo: con el flush desactivado, los dos tests de
  flush fallan.

Los cambios de `ProjectView.tsx` (B1/B3) no tienen test de componente: la
suite del Studio solo cubre módulos puros y de API (`client`, `demo`,
ahora `sse`), sin infraestructura de render de componentes; no se ha
inventado una para este paquete.

## Verificación

| Suite | Baseline | Resultado |
|---|---|---|
| Server (`apps/server`) | 110 | **113 ✓** (+3 de `settingsHttp.test.ts`) |
| Studio (`apps/studio`) | 9 | **16 ✓** (+7 de `sse.test.ts`) |
| Worker (`apps/worker`) | 456 | **456 ✓** (sin tocar; 18 skipped, igual que el baseline) |
| Studio build (`tsc -b && vite build`) | — | ✓ |
| Server typecheck (`tsc --noEmit`) | — | ✓ |
