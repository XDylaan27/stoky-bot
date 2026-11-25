# Stoky Bot

## Render

Servicio gratuito: https://stoky-bot.onrender.com/health. Arranque remoto: npm run start:cloud; Node.js 24. Los despliegues son manuales para evitar reinicios inesperados al subir cambios.

La sesion completa de Baileys se guarda cifrada con AES-256-GCM en Supabase a traves de una funcion privada, junto con las llaves dinamicas y el estado del bot. STOKY_STATE_URL, STOKY_STATE_TOKEN y STOKY_STATE_KEY se configuran exclusivamente como secretos del servidor. No subir .env.cloud.local ni auth_info_baileys. Perder la clave de cifrado impide recuperar la sesion.

Un bloqueo de 90 segundos, renovado cada 20 segundos, evita conexiones simultaneas entre despliegues. La nueva instancia espera mientras la anterior libera la sesion. Las claves de autenticacion se guardan en cada actualizacion; preferencias e historial se guardan cada 20 segundos y al cerrar ordenadamente. Una caida abrupta puede perder hasta ese intervalo de preferencias, no implica que deba generarse un QR nuevo.

Supabase Cron consulta /health cada cinco minutos (job stoky-render-health). No consume RapidAPI. El endpoint informa whatsapp=open cuando la conexion esta lista. Render gratuito puede reiniciar o suspender el servicio por limites; el monitor no garantiza disponibilidad absoluta. Una sesion revocada por WhatsApp requiere volver a vincular.

Mientras Render este conectado, no ejecutar npm start en el portatil con la copia antigua de la misma sesion. Antes de volver al equipo local, detener Render y recuperar la version mas reciente de la sesion. El bloqueo remoto no protege ejecuciones locales con archivos antiguos.

TIKTOK_DEBUG=false desactiva las trazas de conversion y las muestras de diagnostico. Se conservan errores y avisos operativos.

Bot de WhatsApp que convierte multimedia de comentarios de TikTok a stickers WebP. Usa Baileys, ScrapTik/RapidAPI, FFmpeg y node-webpmux.

## Arranque

Requiere Node.js 20 o superior. Ejecuta npm ci, copia .env.example a .env y configura ALLOWED_JID (tu numero autorizado con codigo de pais) y RAPIDAPI_KEYS (una o varias claves separadas por coma con acceso a ScrapTik). Ejecuta npm start y escanea el QR con la cuenta de WhatsApp del bot. Alternativamente configura PAIRING_NUMBER con el numero del bot para obtener un codigo de vinculacion. Los comandos administrativos se envian desde la cuenta vinculada: ALLOWED_JID autoriza uso, no concede administracion.

En Windows/Linux se intenta usar FFmpeg incluido; en Termux instala FFmpeg del sistema.

## Comandos

- iniciar-bot / pausar-bot: activa o pausa conversiones de enlaces para ese chat. Los comandos siguen disponibles.
- stoky estado, stoky ayuda, stoky admin, stoky-quota
- stoky catalogo, sticker A1, stickers A1 A2
- unirme CODIGO
- Desde la cuenta vinculada: stoky private, stoky public, stoky invite, stoky kick NUMERO, stoky historia, stoky newkey CLAVE.

Arranca privado si no existe estado guardado. Conserva el modo existente al reiniciar. La pausa se guarda en disco. No compartas .env ni auth_info_baileys.

## Catalogo y configuracion

SUPABASE_URL y SUPABASE_KEY son opcionales. Sin ellas funciona el catalogo local. Para publicar necesitas el bucket stoky-stickers y la tabla stoky_stickers con code unico, title, preview_url y cid. Al iniciar se recupera el catalogo remoto y sus archivos; si un codigo local corresponde a otro comentario, se conserva el publicado y se asigna un codigo libre al nuevo.

Los archivos nuevos usan nombres con hash y se insertan sin sobrescribir. Esta sincronizacion requiere SELECT e INSERT en la tabla y SELECT e INSERT sobre el bucket; no requiere UPDATE publico. Los fallos se reintentan cada minuto y sobreviven al reinicio. CATALOG_URL define el enlace compartido. El orden es numerico dentro de cada grupo: A1, A2, ... A10, B1.

Para futuras actualizaciones de registros protegidos, usa una identidad autenticada del bot con politicas RLS de SELECT/UPDATE limitadas a sus datos. Alternativamente, el proceso privado del bot admite SUPABASE_SERVICE_ROLE_KEY; esta clave evita RLS y nunca debe estar en el frontend ni en variables NEXT_PUBLIC_. No se necesita para insertar los stickers con los permisos actuales.

Los codigos siguen A1..Z10, AA1, etc. El indice corrupto detiene el arranque para evitar sobrescribirlo. Conserva copias de data y de la sesion.

MAX_COMMENT_PAGES limita el coste de busqueda (10 por defecto, maximo 100). No garantiza encontrar cualquier comentario: respuestas no incluidas por el proveedor, comentarios eliminados o fuera de esas paginas siguen sin estar disponibles. La cuota inicial es desconocida hasta recibir cabeceras de RapidAPI; el saldo mide solicitudes, no stickers.

Se mantienen pausas de lectura, escritura y envio; los envios se serializan y las conversiones tienen cooldown configurable. Esto no garantiza evitar bloqueos de WhatsApp.

## Verificacion

Ejecuta npm test para las regresiones y pruebas de integracion locales. No necesitan credenciales reales ni WhatsApp vinculado. Las pruebas reales contra ScrapTik y la entrega final por WhatsApp si requieren configuracion y una cuenta vinculada.

## Estado de compatibilidad animada

Las animaciones WebP se decodifican con libwebp (WebAssembly incluido en node-webpmux), se componen respetando blend/dispose y se convierten a fotogramas completos de 512x512 con fondo transparente. Se limita a 6 segundos, 180 fotogramas de entrada y un lienzo de hasta 1024x1024 pixeles equivalentes. Se comprime hasta 480 KiB antes de agregar metadatos. Los archivos antiguos no se migran automaticamente. La comprobacion en WhatsApp Web y movil sigue siendo necesaria.

El host tiktok-scraper7 usa /comment/list y recibe el identificador de video en url. Las pruebas de rotacion usan respuestas simuladas: no certifican suscripcion ni cuota real.

## Conversion y diagnostico

Cada conversion usa una carpeta temporal exclusiva con input y output separados, incluso cuando ambos son WebP. Se eliminan al terminar o fallar. Se respetan FFMPEG_PATH y un timeout de 60 segundos. El formato se decide por los bytes descargados, no por el nombre animated_url de ScrapTik. Los WebP estaticos grandes se comprimen progresivamente y todos los resultados se validan (512x512, tamano y metadatos) antes del envio.

Con TIKTOK_DEBUG=true se registran la descarga, formato real, comando FFmpeg y resultado en scratch/tiktok-debug.jsonl. Se conserva el ultimo archivo descargado en scratch/last-media-download.bin para reproducir fallos sin gastar otra consulta. Los errores status_code de ScrapTik se detectan antes de buscar comentarios. Las pruebas integradas utilizan HTTP local, el binario real de FFmpeg, libwebp y la preparacion cifrada de Baileys con subida simulada; no envian mensajes ni consumen RapidAPI.

## Formatos de fotos de ScrapTik

Las fotos pueden llegar en image_list con origin_url o crop_url. El detector conserva las URLs alternativas de la misma imagen, prefiere las versiones JPEG/PNG/WebP explicitas y usa otro servidor/formato si falla la descarga o conversion (maximo seis intentos sin repetir la consulta RapidAPI). Los stickers animados conservan sus URLs animadas; no se sustituyen silenciosamente por otro comentario ni por una imagen estatica. La respuesta real que expuso este caso esta en test/fixtures/scraptik-photo-comment.json, con firmas y hosts reemplazados.

