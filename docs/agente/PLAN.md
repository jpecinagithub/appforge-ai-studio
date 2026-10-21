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
