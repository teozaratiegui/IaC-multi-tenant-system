variable "org_slug" {
  description = "Organisation identifier, lower case (e.g. acme)"
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$", var.org_slug))
    error_message = "org_slug must be lower-case alphanumeric with hyphens, 3-32 characters."
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

variable "messaging_use_cases" {
  description = <<-EOT
    Use cases of this tenant that talk to a messaging provider, by slug — for
    example ["access-control"]. Each one gets its **own** bot token and its own
    webhook secret, at /<org>/<env>/<use case>/…

    Per use case and not per tenant on purpose: one organisation can perfectly
    well run access control on Telegram and something else on WhatsApp, and a
    single shared token could only ever hold one provider's credential. The
    slugs must match what the use-case roots read. They are matched by name and
    nothing checks the pairing at plan time: a use-case root builds its parameter
    names as strings rather than reading them with a data source, because that
    data source would copy the decrypted secrets into its state. A slug missing
    here surfaces as a GetParameter error in the function's log on its first
    invoke — see the note in iac/orgs/acme/access-control/dev/main.tf.

    Which provider each use case actually uses is **not** decided here: it is a
    variable of the use-case root. Naming it in two places is how the two drift.
  EOT
  type        = set(string)
  default     = []

  validation {
    condition = alltrue([
      for slug in var.messaging_use_cases : can(regex("^[a-z0-9][a-z0-9-]{1,40}[a-z0-9]$", slug))
    ])
    error_message = "Each use-case slug must be lower-case alphanumeric with hyphens, 3-42 characters."
  }
}

variable "tags" {
  description = "Tags applied to every resource in this layer"
  type        = map(string)
  default     = {}
}
