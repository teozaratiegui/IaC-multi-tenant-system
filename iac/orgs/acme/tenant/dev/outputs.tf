output "api_key_parameter_name" {
  description = "SSM parameter the use-case roots read"
  value       = module.tenant.api_key_parameter_name
}

output "messaging_token_parameter_names" {
  description = "SSM parameter holding the bot token, per use case"
  value       = module.tenant.messaging_token_parameter_names
}

output "webhook_secret_parameter_names" {
  description = "SSM parameter the webhook verifies inbound requests against, per use case"
  value       = module.tenant.webhook_secret_parameter_names
}

output "parameters_to_set" {
  description = "Run these after the first apply to put the real values in"
  value       = module.tenant.parameters_to_set
}
