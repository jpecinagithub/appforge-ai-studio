# Plataforma: navegador post-login + presupuesto de reparación consciente del progreso

**Fecha:** 2026-10-21 · **Rama:** `fix/plataforma-postlogin-presupuesto` (desde `master` efe947b) · Sin fusionar ni desplegar.

Dos correcciones en el worker, ambas nacidas de runs reales de «PcBox online»
el mismo día: un catálogo con todas las imágenes rotas sacó un 6/6, y el run
que casi lo cierra murió por presupuesto de reparación a una llamada del éxito.

## Pieza 1 — Aserciones de navegador TRAS los pasos (`apps/worker/src/browser.ts`)

### El problema

`checkBrowserAtUrl` ejecutaba `assertImagesLoaded` solo ANTES de los pasos.
En el flujo autenticado, esa primera pantalla es el formulario de login —sin
datos—, así que las pantallas que aparecen tras la interacción (el catálogo
ya logueado, con `images: []` en cada producto) nunca se miraban: la tienda
verificó 6/6 con todas las fotos rotas. Los `pageerror` sí se recogían
durante los pasos, pero la aserción de imágenes no se repetía sobre la
pantalla final.

### El cambio

- Nuevo helper compartido `assertImagesLoadedAfterSteps(page)`: hace scroll
  completo de la página (de arriba abajo y vuelta, para disparar la carga
  lazy), espera un asentamiento corto (300 ms) y aplica `assertImagesLoaded`
  —el mismo criterio de siempre (`complete && naturalWidth === 0`, que cubre
  también el `src` vacío— sobre la pantalla final.
- `checkBrowserAtUrl`: tras completar todos los pasos, se ejecuta el helper
  antes de capturar texto/snapshot; la puerta `hasHardErrors` ya existente
  juzga después los pageerror acumulados durante los pasos. Si algo falla,
  el diagnóstico enriquecido (paso, PAGE ERRORS, veredicto del selector,
  red, foto del fallo) se compone desde esa pantalla final, no la inicial.
- `checkBrowser` (vía estática): la misma aserción post-pasos, tras su bucle
  de pasos y antes del cambio a viewport móvil (donde ya existía una tercera
  comprobación de imágenes).
- La salida de éxito no cambia de formato en ninguna de las dos vías.

### Tests (browser.test.ts, navegador real, corren en este entorno)

- (a) Una página sin imágenes cuyo click revela una foto con `src` roto y
  otra con `src` vacío → `checkBrowserAtUrl` falla con `Broken images
  detected` nombrando ambas.
- (b) La misma página con la imagen sana (data URI) → pasa, sin bloque de
  diagnóstico.
- (c) Un `pageerror` lanzado solo tras el click → el flujo falla con ese
  error en `PAGE ERRORS:` y la foto del fallo muestra el texto de la
  pantalla final («Final screen after click»), no la inicial.
- (d) Sin regresión: los 6 tests previos de browser.test.ts (incluidos los
  del diagnóstico enriquecido) y los 11 de authFlow.test.ts siguen verdes.

## Pieza 2 — Presupuesto de reparación consciente del progreso (`apps/worker/src/agent.ts`)

### El problema

`failedRepairVerifications` contaba TODA verificación del gate que no
cerraba, aunque el agente estuviera avanzando. El run real `6ad56917`
re-pasó los cinco primeros checks en verde tras corregir el precio y murió
con 13 verificaciones fallidas (> `maxRepairAttempts=12`) justo antes de
repetir `test_authenticated_flow` — a una llamada del éxito. Además, el
diagnóstico de `verify()` ordenaba re-ejecutar la cadena COMPLETA de seis
herramientas aunque faltara un solo check, quemando turnos en re-probar lo
que ya estaba en verde.

### El cambio

- **Clave de progreso** (`verificationProgressKey()`): longitud del prefijo
  válido de checks (derivada de las huellas de los recibos, vía
  `validDynamicPrefixLength`) + `sourceFingerprint` de la raíz que
  `perform()` ya vigila (proyecto en dinámicos, frontend en estáticos). No
  se introduce contabilidad nueva: se compone de mecanismos existentes.
- `noteFailedVerification()` solo incrementa `failedRepairVerifications`
  cuando la clave de progreso NO se movió desde la verificación fallida
  anterior. La primera verificación fallida de un run siempre cuenta (no
  hay clave previa).
- El cortocircuito por firma repetida (`errorSignatureRepeats`, 3 firmas
  idénticas seguidas) NO cambia ni se hace consciente del progreso: se
  sigue evaluando en cada verificación fallida, con prioridad sobre el
  presupuesto — un bucle que produce el mismo diagnóstico sigue muriendo
  a las 3, edite o no edite ficheros.
- **Diagnóstico de verify**: con checks incompletos (y sin hueco de
  implementación) la instrucción ahora nombra SOLO las herramientas de los
  checks que faltan o están stale, en orden canónico, mapeadas
  check→herramienta (`frontendBuild→run_frontend_build`, …,
  `authenticatedFlow→test_authenticated_flow`): «Run only the missing
  tools now, in this exact order: test_authenticated_flow.». La primera
  línea (`missing or stale checks: …`) y la variante `IMPLEMENT FIRST`
  quedan intactas. Si no falta ningún check pero el orden registrado es
  inválido, la cadena completa en orden canónico ES el trabajo que falta
  y se lista entera.

### Tests (dynamicGate.test.ts, harness scripted existente)

- (a) Presup
...[truncated 1477 chars]
## Despliegue del paquete completo (21-oct-2026)

Fusionada en `master` junto al frente B (`fix/plataforma-biblioteca-detector`, que ya contenía esta rama como ancestro) con fast-forward a `74477f5` y redesplegada en la instancia edu con el procedimiento seguro (sin runs ni despliegues activos). Verificado dentro del contenedor healthy junto a los marcadores del frente B; health local y público 200.
