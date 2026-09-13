variable "org_slug" {
  description = "Organisation identifier (e.g. acme). Must match the tenant layer's, exactly."
  type        = string

  # The same rule the tenant layer enforces, and it has to be here too: nothing
  # ties the two roots together. The SSM parameter names arrive as plain strings
  # (see the org root), so there is no data source to notice that `Acme` is not
  # `acme` — the apply succeeds, the infrastructure comes up complete, and the
  # first invoke fails with a 500 and ParameterNotFound. Validating the shape on
  # both sides turns the likeliest version of that mistake into a plan-time
  # error instead of a runtime one.
  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$", var.org_slug))
    error_message = "org_slug must be lower-case alphanumeric with hyphens, 3-32 characters, and must match the tenant layer's org_slug exactly."
  }
}

variable "environment" {
  description = "Environment name: dev, staging or prod"
  type        = string

  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "environment must be one of: dev, staging, prod."
  }
}

# --- Credentials, owned by the tenant layer ----------------------------------

variable "api_key_parameter_name" {
  description = "SSM parameter holding the API key (e.g. /acme/dev/api-key), created by the tenant layer"
  type        = string
}

variable "api_key_parameter_arn" {
  description = "ARN of that parameter, so the functions' roles can read it"
  type        = string
}

variable "messaging_token_parameter_name" {
  description = <<-EOT
    SSM parameter holding the messaging bot token, from the tenant layer. Null
    disables messaging entirely: no webhook function, no webhook URL, and neither
    the notify path nor its permission is deployed.
  EOT
  type        = string
  default     = null
}

variable "messaging_token_parameter_arn" {
  description = "ARN of the messaging token parameter. Required when messaging_token_parameter_name is set."
  type        = string
  default     = null
}

variable "webhook_secret_parameter_name" {
  description = <<-EOT
    SSM parameter holding the webhook secret, from the tenant layer. It is what
    proves an inbound webhook request really came from the messaging provider:
    Telegram echoes it in a header, WhatsApp keys its body HMAC with it. Without
    it the webhook has no authentication at all, and its Function URL is public.
  EOT
  type        = string
  default     = null
}

variable "webhook_secret_parameter_arn" {
  description = "ARN of the webhook secret parameter. Required when messaging is enabled."
  type        = string
  default     = null
}

variable "messaging_provider" {
  description = "Which integration the handlers talk to"
  type        = string
  default     = "telegram"

  validation {
    condition     = contains(["telegram", "whatsapp"], var.messaging_provider)
    error_message = "messaging_provider must be telegram or whatsapp."
  }
}

variable "whatsapp_phone_number_id" {
  description = "WhatsApp Business phone number id. Only used when messaging_provider is whatsapp."
  type        = string
  default     = ""
}

variable "whatsapp_verify_token" {
  description = <<-EOT
    Token WhatsApp echoes back when verifying the webhook. Not a secret in the SSM
    sense — Meta sends it in a query string — but do not commit a real one.
  EOT
  type        = string
  default     = ""
}

# --- Presentation ------------------------------------------------------------

variable "org_display_name" {
  description = <<-EOT
    The organisation's name as a person reads it in an alert. Defaults to the
    slug, which is what the deployed code printed — owners were told about
    "el lector de acme".
  EOT
  type        = string
  default     = null
}

variable "messaging_locale" {
  description = "Locale for dates and times in the messages sent to owners"
  type        = string
  default     = "es-AR"
}

variable "messaging_timezone" {
  description = "IANA time zone the messages are written in"
  type        = string
  default     = "America/Argentina/Buenos_Aires"
}

# --- Behaviour ---------------------------------------------------------------

variable "auto_register_tags" {
  description = <<-EOT
    Register any unknown tag as allowed on first sight. Development only.
    This is an explicit flag and never inferred from `environment`: when it was,
    a mistyped ENVIRONMENT opened the door to every tag. With it false, the
    functions are not even granted PutItem on the tags table.
  EOT
  type        = bool
  default     = false
}

variable "lambda_timeout" {
  description = <<-EOT
    Must stay below the Fog gateway's own timeout (5 s, AWS_TIMEOUT_S) so a slow
    invocation fails before the caller gives up and retries. See the note in main.tf.
  EOT
  type        = number
  default     = 4

  validation {
    condition     = var.lambda_timeout > 0 && var.lambda_timeout < 5
    error_message = "lambda_timeout must be under 5 s, the gateway's own timeout."
  }
}

variable "lambda_memory_size" {
  description = "Memory for each function, in MB"
  type        = number
  default     = 256
}

variable "log_retention_days" {
  description = "CloudWatch retention for every function in this use case"
  type        = number
  default     = 7
}

variable "point_in_time_recovery" {
  description = "Enable DynamoDB point-in-time recovery. Costs money; off by default."
  type        = bool
  default     = false
}

variable "tags" {
  description = "Tags for resources"
  type        = map(string)
  default     = {}
}
