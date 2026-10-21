# Llamadas vacías (malformed tool calls) — resultados

**Fecha:** 2026-10-21 · **Rama:** `fix/agente-llamadas-vacias` (desde `master` 56fe237) · Sin fusionar ni desplegar.

## El caso que lo motiva

Run de producción `3723178d` (proyecto `5ec62ac6`, «PcBox online»): el
modelo (qwen3-coder vía OpenRouter) emitió `read_file` con los argumentos
vacíos **5 veces** y `write_file` **1 vez**. Cada llamada fue rechazada con
«missing required argument: path» y el run murió sin ejecutar nada útil
(362 tokens de salida en 10 llamadas LLM).

Causa estructural: `parseResponse` (`apps/worker/src/llm.ts`) convertía en
silencio un `function.arguments` ausente/vacío en `{}`
(`tc.function?.arguments ? JSON.parse(...) : {}`), sin distinguir «el
proveedor no envió argumentos» de «la herramienta no los requiere». Y el
bucle ni reintentaba la completion ni cortaba rápido: cada rechazo era un
turno quemado.

## Diseño (tres piezas)

### 1. Marcado en el parseo (`llm.ts` + `packages/shared`)

`LlmToolCall` gana dos campos opcionales:

- `rawArguments?: string` — la cadena `function.arguments` tal cual llegó
  (undefined si el proveedor omitió el campo).
- `malformed?: 'empty-arguments'` — presente cuando la cadena cruda es
  undefined, `null`, vacía o solo espacios.

El parseo sigue produciendo `arguments: {}` en ese caso (ningún otro camino
se rompe) y el error `LLM_BAD_TOOL_ARGS` para JSON inválido no cambia. Un
`"{}"` explícito **no** es malformed a este nivel: hay herramientas
legítimas sin argumentos (p. ej. `get_dynamic_status`); resolverlo es
trabajo de la pieza 2. Nota: unos argumentos de solo espacios antes
explotaban como JSON inválido; ahora quedan marcados como payload vacío,
que es lo que son.

### 2. Detección + reintento en el bucle (`agent.ts` + `findMalformedToolCalls` en `llm.ts`)

`findMalformedToolCalls(toolCalls, defs)` es pura y testeable. Una llamada
es malformada si:

- **(a)** trae `malformed: 'empty-arguments'` y su definición exige ≥1
  parámetro `required` — todos los requeridos faltan por definición. Si la
  herramienta no requiere nada, la llamada es válida con `{}`: no hay nada
  que re-pedir y reintentar solo quemaría completions.
- **(b)** le falta alguno de los `parameters.required` de su definición en
  `TOOL_DEFS`/`DYNAMIC_TOOL_DEFS`: ausente, `null` o cadena vacía. Esto
  atrapa emisiones con clave equivocada (`read_file {file: 'x'}`), que
  parsean bien y no llevan marca.

La llamada al modelo pasa a ser `requestCompletion()` (envuelve tanto
`chatLlm` como la vía `StubLlm`). Si la respuesta trae ≥1 llamada
malformada:

- **No se ejecuta ninguna** llamada de esa respuesta.
- Se reintenta la completion hasta **2 veces más** (1 + 2 = 3 completions
  por iteración como máximo), añadiendo al historial un mensaje de usuario
  **temporal** que nombra herramientas y parámetros ausentes: «Your
  previous reply contained tool call(s) with missing or empty arguments:
  read_file (missing: path). Re-emit each call with its complete required
  arguments.»
- Cada reintento emite un evento de run tipo `log`: «llm malformed tool
  call(s): read_file — retrying completion (1/2)».
- Los reintentos cuentan como llamadas LLM (uso y tiempo: la respuesta
  descartada suma `llmCalls`/tokens al descartarse; la que sobrevive la
  cuenta el bucle como siempre), pero **no** como iteraciones ni como
  errores de herramienta.
- Si el último reintento sigue malformado, se lanza
  `LlmError('LLM_BAD_TOOL_ARGS', …)` con la bandera `fatal` (campo nuevo
  de `LlmError`): el bucle lo captura antes que la rama de recuperación
  por `LLM_BAD_TOOL_ARGS` clásica y termina el run con ese código vía
  `finishError`. Sin la bandera, el error habría entrado en la
  recuperación de historial compactado y el run habría agonizado 4
  iteraciones × 3 completions en vez de cerrar en 3.

**Por qué la respuesta malformada no entra en el historial canónico:** un
mensaje `assistant` con `tool_calls` sin sus correspondientes mensajes
`tool` de resultado invalida la siguiente petición al proveedor (la API
exige que cada tool call tenga su resultado). Tampoco entra el aviso
temporal: es una corrección local de esta iteración, no parte de la
conversación; la respuesta buena que lo sustituye sí entra, como siempre.

### 3. Corte rápido (`agent.ts`: `updateArgumentStreak`)

Red de seguridad para las formas que la pieza 2 no puede ver: la detección
solo juzga los `required` de nivel superior, pero las herramientas
validan también formas anidadas (los ítems de `write_files` exigen
`path`+`content` cada uno) y esos rechazos llegan como resultados con el
mismo prefijo «missing required argument». `updateArgumentStreak` (pura)
cuenta resultados consecutivos con ese prefijo **para la misma
herramienta**; cualquier otro resultado (éxito, otro error, otra
herramienta) reinicia el contador. Al llegar a **3** consecutivos, el
bucle aborta con `failRun(..., 'TOOL_ARGUMENT_STAGNATION', ...)` tras
registrar el resultado en el historial. Es una guarda barata y queda
igualmente aunque tras la pieza 2 las rutas reales que la alimentan sean
solo las validaciones internas de las herramientas.

## Tests

19 tests nuevos:

- `llm.test.ts` (+13): marcado en el parseo (ausente, `''`, solo espacios,
  JSON real, `"{}"` explícito) y unidad de `findMalformedToolCalls`
  (`read_file {}` → missing path; marcada por el parser → missing path;
  `get_dynamic_status {}` válida, también marcada; `write_file {path}` →
  missing content; `read_file {file}` → missing path; cadena vacía cuenta
  como ausente; llamadas completas válidas).
- `malformedCalls.test.ts` (6, bucle con LLM scripted, fixture dinámica de
  `dynamicGate.test.ts`):
  - **(a)** `read_file` con argumentos crudos vacíos → el bucle reintenta
    (la segunda petición lleva el aviso temporal nombrando
    `read_file`/`path`), la llamada malformada **nunca se ejecuta**
    (1 solo evento `tool_call` de `read_file`, el válido), evento `log`
    de reintento emitido, y el run llega a `done`.
  - **(b)** argumentos vacíos persistentes → el run termina en `error`
    con código `LLM_BAD_TOOL_ARGS` (evento `error`) tras exactamente
    **1 + 2 completions** (`stats.llmCalls = 3`) y **cero** ejecuciones
    de herramienta.
  - **(c)** `read_file {file: 'x'}` → mismo camino de reintento por
    `required` (aviso «read_file (missing: path)»), run a `done`.
  - **(d)** `write_files` con el ítem sin `content` ×3 → aborto con
    `TOOL_ARGUMENT_STAGNATION` tras 3 completions y 3 ejecuciones
    rechazadas; más la unidad pura de `updateArgumentStreak` (cuenta,
    cambio de herramienta y reseteos).

## Resultados

- Worker: **456 ✓ / 0 ✗** (baseline 437 + 19 nuevos), server: **110 ✓ / 0 ✗**.
- Typecheck del worker (`npx tsc --noEmit -p tsconfig.json` dentro de
  `apps/worker`): limpio.

## Límites honestos

- La detección juzga solo `parameters.required` de nivel superior. Las
  formas anidadas inválidas (`write_files` con `files: []`, ítems con
  tipos erróneos, `run_command` con `args` no-string, etc.) siguen
  dependiendo de la validación de cada herramienta; la pieza 3 cubre
  únicamente las que rechazan con el prefijo «missing required argument»
  para la misma herramienta.
- Un parámetro `required` presente pero con el tipo equivocado (p. ej.
  `path: 42`) no es «malformado» para esta capa: lo rechaza la
  herramienta («argument path must be a string») y no alimenta el corte
  rápido. Es deliberado: re-pedir la completion no arregla errores de
  tipo mejor que el propio mensaje de la herramienta.
- La regla «cadena vacía = ausente» también alcanza a `patch_file` con
  `replace: ''` (borrado de texto legítimo): la especificación manda
  tratar la cadena vacía como parámetro ausente, así que esa emisión se
  reintentaría y, si el modelo insiste, el run cerraría con
  `LLM_BAD_TOOL_ARGS`. Es el precio aceptado de la regla uniforme; el
  aviso del reintento da al modelo la oportunidad de reformular.
- El reintento re-pide la completion **entera**: si una respuesta traía
  una llamada malformada y otra válida, la válida tampoco se ejecuta y
  debe re-emitirse. Es el comportamiento seguro (ejecutar la mitad
  dejaría el historial partido) y el aviso pide re-emitir «each call».
- Nada de esto protege contra un proveedor que directamente **no
  responde** o responde sin `choices`: esos caminos (`LLM_EMPTY`,
  timeouts, 429/5xx) ya tenían su tratamiento y no cambian.

## Despliegue (21-oct-2026)

Fusionada en `master` (fast-forward a `4f7e927`) y redesplegada en la instancia edu con el procedimiento seguro (sin runs activos, mod local del compose conservada). Verificado dentro del contenedor healthy: `findMalformedToolCalls` en llm.ts y agent.ts, `TOOL_ARGUMENT_STAGNATION` en agent.ts, marca `empty-arguments` en el parseo; health local y público 200.
