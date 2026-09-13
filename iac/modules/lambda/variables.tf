variable "function_name" {
  description = "Name of the Lambda function"
  type        = string
}

variable "handler" {
  description = "Lambda handler, e.g. src/handlers/tagScan.handler"
  type        = string
}

variable "runtime" {
  description = "Lambda runtime (e.g. nodejs20.x)"
  type        = string
  default     = "nodejs20.x"
}

variable "source_path" {
  description = "Path to the deployment package (zip)"
  type        = string
}

variable "source_code_hash" {
  description = <<-EOT
    Base64 SHA-256 of the package, so a code change redeploys the function. Pass
    `data.archive_file.<x>.output_base64sha256` rather than letting the module read
    the file off disk: it makes the dependency on the archive explicit.
  EOT
  type        = string
}

variable "timeout" {
  description = "Lambda timeout in seconds"
  type        = number
  default     = 3
}

variable "memory_size" {
  description = "Lambda memory size in MB"
  type        = number
  default     = 128
}

variable "environment_variables" {
  description = "Environment variables for the function"
  type        = map(string)
  default     = {}
}

variable "policy_statements" {
  description = <<-EOT
    The permissions this function needs, declared by whoever knows what it calls —
    the use case, not this module. Replaces the old one-variable-per-AWS-service
    shape (`dynamodb_table_arns`, `ssm_parameter_arns`, …), which forced a fixed
    action list per service and made least privilege something you had to remember
    rather than something the design produced. A use case that needs SQS or S3 now
    needs no change here.
  EOT
  type = list(object({
    sid       = string
    actions   = list(string)
    resources = list(string)
  }))
  default = []
}

variable "log_retention_days" {
  description = <<-EOT
    Retention of the function's CloudWatch log group. The group is declared here on
    purpose: left to Lambda, it is created outside Terraform with retention "never
    expire", `destroy` leaves it orphaned, and the reproducibility claim gets a
    silent exception. Verified twice in this account.
    Note this caps storage only — log *ingestion* is billed either way.
  EOT
  type        = number
  default     = 7
}

variable "deny_costly_actions" {
  description = "Attach a Deny policy for expensive services so a use case cannot run up a bill"
  type        = bool
  default     = true
}

variable "tags" {
  description = "Tags to apply to the function, its role and its log group"
  type        = map(string)
  default     = {}
}
