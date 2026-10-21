# Puerta de implementación (backend, no prompt) — RESULTADOS

**Fecha:** 2026-10-21 · **Rama:** `fix/agente-puerta-implementacion` (desde `master da77a89`) · **Encargo:** «que la corrección esté en el backend en lugar que en el prompt» — mecanismos 1+2 aprobados por el usuario.

## El fallo que lo motiva (verificado en producción)

Run `5c844de3` del proyecto «PcBox online» (2026-10-21): el modelo pasó las
seis comprobaciones sobre la **plantilla intacta** (las pasa por diseño),
escribió un único fichero (`migrations/002_catalog.sql`), re-verificó desde
`migrations` y terminó `done`. Sin rutas de productos ni frontend de
catálogo: la preview mostraba el Sign in de la plantilla porque es lo único
que existía. La guarda previa (`unchangedStarter`) solo rechazaba el
proyecto byte-idéntico a la plantilla en las cuatro áreas: **una sola
escritura en `migrations` la derrotaba**.

## Qué se ha construido

Nuevo módulo `apps/worker/src/implementationEvidence.ts` (determinista,
sin LLM) que calcula la **evidencia de implementación** comparando el
proyecto con la plantilla `dynamic-react-node`:

1. **Áreas clave (mecanismo 1):** `frontend/src` **y** `backend/src` deben
   diferir de la plantilla (huella SHA-256 por área). Cambiar solo
   migraciones, tests o docs no cuenta.
2. **Superficie de backend (mecanismo 2):** al menos un fichero de ruta en
   `backend/src/routes/` que la plantilla no trae, **o** un fichero de ruta
   existente (o `server.ts`) que declare más handlers
   (`.get/.post/.put/.patch/.delete/.all(`) que su homólogo de plantilla.
3. **Superficie de frontend (mecanismo 2):** `frontend/src/App.tsx`
   distinto del de la plantilla, o algún fichero nuevo en `frontend/src`.

En `verify()` (vía dinámica), si la evidencia está disponible
(`APPFORGE_TEMPLATES_DIR` localizable) sustituye a la guarda antigua: sin
evidencia no hay cierre, y el diagnóstico `NO_IMPLEMENTATION` enumera los
huecos concretos («backend/src is still the untouched starter template»,
«no new backend route surface: …») para que la reparación sea accionable.
Si la plantilla no se puede localizar, se mantiene el comportamiento
anterior (la evidencia nunca bloquea por no haber podido ejecutarse).

### Límites honestos

- La puerta garantiza «se construyó algo real, distinto de la plantilla,
  que funciona»; no puede garantizar semánticamente «es la tienda pedida».
  Ese último tramo sigue siendo del modelo (o de futuros tests de
  aceptación derivados del prompt).
- Un primer run dinámico queda obligado a tocar backend **y** frontend:
  es el contrato full-stack de la plantilla; un encargo legítimo de
  «solo API» sin UI quedaría bloqueado por esta puerta (decisión
  consciente, coherente con que la plantilla y la preview son full-stack).

## Tests (8 nuevos)

- `implementationEvidence.test.ts` (6): plantilla prístina rechazada con
  los cuatro huecos; **migración sola rechazada** (el caso pcBOX a nivel
  de ficheros); backend-solo y frontend-solo rechazados; endpoints dentro
  de un fichero de ruta existente + fichero frontend nuevo aceptados;
  cambio cosmético de backend sin superficie nueva rechazado; sin
  directorio de plantillas la comprobación se salta sin bloquear.
- `dynamicGate.test.ts` (+2 de bucle con LLM guionizado): reproducción
  completa del caso pcBOX (seis checks → migración → re-verificación →
  intentos de cierre) termina en `error` con `NO_IMPLEMENTATION` y el
  detalle de área; y el camino feliz con ruta nueva + App cambiada cierra
  en `done`.

## Verificación

- Worker: **415 ✓ / 0 ✗** (master: 407; +8 nuevos), 18 skipped
  preexistentes. Server: **110 ✓ / 0 ✗**. Typechecks de worker y server
  limpios.
- No desplegado ni fusionado a `master`: queda en la rama, como las fases
  anteriores, a la espera de la decisión del usuario.
