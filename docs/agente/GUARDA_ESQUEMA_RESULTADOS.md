# Guarda de esquema (schema contract guard) — resultados

**Fecha:** 2026-10-21 · **Rama:** `fix/agente-guarda-esquema` (desde `master` 841d82a) · Sin fusionar ni desplegar.

## El caso que la motiva

Proyecto `07007457` («PcBox online»), run `b6de6a05`: un run anterior había
reescrito `migrations/001_init.sql` desde cero y su tabla `sessions` perdió la
columna `last_seen_at`, que el código de sesión de la plantilla
(`backend/src/auth/session.ts`: INSERT con `id, user_id, token_hash,
created_at, expires_at, last_seen_at` y UPDATE al validar) escribe siempre.
Resultado: `register` devolvía 500 `ERR_SQLITE_ERROR` y `run_api_tests` cayó
en cascada a 10/17. Nadie lo detectó hasta los tests, y el diagnóstico costó
una reproducción manual. La guarda hace que sea imposible llegar tan lejos:
el esquema que producen las migraciones de un proyecto debe seguir siendo un
**superconjunto** del esquema de la plantilla servida.

## Diseño (tres capas, de temprana a autoritativa)

### 1. Introspección en `run_migrations` — la guarda autoritativa

`apps/worker/src/dynamicTools.ts`, función `checkSchemaContract`, invocada
tras la pasada de idempotencia y **antes** de `recordDynamicCheck(ctx,
'migrations')`:

- Deriva el esquema de la plantilla ejecutando sus ficheros `.sql` de
  migración directamente (orden de nombre, patrón `^\d+_.+\.sql$`) con
  `db.exec` de `node:sqlite` sobre una segunda BD temporal (dentro del
  mismo `tmpDir` que `run_migrations` ya limpia en todos los caminos).
  Sin npm, sin compilación, sin dependencias instaladas: la derivación
  funciona igual en desarrollo y en la imagen de producción, donde las
  plantillas viajan como fuentes peladas (ver «Corrección de paridad con
  producción»).
- Lee ambas BDs en modo lectura con `node:sqlite` (`readDbSchema`:
  `sqlite_master` + `PRAGMA table_info` por tabla; se excluye la tabla de
  control `migrations`, que es estado del runner y no contrato).
- `compareSchemas` (función pura, exportada y testeada): por cada tabla de la
  plantilla, el proyecto debe tener la tabla y **todas** sus columnas. Las
  tablas/columnas extra del proyecto son válidas siempre.
- Si falta algo: `fail` con código **`SCHEMA_CONTRACT_VIOLATION`**, mensaje
  que enumera cada `tabla.columna` ausente y ordena el arreglo correcto —
  añadir una migración NUEVA (siguiente número) con `ALTER TABLE ... ADD
  COLUMN`; nunca reescribir una migración ya aplicada (checksum) — y el
  check `migrations` **no se registra**.
- Localización de la plantilla: `process.env.APPFORGE_TEMPLATES_DIR` +
  `dynamic-react-node`, la misma fuente que usan `implementationEvidence` y
  `verify()` (el `ToolContext` no lleva `templateDir`; se sigue el patrón
  existente del repo).

### 2. Lint SQL al escribir — aviso en el mismo turno

`analyzeMigrationSql` / `parseCreateTableColumns` en
`apps/worker/src/backendContracts.ts` (sin dependencias, escaneo de texto,
nunca bloquea la escritura):

- Parsea los bloques `CREATE TABLE [IF NOT EXISTS]` del contenido escrito y
  extrae nombres de columna (primer token de cada definición; las líneas de
  constraint `PRIMARY KEY`/`FOREIGN KEY`/`UNIQUE`/`CHECK`/`CONSTRAINT`/
  `KEY`/`INDEX` nunca cuentan como columnas).
- Compara `users`/`sessions` contra los conjuntos requeridos derivados de la
  plantilla (`CORE_TABLE_REQUIRED_COLUMNS`). Si falta alguna, la nota nombra
  tabla y columnas, recuerda que el código auth/session de la plantilla las
  usa y que `run_migrations` lo verificará.
- Cableado en `tools.ts` (`withBackendNotes` + un parámetro de snippets de
  migraciones): se adjunta en `write_file`, `write_files` y `patch_file`
  cuando el área de la escritura es `migrations`. En `patch_file` el lint
  solo ve el texto pegado (`replace`), así que la nota solo salta si ese
  texto contiene el bloque `CREATE TABLE` completo — comportamiento buscado.

### 3. Contexto y prompt (`agent.ts`)

- `backend/src/auth/session.ts` se añade a la lista de contratos de
  plantilla inyectados en el contexto inicial dinámico (junto a
  `lib/errors.ts` y `routes/todos.ts`, añadidos con la autonomía).
- La sección «TEMPLATE API FACTS» del prompt dinámico gana el hecho (4):
  la 001 de la plantilla define `users` y `sessions` y el auth depende de
  sus columnas exactas (enumeradas); nunca reescribir la 001 para eliminar
  o renombrar tablas/columnas núcleo; tablas nuevas en 002+ y extensiones
  del núcleo solo con `ALTER TABLE` en migración nueva; `run_migrations`
  verifica el esquema resultante contra la plantilla.
- En `perform()`, la inyección de contratos al fallar se generaliza (mismo
  helper y misma cabecera «TEMPLATE CONTRACTS RELEVANT TO THIS FAILURE»):
  `run_backend_build` sigue adjuntando `lib/errors.ts` + `db/index.ts`, y
  un `run_api_tests` fallido adjunta ahora el `auth/session.ts` del
  proyecto — los tests de API ejercitan register/login, cuyos 500 nacen del
  esquema de sesiones.

## Corrección de paridad con producción (21-oct-2026, segundo commit de la rama)

La primera versión derivaba el esquema de la plantilla ejecutando su
`npm run migrate`. Eso funcionaba en desarrollo pero NO en producción: la
imagen Docker copia `templates/` como código fuente (`COPY templates
templates` en `infra/Dockerfile`), sin instalar las dependencias del
backend de la plantilla, y el `migrate` de la plantilla empieza
compilando ese backend. Comprobado empíricamente sobre una copia pelada:
`sh: 1: tsc: not found`. La guarda se saltaba a sí misma con su nota justo
en el entorno que importa.

La derivación final es la ejecución directa de SQL descrita en la capa 1:
los `.sql` de la plantilla se aplican en orden sobre una BD temporal con
`node:sqlite` y el resultado pasa por los mismos `readDbSchema` /
`compareSchemas` ya existentes. Sin `runLive`, sin npm, sin dependencias
externas. El lado del proyecto no cambia: su esquema sale de la
`verify.db` real que `run_migrations` ya produce, y la tabla de control
`migrations` sigue excluida de la comparación (la BD derivada por `exec`
directo ni siquiera la crea; la `verify.db` del proyecto sí puede
tenerla, y `readDbSchema` la excluye en ambos lados).

Tests de paridad obligatorios (`dynamicTools.test.ts`): el fixture de
plantilla de la guarda es ahora un árbol pelado con la forma de
producción (sin `node_modules` y con el `migrate` real, que compila
primero y no puede ejecutarse allí), y dos tests adicionales copian la
plantilla REAL del repo sin `node_modules` en ninguna parte (verificado
recorriendo el árbol) y comprueban que la guarda sigue activa y actúa en
ambos sentidos: `sessions` sin `last_seen_at` →
`SCHEMA_CONTRACT_VIOLATION` nombrándola y sin registrar el check; la 001
de la plantilla verbatim → `run_migrations` ok.

## Límites honestos

- **Fallback silencioso anotado:** si `APPFORGE_TEMPLATES_DIR` no está
  definido, la plantilla no se localiza, algún `.sql` de la plantilla
  falla al ejecutarse sobre una BD vacía o la introspección misma lanza,
  la guarda se **salta** y deja una nota en el output de `run_migrations`
  (la misma filosofía que el fallback de `implementationEvidence`). Nunca
  convierte un entorno no verificable en un check fallido.
- **Paridad con producción resuelta:** la derivación por SQL directo
  solo necesita `node:sqlite`, presente donde corre el worker, así que la
  introspección está activa también en la imagen de producción con las
  plantillas como fuentes peladas (verificado por los tests de paridad
  contra la copia pelada de la plantilla real). Las capas 2 y 3 (lint al
  escribir, prompt, contexto e inyección de `session.ts`) actúan
  igualmente en cualquier entorno.
- **La comparación es contra la plantilla servida AHORA**, no contra la
  versión de la plantilla con la que se creó el proyecto: un proyecto creado
  con una plantilla antigua que difiera de la actual puede ser marcado
  aunque su esquema fuera fiel al nacer; el arreglo prescrito (migración
  nueva con `ALTER TABLE`) es también el camino de actualización correcto.
- La guarda compara **nombres de tabla y columna** (presencia), no tipos,
  defaults ni índices: es un contrato de superficie, el mismo nivel al que
  el código de la plantilla acopla sus consultas. La tabla de ejemplo
  `todos` también forma parte del superconjunto exigido mientras la
  plantilla la traiga.
- El lint SQL es escaneo de texto: entiende el estilo de `CREATE TABLE` de
  la plantilla y de SQL manuscrito razonable; construcciones exóticas
  (p. ej. columnas generadas dinámicamente) pueden escapar a la nota — por
  eso la capa autoritativa es la introspección sobre la BD aplicada, no el
  lint.

## Tests

13 tests nuevos (los demás fixtures existentes no necesitaron ajuste: los
de `dynamicTools.test.ts` que no definen `APPFORGE_TEMPLATES_DIR`
ejercitan el skip con nota, y en `dynamicGate.test.ts` proyecto y
plantilla stub son el mismo árbol → el superconjunto se cumple). El
fixture de plantilla de la propia guarda sí cambió con la corrección de
paridad: pasó de un `migrate` falso ejecutable a un árbol pelado con la
forma de producción:

- `backendContracts.test.ts` (+6): parseo de columnas de la 001 fiel;
  constraints nunca cuentan como columnas; 001 fiel → silencio; `sessions`
  sin `last_seen_at` → nota que la nombra (el caso pcBOX); `users` sin
  `display_name` → nota; tablas no núcleo y `ALTER TABLE` → silencio.
- `dynamicTools.test.ts` (+7): unidades puras de `compareSchemas`
  (superconjunto pasa; columna ausente nombrada; tabla ausente enumera sus
  columnas) y de `readDbSchema` (introspección real, `migrations`
  excluida); extremo a extremo contra el fixture pelado: 001 con
  `sessions` sin `last_seen_at` → `SCHEMA_CONTRACT_VIOLATION` nombrando
  `sessions.last_seen_at`, check NO registrado y temporales limpios; 001
  fiel + tabla de dominio extra → ok; sin dir de plantillas → skip con
  nota y check registrado; y los dos tests PARITY contra la copia pelada
  de la plantilla real del repo (violación y fiel), descritos en
  «Corrección de paridad con producción».

Resultados: worker **437 ✓ / 0 ✗** (baseline 424 + 13 nuevos; 18 skipped de
integración Docker, como siempre), server **110 ✓ / 0 ✗**, typecheck del
worker (`npx tsc --noEmit -p tsconfig.json` en `apps/worker`) limpio.

## Ficheros tocados

- `apps/worker/src/dynamicTools.ts` — introspección y comparación de
  esquemas + gancho en `runMigrations`.
- `apps/worker/src/backendContracts.ts` — `analyzeMigrationSql`,
  `parseCreateTableColumns`, `CORE_TABLE_REQUIRED_COLUMNS`,
  `migrationSqlNote`.
- `apps/worker/src/tools.ts` — cableado de la nota SQL en las tres
  herramientas de escritura.
- `apps/worker/src/agent.ts` — `session.ts` en contratos, hecho (4) del
  prompt, inyección generalizada en `perform()`.
- Tests: `apps/worker/src/backendContracts.test.ts`,
  `apps/worker/src/dynamicTools.test.ts`.
- Docs: este fichero + apéndice en `docs/agente/PLAN.md`.

## Despliegue (21-oct-2026)

Fusionada en `master` (fast-forward a `bee0701`) y redesplegada en la instancia edu con el procedimiento seguro (sin runs activos, mod local del compose conservada). Verificado dentro del contenedor healthy: `SCHEMA_CONTRACT_VIOLATION` y `deriveTemplateSchema` en `dynamicTools.ts`, `auth/session.ts` en los contratos de `agent.ts`, y la plantilla servida SIN `backend/node_modules` — la condición pelada de los tests PARITY — con su `migrations/001_init.sql` presente: la derivación por SQL directo opera también en este entorno. Health local y público 200.
