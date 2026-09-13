variable "aws_region" {
  description = "AWS region for the backend resources"
  type        = string
  default     = "sa-east-1"
}

variable "state_bucket_name" {
  description = "Unique name for the state S3 bucket (e.g. mycompany-terraform-state-dev)"
  type        = string
}

variable "lock_table_name" {
  description = "Name for the DynamoDB lock table (e.g. mycompany-terraform-lock-dev)"
  type        = string
}

variable "tags" {
  description = "Tags applied to the state bucket and the lock table"
  type        = map(string)
  default     = {}
}
