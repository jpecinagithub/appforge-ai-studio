# Flexibilidad agéntica: muertes solo por hechos, escalera de intervención y degradación declarada

**Fecha:** 2026-10-21 · **Rama:** `feat/flexibilidad-agentica` (desde `master` 034c80d) · Sin fusionar ni desplegar.

Implantación de la propuesta aprobada `PROPUESTA_FLEXIBILIDAD_AGENTICA_2026-10-21.md`
(las tres decisiones de su §9 en la variante recomendada: escalera de
intervención, `maxRunTokens` por defecto 3 M configurable, `done` único con
degradaciones declaradas). El principio rector: **determinismo en la
evidencia, agencia en la conducta** — la semántica de recibos, huellas,
prefijo canónico, puertas de despliegue e implementación, migraciones
inmutables y guarda de esquema no cambia (§5); lo que cambia es cómo el
bucle reacciona a los atascos.

Commits (atómicos por pieza, todos en la rama):

| Commit | Pieza |
| --- | --- |
| `fd052ff` | §4.1 — techo de tokens `maxRunTokens` |
| `e7400bc` | §4.2 — escalera de intervención |
| `2866971` | §4.3 — `ToolResult` con alternativas + `acquire_image` con presupuesto y fallback |
| `7aa8288` | §4.3/§4.4 — libro de degradaciones, resumen determinista y prompt |
| este documento | documentación |

## §4.1 — Muertes solo por hechos + techo de tokens

- Ajuste nuevo `maxRunTokens` en toda la cadena: `Settings` (shared),
  `StoredSettings`/`defaultSettings()` = **3 000 000** y `toPublicSettings`
  (servidor), validación PATCH zod `int, min 0, max 20 000 000`
  (**0 = sin techo**), lista de campos copiables del PATCH, y
  `AgentSettings`/`DEFAULT_LIMITS.maxRunTokens = 3 000 000` (worker).
  En los límites del bucle se resuelve con `??`, nunca con `||`: el 0 es
  significativo.
- El bucle lo comprueba al inicio de cada iteración, junto al watchdog
  (`runTokensUsed >= maxRunTokens`): `failRun(..., 'TOKEN_BUDGET_EXHAUSTED',
  restore=true)` con el mensaje nuevo `tokenBudget` (ES/EN) que nombra el
  gasto y el techo. La contabilidad de tokens ya existía (`usage` de cada
  completion); no se toca.
- Los hechos que matan quedan: éxito verificado, cancelación, watchdog
  `runTimeoutMs`, techo `maxHardIterations` y el nuevo techo de tokens.

## §4.2 — Escalera de intervención (una señal unificada)

Los cuatro contadores y las malformadas fatales dejan de matar y alimentan
`recordStuckSignal(kind, detail)` con kinds `repeated-signature`,
`repair-budget`, `stagnation`, `argument-stagnation`, `malformed-calls`.
Al disparar, el contador que disparó se resetea; la primera señal pendiente
gana si varias coinciden.

`processStuckSignal()` (sustituye a `checkRepairAbort`, eliminado):

- **Progreso manda**: compara `verificationProgressKey()` con la clave de
  la última señal; si se movió, la escalera vuelve a 0 y la señal queda
  como aviso (directiva simple). Sin clave comparable (proyectos
  estáticos, antes del primer `verify()`), no hay reset por progreso.
- **Escalón 1**: directiva persistente en la historia — nombra el atasco
  con datos, prohíbe repetir la operación sin cambio material y sugiere
  vías (reescribir entero en vez de parchear, saltar y volver, degradar
  lo no esencial, consultar `get_dynamic_status`). Evento de estado
  `{phase:'stuck_signal', level, kind}`.
- **Escalón 2**: directiva reforzada + `history = compactRecoveryHistory(...)`
  en la siguiente completion (se reutiliza la compactación de recuperación
  existente, sin tocarla).
- **Escalón 3**: `failRun(..., 'LOOP_EXHAUSTED', restore=true)`; el mensaje
  (`loopExhausted`, ES/EN) enumera las intervenciones con su kind y su
  diagnóstico: el humano ve QUÉ se atasca, no un contador.

Puntos de proceso: tras el bucle de tool calls (racha de argumentos), tras
cada `verify()` (firma, presupuesto, estancamiento del bucle de
reparación), en el `catch` de `LlmError` fatal (malformadas: registra,
procesa y **continúa** el bucle en vez de re-lanzar) y en la vía
`malformedResponses >= 4` (registra, resetea el contador a 0, conserva la
compactación de un fichero y procesa). El antiguo texto «Run only the
missing tools, in this exact order» de `verify()` pasa a recomendación
(«Recommended next step… not a cage»), y el diagnóstico de error repetido
ya no promete un aborto que no ocurre. Invariante intacto: ninguna llamada
malformada se ejecuta ni entra en la historia canónica.

Decisión de implementación: el `failRun('REPAIR_LIMIT')` tras el bucle
principal queda como código defensivo inalcanzable (anotado en el código):
la única salida sin progreso del bucle es ahora `LOOP_EXHAUSTED` por la
escalera, y el techo duro sigue cortando con su propio mensaje.

## §4.3 — Herramientas que proponen alternativas / degradan

- `ToolResult` (shared) gana `retryable?: boolean` y
  `alternatives?: string[]`, opcionales: la serialización no cambia y el
  bucle ya los presenta al modelo en el mensaje de resultado (bloque
  `ALTERNATIVES:` existente).
- `acquire_image`:
  - **Presupuesto TOTAL por llamada de 90 000 ms** (`IMAGE_CALL_BUDGET_MS`,
    override por entorno `APPFORGE_IMAGE_CALL_BUDGET_MS` para tests).
    Cada fetch se acota por `min(cmdTimeoutMs, 30 s, presupuesto
    restante)` y el bucle de candidatos se detiene al agotarlo. Antes el
    peor caso encadenaba ≈12 minutos en silencio — la clase de muerte
    real del run `b4427a59` de «T-shirts».
  - Los fallos de adquisición (`IMAGE_TIMEOUT`, `IMAGE_DOWNLOAD_FAILED`,
    `IMAGE_NOT_FOUND`, `IMAGE_SEARCH_FAILED`) devuelven `retryable: true`
    y `alternatives` (query más específica / `fallback: "placeholder"` /
    seguir sin esta imagen). Los fallos de validación (query, path,
    `ASSET_EXISTS`) quedan como estaban: no son degradables.
  - Nuevo parámetro opcional `fallback: 'placeholder'`: si la adquisición
    fracasa, escribe —solo si no existe— el asset de plataforma
    `public/placeholder-illustrative.svg` (SVG sobrio, texto «Imagen
    ilustrativa») y devuelve `ok: true` con
    `data.degraded = 'illustrative-placeholder'`, la query, el path pedido
    y el código del fallo.
- **Libro de degradaciones del run**: `perform()` registra cada
  degradación (hoy: placeholders, con su query) en el contexto del run.
  `complete()` añade al resumen final, de forma **determinista** (no
  depende de que el modelo lo escriba), la sección
  «Degradaciones declaradas» / «Declared degradations» con conteos
  agrupados y hasta 5 detalles: p. ej.
  `- imágenes ilustrativas (placeholder de plataforma): 1 — "red sports car"`.
  El estado sigue siendo `done` a secas, sin banderas.

## §4.4 — Prompt: orden recomendado y régimen nuevo

- La sección dinámica: «MANDATORY ORDER» → «RECOMMENDED ORDER», con la
  razón honesta (los recibos solo se conservan como prefijo canónico:
  seguir el orden evita repetir; desviarse para aprender es legítimo).
- Regla 13: si la adquisición falla, se llama de nuevo con
  `fallback: "placeholder"` (la plataforma declara la degradación);
  nunca inventar URLs de fotos.
- Regla 15 nueva: las señales de atasco obligan a cambiar de estrategia,
  tres sin progreso cierran el run, y degradar con declaración es
  legítimo — nunca presentar un placeholder o un dato simulado como real.

## Tests — antes / después

Baselines medidas el 2026-10-21 antes de tocar código (los 465/113/16 de
la propuesta eran orientativos): **worker 467 ✓ / 18 skipped, server
116 ✓, studio 22 ✓**.

Final: **worker 475 ✓ / 18 skipped / 0 ✗ · server 121 ✓ / 0 ✗ · studio
22 ✓ + build · typechecks de worker y server limpios** (el de studio va
dentro de su `build`, `tsc -b`).

Cambios de semántica en tests existentes (ningún test de evidencia §5 se
tocó):

- `dynamicGate.test.ts` (16): firma ×3 ya no mata — el run recibe la
  directiva «STUCK SIGNAL — intervention 1 of 3» y cierra por el techo
  duro (la escalera se resetea porque la huella de fuentes se mueve entre
  reparaciones); el antiguo «herramienta desaparecida» (presupuesto) se
  reescribe: sin progreso, niveles `[1, 2, 3]` en los eventos y muerte
  `LOOP_EXHAUSTED`; la persistencia de malformadas ahora sube la escalera
  (12 completions con scripting cíclico) y el texto esperado de
  `verify()` es la recomendación nueva.
- `malformedCalls.test.ts` (6): (b) la vía fatal ya no cierra en 3
  completions — tres rondas fatales sin progreso agotan la escalera
  (`LOOP_EXHAUSTED`, 9 completions); (d) la racha de argumentos registra
  UNA señal de nivel 1 y el run ya no muere: llega a `done`.
- `agentSafetyNet.test.ts` (6): se añaden dos restauraciones nuevas — al
  tercer escalón (`LOOP_EXHAUSTED`) y al techo de tokens
  (`TOKEN_BUDGET_EXHAUSTED`) el proyecto vuelve al último estado bueno
  verificado, como ya ocurría con `REPAIR_LIMIT`.
- `settings.test.ts` + `settingsHttp.test.ts` (server): defaults con
  `maxRunTokens: 3_000_000`, PATCH roundtrip (2 500 000 persiste, 0 se
  acepta como «sin techo»), negativos y >20 M rechazados con 400, y la
  clave desconocida se sigue ignorando. (El roundtrip HTTP vive en
  `settingsHttp.test.ts`, no en `settings.test.ts`: desviación menor
  respecto al encargo, misma cobertura.)

Tests nuevos:

- `flexibilidad.test.ts` (worker, nuevo): (1) el escalón 2 compacta —
  tras la 2ª señal la siguiente completion recibe `[sistema, RECOVERY
  MODE, directiva reforzada]` y la 1ª no llevaba `RECOVERY MODE`;
  (2) degradación punta a punta — con Openverse caído (503) el agente
  degrada con `fallback: 'placeholder'`, el run cierra `done` y el
  resumen del asistente lleva la sección determinista con el conteo y la
  query, aunque el texto del modelo no la menciona. El progreso que
  resetea la escalera lo cubre el test de firma ×3 de `dynamicGate`
  (directiva y continuación).
- `tools.test.ts` (+4): presupuesto agotado → `IMAGE_TIMEOUT` +
  `retryable` + 3 alternativas en ~300 ms (antes: cadena de minutos);
  sin fallback, búsqueda vacía → `IMAGE_NOT_FOUND` con alternativas y
  sin asset; con fallback, el asset se escribe una vez y se reutiliza
  sin `ASSET_EXISTS`; el fallback también cubre el fallo HTTP de
  búsqueda.

## Desviaciones y notas

- La tercera señal del test de restauración `LOOP_EXHAUSTED` llega por
  `stagnation` (el contador de reparaciones sin movimiento de clave tras
  la 3ª verificación), no por una tercera `repeated-signature`: la
  escalera es unificada y cualquier detector puede aportar el escalón
  siguiente; el test verifica el comportamiento (3 intervenciones
  enumeradas + restauración), no qué detector dispara cada una.
- En el test de compactación el modelo se llama 8 veces y no 10: al
  llegar la 7ª verificación, el detector de estancamiento aporta la 3ª
  señal y el run muere ahí — coherente con la escalera unificada.
- Ningún cambio en Studio: el ajuste `maxRunTokens` se gestiona por API
  (PATCH) como el resto de ajustes avanzados; la UI de ajustes no se
  tocó porque el encargo no la incluía.
