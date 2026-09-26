# germaniai.com

Sitio de GermanIAI: catálogo público de la familia de IA, chat privado con usuario y contraseña, biblioteca privada del titular y archivo público de investigaciones revisadas.

## Cómo está armado

| Parte | Dónde vive | Qué hace |
|---|---|---|
| `index.html`, `archivo.html`, `biblioteca.html` | GitHub Pages → germaniai.com | Páginas estáticas. El catálogo y el archivo son públicos; el chat y la biblioteca piden sesión. |
| `api/` | Render → api.germaniai.com (servicio `germaniai-api`, definido en `render.yaml`) | Ingreso, chat con la API de Anthropic y búsqueda web, biblioteca, panel `/admin`. |
| `dohmenger-tech/germaniai-pendientes` | GitHub (privado) | `biblioteca/` (documentos del titular), `usuarios/` (hashes de contraseña), `pendientes/` (investigaciones a revisar). |

## Acceso

- **Titular**: usuario `dohmenger` y la contraseña cargada en Render como `ADMIN_CLAVE`. Ve la biblioteca y puede aplicar su Directiva (`biblioteca/GermanIAI.md`) a las respuestas.
- **Otros usuarios**: se dan de alta en `https://api.germaniai.com/admin`. Entran al chat con su propio usuario, con límite por hora, y nunca reciben la Directiva ni ven la biblioteca.
- Las sesiones duran 30 días y se cierran solas si cambia la contraseña.

## Variables en Render

| Variable | Obligatoria | Uso |
|---|---|---|
| `ANTHROPIC_API_KEY` | sí | Chat |
| `ADMIN_CLAVE` | sí | Contraseña del titular y del panel |
| `GITHUB_TOKEN` | no | Biblioteca, usuarios adicionales y archivo (token con permiso de contenido sobre los dos repositorios) |
| `SESION_SECRETO` | la genera Render | Firma de las sesiones |

Ninguna clave va en el código ni en este repositorio, que es público.
