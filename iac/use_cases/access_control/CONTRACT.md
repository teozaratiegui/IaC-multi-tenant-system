# Contrato entre la infraestructura y el código de la Lambda

> Lo que la infraestructura le exige al código. Incumplirlo falla en runtime, no
> en el `apply`.
>
> **Estado: cumplido.** Los tres handlers existen en las rutas que declara
> `main.tf`, `npm test` está en verde y `terraform validate` también.
>
> Última actualización: 2026-09-13.

---

## 1. Handlers

Un solo paquete, tres puntos de entrada. Terraform los referencia por ruta exacta:

| Función | `handler` | Archivo |
|---|---|---|
| `<org>-<env>-access-control-tag-scan` | `src/handlers/tag-scan.handler` | `lambdas/access_control/src/handlers/tag-scan.js` |
| `<org>-<env>-access-control-associate-tag` | `src/handlers/associate-tag.handler` | `.../src/handlers/associate-tag.js` |
| `<org>-<env>-access-control-webhook` | `src/handlers/webhook.handler` | `.../src/handlers/webhook.js` |

Los nombres son kebab-case, que es la convención del resto del repo. Estaban en
camelCase y se corrigieron mientras no había nada desplegado: una convención con
una excepción no documentada es peor que cualquiera de las dos convenciones.

El webhook sólo se despliega si `enable_messaging = true`.

**Cada handler es un composition root** y el único tipo de archivo que lo es: es
donde se construyen los clientes de AWS, donde se lee `process.env` y donde se
arma el grafo de dependencias. Nada debajo de `use_cases/` o `domain/` importa un
adaptador, un SDK de AWS ni una variable de entorno — `src/architecture.test.js`
lo verifica, y es la misma regla que cumple el núcleo del gateway Fog.

**El paquete se arma con una lista derivada de archivos**, no zipeando el directorio:
entran todos los `**/*.js` menos `*.test.js`, `node_modules/` y las cuatro
herramientas de test. Consecuencias:

- **No se empaqueta `node_modules`.** El runtime `nodejs20.x` ya provee AWS SDK v3
  (`@aws-sdk/client-dynamodb`, `@aws-sdk/client-ssm`). **Cualquier otra dependencia
  de runtime rompe el despliegue**: si hace falta una, hay que cambiar el empaquetado.
- Un `.env` local nunca puede entrar al zip. El paquete anterior pesaba 10 MB
  porque zipeaba el directorio entero.

---

## 2. Variables de entorno

| Variable | tag-scan | associate-tag | webhook | Qué trae |
|---|:--:|:--:|:--:|---|
| `ORG_NAME` | ✓ | ✓ | ✓ | slug de la organización |
| `ORG_DISPLAY_NAME` | ✓ | ✓ | ✓ | nombre presentable; por defecto, el slug |
| `ENVIRONMENT` | ✓ | ✓ | ✓ | `dev` \| `staging` \| `prod` |
| `TAGS_TABLE_NAME` | ✓ | ✓ | ✓ | tabla de tags |
| `MESSAGING_LOCALE` | ✓ | ✓ | ✓ | locale de los textos; por defecto `es-AR` |
| `MESSAGING_TIMEZONE` | ✓ | ✓ | ✓ | zona horaria; por defecto Buenos Aires |
| `EVENTS_TABLE_NAME` | ✓ | | | tabla de eventos |
| `API_KEY_PARAMETER_NAME` | ✓ | ✓ | | parámetro SSM de la API key |
| `AUTO_REGISTER_TAGS` | ✓ | | | `"true"` \| `"false"` |
| `MESSAGING_PROVIDER` | ✓* | | ✓ | `telegram` \| `whatsapp` |
| `MESSAGING_TOKEN_PARAMETER_NAME` | ✓* | | ✓ | parámetro SSM del bot token |
| `WEBHOOK_SECRET_PARAMETER_NAME` | | | ✓* | parámetro SSM del secreto del webhook |
| `WHATSAPP_PHONE_NUMBER_ID` | ✓** | | ✓** | sólo con provider `whatsapp` |
| `WHATSAPP_VERIFY_TOKEN` | ✓** | | ✓** | ídem |

\* sólo cuando `enable_messaging = true` · \*\* sólo cuando el provider es `whatsapp`

**El código tiene que tolerar que las de mensajería no estén.** Con
`enable_messaging = false` no se define ninguna, `MESSAGING_PROVIDER` se lee como
`none`, el `NullMessenger` ocupa el lugar del canal y `tag-scan` sigue
funcionando sin notificar. Está cubierto por test.

La validación de configuración es **por handler**: exigirle `EVENTS_TABLE_NAME` a
`associate-tag`, que nunca la recibe, haría fallar un despliegue correcto en el
primer invoke.

---

## 3. Permisos IAM — lo que cada función puede llamar

Least privilege real: una llamada fuera de esta tabla devuelve `AccessDenied` en
runtime. Si el código necesita algo más, **se agrega a `policy_statements` en
`main.tf`**; no alcanza con escribirlo en el handler.

### tag-scan

| Recurso | Acciones |
|---|---|
| tabla de tags | `GetItem` |
| tabla de tags | `PutItem` — **sólo si `auto_register_tags = true`** |
| tabla de eventos | `PutItem` |
| SSM api-key | `GetParameter` |
| SSM messaging-token | `GetParameter` — sólo con mensajería |

> Con `auto_register_tags = false` la función **no puede** crear tags aunque el
> código lo intente. Es deliberado: el fail-open estaba implícito en
> `ENVIRONMENT=dev` y un valor mal escrito abría la puerta a todos los tags.

### associate-tag

| Recurso | Acciones |
|---|---|
| tabla de tags | `GetItem`, `UpdateItem`, `PutItem` |
| índice `chatId-index` | `Query` |
| SSM api-key | `GetParameter` |

> `PutItem` es lo que habilita `op = provision`, el alta de tags. Sin él no había
> **ningún** camino soportado para poner un tag en producción: `associate` exige
> que el tag exista y lo único que creaba tags era la auto-registración, que es
> una comodidad de desarrollo y está apagada en producción a propósito.
>
> Usa **la misma `x-api-key`** que `tag-scan`. Una credencial de administración
> separada se evaluó y se descartó por sobreingeniería a esta escala; los dos
> límites que eso deja están escritos en el README del repo.
>
> El `Query` sobre el índice lo usan **las dos** operaciones, no sólo `associate`:
> `provision` hace el mismo control de nombre duplicado antes de escribir. Sin él,
> dos tags distintos podían terminar compartiendo la clave completa del índice
> (`chatId` + `tagNameNormalized`), y cada `/status`, `/lock` y `/unlock` posterior
> resolvía a uno de los dos arbitrariamente.

### webhook

| Recurso | Acciones |
|---|---|
| tabla de tags | `GetItem`, `UpdateItem` |
| índice `chatId-index` | `Query` |
| SSM messaging-token | `GetParameter` |
| SSM webhook-secret | `GetParameter` |

Sin API key: al webhook lo llama el proveedor de mensajería, y se autentica con
el mecanismo propio del proveedor (§9).

### Permiso de invocación de las Function URL

`authorization_type = "NONE"` sólo apaga la verificación SigV4; **no** concede el
derecho a invocar. Eso es una sentencia aparte en la policy de recurso de cada
función, declarada al lado de cada URL:

```hcl
resource "aws_lambda_permission" "<fn>_url" {
  action                 = "lambda:InvokeFunctionUrl"
  principal              = "*"
  function_url_auth_type = "NONE"
}
```

La consola de Lambda agrega esa sentencia sola cuando se crea una URL desde ahí;
la API `CreateFunctionUrlConfig`, que es la que llama Terraform, no. Sin ella los
tres endpoints contestan **403 a todo el mundo**, incluido el gateway, sin que el
handler llegue a ejecutarse.

---

## 4. Modelo de datos

### `<org>-<env>-tags`

- PK `tagId` (S)
- GSI **`chatId-index`**: hash `chatId` (S), **range `tagNameNormalized` (S)**, projection `ALL`
- Atributos que usa el código: `allowed`, `chatId`, `tagName`, `tagNameNormalized`,
  `ownerName`, `ownerLastName`, `registeredAt`

El GSI es lo que permite "¿qué tags pertenecen a este chat?" sin `Scan`. **Una
`Query` sobre él necesita el ARN del índice**, que ya está en la política.

La range key convierte "¿cuál es el tag llamado *bici* en este chat?" —o sea cada
`/status <nombre>`, `/lock`, `/unlock` y cada chequeo de nombre duplicado— en la
lectura de **un solo ítem**, en vez de traer el chat entero y filtrar en memoria.

#### ⚠️ Invariante que la range key impone al código

DynamoDB **deja fuera del índice** cualquier ítem al que le falte un atributo de
clave. Por lo tanto:

> **si un tag tiene `chatId`, tiene que tener `tagNameNormalized`.**

Un tag que quedara con uno y sin el otro desaparecería del `/status` de su dueño
sin que nada lo registre. Se garantiza en un solo lugar —`associate` escribe los
dos atributos en el mismo `UpdateItem`, y `domain/tag.js` es lo único que los
construye— y hay test de eso. Un tag auto-registrado no tiene ninguno de los dos,
así que queda fuera del índice: es lo correcto, no pertenece a ningún chat.

`tagNameNormalized` es `tagName.trim().toLowerCase()`; `tagName` conserva las
mayúsculas para mostrar.

### `<org>-<env>-events`

- PK `tagId` (S)
- **SK `eventId` (S)**

El código desplegado escribía la SK como `eventTime` (un número, epoch ms). La
infraestructura declara **`eventId` (string)**, con la forma:

```
<epoch ms en 13 dígitos>#<discriminador>
1789000000000#3f2a...
```

Por qué se cambió:

1. Con `eventTime` como SK, **dos lecturas del mismo tag en el mismo milisegundo
   se pisaban en silencio.**
2. Zero-padear a 13 dígitos hace que el orden lexicográfico sea cronológico, así
   que se puede consultar un rango temporal por tag sin `Scan`.
3. El discriminador permite `ConditionExpression: attribute_not_exists(...)`, o sea
   **escritura idempotente**: el gateway reintenta un POST hasta 4 veces sin clave
   de idempotencia (hallazgo G3), y hoy eso mete hasta 4 filas por lectura.

El handler escribe además, como atributos normales: `eventTime` (N, epoch ms),
`eventTimeIso` (S) y `decision` (S: `ALLOW` \| `DENY` \| `UNKNOWN` \| `REGISTERED`).
Opcionalmente `nodeId` y `clientTimestamp`, cuando el que llama los manda.

Y en una denegación, `notified` (BOOL) y `notifyChannel` (S: el proveedor, o
`NONE` cuando el tag no tenía a quién avisar). Ese par vive acá y **no** en el
body a propósito: el gateway cachea `(status, body)` por tag 300 s, así que un
body que dijera "notificado" se le serviría a lecturas que no notificaron a
nadie. En la fila del evento es auditable y consultable, que es lo que hace
falta.

---

## 5. Códigos de estado — restricción dura del gateway

El gateway Fog sólo reenvía al nodo `{200, 201, 204, 404, 422, 500, 503}` y
**colapsa todo lo demás a `503 upstream_error`**
(`thesis-sketch/src/core/use_cases/relay_tag_read.py:15,137-164`).

| Situación | Status | Por qué |
|---|---|---|
| Tag permitido | `200` | |
| Tag registrado al vuelo | `201` | el gateway lo normaliza a 200 |
| Tag conocido y **no** permitido | **`422`** | **no 403**: un 403 llega al lector como "el backend se rompió", indistinguible de una caída |
| Tag desconocido | `404` | |
| Body inválido o falta `tag` | `400` | el que llama está mal, no el tag |
| API key inválida | `401` | ídem |

**El 422 es uno solo, haya o no canal de notificación.** El código desplegado
contestaba `403` cuando el dueño era contactable y `422` cuando no. Para el lector
son el mismo hecho —el tag está bloqueado, la puerta no se abre— y el matiz no
sobrevive al caché del gateway (§7): un `associate-tag` posterior no lo
invalidaría, así que el lector vería la respuesta vieja durante 5 minutos después
de que el canal ya existe. Que se haya podido avisar o no se registra en la fila
del evento (`notified`, `notifyChannel`), que es donde es auditable.

`domain/decisions.js` es el **único** lugar que mapea decisión → status, y un test
verifica que todo lo que produce está en la lista blanca del gateway. Es lo que
impide que la asimetría 403/422 vuelva a colarse en un refactor.

### Administración (`associate-tag`) y webhook

No los ve el nodo, así que no están sujetos a la lista blanca:

| Situación | Status |
|---|---|
| `associate` ok | `200` |
| `associate`, el tag no existe | `404` |
| `associate`, nombre ya usado en ese chat | `409` |
| `provision` creado | `201` |
| `provision`, ya existía | `409` |
| `op` desconocido o faltan campos | `400` |
| Webhook sin la verificación del proveedor | `401` |
| Webhook, `GET` sin handshake (Telegram) | `405` |
| Webhook, comando ejecutado | **`200` siempre** |

El `200` del webhook es deliberado: un no-2xx hace que Telegram reintente el mismo
update indefinidamente, y para un comando que quizá ya surtió efecto. El error va
en el body y en el log.

`400` y `401` se mantienen a propósito aunque el gateway los colapse: significan
"el que llama está mal configurado", nunca "esta credencial fue rechazada", y el
nodo no tiene nada útil que hacer con ellos.

**Un 401 tiene que dejar rastro en el log.** Como el gateway lo convierte en 503,
una API key mal puesta es indistinguible de un backend caído en todas las capas —
la línea de log es la única evidencia.

---

## 6. Timeout: 4 segundos, y no es negociable hacia arriba

`lambda_timeout` tiene `validation` que exige `< 5`. El gateway corta a los 5 s
(`thesis-sketch/src/main.py:84`). Si la función puede correr más que lo que el que
llama espera, una invocación lenta hace que el gateway se rinda y reintente
**mientras esta función sigue viva y está por escribir el evento** → evento
duplicado. Fallar antes que el que llama es lo que hace seguro el reintento.

Implicancia para el código: **nada de trabajo sincrónico largo en el camino del
request.** Notificar al dueño es best-effort y **acotado**: `try/catch` alrededor
del envío *y* un `AbortController` de 1500 ms. El `try/catch` solo no alcanzaba —
un proveedor que acepta la conexión y no contesta nunca se come el presupuesto
entero **después** de que el evento ya se escribió, el gateway se rinde a los 5 s
y reintenta, y como no manda clave de idempotencia (G3) ese reintento entra como
una segunda fila.

---

## 7. Invariante del caché del gateway

El gateway cachea el par `(status, body)` **por tag** durante 300 s, y **no lo
indexa por nodo** (`thesis-sketch/src/infrastructure/cache/cache_service.py`).

Por lo tanto **la respuesta tiene que depender sólo del tag**. Una regla del tipo
"este lector puede abrir esa puerta" se serviría desde el caché al lector
equivocado. Ese tipo de política va en el gateway, no acá.

---

## 8. Cómo verificar que el código cumple

```bash
export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"
cd lambdas/access_control && npm test

# Y contra el despliegue real:
export ACCESS_CONTROL_URL=$(terraform -chdir=../../../orgs/acme/access-control/dev output -raw tag_scan_url)
export ACCESS_CONTROL_API_KEY=$(aws ssm get-parameter --name /acme/dev/api-key \
  --with-decryption --query Parameter.Value --output text)
npm run test:integration
```

---

## 9. Autenticación del webhook

El webhook **no lleva API key**: lo llama el proveedor de mensajería. Cada
adaptador inbound aporta su propia verificación, porque el mecanismo es
específico del proveedor — que es exactamente lo que justifica que el puerto
exista:

| Proveedor | Mecanismo | Cómo |
|---|---|---|
| Telegram | `secret_token` de `setWebhook` | se compara en tiempo constante contra el header `X-Telegram-Bot-Api-Secret-Token` |
| WhatsApp | firma HMAC-SHA256 de Meta | se valida `X-Hub-Signature-256` contra el app secret, sobre los bytes crudos del body |

Los dos leen el mismo parámetro SSM, `/<org>/<env>/access-control/webhook-secret`,
con el mismo lector cacheado que la API key. Es **por caso de uso**, no por tenant:
cada caso de uso tiene su propio bot, así que su propio webhook y su propio
secreto. La API key, en cambio, sigue siendo del tenant y compartida.

**Un secreto sin configurar rechaza todo.** No leer el parámetro no puede
significar "no hace falta verificar".

Esto no existía: el código desplegado no verificaba absolutamente nada. Con una
Function URL pública y el `chat.id` autodeclarado en el body, cualquiera que
descubriera la URL podía bloquear o desbloquear los tags de otro.

Runbook de Telegram, después del primer `apply`:

```bash
SECRET=$(openssl rand -hex 32)
aws ssm put-parameter --name /acme/dev/access-control/webhook-secret --type SecureString \
  --value "$SECRET" --overwrite --region sa-east-1
curl -X POST "https://api.telegram.org/bot<token>/setWebhook" \
  -d "url=$(terraform -chdir=../../../orgs/acme/access-control/dev output -raw webhook_url)" \
  -d "secret_token=$SECRET"
```

---

## 10. Elegir el medio de mensajería

`MESSAGING_PROVIDER` lo inyecta `main.tf` desde `var.messaging_provider`. Pasar una
organización de Telegram a WhatsApp es **una línea en su `terraform.tfvars` y un
`apply`**: cero código.

| `MESSAGING_PROVIDER` | inbound | outbound | Webhook desplegado |
|---|---|---|---|
| *(ausente)* → `none` | — | `NullMessenger` | no (`count = 0`) |
| `telegram` | `TelegramInbound` | `TelegramMessenger` | sí |
| `whatsapp` | `WhatsAppInbound` | `WhatsAppMessenger` | sí |

Agregar un proveedor nuevo = un directorio bajo `src/adapters/messaging/`, dos
archivos, una línea en `registry.js` y un valor más en la `validation` de
`var.messaging_provider`. Nada más cambia.
