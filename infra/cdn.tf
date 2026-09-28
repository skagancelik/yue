resource "aws_cloudfront_origin_access_control" "s3" {
  name                              = "yue-s3"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

locals {
  # AWS managed policies
  cache_optimized    = "658327ea-f89d-4fab-a63d-7e88639e58f6"
  caching_disabled   = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad"
  all_viewer_no_host = "b689b0a8-53d0-40ab-baf2-68738e2966ac"
  lambda_host        = replace(replace(aws_lambda_function_url.api.function_url, "https://", ""), "/", "")
}

resource "aws_cloudfront_distribution" "web" {
  enabled             = true
  comment             = "yue cover studio"
  default_root_object = "index.html"
  price_class         = "PriceClass_100"
  http_version        = "http2and3"

  origin {
    origin_id                = "s3"
    domain_name              = aws_s3_bucket.studio.bucket_regional_domain_name
    origin_path              = "/web"
    origin_access_control_id = aws_cloudfront_origin_access_control.s3.id
  }

  origin {
    origin_id   = "api"
    domain_name = local.lambda_host
    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  default_cache_behavior {
    target_origin_id       = "s3"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    cache_policy_id        = local.cache_optimized
    compress               = true
  }

  ordered_cache_behavior {
    path_pattern             = "/api/*"
    target_origin_id         = "api"
    viewer_protocol_policy   = "https-only"
    allowed_methods          = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods           = ["GET", "HEAD"]
    cache_policy_id          = local.caching_disabled
    origin_request_policy_id = local.all_viewer_no_host
  }

  restrictions {
    geo_restriction { restriction_type = "none" }
  }

  viewer_certificate { cloudfront_default_certificate = true }
}

resource "aws_s3_bucket_policy" "studio" {
  bucket = aws_s3_bucket.studio.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "cloudfront.amazonaws.com" }
      Action    = "s3:GetObject"
      Resource  = "${aws_s3_bucket.studio.arn}/web/*"
      Condition = { StringEquals = { "AWS:SourceArn" = aws_cloudfront_distribution.web.arn } }
    }]
  })
}
