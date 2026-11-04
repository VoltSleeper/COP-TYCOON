# COP TYCOON — configuración del acceso de administración

Esta guía corresponde al acceso con una contraseña compartida. La contraseña nunca debe guardarse en `index.html`, en Git ni en mensajes.

## Estado

- El HTML muestra un campo de contraseña oculto y conserva el panel de historial existente.
- La Edge Function `cop-admin` valida la contraseña en el servidor y crea sesiones aleatorias de 8 horas.
- La base de datos guarda únicamente el hash del token de sesión.
- Las escrituras del historial pasan por la Edge Function.
- La migración SQL de este directorio aún debe revisarse y aplicarse antes de activar el nuevo acceso.

## Antes del despliegue

1. En Supabase Dashboard, abre el proyecto y entra en **Edge Functions → Secrets**.
2. Añade el secreto `COP_ADMIN_PASSWORD` con una contraseña nueva, larga y aleatoria (recomendado: 24 caracteres o más).
3. No reutilices el antiguo código de demostración: ya había aparecido en una versión pública del HTML y puede seguir presente en el historial de Git.
4. No compartas la contraseña ni la clave `service_role` / secret key en chats, issues o archivos del repositorio.

Supabase proporciona `SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY` al runtime de Edge Functions en proyectos que siguen usando las claves heredadas. Esa clave de servidor nunca debe llegar al navegador.

## Activación coordinada

1. Desplegar `supabase/functions/cop-admin/index.ts` como Edge Function `cop-admin`.
2. Configurar la función con `verify_jwt = false`: el endpoint realiza su propia autenticación mediante contraseña y token de sesión. No quitar las comprobaciones internas de sesión.
3. Publicar la versión nueva de `index.html`.
4. Aplicar la migración `20261104000000_secure_cop_history.sql` en Supabase. Esta operación elimina los permisos de escritura directos de `anon` y `authenticated`; por eso debe coordinarse con el despliegue del nuevo frontend y de la Edge Function.
5. Verificar lectura pública, login correcto/incorrecto, bloqueo temporal tras intentos fallidos, alta/edición/reversión/eliminación, cierre de sesión y dos administradores simultáneos.

No activar la migración en producción hasta tener desplegados el frontend y la función compatibles. La migración está preparada para revisión; no se aplica automáticamente desde GitHub.

## Notas de seguridad

- La función usa una sesión de 8 horas y elimina tokens caducados al iniciar sesión.
- Después de 5 intentos fallidos desde la misma IP, el acceso se bloquea durante 15 minutos.
- El ID de cada transacción lo genera PostgreSQL para evitar colisiones entre administradores.
- El historial continúa siendo legible públicamente. Esta migración todavía no resuelve la privacidad de campos de remitente anónimo a nivel de API/Realtime; hay que abordarlo por separado antes de tratar el anonimato como confidencialidad real.
