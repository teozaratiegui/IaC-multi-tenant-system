output "tags_table_name" {
  description = "DynamoDB table of tags (tagId -> allowed, owner, chatId)"
  value       = module.table_tags.table_name
}

output "events_table_name" {
  description = "DynamoDB table of events (tagId + eventId, one row per scan)"
  value       = module.table_events.table_name
}

output "tag_scan_url" {
  description = <<-EOT
    HTTPS endpoint for tag events. This is what the Fog gateway's BASE_URL points
    at; the path it appends is ignored. The API key comes from SSM:
      aws ssm get-parameter --name <api_key_parameter_name> --with-decryption \
        --query Parameter.Value --output text
  EOT
  value       = aws_lambda_function_url.tag_scan.function_url
}

output "associate_tag_url" {
  description = "HTTPS endpoint that binds a tag to an owner and a chat"
  value       = aws_lambda_function_url.associate_tag.function_url
}

output "webhook_url" {
  description = "HTTPS endpoint to register with the messaging provider, or null when messaging is disabled"
  value       = length(aws_lambda_function_url.webhook) > 0 ? aws_lambda_function_url.webhook[0].function_url : null
}

output "log_group_names" {
  description = "Log groups of this use case, managed by Terraform so destroy removes them"
  value = compact([
    module.lambda_tag_scan.log_group_name,
    module.lambda_associate_tag.log_group_name,
    length(module.lambda_webhook) > 0 ? module.lambda_webhook[0].log_group_name : "",
  ])
}
