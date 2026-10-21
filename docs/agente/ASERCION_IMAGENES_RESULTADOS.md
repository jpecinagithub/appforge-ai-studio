# Aserción de imágenes honesta: la sustitución por onError ya no cuenta como foto cargada — RESULTADOS

**Fecha:** 2026-10-21 · **Rama:** `fix/asercion-imagenes-honesta` (desde master `2ad4781`) · **Estado:** completada en local, sin fusionar ni desplegar.

## El fallo real

Proyecto «T-shirts» (`497f482d`), ya desplegado y sirviendo la tienda: los productos guardan `image_url` con rutas absolutas a ficheros que nunca existieron (`/assets/products/arsenal-away.jpg`, …) y la tarjeta (`ProductCard`) lleva un `onError` que sustituye cada foto rota por un marcador visual en línea. En producción se ven recuadros vacíos; la verificación, en cambio, había cerrado en verde.

## Causa raíz

Las aserciones de imágenes del flujo (`assertImagesLoaded` / `assertImagesLoadedAfterSteps` en `apps/worker/src/browser.ts`, del paquete «navegador post-login») juzgaban una foto por su estado en el DOM: `complete && naturalWidth === 0` = rota. Tras la sustitución del `onError`, el `<img>` apunta a un data-URI válido, termina `complete` con `naturalWidth > 0` y el criterio lo contaba como foto cargada — renderizaba píxeles, pero no los de ninguna foto real: la respuesta de red del fichero pedido nunca existió. Era el punto ciego ya documentado en la saga de pcBOX («el onError→placeholder puede enmascarar fotos rotas»), anotado entonces y mordido ahora en producción.

## El cambio

Todo en `apps/worker/src/browser.ts`; no cambian ni las pantallas que se visitan, ni los pasos del flujo, ni los topes del diagnóstico, ni la evidencia (recibos, huellas, puertas intactas).

1. **Registro de respuestas de imagen.** El listener de `response` de `attachPageDiagnostics` registra ahora TODAS las respuestas de recursos de tipo `image` (antes solo miraba los fallos ≥400): `PageDiagnostics` gana `imageResponses`, un `Map` claveado por URL sin query con `{ status, contentType, valid }`, donde `valid` = estado 2xx y content-type `image/*`. Regla de permanencia: una observación válida es prueba de que los bytes llegaron y nunca la desplaza una inválida posterior (una revalidación de caché o una página de error reintentada no «des-prueba» una foto que cargó); una inválida cede ante cualquier observación posterior (un reintento que al final sirve la imagen real sustituye al fallo anterior).
2. **Criterio honesto de «imagen cargada»**, aplicado en todos los puntos donde hoy se afirma — `checkBrowser` (inicial, post-pasos y viewport móvil) y `checkBrowserAtUrl` (inicial y post-pasos), vía `assertImagesLoaded(page, diag)` / `assertImagesLoadedAfterSteps(page, diag)`. Un `<img>` completado se rechaza cuando:
   - no renderizó datos (`naturalWidth === 0`) — el fallo clásico, con el motivo `no image data rendered (naturalWidth 0)`; o
   - renderizó píxeles pero su `currentSrc` no tiene respuesta válida observada en el registro — motivo `no valid image response observed (possible error substitution or missing resource)` (la «sin respuesta de imagen válida (posible sustitución por error o recurso ausente)» del encargo). La sustitución por data-URI no produce respuesta de red alguna: no puede satisfacer el criterio.
   
   Las imágenes aún cargando (`complete === false`) siguen sin juzgarse, la misma paciencia de antes. El error conserva la cabecera `Broken images detected:` y lista cada rechazada con su `alt`, su src (truncado a 160 caracteres para que un data-URI no sature el diagnóstico) y su motivo, distinguiendo los dos casos.
3. **El placeholder oficial queda intacto como vía honesta**: es un fichero real que la app sirve (`public/placeholder-illustrative.svg`), llega como respuesta 2xx `image/svg+xml` y satisface el criterio por sus propios méritos — además de ir declarado como degradación en el resumen del run por el libro de degradaciones. Lo que ya no pasa es la sustitución en línea sin procedencia.

## Tests

**Nuevos (3, en `browser.test.ts`; la suite pasa de 14 a 17):**

1. **Regresión T-shirts**: tarjeta de producto cuyo `<img>` apunta a `/assets/products/arsenal-away.jpg` (ruta 404) con un `onError` que lo sustituye por un GIF data-URI válido. La aserción **falla** nombrando la imagen («Arsenal Away Shirt») con el motivo de sustitución, y el diagnóstico **no** contiene el veredicto `naturalWidth 0` (la imagen sustituida sí renderizó píxeles). Verificado que el test **muerde**: contra el `browser.ts` anterior (vía `git stash` del fichero) el mismo caso pasa la aserción (solo cae por el gate de red dura del 404, sin nombrar sustitución alguna) y el test falla.
2. **Contraparte A/B**: la misma página y el mismo `onError`, pero la URL sirve bytes reales (200, `image/png`): el manejador nunca se dispara, la respuesta observada prueba la foto y el check **pasa**.
3. **Placeholder de plataforma**: página con `<img src="/placeholder-illustrative.svg">` servido en 2xx como `image/svg+xml` (fixture calcado del asset real, 800×600): el check **pasa**.

**Ajustados (2), ambos documentados como cambio de semántica deliberado:**

- «passes when the image revealed by a step is healthy»: la foto «sana» era un GIF **data-URI en línea** — sin respuesta de red, indistinguible de una sustitución con el criterio honesto. La foto sana pasa a servirse como `image/png` real vía ruta del servidor de test (la fixture `servePage` gana `contentType` y cuerpo `Buffer` en sus rutas, cambio solo de test). Es el caso (ii) del encargo con la forma «revelada por un paso» que ya tenía el test.
- El literal de `PageDiagnostics` en «caps the composed diagnostic…» gana el campo `imageResponses: new Map()` (cambio de forma, no de semántica).

**Sin tocar, y siguen verdes** (caso (iv) del encargo): «rejects a bundle with a broken image» (404 sin sustitución → `naturalWidth 0`) y «fails when a step reveals a broken or empty image» (rota y vacía tras un paso).

**Suites** (baselines recontadas antes de tocar nada: worker 509 ✓ / 18 skipped, server 121 ✓, studio 22 ✓):

- Worker: **512 ✓ / 18 skipped** (509 de base + 3 nuevos), typecheck limpio.
- Server y studio: sin cambios de código; no re-ejecutadas en esta rama.
