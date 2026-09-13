# No output exposes a credential value: the values are not in Terraform at all.
# Read one with:
#   aws ssm get-parameter --name <name> --with-decryption \
#     --query Parameter.Value --output text

output "api_key_parameter_name" {
  description = "SSM parameter holding the API key; use-case roots read this name"
  value       = aws_ssm_parameter.api_key.name
}

output "api_key_parameter_arn" {
  description = "ARN of the API key parameter, for the Lambda IAM policy"
  value       = aws_ssm_parameter.api_key.arn
}

# Maps keyed by use-case slug. A use-case root reads its own parameter by name
# rather than through these, so that the two roots stay independently appliable;
# these are here to make "what exists for this tenant?" answerable in one look.
output "messaging_token_parameter_names" {
  description = "SSM parameter holding the bot token, per use case"
  value       = { for slug, parameter in aws_ssm_parameter.messaging_token : slug => parameter.name }
}

output "messaging_token_parameter_arns" {
  description = "ARN of the bot token parameter, per use case"
  value       = { for slug, parameter in aws_ssm_parameter.messaging_token : slug => parameter.arn }
}

output "webhook_secret_parameter_names" {
  description = "SSM parameter holding the webhook verification secret, per use case"
  value       = { for slug, parameter in aws_ssm_parameter.webhook_secret : slug => parameter.name }
}

output "webhook_secret_parameter_arns" {
  description = "ARN of the webhook secret parameter, per use case"
  value       = { for slug, parameter in aws_ssm_parameter.webhook_secret : slug => parameter.arn }
}

output "parameters_to_set" {
  description = "Commands that put the real values in. Run these after the first apply."
  value = concat(
    ["aws ssm put-parameter --name ${aws_ssm_parameter.api_key.name} --type SecureString --value \"$(openssl rand -hex 32)\" --overwrite"],
    [
      for slug, parameter in aws_ssm_parameter.messaging_token :
      "aws ssm put-parameter --name ${parameter.name} --type SecureString --value '<bot token for ${slug}>' --overwrite"
    ],
    [
      for slug, parameter in aws_ssm_parameter.webhook_secret :
      "aws ssm put-parameter --name ${parameter.name} --type SecureString --value \"$(openssl rand -hex 32)\" --overwrite   # then give the same value to ${slug}'s setWebhook"
    ],
  )
}
