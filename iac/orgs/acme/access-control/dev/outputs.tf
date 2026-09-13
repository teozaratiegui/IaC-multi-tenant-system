output "tags_table_name" {
  description = "DynamoDB table of tags"
  value       = module.access_control.tags_table_name
}

output "events_table_name" {
  description = "DynamoDB table of events"
  value       = module.access_control.events_table_name
}

output "tag_scan_url" {
  description = <<-EOT
    Endpoint for tag events — this is the gateway's BASE_URL.
    The API key: aws ssm get-parameter --name /acme/dev/api-key --with-decryption \
      --query Parameter.Value --output text
  EOT
  value       = module.access_control.tag_scan_url
}

output "associate_tag_url" {
  description = "Endpoint that binds a tag to an owner and a chat"
  value       = module.access_control.associate_tag_url
}

output "webhook_url" {
  description = "Endpoint to register with the messaging provider, or null when messaging is off"
  value       = module.access_control.webhook_url
}

output "log_group_names" {
  description = "Log groups managed by Terraform"
  value       = module.access_control.log_group_names
}
