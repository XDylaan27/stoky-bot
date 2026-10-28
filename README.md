# 🤖 Stoky Bot - TikTok Sticker Bot para WhatsApp

Bot inteligente y modular de WhatsApp desarrollado con **Node.js**, **Baileys**, **wa-sticker-formatter**, **FFmpeg** y **Axios**. Permite convertir automáticamente comentarios con fotos/stickers de TikTok en stickers de WhatsApp, gestionar un catálogo local con consumo cero de cuota, administrar claves dinámicas de RapidAPI y controlar el acceso mediante un sistema seguro de invitaciones y modo privado.

---

## 🌟 Características Principales

- 🎯 **Conversión Automática:** Envía cualquier enlace de comentario de TikTok con foto o sticker y Stoky lo convertirá en sticker de WhatsApp al instante.
- 🔑 **Pool de Multi-Keys & Failover:** Soporte para múltiples claves de RapidAPI (`ScrapTik`) con rotación automática ante cuotas agotadas o errores.
- ⚡ **Comando Dinámico de Claves:** Agrega nuevas API keys en caliente desde WhatsApp (`stoky newkey <clave>`) sin reiniciar el bot.
- 🔒 **Modo Privado & Sistema de Invitaciones:**
  - Control de acceso por lista blanca (`whitelist`).
  - Generación de códigos de invitación de un solo uso (`stoky invite` ➔ `unirme STK-XXXX`).
  - Gestión remota de permisos (`stoky kick <numero>`).
- 📊 **Auditoría e Historial:** Registro detallado de usuarios, stickers creados y detección de comentarios que requirieron paginación profunda (`stoky historia`).
- 📚 **Catálogo Integrado (0 Cuota API):** Catálogo de stickers locales servidos directamente desde caché sin consumir peticiones (`stoky catalogo`, `sticker A1`, `stickers A1 A2`).
- 🛡️ **Protecciones Anti-Ban / Anti-Spam:**
  - Marcado de lectura con simulación humana.
  - Presencia interactiva ("Escribiendo...").
  - Cola secuencial con cooldown configurable entre envíos.
  - Respuestas asíncronas con reacciones de estado (⏳, ✅, ❌).

---

## 📁 Estructura del Proyecto

```text
bot-sticker-tiktok/
├── .env.example              # Plantilla de variables de entorno
├── .gitignore                # Reglas de exclusión (tokens, sesiones, logs)
├── package.json              # Dependencias y scripts
├── README.md                 # Documentación completa
├── data/
│   ├── catalog.json          # Registro del catálogo local de stickers
│   └── stickers_cache/       # Almacenamiento local de stickers (.webp)
└── src/
    ├── config.js             # Carga y validación de variables de entorno
    ├── index.js              # Inicialización de Baileys, eventos y comandos
    ├── queue.js              # Cola secuencial con rate limiting y anti-spam
    ├── services/
    │   ├── catalogService.js # Gestión de stickers locales y pedidos en lote
    │   ├── stateService.js   # Persistencia de estado, whitelist, historial e invitaciones
    │   ├── stickerService.js # Conversión y optimización a WebP 512x512
    │   └── tiktokService.js  # Scraper de TikTok, pool dinámico de RapidAPI y failover
    └── utils/
        ├── delay.js          # Temporizadores con varianza aleatoria humana
        └── logger.js         # Configuración del logger Pino
```

---

## 🛠️ Requisitos Previos

- **Node.js**: v18 o superior (v20+ recomendado).
- **FFmpeg**: Instalado en el sistema (en Android/Termux: `pkg install ffmpeg`).
- **Cuenta en RapidAPI**: Claves para la API de TikTok (`ScrapTik`).
- **WhatsApp**: Teléfono con WhatsApp para vincular mediante código QR o código de emparejamiento.

---

## 📦 Instalación

1. Clona el repositorio:
   ```bash
   git clone https://github.com/XDylaan27/stoky-bot.git
   cd stoky-bot
   ```

2. Instala las dependencias:
   ```bash
   npm install
   ```

3. Configura las variables de entorno:
   ```bash
   cp .env.example .env
   ```

4. Edita el archivo `.env` con tus datos:
   ```env
   ALLOWED_JID=573001234567@s.whatsapp.net
   RAPIDAPI_KEYS=tu_primera_key,tu_segunda_key
   RAPIDAPI_HOST=scraptik.p.rapidapi.com
   STICKER_PACK=Stoky Stickers
   STICKER_AUTHOR=Stoky Bot
   COOLDOWN_SECONDS=5
   ```

---

## 🚀 Inicio y Vinculación

Inicia el servicio con:

```bash
npm start
```

### Primera Vinculación:
1. En la consola aparecerá un código QR.
2. Abre **WhatsApp** en tu teléfono ➔ **Dispositivos vinculados** ➔ **Vincular un dispositivo**.
3. Escanea el código QR.
4. La sesión se guardará en `auth_info_baileys/` para reconexiones automáticas sin requerir escaneo futuro.

---

## 📋 Lista de Comandos

### Comandos Generales (Usuarios Autorizados)
| Comando | Descripción |
|---|---|
| `<enlace de tiktok>` | Convierte la foto/sticker del comentario a sticker de WhatsApp. |
| `stoky catalogo` | Muestra el enlace al catálogo interactivo y las instrucciones de pedido. |
| `sticker <código>` | Envía un sticker del catálogo local sin gastar peticiones (ej: `sticker A1`). |
| `stickers <código1> <código2>...` | Envía múltiples stickers locales en lote (ej: `stickers A1 A3 A5`). |
| `unirme <código>` | Canjea un código de invitación para registrarte en la lista autorizada. |
| `stoky-quota` | Consulta el estado y peticiones restantes en RapidAPI. |
| `stoky estado` | Informa si Stoky está activo o en pausa. |
| `stoky -h` | Muestra la ayuda con todos los comandos disponibles. |

### Comandos de Administrador (Solo desde tu chat / `fromMe`)
| Comando | Descripción |
|---|---|
| `iniciar-bot` | Activa las respuestas del bot. |
| `pausar-bot` | Pone a Stoky en pausa temporal. |
| `stoky private on` | Activa el modo privado (ignora mensajes fuera de la whitelist). |
| `stoky private off` | Desactiva el modo privado (modo público). |
| `stoky private status` | Consulta si el modo privado está activo y cuántos autorizados hay. |
| `stoky invite` | Genera un código de invitación de un solo uso (`STK-XXXX`). |
| `stoky kick <número>` | Remueve a un usuario de la lista autorizada. |
| `stoky historia` | Muestra estadísticas de uso, usuarios activos y stickers de alto consumo. |
| `stoky newkey <clave>` | Valida y agrega una nueva API key a la rotación en vivo y la guarda en `.env`. |

---

## 🛡️ Medidas Anti-Ban Implementadas

1. **Simulación de presencia humana:** Tiempos de lectura naturales y pausas de cálculo antes de enviar stickers.
2. **Cola secuencial asíncrona:** Previene ráfagas de mensajes simultáneos respetando un cooldown de seguridad.
3. **Manejo inteligente de cuota:** Detecta límites de peticiones antes de fallar y conmuta a la siguiente clave disponible.

---

## 📄 Licencia

Desarrollado por [Dylan](https://github.com/XDylaan27). Proyecto de uso personal y educativo.
