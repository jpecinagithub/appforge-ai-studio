# Transitorios del proveedor LLM: reintentables dentro de la llamada (21-oct-2026, rama `fix/llm-transitorios-reintentables`)

## El fallo real

Run `8a141027` («T-shirts», 2026-10-21): a los ≈5 minutos y 10 llamadas al modelo, el run terminó en `error` con «Fallo la llamada al modelo: LLM returned no choices». OpenRouter (qwen/qwen3-coder) devolvió **una sola vez** una respuesta sin `choices` y el run murió entero, perdiendo el trabajo en curso.

## Causa raíz

La resiliencia existía, pero solo a nivel HTTP y a medias: `chatLlm` reintentaba 429/5xx y timeouts de curl (máx. 3 intentos, backoff con Retry-After), pero el `LLM_EMPTY` de `parseResponse` se lanzaba *después* de esa clasificación y caía en la rama «cualquier otro error: fail fast». En `agent.ts`, `LLM_EMPTY` tampoco estaba en las listas de códigos con recuperación del bucle (timeout/rate-limit/server-error/request-failed), así que llegaba a `failRun` tal cual. Un transitorio del proveedor — que bajo la doctrina del bucle flexible no es un hecho, porque no dice nada sobre el trabajo — mataba como si lo fuera.

## La corrección (`apps/worker/src/llm.ts` + un gancho en `agent.ts`)

**Clasificación única** (`TRANSIENT_LLM_CODES` + `isTransientLlmError`), aplicada por un único driver, `callWithTransientRetries`, que ahora gobierna toda llamada de `chatLlm` (la lógica de reintento que vivía duplicada en las ramas 429/5xx y timeout queda unificada en él):

| Clase | Códigos | Tratamiento |
|---|---|---|
| Transitoria | `LLM_RATE_LIMIT` (429), `LLM_SERVER_ERROR` (5xx), `LLM_TIMEOUT` (stall del proveedor), `LLM_REQUEST_FAILED` (transporte sin respuesta parseable / cuerpo 200 no-JSON), `LLM_EMPTY` (200 sin nada usable) | Reintento acotado dentro de la llamada |
| No transitoria | `LLM_HTTP_ERROR` (401/402/403/404: auth, cuota/saldo, modelo inexistente), `LLM_TRUNCATED`, `LLM_BAD_TOOL_ARGS`, `RUN_TIMEOUT` | Fallo a la primera, error intacto |

`LLM_EMPTY` cubre los dos vacíos del proveedor sin error reportado: (a) respuesta sin `choices` o con `choices` vacío (la lanza `parseResponse`, sin cambios); (b) respuesta con choice pero **sin contenido utilizable** — ni texto ni tool calls — detectada por el nuevo predicado `isUnusableEmptyResponse` tras parsear. La distinción importa: una respuesta *con* tool calls de argumentos rotos no es un vacío, es el camino de llamadas malformadas (`findMalformedToolCalls` + reintentos de compleción del bucle), que queda intacto, igual que la escalera de intervención y el resto de caminos de `agent.ts`.

Detalles de implementación:

- **Backoff**: el esquema que el código ya usaba — exponencial 1 s/2 s, tope 15 s, honrando `Retry-After` (tope 30 s) cuando el fallo HTTP lo trae (el error lleva ahora el header en `LlmError.retryAfter`) — en vez de inventar otro. Máximo **3 intentos totales** (el `MAX_ATTEMPTS` preexistente), compartidos entre clases: una secuencia mixta (timeout → 502 → vacío) consume el mismo presupuesto.
- **Registro y watchdog**: antes de cada espera, el driver invoca `cfg.onRetry({attempt, maxAttempts, code, message, backoffMs})`. `agent.ts` lo conecta en `requestCompletion`: refresca `lastProgressAt` — un proveedor reintentando es actividad, no un run colgado — y emite el evento `log` del run («llm transient failure (LLM_EMPTY): LLM returned no choices — retrying, attempt 2/3 after 1000ms backoff»), visible en el resumen y para la vigilancia. El deadline absoluto compartido por los intentos de una misma llamada no cambia: sigue siendo un hecho que acota la llamada.
- **Agotamiento**: el driver lanza el error real del proveedor con el conteo en el mensaje — «LLM returned no choices (attempt 3/3 — transient retries exhausted)» — nunca el error crudo a secas. Como `LLM_EMPTY` no entra en las listas de recuperación del bucle, el run muere con ese mensaje completo («Fallo la llamada al modelo: …»). (`LLM_REQUEST_FAILED` conserva además, como antes, la recuperación a nivel de bucle tras agotar los reintentos internos: capas que se componen, no que se pisan.)
- **Excepciones que no son `LlmError`**: no las expuso el cliente como fallo del proveedor; conservan el contrato histórico (envoltura en `LLM_REQUEST_FAILED` y fail fast), sin adivinar que son transitorias.

## Tests (18 nuevos en `llm.test.ts`, 37 en el fichero)

- Clasificación: `parseResponse` sin `choices` (o `[]`) = `LLM_EMPTY` con su mensaje; la clase transitoria frente a la no transitoria código a código; excepciones ajenas no clasifican; el predicado de vacío distingue «sin contenido ni calls» de «con calls» y de «con texto».
- Driver con intentos guionizados y `sleep` inyectado (sin esperas reales): (i) dos «sin choices» y éxito a la tercera → la llamada continúa, con los dos reintentos registrados (intento, código, mensaje) y sus backoffs (1 s/2 s); secuencia mixta timeout→5xx absorbida igual; `Retry-After: 7` honrado (7000 ms) sobre el exponencial. (ii) Transitorio persistente → error final tras exactamente 3 intentos con «attempt 3/3» en el mensaje y 2 avisos de reintento. (iii) 401 y 402 simulados (`LLM_HTTP_ERROR`) → cero reintentos, un solo intento y el error propagado intacto (misma instancia).

## Suites

- Antes: worker **515 ✓ / 18 skipped**, server **121 ✓**, studio **22 ✓** (recontados sobre master `891956e`).
- Después: worker **533 ✓ / 18 skipped** (515 + 18 nuevos), typecheck del worker limpio; server y studio sin cambios de código.

Sin fusionar ni desplegar.
