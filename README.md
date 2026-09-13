# Multi-tenant, use-case-driven infrastructure as code

Cloud layer of an Edge / Fog / Cloud asset-traceability system. Terraform provisions, per
organisation and environment, the AWS resources a **use case** needs — today one use case,
`access_control`: decide whether an RFID tag may pass, record every scan, alert the owner
when something of theirs moves without permission, and let that owner check and lock their
own tags from a chat.

The design goal is that adding a second organisation is a new directory and a `terraform
apply`, and adding a second use case is a new module that reuses the same tenant.

---

## Layout

```
iac/
├── bootstrap/              run once: S3 state bucket + DynamoDB lock table
├── modules/                generic building blocks
│   ├── backend/            the state bucket and lock table themselves
│   ├── dynamodb/           a table with optional sort key and GSIs
│   └── lambda/             a function, its role, and scoped IAM policies
├── tenant/                 what belongs to an (org, environment): its credentials
├── use_cases/
│   └── access_control/     tags + events tables, three functions, three Function URLs
└── orgs/
    └── acme/
        ├── tenant/dev/             deployment root — apply this first
        └── access-control/dev/     deployment root — apply this second
```

**Modules** describe *what a thing is*. **Deployment roots** (everything under `orgs/`)
describe *which things exist*, hold their own Terraform state, and are the only places you
run `terraform apply`.

The tenant layer exists because the credentials live at `/<org>/<env>/…` — names that do
not mention the use case. When a use-case root created them, the second use case of the
same organisation collided with the first, so the architecture supported exactly one use
case per (org, environment). Use-case roots *build* those names as strings rather than
reading them with `data "aws_ssm_parameter"`, which would copy the decrypted values into
their own state file — see *Security posture* below for why, and what it costs.

Credentials, all `SecureString`, all created empty and filled in out of band:

| Parameter | Scope | Who uses it |
| --- | --- | --- |
| `/<org>/<env>/api-key` | the tenant | the Fog gateway, and whoever administers tags |
| `/<org>/<env>/<use case>/messaging-token` | one use case | the bot token outbound messages are sent with |
| `/<org>/<env>/<use case>/webhook-secret` | one use case | what the provider proves itself with on the way in |

The API key is shared across the tenant's use cases because it *is* the tenant's credential:
the gateway holds exactly one. The messaging credentials are **per use case**, created by
listing the use case in the tenant root's `messaging_use_cases`. That is not symmetry for its
own sake — one organisation can perfectly well run access control on Telegram and something
else on WhatsApp, and a single shared token can only ever hold one provider's credential.

**Apply order is a runbook step, not something Terraform enforces.** Because the names are
built as strings, nothing verifies that the parameter exists: a use-case root applied before
its tenant root — or with an `org_slug` that does not match it — completes successfully, and
the mistake surfaces as a `ParameterNotFound` in the function's log on the first invoke. Run
the tenant root first, and keep `org_slug` identical in both `terraform.tfvars`.

### The handler code

```
lambdas/access_control/src/
├── handlers/     the three entry points. The only composition roots: the only
│                 files that build AWS clients and read process.env
├── platform/     I/O with no business vocabulary: http, config, SSM, API key
├── domain/       the vocabulary. No I/O, no AWS, no environment
├── use_cases/    the rules. They receive ports, never adapters
└── adapters/     DynamoDB, and messaging behind two ports
```

One rule, and `src/architecture.test.js` enforces it rather than trusting anyone to
remember: **`domain/` and `use_cases/` import nothing from `adapters/`, `platform/` or
`@aws-sdk/*`.** It is the same rule the Fog gateway's core follows.

---

## Deploying

Prerequisites: Terraform >= 1.0, AWS credentials with permission to create the resources
below, and Node.js >= 20 if you want to run the handler tests.

### 1. Bootstrap the state backend — once per AWS account

```bash
cd iac/bootstrap
cp terraform.tfvars.example terraform.tfvars   # pick globally unique names
terraform init && terraform apply
terraform output          # note the bucket and lock table names
```

### 2. The tenant — once per (organisation, environment)

```bash
cd iac/orgs/acme/tenant/dev
cp backend.hcl.example backend.hcl             # fill in the bootstrap outputs
cp terraform.tfvars.example terraform.tfvars
terraform init -backend-config=backend.hcl && terraform apply

terraform output parameters_to_set             # then run the commands it prints
```

The credential *values* are deliberately not in Terraform. Generating them with
`random_password` writes the secret in plain text into the state file, and no amount of
encrypting the bucket fixes that — Terraform needs the plaintext to create the parameter.
So the parameters are created with a placeholder and set with the AWS CLI:

```bash
aws ssm put-parameter --name /acme/dev/api-key --type SecureString \
  --value "$(openssl rand -hex 32)" --overwrite --region sa-east-1   # → the gateway's AWS_API_KEY
aws ssm put-parameter --name /acme/dev/access-control/messaging-token --type SecureString \
  --value '<bot token from @BotFather>' --overwrite --region sa-east-1
```

The webhook secret is set in step 4, together with the `setWebhook` call that has to carry
the same value.

### 3. The use case

```bash
cd iac/use_cases/access_control/lambdas/access_control && npm install && cd -
cd iac/orgs/acme/access-control/dev
cp backend.hcl.example backend.hcl
cp terraform.tfvars.example terraform.tfvars
terraform init -backend-config=backend.hcl && terraform apply

terraform output tag_scan_url                  # → the gateway's BASE_URL
terraform output associate_tag_url             # → the administration endpoint
terraform output webhook_url                   # → register this with the provider
```

`npm install` is needed for the tests, not for the deployment: the zip contains only the
handler sources. The `nodejs20.x` runtime provides AWS SDK v3, so the SDK is a
devDependency.

### 4. The bot — only with messaging enabled

Telegram authenticates itself to the webhook with a shared secret, which has to be the same
in SSM and in `setWebhook`:

```bash
SECRET=$(openssl rand -hex 32)
aws ssm put-parameter --name /acme/dev/access-control/webhook-secret --type SecureString \
  --value "$SECRET" --overwrite --region sa-east-1

curl -X POST "https://api.telegram.org/bot<bot token>/setWebhook" \
  -d "url=$(terraform output -raw webhook_url)" \
  -d "secret_token=$SECRET"
```

Get them out of step and the bot stops answering with a `401` in the logs — which is the
intended failure, not a subtle one. For WhatsApp the same parameter holds the **app
secret** Meta signs request bodies with, and `whatsapp_verify_token` is what the
subscription handshake echoes back.

---

## The API

Three endpoints, one deployment package.

### `tag-scan` — a reader saw a tag

```
POST <tag_scan_url>
Header  x-api-key: <the tenant's API key>
Body    {"tag": "E28006900000500E88C6A4A7",
         "nodeId": "node-3f9a1c04",          // optional
         "timestamp": "2026-09-12T14:03:07Z", // optional, the reader's own clock
         "eventId": "…"}                      // optional idempotency key
```

| Status | Meaning |
| --- | --- |
| `200` | Tag known and allowed |
| `201` | Tag was unknown and got registered (only with `auto_register_tags = true`) |
| `422` | Tag known and **not** allowed |
| `404` | Tag unknown |
| `400` | Body is not JSON, or `tag` is missing |
| `401` | Missing or wrong `x-api-key` |
| `500` | Misconfigured deployment, or DynamoDB failed |

When a tag is refused and its owner has a chat bound to it, they get a message. The attempt
is best-effort **and bounded**: it is wrapped in a `try/catch` *and* aborted after 1500 ms.
The `try/catch` alone was not enough — a provider that accepts the connection and never
answers would spend the function's whole 4 s budget after the event row is already written,
the gateway would give up at 5 s and retry, and since it sends no idempotency key that
retry lands as a second event.

> Because the gateway caches the decision per tag for 300 s, a second scan of the same tag
> inside that window never reaches AWS. **An owner therefore gets at most one alert every
> five minutes per tag.** That is a desirable rate limit, and it is a documented
> consequence rather than a surprise.

### `associate-tag` — administration

```
POST <associate_tag_url>
Header  x-api-key: <the tenant's API key>
Body    {"op": "provision" | "associate",     // default: associate
         "tag": "E28006900000500E88C6A4A7",
         "allowed": true,                     // provision only, default true
         "chatId": "12345", "tagName": "bici",
         "ownerName": "Teo", "ownerLastName": "Zaratiegui"}
```

| `op` | What it does | Success | Conflict |
| --- | --- | --- | --- |
| `provision` | Creates the tag, optionally bound to an owner in the same write | `201` | `409` if it already exists |
| `associate` | Binds an **existing** tag to a chat and an owner | `200` | `404` unknown tag, `409` name taken in that chat |

`provision` is the answer to "how does a tag get into production?" — a question the system
previously had no answer to: `associate` requires the tag to exist, and the only thing that
created tags was `auto_register_tags`, which is a development flag and off in production by
design.

`associate` deliberately does not create the tag it cannot find. A mistyped EPC has to
fail: a phantom tag is a row nobody will ever scan and nobody will ever notice.

The operation is routed by the `op` field, not by the path, because a Lambda Function URL
ignores the path entirely — path routing would look like it worked while always taking the
same branch. The snake_case spellings (`chat_id`, `tag_name`, `name`, `lastname`) are
accepted too.

### `webhook` — the bot

Registered with the messaging provider; not called by hand. Commands:

| Command | |
| --- | --- |
| `/help`, `/start` | list the commands |
| `/status` | every tag in this chat, with its state |
| `/status <name>` | one tag: name, id, state, owner |
| `/lock <name>` | block it |
| `/unlock <name>` | allow it |

Tags are resolved **by name within the sender's chat**, never by id. That is the whole
authorisation model — one chat cannot name another chat's tag — and it is why the
`chatId-index` exists.

`/lock` and `/unlock` say that readers take up to five minutes to catch up, because the
gateway caches the decision for 300 s and nothing invalidates it. Without that sentence the
bot says "unlocked" and the door keeps refusing.

Once a command has been accepted, the answer is always `200`, even if the command failed: a
non-2xx makes Telegram redeliver the same update indefinitely, for a command that may
already have taken effect. The error goes in the body and in the log.

### Why denial is 422 and not 403

The Fog gateway only forwards `{200, 201, 204, 404, 422, 500, 503}` to the node and
collapses everything else into `503 upstream_error`
(`thesis-sketch/src/core/use_cases/relay_tag_read.py:15,137-164`). A `403` would therefore
reach the reader as "the backend is broken", indistinguishable from a real outage. `422`
survives the trip and means "tag disabled" in the node-facing contract.

`400` and `401` stay as they are on purpose: they mean the *caller* is misconfigured, never
that a particular badge was refused, and there is nothing a reader can usefully do about
them. They do reach the node as `503`.

**422 is the answer whether or not the owner could be notified.** The previously deployed
code split that into `403` (notifiable) and `422` (not). For the reader they are one fact —
the tag is blocked, the door stays shut — and whether a chat happens to be bound to the tag
is a backoffice configuration matter. It also could not survive the cache below: binding a
chat afterwards would not invalidate a status that had depended on the channel, so the
reader would see the old answer for five more minutes. Whether the alert went out is
recorded on the event row instead.

### Why the answer never depends on the reader

The gateway caches the `(status, body)` pair per tag for 300 s and does not key that cache
by node. A rule like "this reader may open that door" would be served from cache to the
wrong reader. So the answer here depends on the tag alone; per-reader rules belong in the
gateway.

---

## Data model

`<org>-<env>-tags` — who may pass

| Attribute | Type | |
| --- | --- | --- |
| `tagId` | S | partition key |
| `allowed` | BOOL | |
| `registeredAt` | S | set when the tag is created |
| `chatId` | S | GSI `chatId-index` partition key |
| `tagNameNormalized` | S | GSI `chatId-index` sort key — `tagName` trimmed and lower-cased |
| `tagName` | S | as the owner typed it, for display |
| `ownerName`, `ownerLastName` | S | |

`chatId-index` answers "which tags belong to this chat?" without a `Scan`, and its sort key
makes "which tag is called *bici* in this chat?" — every `/status <name>`, `/lock`,
`/unlock` and every duplicate-name check — a read of a **single item** rather than a full
listing filtered in memory.

> **Invariant the index imposes:** DynamoDB leaves out of an index any item missing a key
> attribute, so *a tag with a `chatId` must have a `tagNameNormalized`* — otherwise it
> silently vanishes from its owner's `/status`. Both are written by one `UpdateItem`, built
> in one place (`domain/tag.js`), and a test asserts it. An auto-registered tag has neither
> and is correctly outside the index: it belongs to no chat.

`<org>-<env>-events` — what happened

| Attribute | Type | |
| --- | --- | --- |
| `tagId` | S | partition key |
| `eventId` | S | sort key, `<13-digit epoch ms>#<discriminator>` |
| `eventTime` | N | epoch ms |
| `eventTimeIso` | S | |
| `decision` | S | `ALLOW`, `DENY`, `UNKNOWN`, `REGISTERED` |
| `nodeId` | S | which reader, when the caller sends it |
| `clientTimestamp` | S | the reader's own clock, when the caller sends it |
| `notified` | BOOL | on a denial: whether the owner was actually told |
| `notifyChannel` | S | the provider, or `NONE` when the tag had nobody to tell |

`notified` and `notifyChannel` live here and **not** in the HTTP body on purpose: the
gateway caches `(status, body)` per tag for 300 s, so a body that said "notified" would be
replayed to readings that notified nobody. On the event row it is auditable and queryable,
which is what is actually needed.

The sort key is zero-padded so lexicographic order is chronological — a range query over
`eventId` is a time range. The discriminator is what makes the write conditional: with
`ConditionExpression: attribute_not_exists`, a retried POST carrying the same idempotency
key lands on the same row instead of creating a second event.

> **The gateway does not send an idempotency key yet**, and it retries a failed POST up to
> four times (`thesis-sketch/src/infrastructure/aws/aws_client.py:36-42`). Until it does,
> retries still produce separate rows. The Cloud side cannot fix this alone: two identical
> POSTs with no key are indistinguishable from two real reads. See
> the project-level gateway findings report, finding G3.

`event_dedup_window_ms` is the stopgap: inside that window all events for one tag share an
id. It is off by default, and capped at 5000 ms, because the window also swallows a genuine
second read — it has to stay below the node's own 5 s debounce.

---

## Configuration

| Variable | Default | |
| --- | --- | --- |
| `org_slug` | `acme` | Lower-case slug; prefixes every resource name |
| `environment` | `dev` | Validated against `dev`, `staging`, `prod` |
| `aws_region` | `sa-east-1` | |
| `auto_register_tags` | `false` | Registers any unknown tag as allowed. **Development only** |
| `enable_messaging` | `true` | Deploys the webhook and the notification path (use-case root) |
| `messaging_provider` | `telegram` | `telegram` or `whatsapp` — chosen per use case, only here |
| `messaging_use_cases` | `["access-control"]` | Which use cases get a bot of their own (tenant root) |
| `org_display_name` | the slug | What owners read in an alert |
| `messaging_locale` | `es-AR` | Language and date format of every message |
| `messaging_timezone` | `America/Argentina/Buenos_Aires` | |
| `point_in_time_recovery` | `false` | Costs money |

Moving an organisation from Telegram to WhatsApp is **one line in its `terraform.tfvars`
and an apply** — no code. A provider nobody has implemented yet is a directory under
`src/adapters/messaging/`, two files, one line in `registry.js` and one more value in the
`messaging_provider` validation.

`EVENT_DEDUP_WINDOW_MS` is read by the handler but no Terraform variable sets it today, so
it is always 0 in a deployment. Wiring it up is a two-line change if the stopgap above is
ever wanted. The 5000 ms ceiling is enforced in `platform/config.js`, not merely documented:
a larger value is clamped, because past the node's own debounce the window stops collapsing
retries and starts dropping real reads.

`auto_register_tags` used to be implied by `ENVIRONMENT=dev`, whose variable had
`default = "dev"` — so the permissive path was the default and a typo in the environment
name silently switched it. It is now an explicit flag, and the environment name is
validated.

---

## Cost

Everything here is either free or pay-per-request; there is no always-on resource.

| Resource | |
| --- | --- |
| Lambda | Free tier covers 1M requests/month |
| DynamoDB | `PAY_PER_REQUEST` — no provisioned capacity, which would be ~US$12/month |
| SSM Parameter Store | Standard tier is free |
| Lambda Function URL | No hourly charge, unlike API Gateway |
| S3 + DynamoDB for state | Cents |

Every Lambda role also carries a `deny_costly` policy that denies EC2, RDS, EKS/ECS,
`lambda:CreateFunction`, `dynamodb:CreateTable` and S3 writes, so a compromised or buggy
handler cannot run up a bill.

### Function URL vs API Gateway

The gateway's `.env.example` mentions `execute-api`, but what is deployed is a Lambda
Function URL. It works unchanged, because a Function URL ignores the request path: the
gateway's `BASE_URL/PROJECT_NAME/event` resolves to the same function. The difference is
cosmetic and documented here rather than papered over. API Gateway would add per-request
cost and buys nothing this use case needs today (no custom domain, no usage plans, no
request validation).

---

## Tests

```bash
cd iac/use_cases/access_control/lambdas/access_control
npm install
npm test                  # 272 unit tests, AWS SDK mocked, no network
npm run test:integration  # optional, against a deployed URL
```

The integration test skips itself when `ACCESS_CONTROL_URL` and `ACCESS_CONTROL_API_KEY`
are unset, so it is safe to run without secrets. What it asserts is the contract that
matters: that the status code is one the Fog gateway forwards to the node.

Two of the unit tests are worth knowing about:

- `src/architecture.test.js` reads every `require` in the tree and fails if `domain/` or
  `use_cases/` reach for an adapter, a platform module, the AWS SDK or `process.env` — and
  if anything outside `handlers/` constructs an AWS client.
- `src/domain/messages.test.js` asserts the owner alert **character for character**. It is
  the text the owner has always received, and a locale default drifting under it is a
  regression only they would ever see.

---

## Security notes

- The API key is a `SecureString` in SSM; the Lambda reads it at runtime and caches it for
  the life of the execution environment. It is never a Lambda environment variable.
- Comparison is `crypto.timingSafeEqual`, and an empty key never matches — a gateway that
  forgot to set `AWS_API_KEY` is refused rather than let through.
- Each Lambda role reaches only the tables and parameters it needs. `associate-tag` cannot
  write events; `tag-scan` cannot create a tag at all unless `auto_register_tags` is on.
- The webhook is authenticated by the messaging provider's own mechanism: Telegram's
  `secret_token` header, compared in constant time, or Meta's `X-Hub-Signature-256` HMAC
  over the raw body. An unset secret refuses everything — it must not read as "no check
  required". Before this, the webhook verified nothing at all: with a public Function URL
  and a self-declared `chat.id` in the body, anyone who found the URL could lock or unlock
  someone else's tags.
- The Function URL is `authorization_type = "NONE"`: AWS does no authentication and the
  handler does it. That means **the endpoint is public** and its only protection is the API
  key. Rate limiting is a gap — see the thesis notes. Note that `NONE` only switches off
  the SigV4 check; the right to invoke is a separate `aws_lambda_permission` with
  `function_url_auth_type = "NONE"`, declared next to each URL. The console adds that
  statement for you, the API Terraform calls does not, and without it every request is
  answered 403 before the handler runs.
- **No credential value reaches the Terraform state.** The tenant layer creates the three
  SSM parameters with a placeholder and the real values are put in out of band; the
  use-case root *builds* the parameter names and ARNs as strings instead of reading them
  with `data "aws_ssm_parameter"`, which would have copied all three decrypted secrets into
  its state file — a data source persists every attribute, and `sensitive = true` only
  redacts CLI output. The cost is that a missing parameter is no longer caught at plan
  time; it surfaces as a GetParameter error in the function's log on the first invoke.
- `backend.hcl` and `*.tfvars` are gitignored; the `.example` files are the templates.
- The deployment package is built from an explicit file list, so a local `.env` (which can
  hold a real key) cannot end up in the zip.

### Known limits, accepted on purpose

Two of them, both consequences of one decision: **`associate-tag` is guarded by the same
`x-api-key` as `tag-scan`.** A separate administration credential was designed and dropped
as over-engineering for a single tenant and a single node — it added a layer, a parameter,
a runbook step and one more way to get it wrong.

1. **The Fog gateway holds the key that administers tags.** It runs on a Raspberry Pi
   behind an anonymous MQTT broker with no TLS, so a compromised gateway can provision and
   bind tags. Accepted at this scale: whoever has the Pi already has the reader.
2. **Any `chatId` can bind itself to any existing tag.** There is no proof of ownership.

Both have the same textbook fix — a separate administration credential, or a single-use
`/claim <code>` issued by the operator — and both are explicit future work rather than
oversights. Rate limiting on the public Function URLs is a third gap, unrelated to this
one and equally open.

### What a second use case would cost today

The catalogue this repository sells is a catalogue of **Terraform composition**: the
primitives in `modules/`, the business composition in `use_cases/`, and the per-tenant
values in `orgs/`. That part holds — a second use case adds a directory under `use_cases/`
and a deployment root under `orgs/<org>/`, and touches neither `modules/` nor `tenant/`.

The handler code is a different story, and it is worth stating plainly rather than
discovering it during the second use case. Roughly **45 % of `src/` is use-case agnostic**
— `platform/http.js`, `platform/api-key.js`, `platform/ssm-parameter.js`, all of
`adapters/messaging/`, and `architecture.test.js` — and none of it lives anywhere shared.
A second use case would copy those files, security-sensitive ones included (the HMAC
verification, the constant-time comparison, the cached SSM read), and each copy would then
need auditing on its own.

**This is deferred on purpose, not overlooked.** Extracting a shared library while there is
exactly one consumer would validate the abstraction against nobody, and the mechanics have a
real seam: `data.archive_file` mirrors the source tree into the zip (`filename =
source.value`), so a second `dynamic "source"` block reading from a shared directory would
land the files exactly where the existing `require('../platform/http')` expects them — but
Node resolves `require` against the **physical** filesystem, so the test run would not.
Closing that gap needs either a symlink (OS-dependent, in a repository whose argument is
reproducibility) or a copy step before packaging (a build step, in a repository whose
argument is `terraform apply`). Neither is worth paying for one consumer.

The migration path, for whoever writes the second use case: move the agnostic files to
`iac/use_cases/_shared/src/`, add a second `dynamic "source"` block to each use case's
`data.archive_file` publishing them under the same `src/...` prefix, and give `_shared/` its
own jest project. Do it with two real consumers in hand, so the boundary is drawn by
evidence instead of by guesswork.

One coupling is worth removing before then, because it costs nothing: `validateConfig` in
`platform/config.js` reads `REQUIREMENTS` and `LABELS` as module constants, and both list
*this* use case's handlers. Passing them in as arguments makes that file fully generic.
