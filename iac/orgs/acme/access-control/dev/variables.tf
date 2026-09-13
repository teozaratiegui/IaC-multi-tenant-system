variable "org_slug" {
  description = "Organisation identifier"
  type        = string
  default     = "acme"
}

variable "environment" {
  description = "Environment name: dev, staging or prod"
  type        = string
  default     = "dev"
}

variable "aws_region" {
  description = "AWS region"
  type        = string
  default     = "sa-east-1"
}

variable "enable_messaging" {
  description = <<-EOT
    Deploy the webhook and the owner-notification path. Requires the tenant root
    to list this use case in `messaging_use_cases`, which is what creates the bot
    token and the webhook secret it reads.
  EOT
  type        = bool
  default     = true
}

variable "messaging_provider" {
  description = "telegram or whatsapp"
  type        = string
  default     = "telegram"
}

variable "org_display_name" {
  description = "The organisation's name as owners read it in an alert. Null uses the slug."
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

variable "auto_register_tags" {
  description = "Register any unknown tag as allowed on first sight. Development only."
  type        = bool
  default     = false
}

variable "point_in_time_recovery" {
  description = <<-EOT
    Enable DynamoDB point-in-time recovery on both tables. Off by default because
    it costs money; the README lists it as a deployment-time choice, so the root
    has to expose it — the module's own default is not reachable from here.
  EOT
  type        = bool
  default     = false
}

variable "log_retention_days" {
  description = "CloudWatch retention, in days"
  type        = number
  default     = 7
}

variable "tags" {
  description = "Extra tags"
  type        = map(string)
  default     = {}
}
