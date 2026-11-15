# SC Grabber

Extensión de Chrome (Manifest V3) que descarga la pista de SoundCloud abierta, o una
playlist completa, como `.m4a` con metadatos y portada. Todo ocurre en tu navegador:
sin servidor, sin claves de terceros y sin dependencias externas en tiempo de ejecución.

## Instalación (extensión descomprimida)

Requiere Chrome 120 o posterior. No hay que compilar nada.

1. Descarga el proyecto: **Code → Download ZIP** y descomprímelo, o bien
   `git clone` de este repositorio.
2. Abre `chrome://extensions` en Chrome.
3. Activa **Modo de desarrollador** (arriba a la derecha).
4. Pulsa **Cargar descomprimida** y elige la carpeta que contiene `manifest.json`.
5. Opcional: fija el icono de SC Grabber en la barra de extensiones.
6. Si ya tenías pestañas de SoundCloud abiertas, la extensión se inyecta sola; si no
   ves el botón, recarga la pestaña.

Para actualizar: sustituye los archivos y pulsa el icono de recarga de la extensión en
`chrome://extensions`.

## Uso

- **En una pista**: botón **Descargar M4A** junto al de Like.
- **En una playlist o álbum**: botón **Descargar playlist M4A** en la cabecera y un
  botón pequeño en cada fila para bajar pistas sueltas.
- **Popup** (icono de la extensión): pega una URL de pista o playlist, elige calidad,
  descarga la playlist de la pestaña activa y consulta la última descarga.
- **Panel lateral** (botón *Ver cola* del popup): progreso por pista
  (segmentos/total), cancelar, reintentar, quitar y limpiar terminadas.
- **Opciones**: subcarpeta dentro de Descargas, patrón de nombre, segmentos en
  paralelo, saltar existentes, incrustar portada y gestión del `client_id`.

Los archivos se guardan en la subcarpeta `SoundCloud` dentro de la carpeta de
descargas de Chrome (se puede cambiar o dejar vacía en Opciones). El patrón por defecto es
`{artist} - {title}.m4a`; variables disponibles: `{artist} {title} {album} {genre}
{year} {date} {id} {index}`. Se sanean `\ / : * ? " < > |`, el nombre se trunca a 180
caracteres y las colisiones se resuelven con sufijo ` (2)`, ` (3)`…

La cola se guarda en `chrome.storage.local`: puedes cerrar la pestaña de SoundCloud o
el panel y la descarga continúa; tras reiniciar el navegador, lo que quedó a medias se
reanuda.

## Cómo funciona

| Contexto | Archivo | Responsabilidad |
| --- | --- | --- |
| Content script | `content/content.js` | Lee `window.__sc_hydration`, inyecta el botón (shadow DOM cerrado) |
| Service worker | `background.js` | Enruta mensajes, persiste la cola, `chrome.downloads`, badge |
| Offscreen document | `offscreen.js` | Cola, descarga de segmentos HLS, ffmpeg.wasm |

1. El content script toma los datos de la pista de la hydration del HTML (sin llamar a
   `/resolve`). Si has navegado dentro de SoundCloud y la hydration ya no corresponde
   a la URL, o si pegas una URL en el popup, se resuelve con `api-v2.soundcloud.com`.
2. Formato, en orden estricto: AAC por HLS → MP3 progresivo → MP3 por HLS. Los dos
   últimos se recodifican a AAC 256 kbps.
3. El offscreen descarga los segmentos en paralelo (8 por defecto, reintentos con
   backoff exponencial y timeout de 30 s), los concatena y los pasa a ffmpeg.wasm
   (`-c:a copy -movflags +faststart`), con metadatos y la portada `-original`.
4. El resultado se entrega al service worker como blob URL y se guarda con
   `chrome.downloads`.

Si ffmpeg.wasm no arranca, se guarda el MP3 progresivo (o el AAC tal cual llega) y la
cola avisa de que el archivo no es un M4A con metadatos.

## Diferencias respecto a la especificación original

SoundCloud ha cambiado cosas y la extensión se adapta a lo que sirve hoy
(comprobado en noviembre de 2026):

- **El AAC por HLS ya no es MPEG-TS, es fMP4**: el `.m3u8` trae `#EXT-X-MAP` con un
  `init.mp4` y segmentos `.m4s`. Se descarga el init más los segmentos y se pasan a
  ffmpeg como `.mp4` en lugar de `.ts`. Los `.ts` y el MP3 por HLS siguen soportados.
- **Los segmentos AAC se sirven desde `*.soundcloud.cloud`**, dominio que no estaba en
  la lista de `host_permissions`. Se ha añadido; sin él, las descargas fallan por CORS.
- **`side_panel` exige el permiso `sidePanel`**, también añadido.
- El transcoding `abr_sq` devuelve 404 y se ignora. Muchas pistas recientes ya no
  ofrecen MP3 progresivo, así que el respaldo sin ffmpeg para ellas es el AAC sin
  remuxar.

## Limitaciones

- **La API no es pública.** `api-v2.soundcloud.com` y el formato de la hydration no
  están documentados y pueden cambiar sin aviso; si SoundCloud renombra las clases del
  DOM, el botón puede dejar de aparecer (el popup seguirá funcionando).
- **El `client_id` caduca.** La extensión lo renueva sola, pero puede fallar
  temporalmente.
- **Uso personal.** Descarga solo contenido para el que tengas permiso (tus propias
  pistas, licencias Creative Commons, descargas autorizadas por el autor) y respeta
  los términos de SoundCloud y los derechos de autor.
- **Sin DRM.** Las pistas que solo se sirven cifradas no se descargan; la extensión no
  intenta saltarse ninguna protección.
- **Sin sesión.** Las peticiones no llevan tus cookies: no se obtiene calidad Go+ ni
  pistas privadas sin enlace secreto; de las pistas de pago solo llega el fragmento.
- «Saltar existentes» consulta el historial de descargas de Chrome, no el disco: si
  borras el historial, no detectará archivos antiguos.
- El primer muxing tarda unos segundos (carga de 32 MB de WebAssembly).

## client_id: ver, borrar y reasignar

El `client_id` se obtiene de la propia página de SoundCloud (hydration `apiClient`) o,
si hace falta, de sus bundles JS, y se guarda en `chrome.storage.local`.

- **Verlo o borrarlo**: Opciones → *client_id de SoundCloud* → **Borrar caché**. La
  siguiente descarga obtiene uno nuevo.
- **Fijar uno a mano**: Opciones → *Usar siempre este client_id* → pega los 32
  caracteres → **Guardar**. Déjalo vacío para volver al modo automático.
- **Desde la consola** del service worker (`chrome://extensions` → *service worker*):
  `chrome.storage.local.remove('clientId')`.
- Si la API rechaza el `client_id` (401/403), la extensión lo descarta y busca otro
  automáticamente una vez antes de mostrar el error.

## Estructura

```
manifest.json
background.js            service worker
offscreen.html / .js     cola + pipeline
content/content.js       botón inyectado
content/inject.css
popup.html / .js
sidepanel.html / .js
options.html / .js
ui.css                   estilos compartidos de las páginas
lib/messages.js          contrato de mensajería
lib/errors.js            errores tipados
lib/naming.js            patrón, saneado, colisiones
lib/hls.js               m3u8, reintentos, segmentos
lib/mux.js               wrapper de ffmpeg.wasm
lib/ffmpeg-worker.js     worker que aloja el core
lib/soundcloud.js        client_id, resolve, transcodings
lib/settings.js, lib/i18n.js
_locales/es, _locales/en
icons/                   16, 32, 48, 128
vendor/                  ffmpeg-core.js + ffmpeg-core.wasm
```

## Componentes de terceros

`vendor/ffmpeg-core.js` y `vendor/ffmpeg-core.wasm` son el build single-thread de
[`@ffmpeg/core` 0.12.10](https://github.com/ffmpegwasm/ffmpeg.wasm), sin modificar,
con licencia GPL-2.0-or-later. Su código fuente está en ese repositorio. Consulta
`vendor/NOTICE.md`.
