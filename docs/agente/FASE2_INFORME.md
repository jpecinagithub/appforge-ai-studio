# Informe detallado — Fase 2: red de seguridad del agente de AppForge

**Objetivo de la fase:** que una ejecución fallida nunca deje un proyecto peor
de lo que llegó a estar en su mejor momento dentro de esa misma ejecución.
Hoy el sistema conserva los archivos «tal como quedaron» al fracasar — es
decir, en su peor estado — y el mejor estado alcanzado se pierde sin remedio.

**Punto de partida (verificado en la auditoría del 20-oct-2026):**

- El único punto de control del código durante una ejecución es una foto
  Git creada **antes** de empezar (`create_revision`, invocada por el
  orquestador en `apps/worker/src/agent.ts:286-294`, solo si el ajuste
  `autoRevision` está activo). No hay fotos intermedias.
- La restauración existe, pero **solo como botón manual** del usuario en el
  panel de Revisiones (`POST /api/projects/:id/revisions/:rid/restore` →
  `git reset --hard`, en `apps/server/src/index.ts:1062-1072`). El agente no
  tiene herramienta de restauración y el orquestador nunca restaura.
- **No existe noción de «mejor estado»**: nadie compara las rondas entre sí;
  un cambio a peor cuenta igual que uno a mejor.
- El estado de las seis comprobaciones sí está bien calculado por dentro
  (`dynamicGateStatus`, `apps/worker/src/dynamicTools.ts`), con recibos
  persistidos y la invariante de que las comprobaciones válidas forman un
  prefijo del orden canónico — pero el agente **no puede consultarlo**: no
  existe herramienta para ello.

La Fase 2 tiene tres trabajos.

---

## Trabajo 6 — Fotos automáticas cuando el agente avanza

**Qué se hace:** cada vez que la ejecución consigue que el prefijo de
comprobaciones válidas **crezca** (por ejemplo, pasa `backendBuild` y el
prefijo válido pasa de 1 a 2), el orquestador crea automáticamente una
revisión Git del proyecto con la maquinaria que ya existe
(`create_revision`, `apps/worker/src/tools.ts:701-739`), sin intervención
del modelo.

**Detalles de diseño:**

- La foto se dispara al registrar una comprobación nueva que extiende el
  prefijo (`recordDynamicCheck`, `dynamicTools.ts:898-923`), no al repetir
  comprobaciones ya válidas. Máximo teórico: 6 fotos por ejecución, una por
  escalón; en la práctica, 2–4.
- Etiqueta identificable, p. ej. `auto: tras backendBuild (run …)`, para
  distinguirlas en el panel de Revisiones de la foto previa a la ejecución
  y de las manuales. Quedan visibles para Jon: puede inspeccionarlas y
  restaurarlas a mano si quiere.
- Si la foto falla, el fallo **no es fatal** para la ejecución (mismo
  criterio que la foto previa actual): se anota y se sigue.
- Ámbito: proyectos **dinámicos** (la escalera de seis comprobaciones es su
  marcador natural de progreso, y son los dos casos de regresión). Los
  proyectos estáticos quedan fuera de esta fase.

## Trabajo 7 — Restauración automática al mejor estado si el run fracasa

**Qué se hace:** durante la ejecución, el orquestador mantiene registrado
cuál es el **mejor estado** alcanzado y a qué foto corresponde. Si la
ejecución termina en fracaso, el espacio de trabajo se restaura a esa foto
antes de cerrar el run, y el resultado final lo dice expresamente.

**Cómo se define «mejor estado»** (criterio simple y auditable):

1. Principal: la **longitud del prefijo de comprobaciones válidas**
   (cuántas de las seis, en orden, están superadas sobre las fuentes
   actuales).
2. Desempate dentro del mismo prefijo: el **número de tests de API
   superados** en la última ejecución de `apiTests` (p. ej., un estado con
   el prefijo en 3 y 16/17 tests supera a otro con el mismo prefijo y
   10/17).

**Cuándo se restaura y cuándo no:**

- Se restaura solo en **terminación por fracaso** (límite de reparación,
  límite de iteraciones, tiempo de inactividad agotado) y solo si existe
  una foto **estrictamente mejor** que el estado inicial de la ejecución.
- Si la ejecución fracasa sin haber avanzado nunca, los archivos quedan
  como están (comportamiento actual) y el resultado lo indica.
- En caso de **éxito nunca se restaura** nada.
- La restauración ocurre **después de que el bucle del agente ha
  terminado**, sobre un espacio de trabajo ya quieto: no hay carrera
  posible con ediciones en curso.

**Coherencia tras restaurar (parte delicada, explícita en el diseño):**

- Los recibos de comprobaciones deben reflejar las fuentes restauradas:
  al volver a una foto, se eliminan los recibos posteriores a ese estado
  (la huella de las fuentes restauradas ya no coincidiría con ellos, y el
  estado de la puerta se recalcula solo, pero el diseño lo hace explícito
  en vez de depender de ese efecto).
- La restauración se **verifica**: tras restaurar, la huella de las
  fuentes debe coincidir con la registrada en la foto. Si no coincide, el
  run informa de la discrepancia en lugar de dar la restauración por buena.
- La base de datos de la aplicación generada **no** forma parte de la
  foto: las comprobaciones trabajan con bases desechables, así que no hay
  nada que restaurar ahí. La foto es solo código y archivos del proyecto.
- Se emiten eventos de ejecución visibles en el panel tanto al crear cada
  foto como al restaurar, para que la línea de tiempo del run cuente la
  historia completa.

## Trabajo 8 — El agente puede consultar el marcador

**Qué se hace:** una herramienta nueva de **solo lectura** para proyectos
dinámicos que expone el estado de la puerta de comprobaciones
(`dynamicGateStatus`): qué comprobaciones están válidas, cuáles caducadas
y cuáles faltan, el prefijo actual, y el mejor estado alcanzado con su
foto asociada.

**Por qué:** hoy el agente trabaja a ciegas respecto a su propio progreso;
solo descubre el estado cuando intenta terminar y la verificación le
devuelve el diagnóstico. Con la consulta puede decidir su siguiente paso
con el marcador real delante (qué escalón toca, si una edición ha hecho
caducar comprobaciones, cuánto le falta).

**Acompañamiento mínimo en las instrucciones** (la disciplina completa de
edición es la Fase 3; esto es solo el puntero que la herramienta necesita):
una línea en la sección dinámica del prompt del sistema indicando que
consulte el estado antes de actuar durante la reparación.

---

## Lo que la Fase 2 NO toca

- La estrategia de reparación del agente (prompts y preferencia de parche
  mínimo): eso es la **Fase 3**.
- La semántica de las seis comprobaciones: están bien construidas y no se
  modifican.
- La maquinaria de despliegue (sus «snapshots» son de despliegue, otra
  cosa distinta de las fotos del espacio de trabajo).
- La interfaz del Studio: las fotos automáticas aparecerán en el panel de
  Revisiones existente sin cambios de interfaz.

## Riesgos y decisiones a vigilar

- **Ruido en el historial Git del proyecto:** hasta 6 fotos automáticas
  por ejecución. Acotado y etiquetado, pero es un cambio visible en cómo
  crece el historial de cada proyecto dinámico; se acepta a cambio de la
  red de seguridad.
- **Criterio de «mejor» simplificado a propósito:** prefijo + tests de
  API. No intenta juzgar calidad de código; juzga progreso verificado,
  que es lo que la puerta ya mide.
- **Restaurar no reintenta:** la fase no vuelve a lanzar al agente tras
  restaurar. El proyecto queda en su mejor estado, listo para una nueva
  ejecución o para intervención manual, y el run cuenta por qué fracasó.

## Verificación de la fase (cómo se demuestra que funciona)

Tests nuevos sobre el bucle con modelo guionizado, en el estilo de los
existentes (`dynamicGate.test.ts`):

1. **Avanza y degrada:** la ejecución supera comprobaciones, después
   empeora y muere por límite de reparación → al terminar, el contenido
   de los archivos es **exactamente** el de la mejor foto.
2. **Fracasa sin avanzar:** no se restaura nada; los archivos quedan como
   los dejó la ejecución.
3. **Consulta de estado:** la herramienta devuelve el prefijo y las
   comprobaciones correctas en cada momento del guion.
4. **Recibos coherentes tras restaurar:** el estado de la puerta
   recalculado sobre las fuentes restauradas coincide con el de la foto.

Y el cierre habitual: suite completa del worker y del servidor en verde,
comprobación de tipos limpia, informe de resultados y rama local sin
publicar hasta la revisión de Jon.

## Relación con el resto del proyecto

- La **Fase 1** (hecha) impide la autodestrucción: frenos de bucle, guarda
  de escrituras, coherencia inmediata.
- La **Fase 2** (esta) garantiza que, aun fallando, no se pierde lo bueno.
- La **Fase 3** enseñará al agente a reparar con parche mínimo y sin
  borrar funcionalidad, y despejará la ambigüedad de rutas.
- La **regresión** (pcBOX y PlayStation Accesories con sus prompts
  originales) es el examen final de todo lo anterior.
