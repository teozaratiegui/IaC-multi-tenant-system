output "api_key_value" {
  value       = random_password.api_key.result
  sensitive   = true
  description = "API key (stored in SSM Parameter Store): send in header X-Api-Key. Run: terraform output -raw api_key_value"
}

output "access_control_table_name" {
  value       = module.access_control.table_name
  description = "DynamoDB table for access_control (e.g. acme-dev-access-control)"
}

output "access_control_url" {
  value       = module.access_control.function_url
  description = "Lambda Function URL: POST with x-api-key and body {\"tag\":\"...\", \"timestamp\":\"...\"}"
}
