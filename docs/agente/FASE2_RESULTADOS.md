# Fase 2 — Resultados de la implementación (21-oct-2026)

**Rama:** `fix/agente-fase2`, construida sobre `fix/agente-fase1` (`dc83109`).
**Alcance:** Trabajos 6, 7 y 8 del informe `FASE2_INFORME.md`. Solo proyectos
dinámicos; los estáticos conservan su comportamiento exacto. Sin cambios de
interfaz, sin tocar la semántica de las seis comprobaciones ni la maquinaria
de despliegue.

## Trabajo 6 — Fotos automáticas cuando el agente avanza

- `dynamicTools.ts`: `recordDynamicCheck` avisa al orquestador al registrar
  una comprobación (callback opcional `ctx.onDynamicCheckRecorded`). La foto
  no se crea dentro de esa función (es síncrona y el workspace aún está
  dentro de la herramienta): el orquestador la crea en `perform()`
  (`agent.ts`) al terminar la herramienta que la registró, con las fuentes
  quietas y exactamente en el estado que superó la comprobación.
- La foto se dispara solo si la longitud del prefijo válido **creció** con
  esa herramienta (comparación antes/después con el nuevo
  `validDynamicPrefixLength`). Repetir una comprobación ya válida no crea
  foto. Máximo teórico: 6 por ejecución.
- Se reutiliza `create_revision` (maquinaria Git existente). Etiqueta:
  `auto: tras <check> (run <id>)`, visible en el panel de Revisiones.
- Fallo de foto = no fatal: se anota en un evento `log` y la ejecución sigue
  (mismo criterio que la foto previa). Eventos emitidos: `log` +
  `status {phase: 'auto_snapshot', check, prefixLength, revisionId}`.

## Trabajo 7 — Restauración automática al mejor estado

- Mejor estado (auditable): (1) longitud del prefijo válido; (2) desempate,
  tests de API superados sobre **esas mismas fuentes** (la cuenta se reinicia
  con cualquier edición y solo se asocia a una foto si la huella del proyecto
  coincide con la de la foto en el momento de la ejecución de `apiTests`).
- Todas las salidas por fracaso del bucle pasan por un único `failRun()`:
  `REPAIR_LIMIT` (cortocircuitos de la Fase 1 y estancamiento), `ITERATION_LIMIT`
  (tope duro) y timeout de inactividad restauran; `LLM_ERROR` **no** restaura
  (no está en la lista de la fase) y la cancelación tampoco (no es un fracaso).
  En éxito nunca se entra en esta vía.
- Se restaura solo si la foto es **estrictamente mejor** que el estado
  inicial del run. Si no hubo avance, los archivos quedan como están y el
  mensaje final lo dice expresamente («No se restauró ningún estado
  anterior…» / “No earlier state was restored…”).
- Restauración (`restoreRevision`, nueva en `tools.ts`, **no** expuesta como
  herramienta del agente): `git reset --hard <sha>` (como el endpoint manual)
  + `git clean -fd`, para que los ficheros creados después de la foto tampoco
  sobrevivan — el workspace queda exactamente en la foto. `clean -fd` nunca
  toca rutas ignoradas (`node_modules/`, `dist/`, `.env`, `data/*.db`), así
  que la BD de la app generada y las dependencias quedan a salvo.
- Verificación: tras restaurar, la huella de las fuentes
  (`sourceFingerprint` del proyecto) debe coincidir con la registrada en la
  foto; si no, el run informa de la discrepancia en vez de dar la
  restauración por buena.
- **Decisión sobre recibos (desviación documentada del diseño inicial):** el
  diseño decía «eliminar los recibos posteriores a la foto». En la práctica
  eso no basta: la invalidación durante la degradación ya **borra** todos los
  recibos persistidos (no los marca caducados), así que tras restaurar se
  eliminan los posteriores al prefijo **y se re-registran los del prefijo**
  con las huellas recalculadas sobre las fuentes restauradas (idénticas a las
  de la foto, con la huella ya verificada). La puerta en memoria se reconstruye
  igual. Resultado: la puerta recalculada sobre las fuentes restauradas da
  exactamente el estado de la foto.
- Eventos: `status {phase: 'restoring_best' | 'restored_best' |
  'restore_failed' | 'restore_mismatch'}` + `log`. El mensaje final del run
  dice expresamente si se restauró y a qué estado («♻️ Restaurado al mejor
  estado alcanzado en esta ejecución: tras backendBuild (2/6…)»).

## Trabajo 8 — El agente puede consultar el marcador

- Nueva herramienta de solo lectura `get_dynamic_status` en
  `dynamicTools.ts` (registrada en `createDynamicTools` y en
  `DYNAMIC_TOOL_DEFS`; solo se ofrece a proyectos dinámicos, como las demás):
  devuelve comprobaciones válidas / caducadas / ausentes (distingue caducada
  de ausente comparando la huella guardada), prefijo actual, siguiente
  comprobación, `complete`/`orderValid` y el mejor estado del run con su
  foto (leído vía `ctx.getBestDynamicState`, que alimenta el orquestador).
  No ejecuta ninguna comprobación ni registra recibos.
- Prompt: una única línea en la sección dinámica del prompt del sistema
  («During repair, consult get_dynamic_status BEFORE acting…»). Nada más.

## Ficheros tocados

- `apps/worker/src/agent.ts` — seguimiento del mejor estado, fotos en
  `perform()`, `failRun()`/`restoreToBestState()`, una línea de prompt,
  callbacks en el `ToolContext`.
- `apps/worker/src/dynamicTools.ts` — aviso en `recordDynamicCheck`,
  `validDynamicPrefixLength()`, herramienta `get_dynamic_status`.
- `apps/worker/src/tools.ts` — `BestDynamicStateInfo`, dos campos opcionales
  en `ToolContext`, `restoreRevision()` (solo orquestador).
- `apps/worker/src/agentSafetyNet.test.ts` — 4 tests nuevos.
- `docs/agente/FASE2_RESULTADOS.md` — este documento.

## Verificación

Tests nuevos (`agentSafetyNet.test.ts`, LLM guionizado, estilo
`dynamicGate.test.ts`, fixture dinámico + repo Git real por proyecto):

1. **Avanza y degrada** → muere por `REPAIR_LIMIT` (firma repetida): el
   contenido de los archivos es exactamente el de la mejor foto (incluye que
   un fichero creado durante la degradación desaparece), hay 2 revisiones
   `auto:` con sus eventos, y el mensaje final anuncia la restauración a
   «tras backendBuild (2/6)».
2. **Recibos coherentes tras restaurar**: los recibos persistidos que quedan
   son `frontendBuild` + `backendBuild` y el prefijo recalculado desde el
   disco es 2, el de la foto.
3. **Fracasa sin avanzar**: sin fotos, sin restauración, archivos como
   quedaron y mensaje que lo indica.
4. **Consulta de estado**: `get_dynamic_status` devuelve prefijo 0 / todo
   ausente / `best: null` al inicio, y prefijo 2 / válidas
   `[frontendBuild, backendBuild]` / mejor estado con `revisionId` tras los
   dos builds.

Cierre: worker **397 ✓ / 0 ✗** (base Fase 1: 393; +4 nuevos; 18 skipped
preexistentes), servidor **104 ✓ / 0 ✗** (una primera pasada falló bajo
carga en paralelo; la repetición en solitario da 104/104, mismo patrón
«flake por carga» ya documentado en la Fase 1), studio **9 ✓ / 0 ✗**,
typecheck de worker y servidor limpios.

## Notas

- La regresión real (pcBOX / PlayStation Accesories) no se ha ejecutado:
  es el examen de la Fase 4 del plan y requiere lanzar runs reales con
  modelo, fuera del alcance verificado aquí.
- El desempate por tests de API queda ejercitado por construcción (cuentas
  asociadas por huella) pero no por un test de bucle dedicado: con el
  fixture, `apiTests` es el 4.º escalón y un estado con prefijo 3 y tests
  parciales exigiría un `npm test` que falle con conteos parciales tras
  haber pasado migraciones; se deja anotado como cobertura pendiente si se
  quiere endurecer.
