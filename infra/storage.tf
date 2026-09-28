resource "aws_s3_bucket" "studio" {
  bucket = local.bucket
}

resource "aws_s3_bucket_public_access_block" "studio" {
  bucket                  = aws_s3_bucket.studio.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# Browser uploads go straight to S3 via presigned PUT.
resource "aws_s3_bucket_cors_configuration" "studio" {
  bucket = aws_s3_bucket.studio.id
  cors_rule {
    allowed_methods = ["PUT", "GET"]
    allowed_origins = ["*"]
    allowed_headers = ["*"]
    max_age_seconds = 3600
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "studio" {
  bucket = aws_s3_bucket.studio.id
  rule {
    id     = "expire-uploads"
    status = "Enabled"
    filter { prefix = "uploads/" }
    expiration { days = 30 }
  }
  rule {
    id     = "outputs-to-ia"
    status = "Enabled"
    filter { prefix = "outputs/" }
    transition {
      days          = 30
      storage_class = "STANDARD_IA"
    }
  }
}

resource "aws_dynamodb_table" "jobs" {
  name         = "yue-jobs"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "id"

  attribute {
    name = "id"
    type = "S"
  }
  attribute {
    name = "queue"
    type = "S"
  }
  attribute {
    name = "created_at"
    type = "N"
  }
  attribute {
    name = "owner"
    type = "S"
  }

  # Sparse index: only jobs waiting for the GPU carry `queue`.
  global_secondary_index {
    name            = "queue"
    hash_key        = "queue"
    range_key       = "created_at"
    projection_type = "ALL"
  }
  # All jobs, newest first, for the library view.
  global_secondary_index {
    name            = "history"
    hash_key        = "owner"
    range_key       = "created_at"
    projection_type = "ALL"
  }
}

resource "random_password" "passcode" {
  length  = 20
  special = false
}

resource "aws_ssm_parameter" "passcode" {
  name  = "/yue/passcode"
  type  = "SecureString"
  value = random_password.passcode.result
}
