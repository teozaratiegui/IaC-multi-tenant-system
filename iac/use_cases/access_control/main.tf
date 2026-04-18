# -----------------------------------------------------------------------------
# Access control: tags (tagId -> allowed), events (tagId + eventTime per scan)
# Before first apply: cd lambdas/access_control && npm install
# -----------------------------------------------------------------------------

# Tags: whether a tag is allowed or not (tagId + allowed)
module "table_tags" {
  source = "../../modules/dynamodb"

  table_name   = "${var.org_slug}-${var.environment}-tags"
  hash_key     = "tagId"
  billing_mode = "PAY_PER_REQUEST"

  attributes = [
    { name = "tagId", type = "S" }
  ]

  point_in_time_recovery = false
  tags                   = var.tags
}

# Events: one row per scan — tag X at time Y (tagId + eventTime)
module "table_events" {
  source = "../../modules/dynamodb"

  table_name   = "${var.org_slug}-${var.environment}-events"
  hash_key     = "tagId"
  range_key    = "eventTime"
  billing_mode = "PAY_PER_REQUEST"

  attributes = [
    { name = "tagId", type = "S" },
    { name = "eventTime", type = "N" }
  ]

  point_in_time_recovery = false
  tags                   = var.tags
}

data "archive_file" "lambda" {
  type        = "zip"
  source_dir  = "${path.module}/lambdas/access_control"
  output_path = "${path.module}/build/access_control.zip"
}

module "lambda" {
  source = "../../modules/lambda"

  function_name = "${var.org_slug}-${var.environment}-access-control"
  handler       = "index.handler"
  runtime       = "nodejs20.x"
  source_path   = data.archive_file.lambda.output_path

  timeout     = 15
  memory_size = 256

  environment_variables = {
    TAGS_TABLE_NAME        = module.table_tags.table_name
    EVENTS_TABLE_NAME      = module.table_events.table_name
    API_KEY_PARAMETER_NAME = var.api_key_parameter_name
    ENVIRONMENT            = var.environment
  }

  dynamodb_table_arns  = [module.table_tags.table_arn, module.table_events.table_arn]
  ssm_parameter_arns   = [var.api_key_parameter_arn]
  tags                 = var.tags
}

resource "aws_lambda_function_url" "this" {
  function_name      = module.lambda.function_name
  authorization_type = "NONE"
}
