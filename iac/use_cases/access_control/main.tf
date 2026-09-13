# -----------------------------------------------------------------------------
# Access control use case.
#
# Three entry points over one deployment package:
#
#   tag-scan       a reader saw a tag  -> decide, record, optionally notify
#   associate-tag  bind a tag to an owner and a chat
#   webhook        inbound messages from the messaging provider (opt-in)
#
#   <org>-<env>-access-control-tags    tagId -> allowed, owner, chatId (+ GSI)
#   <org>-<env>-access-control-events  tagId + eventId, one row per scan
#
# Credentials come from the tenant layer and are only read at runtime, from SSM.
#
# ── Contract with the Lambda code ────────────────────────────────────────────
# This file fixes four things the handler code must match. See CONTRACT.md.
#   1. handlers at src/handlers/{tag-scan,associate-tag,webhook}.handler
#   2. the events sort key is `eventId`, not `eventTime`
#   3. auto-registration is driven by AUTO_REGISTER_TAGS, never by ENVIRONMENT
#   4. each function may only call what its policy_statements below allow
#
# Before the first apply: nothing. The nodejs20.x runtime provides AWS SDK v3, so
# no node_modules is packaged.
# -----------------------------------------------------------------------------

locals {
  name_prefix = "${var.org_slug}-${var.environment}"

  # Tables carry the use-case segment too, and the functions already did
  # (`${local.name_prefix}-access-control-tag-scan`). Without it the tables were
  # plain `acme-dev-tags` / `acme-dev-events`, so a second use case in the same
  # organisation would declare the same two table names from its own state: the
  # apply fails with ResourceInUseException, or — worse — somebody imports the
  # table and two roots manage it. Added while nothing is deployed, because
  # renaming a DynamoDB table is destroy-and-create and PITR is off.
  table_prefix = "${local.name_prefix}-access-control"

  lambda_source = "${path.module}/lambdas/access_control"

  # Two different things, deliberately not one flag.
  #
  # Notifying an owner needs the bot token. Serving the inbound webhook needs the
  # token *and* the secret it verifies callers with — that secret is the only
  # authentication the endpoint has: no x-api-key, a public Function URL, and a
  # sender id the body declares about itself. So a deployment given half the
  # credentials still notifies owners and simply does not expose a webhook, rather
  # than exposing one that can authenticate nobody.
  #
  # Keeping them separate also removes a null from `webhook_secret_env`, which
  # would otherwise reach a map(string) and fail the apply with an error about
  # types rather than about the missing secret.
  notifications_enabled = var.messaging_token_parameter_name != null
  webhook_enabled       = local.notifications_enabled && var.webhook_secret_parameter_name != null

  # Every function reads these. ORG_NAME is the slug; ORG_DISPLAY_NAME is what a
  # person reads in an alert, so it defaults to the slug and a tenant that wants
  # a real name sets one. Locale and time zone are the same idea: the deployed
  # code hardcoded es-AR and Buenos Aires, which is a fine default and a poor
  # rule.
  common_env = {
    ORG_NAME           = var.org_slug
    ORG_DISPLAY_NAME   = coalesce(var.org_display_name, var.org_slug)
    ENVIRONMENT        = var.environment
    TAGS_TABLE_NAME    = module.table_tags.table_name
    MESSAGING_LOCALE   = var.messaging_locale
    MESSAGING_TIMEZONE = var.messaging_timezone
  }

  messaging_env = local.notifications_enabled ? {
    MESSAGING_PROVIDER             = var.messaging_provider
    MESSAGING_TOKEN_PARAMETER_NAME = var.messaging_token_parameter_name
  } : {}

  # Only the webhook needs it: it is what proves an inbound request really came
  # from the messaging provider. tag-scan never sees it.
  webhook_secret_env = local.webhook_enabled ? {
    WEBHOOK_SECRET_PARAMETER_NAME = var.webhook_secret_parameter_name
  } : {}

  whatsapp_env = var.messaging_provider == "whatsapp" ? {
    WHATSAPP_PHONE_NUMBER_ID = var.whatsapp_phone_number_id
    WHATSAPP_VERIFY_TOKEN    = var.whatsapp_verify_token
  } : {}

  # Reused by the statements below. The GSI needs its own ARN: a Query against
  # chatId-index is denied by a policy that only names the table.
  tags_table_arn   = module.table_tags.table_arn
  tags_index_arn   = "${module.table_tags.table_arn}/index/*"
  events_table_arn = module.table_events.table_arn

  read_api_key = {
    sid       = "ReadApiKey"
    actions   = ["ssm:GetParameter"]
    resources = [var.api_key_parameter_arn]
  }

  read_messaging_token = {
    sid       = "ReadMessagingToken"
    actions   = ["ssm:GetParameter"]
    resources = [var.messaging_token_parameter_arn]
  }

  read_webhook_secret = {
    sid       = "ReadWebhookSecret"
    actions   = ["ssm:GetParameter"]
    resources = [var.webhook_secret_parameter_arn]
  }
}

# -----------------------------------------------------------------------------
# Data
# -----------------------------------------------------------------------------

# chatId-index backs "which tags belong to this chat?", which is how the webhook
# resolves an inbound message to the tags its sender owns. Without it, that query
# would have to Scan the whole table on every message.
#
# The range key makes "which tag is called 'bici' in this chat?" — every /status
# <name>, /lock, /unlock and every duplicate-name check — a read of one item
# instead of a full listing filtered in memory. Adding a range key to a live GSI
# means destroying and recreating the index, so it is done now, while nothing is
# deployed, rather than once the table holds data.
#
# It carries an invariant the code has to keep: DynamoDB leaves out of an index
# any item missing a key attribute, so a tag with a chatId and no
# tagNameNormalized would silently vanish from its owner's listing. The
# `associate` operation writes both in one UpdateItem, and a test asserts it.
module "table_tags" {
  source = "../../modules/dynamodb"

  table_name   = "${local.table_prefix}-tags"
  hash_key     = "tagId"
  billing_mode = "PAY_PER_REQUEST"

  attributes = [
    { name = "tagId", type = "S" },
    { name = "chatId", type = "S" },
    { name = "tagNameNormalized", type = "S" },
  ]

  global_secondary_indexes = [
    {
      name            = "chatId-index"
      hash_key        = "chatId"
      range_key       = "tagNameNormalized"
      projection_type = "ALL"
    }
  ]

  point_in_time_recovery = var.point_in_time_recovery
  tags                   = var.tags
}

# One row per scan. The sort key is `<13-digit epoch ms>#<discriminator>`:
# zero-padded so lexicographic order is chronological, and carrying a
# discriminator so the write can be conditional.
#
# It replaces a plain `eventTime`, under which two scans of the same tag in the
# same millisecond silently overwrote each other, and a retried POST from the
# gateway could not be collapsed at all.
module "table_events" {
  source = "../../modules/dynamodb"

  table_name   = "${local.table_prefix}-events"
  hash_key     = "tagId"
  range_key    = "eventId"
  billing_mode = "PAY_PER_REQUEST"

  attributes = [
    { name = "tagId", type = "S" },
    { name = "eventId", type = "S" },
  ]

  point_in_time_recovery = var.point_in_time_recovery
  tags                   = var.tags
}

# -----------------------------------------------------------------------------
# Package — one zip, three handlers
# -----------------------------------------------------------------------------

# The file list is derived rather than excluded: listing what goes in, instead of
# what to leave out, is what guarantees that a local .env (which can hold a real
# API key) or a node_modules tree never ends up in the zip. The previously
# deployed package was 10 MB because it zipped the directory wholesale.
locals {
  lambda_tooling = [
    "jest.config.js",
    "jest.setup.js",
    "test-env.js",
    "integration-test.js",
  ]

  lambda_files = [
    for file in fileset(local.lambda_source, "**/*.js") : file
    if !can(regex("\\.test\\.js$", file))
    && !can(regex("^node_modules/", file))
    && !contains(local.lambda_tooling, file)
  ]
}

data "archive_file" "lambda" {
  type        = "zip"
  output_path = "${path.module}/build/access_control.zip"

  dynamic "source" {
    for_each = toset(local.lambda_files)
    content {
      content  = file("${local.lambda_source}/${source.value}")
      filename = source.value
    }
  }
}

# -----------------------------------------------------------------------------
# Functions
# -----------------------------------------------------------------------------

# Reads a tag, records the scan, may notify the owner.
# Auto-registration writes to the tags table, so PutItem is granted only when the
# flag is on — a deployment with it off cannot create tags even if the code tries.
module "lambda_tag_scan" {
  source = "../../modules/lambda"

  function_name    = "${local.name_prefix}-access-control-tag-scan"
  handler          = "src/handlers/tag-scan.handler"
  source_path      = data.archive_file.lambda.output_path
  source_code_hash = data.archive_file.lambda.output_base64sha256

  # Deliberately below the gateway's own 5 s timeout
  # (thesis-sketch/src/main.py:84, AWS_TIMEOUT_S). With the function allowed to
  # run longer than the caller waits, a slow invocation makes the gateway give up
  # and retry *while this function is still running and about to write the event*
  # — and since the gateway sends no idempotency key (finding G3), the retry lands
  # as a second row. Failing before the caller does is what keeps the retry safe.
  timeout     = var.lambda_timeout
  memory_size = var.lambda_memory_size

  environment_variables = merge(
    local.common_env,
    local.messaging_env,
    local.whatsapp_env,
    {
      EVENTS_TABLE_NAME      = module.table_events.table_name
      API_KEY_PARAMETER_NAME = var.api_key_parameter_name
      AUTO_REGISTER_TAGS     = var.auto_register_tags ? "true" : "false"
    },
  )

  policy_statements = concat(
    [
      {
        sid       = "ReadTags"
        actions   = ["dynamodb:GetItem"]
        resources = [local.tags_table_arn]
      },
      {
        sid       = "AppendEvents"
        actions   = ["dynamodb:PutItem"]
        resources = [local.events_table_arn]
      },
      local.read_api_key,
    ],
    var.auto_register_tags ? [{
      sid       = "RegisterUnknownTags"
      actions   = ["dynamodb:PutItem"]
      resources = [local.tags_table_arn]
    }] : [],
    local.notifications_enabled ? [local.read_messaging_token] : [],
  )

  log_retention_days = var.log_retention_days
  tags               = var.tags
}

# The tenant's administration surface: creates tags (`op = provision`) and binds
# them to an owner and a chat (`op = associate`).
#
# PutItem is what makes `provision` possible, and it is the answer to a real gap:
# without it the only thing that ever created a tag was auto-registration, which
# is a development flag and off in production by design, so there was no
# supported way to put a tag into service at all.
#
# It is guarded by the same x-api-key as tag-scan. A separate administration
# credential was considered and dropped as over-engineering at this scale; the
# limits that leaves are written down in the repository README.
module "lambda_associate_tag" {
  source = "../../modules/lambda"

  function_name    = "${local.name_prefix}-access-control-associate-tag"
  handler          = "src/handlers/associate-tag.handler"
  source_path      = data.archive_file.lambda.output_path
  source_code_hash = data.archive_file.lambda.output_base64sha256

  timeout     = var.lambda_timeout
  memory_size = var.lambda_memory_size

  environment_variables = merge(
    local.common_env,
    { API_KEY_PARAMETER_NAME = var.api_key_parameter_name },
  )

  policy_statements = [
    {
      sid       = "ReadBindAndCreateTags"
      actions   = ["dynamodb:GetItem", "dynamodb:UpdateItem", "dynamodb:PutItem"]
      resources = [local.tags_table_arn]
    },
    {
      sid       = "FindTagsByChat"
      actions   = ["dynamodb:Query"]
      resources = [local.tags_index_arn]
    },
    local.read_api_key,
  ]

  log_retention_days = var.log_retention_days
  tags               = var.tags
}

# Inbound messages from the messaging provider. No API key: the caller is the
# provider, and it proves who it is with its own mechanism — a shared secret
# header for Telegram, an HMAC over the body for WhatsApp — both keyed by the
# webhook secret this function reads from SSM.
module "lambda_webhook" {
  source = "../../modules/lambda"
  count  = local.webhook_enabled ? 1 : 0

  function_name    = "${local.name_prefix}-access-control-webhook"
  handler          = "src/handlers/webhook.handler"
  source_path      = data.archive_file.lambda.output_path
  source_code_hash = data.archive_file.lambda.output_base64sha256

  timeout     = var.lambda_timeout
  memory_size = var.lambda_memory_size

  environment_variables = merge(
    local.common_env,
    local.messaging_env,
    local.webhook_secret_env,
    local.whatsapp_env,
  )

  policy_statements = [
    {
      sid       = "ReadAndToggleTags"
      actions   = ["dynamodb:GetItem", "dynamodb:UpdateItem"]
      resources = [local.tags_table_arn]
    },
    {
      sid       = "FindTagsByChat"
      actions   = ["dynamodb:Query"]
      resources = [local.tags_index_arn]
    },
    local.read_messaging_token,
    local.read_webhook_secret,
  ]

  log_retention_days = var.log_retention_days
  tags               = var.tags
}

# -----------------------------------------------------------------------------
# Endpoints
#
# authorization_type = "NONE" means AWS does no auth: tag-scan and associate-tag
# check x-api-key against SSM themselves, and the webhook is authenticated by the
# messaging provider. The Function URL ignores the path, so the gateway's
# BASE_URL/PROJECT_NAME/event resolves to tag-scan unchanged.
#
# ── Each URL needs its own resource-based permission ──────────────────────────
# `authorization_type = "NONE"` only says AWS will not check a SigV4 signature. It
# does *not* grant anyone the right to invoke: that is a separate statement on the
# function's resource policy, and without it every request is answered 403 before
# the handler ever runs.
#
# The Lambda console adds that statement for you when you create a URL there. The
# CreateFunctionUrlConfig API — which is what Terraform calls — does not, so it has
# to be declared. `function_url_auth_type = "NONE"` is what scopes the grant to
# calls arriving through the URL rather than to lambda:InvokeFunction at large.
# -----------------------------------------------------------------------------

resource "aws_lambda_function_url" "tag_scan" {
  function_name      = module.lambda_tag_scan.function_name
  authorization_type = "NONE"
}

resource "aws_lambda_permission" "tag_scan_url" {
  statement_id           = "AllowFunctionUrlInvoke"
  action                 = "lambda:InvokeFunctionUrl"
  function_name          = module.lambda_tag_scan.function_name
  principal              = "*"
  function_url_auth_type = "NONE"
}

resource "aws_lambda_function_url" "associate_tag" {
  function_name      = module.lambda_associate_tag.function_name
  authorization_type = "NONE"
}

resource "aws_lambda_permission" "associate_tag_url" {
  statement_id           = "AllowFunctionUrlInvoke"
  action                 = "lambda:InvokeFunctionUrl"
  function_name          = module.lambda_associate_tag.function_name
  principal              = "*"
  function_url_auth_type = "NONE"
}

resource "aws_lambda_function_url" "webhook" {
  count = local.webhook_enabled ? 1 : 0

  function_name      = module.lambda_webhook[0].function_name
  authorization_type = "NONE"
}

resource "aws_lambda_permission" "webhook_url" {
  count = local.webhook_enabled ? 1 : 0

  statement_id           = "AllowFunctionUrlInvoke"
  action                 = "lambda:InvokeFunctionUrl"
  function_name          = module.lambda_webhook[0].function_name
  principal              = "*"
  function_url_auth_type = "NONE"
}
