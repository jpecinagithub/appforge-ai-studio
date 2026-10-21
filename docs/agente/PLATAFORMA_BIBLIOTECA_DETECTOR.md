# Plataforma: despliegue ↔ biblioteca + detector de compatibilidad — resultados

**Fecha:** 2026-10-21 · **Rama:** `fix/plataforma-biblioteca-detector` (desde `master` efe947b) · Sin fusionar ni desplegar.

## Pieza 1 — Al quedar un despliegue live, el proyecto debe reflejarlo

### El problema

Un proyecto desplegado hoy («PcBox online», deployment live y app sirviendo
en `/a/<id>/`) quedó con `projects.preview_url` y `projects.production_url`
**a NULL**: nada en master escribía `production_url` al desplegar — la
máquina de estados marcaba `deployments.status='live'` sin tocar la fila del
proyecto. La Library del Studio calcula «desplegada» como
`p.previewUrl != null`, así que la tarjeta mostraba «Sin desplegar», el botón
de apertura quedaba deshabilitado y el usuario no tenía vía a su app.

Agravante de la misma familia: la URL pública compartible
(`publicAppUrlFor`) se construía siempre sobre la ruta estática `/p/<id>/`.
El enlace «Abrir aplicación» del panel de Operaciones de un proyecto
**dynamic** apuntaba por tanto a `/p/<id>/`, donde el frontend carga pero los
POST a `/api/*` devuelven 404 — el «not found» que el usuario vio al intentar
registrarse en su tienda ya desplegada. (`openProjectPreview` y el
`PreviewPane` del Workspace ya enrutaban dynamic → `/a/<id>/`; la fuga era
`publicAppUrlFor`.)

### Cambios

- **`apps/worker/src/deploy/stateMachine.ts`** — en `finalizeLiveDeployment`,
  dentro de la misma transacción atómica que publica el runtime y marca el
  deployment `live`, se escribe en `projects`:
  `production_url = '/a/<projectId>/'` y `preview_url = '/a/<projectId>/'`.
  Solo en la transición a live: `failed`/`cancelled` no tocan las URL, y en
  un rollback la app sigue sirviendo en la misma `/a/<id>/` (no cambian).
  Repetir la finalización sobre un deployment ya `live` sigue siendo un
  no-op idempotente, URL incluidas.
- **`apps/studio/src/api/client.ts`**
  - `publicAppUrlFor(projectId, origin?, type = 'static')`: con
    `type === 'dynamic'` construye la URL absoluta sobre `liveAppUrlFor`
    (`/a/<id>/`); para static queda `/p/<id>/` como hasta ahora.
  - Nuevo `isProjectDeployed(project, demoMode?)`:
    `!demoMode && (productionUrl ?? previewUrl) != null` — manda la URL de
    producción; `previewUrl` queda como respaldo para filas antiguas
    (algunas solo tienen `preview_url`, incluso con ruta `/p/`).
- **`apps/studio/src/components/OperationsPane.tsx`** — «Abrir aplicación»
  usa `publicAppUrlFor(project.id, undefined, project.type)`: la app viva de
  un dynamic se abre en `/a/<id>/`, nunca en `/p/<id>/`.
- **`apps/studio/src/pages/Library.tsx`** — el filtro por despliegue, el
  contador de desplegadas y la insignia de cada tarjeta usan
  `isProjectDeployed`; el botón de apertura se habilita con ese mismo
  criterio (`disabled={!deployed}`), de modo que un proyecto con
  `productionUrl` puede abrirse aunque su `previewUrl` fuera null.

### Tests

- Worker (`deploy.test.ts`, BD SQLite real + patrón existente de la máquina):
  - la finalización a live escribe `/a/<id>/` en ambas columnas, y repetirla
    es idempotente;
  - un deployment que falla antes de live deja ambas URL a NULL.
- Studio (`client.test.ts`):
  - `publicAppUrlFor` con tipo dynamic → URL absoluta bajo `/a/`; por
    defecto (static) → `/p/` como hoy;
  - `isProjectDeployed`: true con solo `productionUrl`; true con solo
    `previewUrl` (fila antigua); false con ambas null; false en modo demo.

## Pieza 2 — El detector de compatibilidad no debe analizar URLs

### El problema

`assessTechnologyCompatibility` (`apps/server/src/compatibility.ts`) aplica
sus patrones sobre **todo** el prompt. Un encargo legítimo de tienda que
pegaba la URL verificada de la foto de un producto, servida desde un CDN con
dominio `…akamaized.net/…`, fue rechazado como «Backend .NET / C#» porque el
dominio casa con `/\b\.net\b/` (hay frontera de palabra entre el subdominio
y `.net`). El run nació muerto sin consumir una sola llamada al modelo.

### Cambios

- **`apps/server/src/compatibility.ts`** — nuevo `stripUrls` aplicado al
  corpus antes de los patrones: retira los destinos de enlaces markdown
  `](…)` y las URL con esquema (`https?://…` hasta el siguiente espacio).
  No se toca **ningún patrón ni etiqueta**; la prosa se analiza igual:
  «quiero un backend ASP.NET con C#» sigue detectándose como
  «Backend .NET / C#», y las negaciones existentes operan sobre el mismo
  texto resultante.

### Tests (`compatibility.test.ts`)

- (a) prompt de tienda con URL de imagen en dominio `.net` → compatible;
- (b) «backend ASP.NET con C#» en prosa → incompatible, como hoy;
- (c) enlace markdown con destino en dominio `.net` → compatible.

> Nota de verificación: la frase literal «backend en .NET con C#» **no** la
> detectan los patrones actuales ni antes ni después (no hay carácter de
> palabra antes del punto de «.NET» suelto, y `/\bc\s*#\b/` no casa con el
> «C#» final); el test (b) usa la forma en prosa que sí dispara la regla hoy
> (ASP.NET). Cambiar eso sería tocar los patrones, fuera de alcance.

## Resultados

- Worker: **467 ✓ / 0 ✗** (18 skipped preexistentes de integración Docker),
  con typecheck limpio. Los 2 tests nuevos están en `deploy.test.ts`
  (la suite de ese fichero pasa a 47).
- Server: **116 ✓ / 0 ✗** (113 + 3 nuevos de compatibilidad), typecheck
  limpio.
- Studio: **22 ✓ / 0 ✗** (16 + 6 nuevos) y `npm run build` (tsc + vite)
  en verde.

Nota: la cifra «worker 460» del encargo venía del estado de la rama del
diagnóstico de flujo; en `master` efe947b la suite ya sumaba 465 antes de
esta rama (465 + 2 = 467).

## Despliegue del paquete completo (21-oct-2026)

Los dos frentes del paquete (esta rama y `fix/plataforma-postlogin-presupuesto`, que ya era ancestro de esta) se fusionaron en `master` con fast-forward a `74477f5` y se redesplegaron juntos en la instancia edu con el procedimiento seguro (sin runs ni despliegues activos). Verificado dentro del contenedor healthy: aserciones post-login (`assertImagesLoadedAfterSteps`), escritura de URL al pasar a live (`production_url=?` en stateMachine), `stripUrls` en el detector, presupuesto consciente del progreso (`noteFailedVerification`) y `productionUrl` en el dist del Studio; health local y público 200.
