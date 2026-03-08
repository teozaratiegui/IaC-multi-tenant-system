# -----------------------------------------------------------------------------
# Access control use case: table (tagId + allowed), Lambda, Function URL
# Before first apply: cd lambdas/access_control && npm install
# -----------------------------------------------------------------------------

module "table" {
  source = "../../../modules/dynamodb"

  table_name   = "${var.org_slug}-${var.environment}-access-control"
  hash_key     = "tagId"
  billing_mode = "PAY_PER_REQUEST"

  attributes = [
    { name = "tagId", type = "S" }
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
  source = "../../../modules/lambda"

  function_name = "${var.org_slug}-${var.environment}-access-control"
  handler       = "index.handler"
  runtime       = "nodejs20.x"
  source_path   = data.archive_file.lambda.output_path

  timeout     = 15
  memory_size = 256

  environment_variables = {
    TABLE_NAME             = module.table.table_name
    API_KEY_PARAMETER_NAME = var.api_key_parameter_name
  }

  dynamodb_table_arns  = [module.table.table_arn]
  ssm_parameter_arns   = [var.api_key_parameter_arn]
  tags                 = var.tags
}

resource "aws_lambda_function_url" "this" {
  function_name      = module.lambda.function_name
  authorization_type = "NONE"
}
