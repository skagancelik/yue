data "archive_file" "api" {
  type        = "zip"
  source_dir  = "${path.module}/../api"
  output_path = "${path.module}/.build/api.zip"
  excludes    = ["__pycache__", "test_handler.py"]
}

resource "aws_iam_role" "api" {
  name                 = "yue-api"
  path                 = "/yue/app/"
  permissions_boundary = local.boundary
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "lambda.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy" "api" {
  name = "yue-api"
  role = aws_iam_role.api.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"], Resource = "${aws_s3_bucket.studio.arn}/*" },
      { Effect = "Allow", Action = ["dynamodb:*"], Resource = [aws_dynamodb_table.jobs.arn, "${aws_dynamodb_table.jobs.arn}/index/*"] },
      { Effect = "Allow", Action = ["ssm:GetParameter"], Resource = aws_ssm_parameter.passcode.arn },
      { Effect = "Allow", Action = ["ec2:StartInstances", "ec2:StopInstances", "ec2:ModifyInstanceAttribute"], Resource = aws_instance.gpu.arn },
      { Effect = "Allow", Action = ["ec2:DescribeInstances"], Resource = "*" },
      { Effect = "Allow", Action = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"], Resource = "*" },
    ]
  })
}

locals {
  api_env = {
    YUE_BUCKET         = aws_s3_bucket.studio.bucket
    YUE_TABLE          = aws_dynamodb_table.jobs.name
    YUE_INSTANCE_ID    = aws_instance.gpu.id
    YUE_PRIMARY_TYPE   = var.gpu_instance_type
    YUE_FALLBACK_TYPES = var.gpu_fallback_types
    YUE_IDLE_MINUTES   = tostring(var.idle_minutes)
    YUE_PASSCODE_PARAM = aws_ssm_parameter.passcode.name
  }
}

resource "aws_cloudwatch_log_group" "api" {
  name              = "/aws/lambda/yue-api"
  retention_in_days = 14
}

resource "aws_cloudwatch_log_group" "janitor" {
  name              = "/aws/lambda/yue-janitor"
  retention_in_days = 14
}

resource "aws_lambda_function" "api" {
  function_name    = "yue-api"
  role             = aws_iam_role.api.arn
  runtime          = "python3.13"
  architectures    = ["arm64"]
  handler          = "handler.api"
  filename         = data.archive_file.api.output_path
  source_code_hash = data.archive_file.api.output_base64sha256
  timeout          = 29
  memory_size      = 256
  environment { variables = local.api_env }
  depends_on = [aws_cloudwatch_log_group.api]
}

resource "aws_lambda_function_url" "api" {
  function_name      = aws_lambda_function.api.function_name
  authorization_type = "NONE"
}

resource "aws_lambda_permission" "url" {
  statement_id           = "public-url"
  action                 = "lambda:InvokeFunctionUrl"
  function_name          = aws_lambda_function.api.function_name
  principal              = "*"
  function_url_auth_type = "NONE"
}

resource "aws_lambda_permission" "url_invoke" {
  statement_id  = "public-url-invoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.api.function_name
  principal     = "*"
}

# Safety net: stops a GPU that is idle (or whose agent died), starts it when
# jobs are waiting, and fails jobs that got stuck.
resource "aws_lambda_function" "janitor" {
  function_name    = "yue-janitor"
  role             = aws_iam_role.api.arn
  runtime          = "python3.13"
  architectures    = ["arm64"]
  handler          = "handler.janitor"
  filename         = data.archive_file.api.output_path
  source_code_hash = data.archive_file.api.output_base64sha256
  timeout          = 60
  memory_size      = 128
  environment { variables = local.api_env }
  depends_on = [aws_cloudwatch_log_group.janitor]
}

resource "aws_cloudwatch_event_rule" "janitor" {
  name                = "yue-janitor"
  schedule_expression = "rate(5 minutes)"
}

resource "aws_cloudwatch_event_target" "janitor" {
  rule = aws_cloudwatch_event_rule.janitor.name
  arn  = aws_lambda_function.janitor.arn
}

resource "aws_lambda_permission" "janitor" {
  statement_id  = "events"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.janitor.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.janitor.arn
}

resource "aws_budgets_budget" "monthly" {
  name         = "yue-monthly"
  budget_type  = "COST"
  limit_amount = tostring(var.monthly_budget_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"
  cost_filter {
    name   = "TagKeyValue"
    values = ["user:Project$yue"]
  }
  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 80
    threshold_type             = "PERCENTAGE"
    notification_type          = "FORECASTED"
    subscriber_email_addresses = [var.alert_email]
  }
  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.alert_email]
  }
}
