variable "function_name" {
  description = "Name of the Lambda function"
  type        = string
}

variable "handler" {
  description = "Lambda handler (e.g. index.handler)"
  type        = string
}

variable "runtime" {
  description = "Lambda runtime (e.g. nodejs20.x, python3.12)"
  type        = string
}

# Source: either local file or S3
variable "source_path" {
  description = "Path to the deployment package (zip). Use this OR s3_bucket/s3_key."
  type        = string
  default     = null
}

variable "s3_bucket" {
  description = "S3 bucket containing the deployment package"
  type        = string
  default     = null
}

variable "s3_key" {
  description = "S3 key of the deployment package"
  type        = string
  default     = null
}

variable "s3_object_version" {
  description = "S3 object version of the deployment package"
  type        = string
  default     = null
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
  description = "Environment variables for the Lambda"
  type        = map(string)
  default     = {}
}

variable "subnet_ids" {
  description = "Subnet IDs for VPC config (optional)"
  type        = list(string)
  default     = null
}

variable "security_group_ids" {
  description = "Security group IDs for VPC config (optional)"
  type        = list(string)
  default     = null
}

variable "dynamodb_table_arns" {
  description = "ARNs of DynamoDB tables this Lambda can access (grants read/write)"
  type        = list(string)
  default     = []
}

variable "secrets_manager_arns" {
  description = "ARNs of Secrets Manager secrets this Lambda can read (e.g. DB credentials)"
  type        = list(string)
  default     = []
}

variable "ssm_parameter_arns" {
  description = "ARNs of SSM Parameter Store parameters this Lambda can read (Standard tier is free)"
  type        = list(string)
  default     = []
}

variable "deny_costly_actions" {
  description = "If true, attach a policy that Denies EC2, RDS, Lambda create/update, DynamoDB create/delete table, S3 write, EKS/ECS so use cases cannot incur unexpected charges"
  type        = bool
  default     = true
}

variable "tags" {
  description = "Tags to apply to the Lambda and its role"
  type        = map(string)
  default     = {}
}
