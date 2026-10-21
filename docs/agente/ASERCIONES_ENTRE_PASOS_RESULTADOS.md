# Aserciones de imágenes entre pasos: las pantallas intermedias ya se juzgan — RESULTADOS

**Fecha:** 2026-10-21 · **Rama:** `fix/aserciones-entre-pasos` (desde master `d023a68`) · **Estado:** completada en local, sin fusionar ni desplegar.

## El fallo real

Proyecto «T-shirts» (`497f482d`), run `fac615d3`: el run cerró **6/6 en verde** con los 40 `image_url` del catálogo apuntando a ficheros que nunca existieron y **cero** llamadas a `acquire_image`. El paquete anterior (`fix/asercion-imagenes-honesta`) acababa de desplegar el criterio honesto de imagen — respuesta de red 2xx `image/*` observada + `naturalWidth > 0` — y aun así la parrilla de productos pasó la verificación sin ser juzgada ni una sola vez.

## Causa raíz

En `apps/worker/src/browser.ts`, tanto `checkBrowser` como `checkBrowserAtUrl` ejecutaban las aserciones de imágenes solo en dos momentos: tras el `goto` (la pantalla inicial) y tras `runSteps` completo (la pantalla final, con scroll). El flujo autenticado **termina con el paso de logout**, así que:

- la pantalla inicial es el formulario de login (sin datos, sin fotos);
- la pantalla final es **otra vez el login**, tras el logout;
- el contenido autenticado — la parrilla de productos — solo existe **entre pasos** (tras el login, antes del logout), y ninguna aserción corría sobre él.

El comentario junto a la aserción post-pasos en `checkBrowserAtUrl` afirmaba lo contrario («in the authenticated flow that is the post-login content»): falso para la pantalla final. La aserción honesta era correcta; simplemente nunca se ejecutaba sobre la pantalla que importaba. El gate de errores duros tampoco cubre el hueco: las rutas inventadas no producen necesariamente fallos de red duros en el preview, y su cometido no es juzgar fotos.

## El cambio

Todo en `apps/worker/src/browser.ts`. No cambian los pasos del flujo, ni el criterio honesto de imagen (2xx `image/*` + `naturalWidth > 0`), ni el gate de errores duros, ni la evidencia (recibos, huellas, puertas intactas).

1. **Gancho `afterStep` en `runSteps`.** `runSteps` acepta un cuarto parámetro opcional, `(completed: FailedStep) => Promise<void>`, que se ejecuta tras completar cada paso con éxito. Diseño: el gancho vive en `runSteps` — no duplicado en los llamantes — para que ambos caminos compartan exactamente la misma semántica de fallo. Si el gancho rechaza, el paso que llevó a esa pantalla queda marcado vía `markFailed` (el mecanismo `failedStep` existente) y se lanza un error que lo nombra: `image assertion failed after step N/M (action "…"): <error original>`. La composición del diagnóstico es la existente (`composeFailureDiagnostic`), así que el titular queda `step N/M (action "…") failed: image assertion failed after step N/M …` y la foto/extracto de fallo se toma de la pantalla ofensora, porque los pasos se detienen ahí en vez de seguir hasta una pantalla limpia.
2. **Nueva aserción por paso, `assertImagesLoadedAfterStep(page, diag)`.** Aplica el mismo `assertImagesLoaded` (mismo criterio honesto, sin excepciones) sobre la pantalla que el paso deja, con dos diferencias respecto a la aserción final:
   - **Sin scroll completo**: las imágenes ya presentes en el DOM fueron solicitadas al renderizar; las perezosas bajo el pliegue que nunca se pidieron quedan `complete === false` y la propia aserción las salta. El scroll completo sigue existiendo donde estaba: en la aserción final (`assertImagesLoadedAfterSteps`).
   - **Espera acotada y best-effort** para que lo en vuelo se asiente: `waitForLoadState('domcontentloaded', ≤1 500 ms)` — el paso puede haber navegado — y `waitForFunction(todas las imágenes complete, ≤1 000 ms)` — una foto rota o sustituida solo es juzgable cuando su petición se asienta —. Ambas esperas van en `try/catch`: ninguna puede fallar el paso por sí misma, y una imagen que sigue cargando tras ellas simplemente no se juzga aún (la misma paciencia del criterio; una foto colgada no debe tumbar una app correcta — cf. la regresión de la recarga: la persistencia de sesión se juzga por expectativas, no por reposo de red).
   - **Inmune a la carrera de navegación del propio paso**: un paso puede disparar su navegación *después* de volver (el click de logout del flujo primero espera su llamada API y luego la app recarga), de modo que el asentamiento corre sobre el documento viejo y el muestreo muere con `Execution context was destroyed`. Eso es una carrera con el navegador, no un veredicto sobre foto alguna: la aserción espera entonces al documento nuevo (`domcontentloaded`, ≤5 s), se asienta de nuevo y juzga la pantalla que el paso deja de verdad, **una sola vez**; un segundo fallo ya es veredicto y propaga. (Sin este reintento, la primera corrida completa de la suite tumbó 4 tests del flujo autenticado exactamente en el paso 8/9, el click de logout.)
   
   Ambos llamantes conectan el gancho: `checkBrowser` y `checkBrowserAtUrl` pasan `() => assertImagesLoadedAfterStep(page, diag)` a `runSteps`.
3. **Intactas** la aserción inicial tras el `goto` y la final con scroll (baratas, cubren primera/última pantalla), y la tercera de `checkBrowser` tras el cambio a viewport móvil.
4. **Comentarios corregidos a la verdad**: el de cabecera describía las aserciones como «dos, en los extremos» y daba por cazado el catálogo post-login con la post-pasos; el de `checkBrowserAtUrl` llamaba a la pantalla final «the post-login content». Ahora la cabecera documenta los tres momentos y el caso `fac615d3`, y el comentario de `checkBrowserAtUrl` dice que la pantalla final es el login tras el logout y que el contenido intermedio lo juzgan las aserciones por paso.

**Coste por paso**: con la pantalla ya asentada (el caso común), las dos esperas resuelven en su primer sondeo y la aserción es una muestra del DOM (`evaluateAll` sobre los `<img>`): decenas de milisegundos. El peor caso acotado es ~2,5 s por paso, pagado solo mientras haya peticiones de imagen colgadas (que entonces se saltan, no se fallan).

## Tests

**Nuevos (3, en `browser.test.ts`; la suite del fichero pasa de 17 a 20):**

1. **Regresión exacta del caso real** («fails mid-flow when the content screen between steps carries a substituted photo, even if the final screen is clean»): flujo de tres pantallas — login sin imágenes → catálogo con la foto sustituida por `onError` (la firma exacta de producción: ruta 404 + swap a GIF data-URI, alt «Arsenal Away Shirt») → signed-out sin imágenes — con pasos click → expect_text → click. Los extremos están limpios; solo la aserción por paso puede fallarlo, y **falla tras el paso 1/3 nombrándolo** (`image assertion failed after step 1/3 (click "[data-testid="enter-shop"]")`), con la foto rechazada por `no valid image response observed`, la foto de fallo mostrando el catálogo y la pantalla limpia final **nunca alcanzada** (el diagnóstico no contiene «Signed out»).
2. **Contraparte sana**: la misma secuencia de tres pantallas y tres pasos, pero la foto del catálogo llega de verdad como `image/png` 2xx: todas las aserciones por paso pasan y el flujo completa los 3 pasos en verde.
3. **Vacuidad**: flujo de cuatro pasos por tres pantallas sin imágenes en ninguna: pasa entero — un conjunto vacío de fotos es un pase, no un falso positivo de las nuevas aserciones.

**Ajustado (1), documentado como cambio de semántica deliberado:**

- «fails when a step reveals a broken or empty image»: cambia **solo el título** — decía que el caso lo cazaba la aserción post-pasos sobre la pantalla final («post-steps assertion sees the final screen»); ahora lo caza la aserción por paso tras el paso que revela las fotos (verificado: el error abre con `step 1/2 (click …) failed: image assertion failed after step 1/2 …`)—. Sus expectativas (ok falso, ambas fotos nombradas) no cambian.

**Sin tocar y siguen verdes**: el resto de `browser.test.ts` — incluida la regresión de la recarga con la foto lenta de 6,5 s (las esperas acotadas de la aserción por paso la saltan mientras carga; nunca la fallan) y la regresión de sustitución sobre pantalla única del paquete anterior — y las suites de `authFlow`, `dynamicTools` y demás ficheros que ejercitan `checkBrowser`/`checkBrowserAtUrl` a través del worker completo.

## Suites

Baselines recontadas antes de tocar nada: worker 512 ✓ / 18 skipped, server 121 ✓, studio 22 ✓.

- Worker: **515 ✓ / 18 skipped** (512 de base + 3 nuevos), typecheck limpio.
- Server (121 ✓) y studio (22 ✓): sin cambios de código en esta rama; recontados como baseline, no re-ejecutados al final.
