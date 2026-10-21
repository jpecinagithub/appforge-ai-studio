# Proyecto: que el agente de AppForge funcione (apps dinámicas)

Decisión de Jon (20-oct-2026): sin urgencia por la tienda; la prioridad es que el
agente de AppForge AI Studio sea capaz de completar proyectos dinámicos
(full-stack) de forma fiable. pcBOX queda aparcado como caso, no como objetivo.

## Banco de regresión (casos reales, 20-oct-2026)

1. **pcBOX** (proyecto 9b6a0d3c, plantilla dinámica): generación inicial fallida
   (47 iteraciones). La reparación degradó el código: `backend/src/routes/todos.ts`
   sustituido por un placeholder de 4 líneas; `server.ts` reescrito en bucle;
   error TS2554 sin resolver en 3 rondas; 7 ficheros basura en la raíz del
   frontend. Estado con builds en verde (≈13:20) perdido sin restauración.
   Tests de API atascados en 10/17 (409/401/logout/guard). Restauración manual
   del fichero desde la plantilla verificada por hash — el backend vuelve a
   compilar.
2. **PlayStation Accesories** (proyecto 1d21f367, modelo gratuito): ejecución
   única fallida (48 iteraciones, 44 tool calls, 14 errores, coste 0 €).
   Backend incoherente consigo mismo: imports de símbolos inexistentes en el
   módulo destino (`publicUser`, `sendError` desde `../types/index.js`),
   conversiones TS2352 en cart/orders, TS2339 (`product_name`). Confusión de
   rutas de fichero (área backend, `src/server.ts` vs `backend/src/server.ts`)
   con operación abortada por timeout. Sin preview.

Conclusión de los dos casos: ni el prompt, ni el modelo (pago/gratuito), ni un
proyecto concreto. El denominador común es el bucle de generación/reparación.

## Fallos a corregir (diagnóstico)

- F1. Edición destructiva sin validación inmediata (reescrituras completas,
  ficheros vaciados, símbolos exportados que desaparecen).
- F2. Sin puntos de control útiles: una reparación puede terminar peor que el
  mejor estado alcanzado y no hay restauración.
- F3. Bucle sin cortocircuitos efectivo: la misma firma de error se repite
  rondas enteras gastando presupuesto de iteraciones.
- F4. Higiene del espacio de trabajo: el agente escribe donde quiere y deja
  ficheros temporales en la raíz del proyecto.
- F5. Coherencia descubierta tarde: el backend se comprueba al final; los
  imports rotos y tipos incompatibles deberían detectarse tras cada escritura.
- F6. Confusión de rutas entre áreas (frontend/backend) en las herramientas.

## Fases propuestas (a concretar con la auditoría de código)

- **Fase 1 — Puerta de coherencia e higiene:** compilar (tsc) tras cada
  escritura en el backend y rechazar/revertir escrituras que rompan la
  compilación o eliminen símbolos exportados usados por otros ficheros;
  restringir rutas escribibles al layout del proyecto y área temporal limpia.
- **Fase 2 — Red de seguridad del bucle:** checkpoints por run con restauración
  al mejor estado si la reparación empeora; cortocircuitos por firma de error
  repetida (parar y escalar con diagnóstico en vez de seguir iterando);
  preferencia de parches mínimos sobre reescrituras en la fase de reparación.
- **Regresión:** relanzar pcBOX y PlayStation Accesories (mismos prompts) hasta
  superar las seis comprobaciones dinámicas (frontendBuild, backendBuild,
  migrations, apiTests, fullstackPreview, authenticatedFlow) y generar preview.

## Pendiente

- Auditoría de código del runner/herramientas/checks (ubicaciones exactas).
- Aprobación del plan por Jon antes de implementar.

## Auditoría de código (20-oct-2026): causas raíz localizadas

El agente vive en `apps/worker` (no en `apps/server`, que solo crea runs y
arranca el worker in-process). Ficheros centrales: `agent.ts` (634 l., bucle
`runAgentOnce`), `tools.ts` (798 l.), `dynamicTools.ts` (1204 l.),
`dynamicAreas.ts` (239 l.), `recovery.ts`, `fingerprint.ts`.

- **El bucle no tiene tope real de iteraciones.** `maxIterations` (defecto 8)
  solo fuerza `verify()`; no detiene nada (`agent.ts:547,578,595`). Un run
  solo termina por éxito, por estancamiento (6 claves idénticas) o por el
  watchdog de inactividad (900 s). De ahí las ~48 iteraciones.
- **`maxRepairAttempts: 2` es configuración muerta**: definida en
  `agent.ts:51` y `packages/shared`, nunca leída en ningún sitio.
- **La detección de estancamiento está rota para el fallo observado**: la
  clave es `fingerprint + diagnóstico` (`agent.ts:468-474`,
  `recovery.ts:107-114`). Cualquier edición cambia el fingerprint, **resetea
  el contador a 0 y refresca el watchdog**, aunque el error final sea idéntico
  carácter a carácter. Un agente que edita algo en cada ronda y muere en el
  mismo error nunca se detecta como estancado. No existe cortocircuitos por
  firma de error repetida (las cadenas `loopDetected` de `agent.ts:613,629`
  son texto i18n muerto, sin uso).
- **`write_file` sobrescribe sin ninguna validación** (`tools.ts:217-232`):
  contenido completo e incondicional; sin guarda anti-placeholder (puede
  vaciar un fichero), sin límite de líneas, sin copia previa, sin compilar ni
  comprobar símbolos tras escribir. `patch_file` existe pero es opcional y
  solo sustituye la primera ocurrencia. El prompt de reparación estática
  (`agent.ts:513`) empuja además a reescribir en lote con `write_files`.
  **No existe regla de parche mínimo ni de «no borrar funcionalidad»** en el
  prompt de sistema (`agent.ts:57-97`).
- **No hay checkpoints del workspace durante el run ni noción de «mejor
  estado»**: único checkpoint = commit Git previo al run si `autoRevision`
  está activo (`agent.ts:286-294`, `tools.ts:701-739`). La restauración existe
  solo como endpoint HTTP manual para el usuario
  (`apps/server/src/index.ts:1062-1072`); el agente no tiene herramienta de
  restauración y el orquestador nunca restaura. Un cambio a peor resetea el
  estancamiento igual que uno a mejor; al agotarse, «los archivos se
  conservan» en su peor estado.
- **Ningún check se ejecuta automáticamente tras editar**: el agente debe
  invocarlos; la incoherencia solo aflora en `verify()` al intentar terminar
  (`agent.ts:454-516`). **No existe herramienta para que el agente consulte
  el estado de los checks** (`dynamicGateStatus` es interno).
  `perform()` solo invalida receipts por fingerprint (`agent.ts:359-389`).
- **Confusión de rutas estructural** (`dynamicAreas.ts:61-66,140-193`):
  conviven dos convenciones (estática «relativo a frontend/» y dinámica por
  áreas) en los mismos schemas y prompt; `frontend` acepta cualquier ruta
  (`/^.*$/`), `backend` exige prefijo `src/`; el área omitida cae en
  `frontend` en silencio (`:162`), así que `backend/src/server.ts` sin área
  crea `frontend/backend/src/server.ts` sin error. Los ficheros basura
  entraron por ahí (`area` omitida + nombre `.js` arbitrario: `FORBIDDEN`
  no los bloquea). El «abortada por timeout» vino del watchdog de
  inactividad, que recorta los timeouts de las operaciones
  (`agent.ts:345-348`); las escrituras no tienen timeout propio.
- **Las seis comprobaciones en sí están bien construidas**
  (`dynamicTools.ts`, `previewManager.ts`, `authFlow.ts`): deterministas,
  con receipts persistidos, invariante de prefijo y orden canónico único.
  Lo que falla es la disciplina del bucle que las rodea.
- **Tests**: no existe test directo del bucle (`runAgentOnce` solo se
  ejercita indirectamente con LLM guionizado); la decisión de estancamiento,
  el checkpoint/restauración en el bucle y la validación tras escritura no
  tienen cobertura.

## Plan de arreglo (concreto, por fases)

### Fase 1 — El bucle no puede autodestruirse
1. **Cortocircuitos por firma de error**: rastrear la firma normalizada del
   diagnóstico de verificación (errores del compilador/tests) independientemente
   del fingerprint; si la misma firma se repite 3 verificaciones, parar con
   `REPAIR_LIMIT` y escalar el diagnóstico (en `verify()`/`recovery.ts`).
2. **Tope duro de iteraciones** configurable, separado del umbral que fuerza
   `verify()`; e implementar de verdad `maxRepairAttempts` o eliminarlo.
3. **Guarda anti-placeholder en `write_file`/`write_files`**: rechazar
   escrituras que vacíen un fichero no vacío o eliminen símbolos exportados
   que otros ficheros importan (chequeo de supervivencia de símbolos).
4. **Coherencia inmediata en el área backend**: tras escribir, ejecutar una
   comprobación `tsc` incremental y devolver los errores como resultado de
   la herramienta (la incoherencia aflora al escribir, no en `verify()`).
5. **Higiene**: área de trabajo temporal para scripts del agente, excluida
   de fingerprints/checks y limpiada al final; cerrar la vía de `.js`
   arbitrarios en la raíz del área frontend.

### Fase 2 — Red de seguridad: nunca terminar peor
6. **Checkpoints automáticos** con la maquinaria Git existente
   (`create_revision`): al avanzar el prefijo de checks válidos (p. ej. al
   pasar backendBuild, al pasar apiTests).
7. **Restauración al mejor estado**: registrar el mejor estado (prefijo de
   checks más largo; desempate por tests de API superados) y, si el run
   termina en `REPAIR_LIMIT`/timeout, restaurar el workspace a ese
   checkpoint y reportarlo.
8. **Herramienta de estado para el agente**: exponer `dynamicGateStatus`
   como tool de solo lectura para que razone con el estado real.

### Fase 3 — Disciplina de edición
9. **Prompt de reparación**: parche mínimo primero (`patch_file`), prohibido
   eliminar funcionalidad/rutas existentes, corregir el mensaje inyectado de
   `agent.ts:513` que empuja a reescribir en lote.
10. **Rutas sin ambigüedad**: en proyectos dinámicos, `area` obligatoria;
    escribir `backend/...` sin área debe ser error, no aterrizar en
    `frontend/` en silencio; pistas de ruta coherentes en schemas y prompt.

### Fase 4 — Tests del bucle y regresión real
11. Tests directos de `runAgentOnce`: misma firma de error repetida →
    parada; escritura placeholder → rechazada; empeorar → restauración al
    mejor checkpoint; tope duro de iteraciones.
12. **Regresión con los casos reales**: relanzar pcBOX y PlayStation
    Accesories con sus prompts originales hasta superar las seis
    comprobaciones y generar preview funcional.

Orden de implementación: Fase 1 → Fase 2 → Fase 3 → Fase 4 (la regresión
real cierra cada fase intermedia de forma parcial: tras la Fase 1 ya se
puede re-probar pcBOX para medir mejora).

## Fase 1 — COMPLETADA (20-oct-2026, rama local `fix/agente-fase1`, sin push)

Commits: `10c34eb` (trabajos 1–2), `7cfaeba` (trabajos 3–5), `ac191df`
(ajuste de ámbito del trabajo 5). Verificado por el asistente: rama y
commits presentes, árbol limpio, rama NO publicada.

- **T1 Cortocircuitos por firma de error**: `repairErrorSignature()` en
  `recovery.ts` (firma del diagnóstico solo: fichero + código TS + mensaje
  sin línea/columna, contadores de tests, cabecera de la puerta, códigos);
  a la 3ª verificación consecutiva con la misma firma, `REPAIR_LIMIT` con el
  diagnóstico incrustado (reutiliza el texto i18n `loopDetected`, antes
  muerto). Cableado en `agent.ts` (`noteFailedVerification` /
  `checkRepairAbort`); el evento de estado incluye los contadores nuevos.
- **T2 Topes reales**: `maxHardIterations` (defecto 60, `ITERATION_LIMIT`)
  y `maxRepairAttempts` implementado de verdad contando verificaciones de
  reparación fallidas, **defecto subido a 12** (el 2 histórico ahogaría
  reparaciones legítimas; la red fina es la firma). Plomería de settings
  completa (shared, worker, server con validación zod). Sin controles en la
  UI del Studio todavía: se ajustan vía API/settings.
- **T3 Guarda anti-placeholder** (`writeGuard.ts`, 324 l.): rechaza vaciar
  un fichero no vacío y eliminar símbolos exportados importados por otros
  ficheros; **incluye la aridad**: el stub real de pcBOX conservaba el
  nombre `registerTodoRoutes` y solo perdía los parámetros (3→0), y eso
  también se rechaza. Los lotes se juzgan por su estado final (refactor
  atómico legítimo pasa); un rechazo aborta el lote sin escribir nada.
- **T4 Typecheck inmediato de backend**: tras escribir en el área backend,
  `tsc --noEmit` del propio backend y solo se informan los errores NUEVOS
  respecto a la línea base del run; el frontend no dispara nada; si el
  backend aún no tiene dependencias instaladas, se omite en silencio.
- **T5 Higiene de raíz**: rechazo `ROOT_SCRIPT_REJECTED` para scripts
  sueltos en la raíz del área frontend, con pista a `scratch/` o `src/`
  (permitidos `vite.config.*`/`vitest.config.*`). **Ámbito acotado a
  proyectos dinámicos** (commit `ac191df`): la suite preexistente fija por
  contrato que los estáticos conservan su comportamiento exacto, y la
  basura entró por el sistema de áreas de los dinámicos. Una línea de
  sonda en `dynamicAreas.test.ts` pasó de `app.js` a `src/app.js` —
  señalado para revisión humana. Vía residual conocida: `run_command` con
  `node` no confinado (fuera del alcance de la fase).

Tests: 27 nuevos. Worker **393 ✓ / 0 ✗** (línea base en master: 363 ✓ /
6 ✗, todos ambientales: faltaba el Chromium headless en esta VM; instalado
en la caché local, los mismos tests pasan); server **104 ✓ / 0 ✗**; studio
9 ✓ / 0 ✗; typecheck de worker y server limpios. Un flake intermedio por
carga en `dynamicTools.test.ts` (en solitario pasa).

## Nota (21-oct-2026): alcance de mi papel en la Fase 2

Jon pidió el **informe detallado** de la Fase 2 (`FASE2_INFORME.md`,
entregado el 21-oct-2026) y corrigió expresamente la presunción de que la
implementación correría de mi cuenta: «no lo vas a hacer tú». La
implementación de la Fase 2 (y con ella la regresión, que depende de que la
fase exista) **no está asignada al asistente** salvo que Jon lo encargue de
nuevo de forma explícita.

## Fase 2 — COMPLETADA (21-oct-2026, rama `fix/agente-fase2` sobre `fix/agente-fase1`)

Jon subió `fix/agente-fase1` a GitHub y encargó la implementación sobre esa
rama exacta. Trabajos 6–8 implementados y verificados: fotos automáticas al
crecer el prefijo, restauración verificada al mejor estado solo en fracaso,
y herramienta de solo lectura `get_dynamic_status`. Detalle completo en
`FASE2_RESULTADOS.md`. Cierre: worker 397 ✓ / 0 ✗, servidor 104 ✓ / 0 ✗,
studio 9 ✓ / 0 ✗, typechecks limpios. La regresión real (Fase 4) sigue
pendiente.

## Puerta de implementación — COMPLETADA (21-oct-2026, rama `fix/agente-puerta-implementacion`)

Corrección en el backend (no en el prompt) del hueco detectado en el run real de «PcBox online»: las seis comprobaciones se podían satisfacer con la plantilla intacta más una migración. `verify()` exige ahora evidencia estructural (`apps/worker/src/implementationEvidence.ts`): `frontend/src` y `backend/src` distintos de la plantilla, superficie de rutas nueva y superficie de frontend nueva; el diagnóstico `NO_IMPLEMENTATION` enumera los huecos. Si la plantilla no se localiza, se conserva la guarda anterior. 8 tests nuevos (6 de unidad + 2 de bucle, uno reproduce el caso pcBOX); worker 415 ✓, server 110 ✓. Detalle: `docs/agente/PUERTA_IMPLEMENTACION_RESULTADOS.md`. Sin fusionar ni desplegar.

## Autonomía del agente — COMPLETADA (21-oct-2026, rama `fix/agente-autonomia`)

Corrección en el backend para que el agente resuelva solo la clase de fallo del run `a9864671` (contratos de plantilla desconocidos descubiertos tarde): contratos completos en el contexto inicial (faltaban `lib/errors.ts` y la ruta de ejemplo), hechos duros de API en el prompt del sistema (node:sqlite sin `.transaction()`, unión `ErrorCode` cerrada, implementar antes de verificar), lint mecánico de contratos al escribir (`backendContracts.ts`: códigos `sendError` fuera de la unión y `.transaction(`, en el mismo turno y sin necesitar dependencias instaladas), inyección de `errors.ts`+`db/index.ts` en el resultado cuando `run_backend_build` falla, diagnóstico «IMPLEMENT FIRST» en `verify()` cuando el hueco es de implementación, y helper `withTransaction` nuevo en la plantilla. 9 tests nuevos; worker 424 ✓, server 110 ✓, plantilla compila. Detalle: `docs/agente/AUTONOMIA_RESULTADOS.md`. Sin fusionar ni desplegar.

## Guarda de esquema — COMPLETADA (21-oct-2026, rama `fix/agente-guarda-esquema`)

Corrección en el backend del hueco diagnosticado en el run `b6de6a05` de «PcBox online»: una 001 reescrita perdió `sessions.last_seen_at` y nadie lo detectó hasta que `run_api_tests` cayó en cascada (10/17). Tres capas: (1) introspección autoritativa en `run_migrations` — el esquema aplicado debe ser superconjunto del de la plantilla servida (BD temporal + `PRAGMA table_info` a ambos lados); violación = `SCHEMA_CONTRACT_VIOLATION` sin registrar el check, con el arreglo prescrito (migración nueva con `ALTER TABLE`, nunca reescribir la aplicada); fallback silencioso anotado si la plantilla no es localizable o su esquema no se puede derivar; (2) lint SQL al escribir migraciones (`analyzeMigrationSql` en `backendContracts.ts`) que avisa en el mismo turno si un `CREATE TABLE users/sessions` pierde columnas núcleo; (3) `auth/session.ts` en los contratos del contexto, hecho de esquema núcleo en «TEMPLATE API FACTS» e inyección de `session.ts` cuando `run_api_tests` falla. 13 tests nuevos; worker 437 ✓, server 110 ✓. Paridad con producción: la primera versión derivaba el esquema de la plantilla con su `npm run migrate`, inejecutable en la imagen (plantillas peladas, `tsc: not found` verificado) — corregido en un segundo commit de la misma rama: la derivación ejecuta los `.sql` de la plantilla directamente con `node:sqlite`, sin npm ni dependencias, y dos tests PARITY contra una copia pelada de la plantilla real lo verifican en ambos sentidos (violación y fiel). Detalle: `docs/agente/GUARDA_ESQUEMA_RESULTADOS.md`. Sin fusionar ni desplegar.

## Llamadas vacías (malformed tool calls) — COMPLETADA (21-oct-2026, rama `fix/agente-llamadas-vacias`)

Corrección en el backend del hueco verificado en el run de producción `3723178d` («PcBox online» `5ec62ac6`): el modelo emitió `read_file` ×5 y `write_file` ×1 con los argumentos vacíos; `parseResponse` convertía el payload ausente en `{}` en silencio, cada llamada era rechazada con «missing required argument: path» y el run murió sin ejecutar nada. Tres piezas: (1) marcado en el parseo — `LlmToolCall` gana `rawArguments` y `malformed: 'empty-arguments'` cuando el proveedor no envía payload (un `"{}"` explícito no se marca); (2) detección pura `findMalformedToolCalls` (marca del parser + `required` ausentes/nulos/vacíos, con las herramientas sin requeridos siempre válidas) y reintento de la completion en el bucle vía `requestCompletion()`: ninguna llamada de la respuesta se ejecuta, aviso temporal fuera del historial canónico (un assistant con tool calls sin resultados invalidaría la siguiente petición), hasta 2 reintentos contados como llamadas LLM pero no como iteraciones ni errores de herramienta; si persiste, `LlmError('LLM_BAD_TOOL_ARGS')` con bandera `fatal` nueva que salta la recuperación clásica y cierra el run en 3 completions; (3) corte rápido `updateArgumentStreak`: 3 resultados consecutivos «missing required argument» para la misma herramienta (formas anidadas que la detección no ve, p. ej. ítems de `write_files`) abortan con `TOOL_ARGUMENT_STAGNATION`. 19 tests nuevos (13 en `llm.test.ts` + 6 de bucle scripted en `malformedCalls.test.ts`, incluidos (a) recuperación y run a `done`, (b) persistencia = error en 1+2 completions y cero ejecuciones, (c) clave equivocada por `required`, (d) el corte rápido real); worker 456 ✓, server 110 ✓, typecheck limpio. Detalle: `docs/agente/LLAMADAS_VACIAS_RESULTADOS.md`. Sin fusionar ni desplegar.

## Diagnóstico del flujo autenticado — COMPLETADA (21-oct-2026, rama `fix/authflow-diagnostico`)

Corrección en el backend del hueco diagnosticado en el run de «PcBox online» que llegó a 5/6: `test_authenticated_flow` cayó en la fase de navegador (`toFixed` sobre undefined + timeout esperando `[data-testid="user-email"]`) y el agente parcheó `App.tsx` a ciegas (PATCH_NOT_FOUND ×2) porque el diagnóstico de `checkBrowserAtUrl` solo traía el pageerror sin stack, los ≥400 de recursos estáticos y el mensaje crudo de Playwright sin índice de paso. Ahora el diagnóstico (compartido por `checkBrowserAtUrl` y `checkBrowser` en `browser.ts`) abre con `step N/M (action "selector") failed:`, incluye pageerrors con stack, veredicto explícito del selector (`NOT PRESENT in DOM` o `present, text: "…"`), red completa con las líneas `/api/` primero (antes invisibles por ser xhr/fetch), errores de consola, URL/title, inventario de data-testid y extracto del texto visible, con tope de ~6000 caracteres y lo accionable primero; `authFlow.ts` deja de recortar el error a 2000 (ahora 6000). La semántica pasa/falla no cambia (los fallos /api/ y de consola son contexto, no fallo: un 401 de `/auth/me` al cargar es normal) y la salida de éxito es idéntica. 4 tests nuevos de navegador reales (corren, no skip); worker 460 ✓, server 113 ✓, typecheck limpio. Detalle: `docs/agente/AUTHFLOW_DIAGNOSTICO_RESULTADOS.md`. Sin fusionar ni desplegar.

## Plataforma: navegador post-login + presupuesto consciente del progreso — COMPLETADA (21-oct-2026, rama `fix/plataforma-postlogin-presupuesto`)

Dos correcciones en el backend de dos runs reales de «PcBox online» del mismo día. (1) El catálogo con todas las fotos rotas (`images: []` en cada producto) verificó 6/6 porque `checkBrowserAtUrl` solo afirmaba imágenes ANTES de los pasos — la pantalla de login, sin datos —: nuevo helper `assertImagesLoadedAfterSteps` (scroll completo + asentamiento + el mismo criterio de imagen rota) tras los pasos en `checkBrowserAtUrl` y en `checkBrowser` (antes del viewport móvil), con la foto del fallo tomada de la pantalla final; la salida de éxito no cambia. (2) El run `6ad56917` murió por presupuesto (13 verificaciones > 12) a una llamada del éxito tras re-pasar 5 checks en verde: `noteFailedVerification` ahora solo consume `maxRepairAttempts` cuando la clave de progreso (prefijo válido + huella de fuentes, compuesta de los mecanismos de recibos existentes) no se movió desde la verificación anterior; el cortocircuito por firma repetida (×3) no cambia y mantiene prioridad; y el diagnóstico de `verify()` nombra solo las herramientas de los checks que faltan o están stale, en orden canónico (la variante «IMPLEMENT FIRST» y la primera línea, intactas). 6 tests nuevos (3 de navegador real + 3 de bucle), 1 test actualizado a la nueva semántica (el antiguo de `maxRepairAttempts`); worker 465 ✓ / 0 ✗ (18 skipped preexistentes), typecheck limpio. Detalle: `docs/agente/PLATAFORMA_POSTLOGIN_PRESUPUESTO.md`. Sin fusionar ni desplegar.

## Flexibilidad agéntica — COMPLETADA (21-oct-2026, rama `feat/flexibilidad-agentica`)

Implantación de la propuesta aprobada de flexibilidad (determinismo en la evidencia, agencia en la conducta): el bucle ya solo muere por hechos — éxito verificado, cancelación, watchdog, techo de iteraciones y **techo de tokens nuevo** (`maxRunTokens`, default 3 M, 0 = sin techo, `TOKEN_BUDGET_EXHAUSTED` con restauración) — y los contadores (firma ×3, presupuesto de reparación, estancamiento, racha de argumentos, malformadas fatales) alimentan una **escalera de intervención** unificada: directiva persistente → directiva reforzada + compactación → `LOOP_EXHAUSTED` con restauración y resumen que enumera los tres escalones; el progreso verificado (clave de recibos) resetea la escalera. `ToolResult` gana `retryable`/`alternatives`; `acquire_image` tiene presupuesto total por llamada de 90 s (`IMAGE_TIMEOUT` con alternativas al agotarlo) y `fallback: 'placeholder'` que degrada al asset de plataforma `public/placeholder-illustrative.svg` con `data.degraded`; el run lleva un libro de degradaciones y `complete()` añade al resumen, de forma determinista, la sección «Degradaciones declaradas» (el estado sigue siendo `done`). El prompt pasa el orden de verificación a recomendado y gana la regla 15 del régimen nuevo. La evidencia (§5) no cambia: ningún test de recibos/huellas/puertas se tocó. Worker 475 ✓ / 18 skipped (base 467), server 121 ✓ (base 116), studio 22 ✓ + build, typechecks limpios. Detalle: `docs/agente/FLEXIBILIDAD_AGENTICA_RESULTADOS.md`. Sin fusionar ni desplegar.

## Plataforma: despliegue ↔ biblioteca + detector sin URLs — COMPLETADA (21-oct-2026, rama `fix/plataforma-biblioteca-detector`)

Dos correcciones de plataforma de la saga de «PcBox online». (1) Un proyecto con el despliegue live y la app sirviendo quedó con `projects.preview_url`/`production_url` a NULL y la Library lo mostraba «Sin desplegar»: `finalizeLiveDeployment` escribe ahora ambas URL (`/a/<projectId>/`) dentro de la misma transacción atómica de la transición a live (solo ahí; idempotente; rollback no las cambia), la Library usa el nuevo criterio compartido `isProjectDeployed` (`(productionUrl ?? previewUrl) != null`, con el botón de apertura habilitado por ese criterio y no por un solo campo), y `publicAppUrlFor` es consciente del tipo — el enlace «Abrir aplicación» de Operaciones de un dynamic ya no apunta a la ruta estática `/p/<id>/`, cuyos POST a `/api/*` devuelven 404 (el «not found» al registrarse); `openProjectPreview` y el PreviewPane ya enrutaban dynamic → `/a/`, la fuga era esa URL pública. (2) El detector de compatibilidad rechazó un encargo legítimo como «Backend .NET / C#» porque la URL de una foto vivía en un CDN `…akamaized.net/…`: `assessTechnologyCompatibility` retira ahora del corpus los destinos markdown `](…)` y las URL con esquema antes de aplicar los patrones, sin tocar ningún patrón ni etiqueta (la prosa «ASP.NET con C#» se sigue detectando igual). 11 tests nuevos (2 worker + 3 server + 6 studio); worker 467 ✓ / 0 ✗ (18 skipped), server 116 ✓, studio 22 ✓ + build, typechecks limpios. Detalle: `docs/agente/PLATAFORMA_BIBLIOTECA_DETECTOR.md`. Sin fusionar ni desplegar.

## Vista y contrato frontend — COMPLETADA (21-oct-2026, rama `feat/agente-vista-contrato`)

Corrección en el backend del hueco que dejó el run `977a3ab8` de «T-shirts» (`8863cc94`): el bucle flexible funcionó (escalera, 45 llamadas, `LOOP_EXHAUSTED` honesto) y el agente aun así no arregló un `fetch('/api/shirts')` absoluto en `App.tsx` que escapaba del prefijo `/a/<id>/` (404 → `data.items` undefined → crash «reading 'map'»), porque el stack de página era minificado y nadie nombró la conclusión; el mismo run quemó dos `acquire_image` en `INVALID_PATH` por la carpeta destino. Cuatro piezas: (1) **sourcemaps solo en la build de verificación** (`run_frontend_build` ejecuta `npm run build -- --sourcemap`; plantilla intacta y producción en Docker sin mapas) y nuevo `stackResolve.ts` que anota los frames de los pageerrors con su localización original (`frontend/src/App.tsx:300`) vía `source-map-js` (nueva dependencia directa del worker), best-effort sin cambiar la semántica pasa/falla; (2) **contrato frontend** espejo del de backend: el cliente API sale de la lista genérica a su propio bloque FRONTEND API CLIENT CONTRACT en el contexto inicial, hecho (5) en TEMPLATE API FACTS, y lint `frontendContracts.ts` al escribir (detecta el literal `/api` entregado a `fetch`/`axios` en ficheros de frontend, excluye el propio cliente, no marca `resolveApiUrl(...)` ni relativas/externas; anota sin bloquear); (3) **aviso de prefijo** en el diagnóstico del flujo: nueva sección BASE PATH WARNING que nombra deterministicamente las peticiones fallidas same-origin fuera de la ruta base de la página; (4) **`acquire_image` crea la carpeta destino** (recursiva) al validar la ruta, con normalización que convierte el escape `public/../` en `INVALID_PATH` y allowlist de extensiones. 25 tests nuevos (9 stackResolve, 5 frontendContracts, 4 de cableado, 3 acquire_image, 3 browser, 1 dynamicTools); worker 500 ✓ / 18 skipped (base 475), server 121 ✓ y studio 22 ✓ + build sin cambios, typecheck limpio. Detalle: `docs/agente/VISTA_CONTRATO_FRONTEND_RESULTADOS.md`. Sin fusionar ni desplegar.

## Puerta de implementación: divergencia del punto de entrada — COMPLETADA (21-oct-2026, rama `fix/puerta-punto-de-entrada`)

Corrección del agujero que dejó desplegar la plantilla en «T-shirts» (`497f482d`, run `275c9eb3`, despliegue `0a41315f` live sirviendo «My tasks»): la tienda existía en `frontend/src/components/` pero `App.tsx` quedó byte a byte la de la plantilla, y el criterio de superficie aceptaba «App distinta O algún fichero nuevo en frontend/src». La superficie de frontend exige ahora **divergencia del punto de entrada**: (a) `App.tsx` difiere, o (b) `main.tsx` difiere y el componente raíz que importa existe y es nuevo o difiere (bypass legítimo); los ficheros huérfanos ya no cuentan, con resolución de la cadena de imports relativos por regex y recorrido transitivo acotado. El diagnóstico nombra el caso sin ambigüedad («entry point still renders the untouched template (frontend/src/App.tsx is unchanged); wire the root component so the app renders your implementation…») y fluye por el `NO_IMPLEMENTATION` + IMPLEMENT FIRST existentes, sin tocar `agent.ts`. La comprobación simétrica en el backend (test de caracterización previo: ruta nueva sin registrar devolvía `implemented=true, missing=[]`) confirmó el mismo agujero, cerrado con el criterio análogo: la ruta debe estar alcanzable desde `backend/src/server.ts` (transitivo, barrels incluidos) y declarar handlers; `server.ts` con más handlers cuenta por definición. 7 tests nuevos de puerta; ajustados por cambio de semántica deliberado los casos que codificaban la semántica laxa (fichero nuevo no referenciado / ruta sin registrar) en implementationEvidence, dynamicGate y malformedCalls. Worker 507 ✓ / 18 skipped (base 500), server 121 ✓ y studio 22 ✓ sin cambios, typecheck limpio. Detalle: `docs/agente/PUERTA_PUNTO_DE_ENTRADA_RESULTADOS.md`. Sin fusionar ni desplegar.

## Flujo autenticado: recarga sin networkidle — COMPLETADA (21-oct-2026, rama `fix/flujo-recarga-sin-networkidle`)

Corrección del paso que mató el run quirúrgico `0488ed8a` de «T-shirts» (`497f482d`) con la tienda ya cableada: `test_authenticated_flow` falló 3 veces en el paso 6/9 (`reload`) con `page.reload: Timeout 5000ms exceeded — waiting for navigation until "networkidle"`, mientras su propio diagnóstico mostraba el catálogo y el email autenticado — la parrilla de ~20 fotos mantiene conexiones abiertas más de 5 s. El paso `reload` de `browser.ts` espera ahora solo al documento parseado (`waitUntil: 'domcontentloaded'`, techo de navegación de 15 s como el goto inicial): la persistencia de la sesión la juzga, como siempre, la expectativa de visibilidad siguiente con su timeout de locator. Con el mismo criterio, las navegaciones iniciales de `checkBrowser` y `checkBrowserAtUrl` pasan de `networkidle` (techo 15 s) a `load`: el hecho verificado es «la app carga y renderiza» (espera de contenido + aserciones + pasos), no el reposo de la red; auditoría completa — no quedaba ningún otro `networkidle` en el worker. El resto del flujo (pasos, aserciones de imágenes, gate de errores duros, diagnóstico) no cambia. 2 tests nuevos en `browser.test.ts`: regresión con foto lenta de 6,5 s que supera el viejo techo y la secuencia expect→reload→expect pasa (verificado que muerde contra el código anterior), y contraparte en la que la sesión se pierde al recargar y el flujo falla en la expectativa (`step 3/3`), no en la navegación. Worker 509 ✓ / 18 skipped (base 507), typecheck limpio; server y studio sin cambios. Detalle: `docs/agente/FLUJO_RECARGA_RESULTADOS.md`. Sin fusionar ni desplegar.

## Aserción de imágenes honesta: la sustitución por onError ya no cuenta — COMPLETADA (21-oct-2026, rama `fix/asercion-imagenes-honesta`)

Corrección del punto ciego documentado en la saga de pcBOX y mordido ahora en producción por «T-shirts» (`497f482d`) ya desplegada: los `image_url` apuntan a ficheros inexistentes (`/assets/products/*.jpg`) y el `onError` de la tarjeta los sustituye por un marcador en línea, de modo que cada `<img>` terminaba con `naturalWidth > 0` y las aserciones post-pasos del flujo (que solo juzgaban `complete && naturalWidth === 0`) contaban fotos que nunca existieron; en producción, recuadros vacíos. El criterio de «imagen cargada» pasa a ser de procedencia, en todos los puntos de `browser.ts` donde se afirma (`checkBrowser` inicial/post-pasos/móvil y `checkBrowserAtUrl` inicial/post-pasos): un `<img>` completado cuenta solo si renderizó datos Y su `currentSrc` fue observado llegar como respuesta de red 2xx con content-type `image/*`. Para ello el listener de `response` registra ahora todas las respuestas de tipo imagen en un registro nuevo de `PageDiagnostics` (clave: URL sin query; una observación válida nunca la desplaza una inválida posterior, una inválida cede ante una válida posterior). El diagnóstico conserva `Broken images detected:` y nombra cada rechazada con su motivo distinguible: `no image data rendered (naturalWidth 0)` para la rota clásica, o `no valid image response observed (possible error substitution or missing resource)` para la sustituida/sin procedencia; el src se trunca a 160 caracteres. El placeholder oficial no se toca: es un fichero servido como `image/svg+xml` y satisface el criterio por sí mismo (además de declararse como degradación en el resumen). 3 tests nuevos (regresión de sustitución que muerde contra el código anterior, contraparte A/B con foto real, placeholder servido que pasa); 1 test ajustado por cambio de semántica deliberado (la foto «sana» revelada por un paso era un data-URI en línea y pasa a servirse como `image/png` real) y el literal de `PageDiagnostics` del test de topes gana el campo nuevo. Worker 512 ✓ / 18 skipped (base 509), typecheck limpio; server y studio sin cambios. Detalle: `docs/agente/ASERCION_IMAGENES_RESULTADOS.md`. Sin fusionar ni desplegar.
