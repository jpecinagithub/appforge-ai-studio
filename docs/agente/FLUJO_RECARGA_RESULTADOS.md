# Flujo autenticado: la recarga ya no exige reposo de red — RESULTADOS

**Fecha:** 2026-10-21 · **Rama:** `fix/flujo-recarga-sin-networkidle` (desde master `8e243c7`) · **Estado:** completada en local, sin fusionar ni desplegar.

## El fallo real

Proyecto «T-shirts» (`497f482d`), run quirúrgico `0488ed8a`: con la tienda ya cableada al punto de entrada (tras la corrección de la puerta), `test_authenticated_flow` falló 3 veces en el mismo sitio — el paso 6/9, `reload`:

```
page.reload: Timeout 5000ms exceeded — waiting for navigation until "networkidle"
```

El propio diagnóstico de fallo demostraba que la app estaba bien: el texto visible traía el catálogo («Tienda de Camisetas Premier League», «Arsenal Away Shirt 74,99 €»…), el `[data-testid="user-email"]` con el email del usuario estaba presente, el inventario de testids era el correcto y el único fallo de red era el 401 normal de `/api/auth/me` sin sesión. La página nunca llegó a `networkidle` en 5 s porque una parrilla con ~20 fotos de producto mantiene conexiones abiertas más tiempo que eso.

## Causa raíz

El paso `reload` de `browserStep` (`apps/worker/src/browser.ts`) hacía `page.reload({ waitUntil: 'networkidle' })`. Como la página usa `page.setDefaultTimeout(5000)`, la navegación heredaba un techo de 5 s para un hecho que no es el que el paso comprueba: el paso existe para que el paso siguiente verifique que **la sesión persiste tras recargar** (la visibilidad de `[data-testid="user-email"]`), no para certificar que la red se queda vacía. Dos esperas más del mismo fichero usaban `networkidle` con el mismo desajuste de criterio: las navegaciones iniciales de `checkBrowser` y `checkBrowserAtUrl` (techo de 15 s), cuyo hecho es «la app carga y renderiza» — juzgado por la espera de contenido, las aserciones de imágenes y los pasos que siguen — y no «la red está en reposo»: una parrilla de imágenes lentas, polling o conexiones keep-alive pueden posponer el reposo más allá de cualquier techo y matar apps correctas con una mecha más larga.

Auditoría del resto: `networkidle` no aparece en ningún otro punto del worker (ni `previewManager` ni `dynamicTools` lo usan); las demás esperas del flujo ya juzgan su hecho propio (contenido no vacío con `waitForFunction`, visibilidad con locators, asentamiento fijo de 300 ms tras el scroll).

## El cambio

Todo en `apps/worker/src/browser.ts`, sin tocar pasos, aserciones ni diagnóstico:

- **Paso `reload`**: `page.reload({ waitUntil: 'domcontentloaded', timeout: 15_000 })`. Se espera solo al documento parseado — ni siquiera a `load`, que también quedaría secuestrado por las fotos — y el techo de navegación se iguala al de la navegación inicial (15 s). La persistencia de la sesión la juzga donde siempre se ha juzgado: la expectativa de visibilidad siguiente, con su timeout normal de locator (5 s). Si la sesión se pierde de verdad, el flujo falla en esa expectativa, en su paso, con su diagnóstico.
- **Navegación inicial** (`checkBrowser` y `checkBrowserAtUrl`): `waitUntil: 'load'` con el mismo techo de 15 s de antes. `load` acota la espera al documento y sus subrecursos iniciales; el reposo de red (500 ms sin conexiones) deja de ser requisito en cualquier punto del flujo.

La semántica pasa/falla del resto no cambia: las aserciones de imágenes previas y post-pasos, el gate de errores duros (pageerrors y recursos estáticos), los pasos de registro/login/logout y la composición del diagnóstico quedan como estaban.

## Tests

**Nuevos (2, en `browser.test.ts`; la suite pasa de 12 a 14):**

1. **Regresión T-shirts**: página autenticada servida en local con una foto de producto que tarda 6,5 s en responder (> el viejo techo de navegación de 5 s, < el techo de 15 s de la navegación inicial, con `Cache-Control: no-store` para que la recarga la vuelva a pedir). Secuencia `expect_text(user-email) → reload → expect_text(user-email)` — la forma de la fase de navegador del flujo — y el check **pasa** con los 3 pasos. Verificado además que el test **muerde**: contra el `browser.ts` anterior (vía `git stash` del fichero) el mismo caso falla, reproduciendo la firma de producción (la primera carga sobrevivía; moría la recarga).
2. **Contraparte**: la página pierde la sesión al recargar (un contador en `sessionStorage` sustituye el email por la pantalla de login en la segunda carga). El flujo **falla en la expectativa** — el diagnóstico abre con `step 3/3 (expect_text "[data-testid="user-email"]") failed:` — y no contiene ni `page.reload` ni `waiting for navigation`.

**Suites** (baselines recontadas antes de tocar nada: worker 507 ✓ / 18 skipped, server 121 ✓, studio 22 ✓):

- Worker: **509 ✓ / 18 skipped** (507 de base + 2 nuevos), typecheck limpio.
- Server y studio: sin cambios de código; no re-ejecutadas en esta rama.
