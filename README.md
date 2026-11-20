# WEBTOON para Kino

Plugin de Kino para leer webcómic de **webtoons.com** (el sitio oficial de WEBTOON):
inicio por géneros, biblioteca, favoritos, historial, búsqueda, detalle de obra con
todos sus capítulos y lector vertical (tira y modo páginas), con progreso de lectura.

- **Requisitos:** Kino **0.9.83 o superior** (`apiVersion 22`).
- **Capacidades:** `screen`, `progress`, `shared` (el progreso y las listas se sincronizan entre tus aparatos vinculados).
- **Categoría:** manga.

## Qué incluye

| Pantalla | Qué hace |
| --- | --- |
| Inicio | «Seguir leyendo» (tu progreso) + secciones de Drama, Fantasy, Romance y Action + atajos a todos los géneros. |
| Biblioteca | Las obras que abriste, con el capítulo al que llegaste. |
| Favoritos | Las obras que marcaste con el corazón. |
| Historial | Lo que leíste, con barra de progreso; toca una tarjeta para continuar. |
| Buscar | Busca por nombre y muestra resultados en cuadrícula. |
| Género (`genero`) | Obras destacadas de un género y atajos a los demás. |
| Detalle (`detail`) | Portada, sinopsis, autor, «Leer/Continuar Cap. N», favorito y lista de capítulos paginada. |
| Lector (`read`) | Tira vertical con zoom o modo páginas (cuando el aparato lo permite), capítulos anterior/siguiente, barra de progreso y guardado de historial/biblioteca/progreso. |

## Probándolo en local

El kit (`sdk/`) está copiado dentro de este proyecto y `contract.json` queda al lado,
como lo pide el SDK.

```powershell
# 1) Validación (debe terminar en "✓ Kino would accept this plugin", sin "✗")
node sdk/validate.mjs .

# 2) Pantalla principal
node sdk/run.mjs . screen

# 3) Los temporizadores ("every") solo se ven con --raw
node sdk/run.mjs . --raw screen

# 4) Cada invocación corre en un proceso nuevo: el trabajo pendiente se deriva
#    del route y del almacenamiento, así que se simula con un ticke y luego
#    volviendo a pintar:
node sdk/run.mjs . screenEvent tick
node sdk/run.mjs . screen

# 5) Otras pantallas (el route viaja en el contexto)
$ctx = '{"route":{"name":"detail","params":{"t":"1049","href":"https://www.webtoons.com/en/drama/lookism/list?title_no=1049"}}}'
node sdk\run.mjs --context ($ctx.Replace('"','\"')) . screen
node sdk\run.mjs --context ($ctx.Replace('"','\"')) . screenEvent tick

# 6) Búsqueda, pestañas y aparato de TV
node sdk/run.mjs . screenEvent buscar "tower" --trigger submit
node sdk/run.mjs --state ('{"tab":"buscar"}'.Replace('"','\"')) . screen
node sdk/run.mjs --device tv . screen
```

Los archivos `.kino-*.json` que genera el kit son de prueba: ya están en `.gitignore`.

## Cómo funciona por dentro

- **`screen()` es una vista pura**: solo arma el árbol desde `kino.storage` (JSON) y
  desde el `route`. La red ocurre únicamente en `screenEvent`.
- **Nada bloquea la pantalla**: cuando falta dato, la vista pinta esqueletos y añade
  `every: { ms: 1500, event: "tick" }`. Cada ticke ejecuta **una sola** tarea de red
  (una sección de Inicio, el detalle, una página de capítulos o el capítulo abierto)
  y devuelve `{ state: { rev } }` para que Kino vuelva a llamar `screen()`.
  El trabajo pendiente se calcula con `tareasParaRuta(route)`: no hay cola en memoria,
  así que sobrevive a cualquier reinicio del proceso.
- **Fallos:** cada tarea fallida espera 45 s antes de reintentar y se rinde a la
  tercera; entonces la vista ofrece «Reintentar» y se avisa con un `toast`. Los
  ticks nunca lanzan (tres fallos seguidos apagan el temporizador).
- **Imágenes:** las de `pstatic` exigen la cabecera `Referer` de webtoons.com
  (403 sin ella, 200 con ella), así que todo `Image` lleva `headers`.
- **HTML mal formado:** webtoons.com cierra mal sus etiquetas, así que el scraping
  abre un bloque por marca de apertura y corta en su cierre (`bloques()`).

## Límites respetados

600 nodos por pantalla (el lector llega a ~190 con un capítulo de 170 imágenes),
500 elementos por lista, estado de 64 KB, `arg` de 4096 caracteres, almacenamiento
de 256 KB (unas 60 KB en uso), 3 temporizadores como máximo con un mínimo de
1000 ms y sin `setTimeout`/`fetch`/`import` a nivel superior.

## Publicar

1. Crea un repositorio **público** en GitHub con el topic `kino-plugin`.
2. Sube esta carpeta (`kino-plugin.json`, `plugin.js`, `README.md`, `sdk/`,
   `contract.json`, `kino.d.ts`).
3. En Kino: *Añadir plugin* → pega la URL del repositorio.

> No se publica nada desde aquí sin tu permiso.

## Aviso

Este plugin solo lee contenido público de webtoons.com para mostrártelo en Kino.
Todos los derechos de las obras pertenecen a sus autores y a WEBTOON. Sin anuncios,
sin descargas y sin alterar el contenido: la lectura respeta las condiciones del sitio.
