terraform {
  required_version = ">= 1.10"
  required_providers {
    aws     = { source = "hashicorp/aws", version = "~> 6.0" }
    random  = { source = "hashicorp/random", version = "~> 3.6" }
    archive = { source = "hashicorp/archive", version = "~> 2.6" }
  }
  backend "s3" {
    bucket       = "yue-tfstate-730335425452"
    key          = "yue/terraform.tfstate"
    region       = "eu-central-1"
    use_lockfile = true
  }
}

provider "aws" {
  region = var.region
  default_tags { tags = { Project = "yue" } }
}

variable "region" { default = "eu-central-1" }
variable "az" { default = "eu-central-1b" }
variable "gpu_instance_type" { default = "g6.2xlarge" }
# Tried in order when the primary type has no capacity.
variable "gpu_fallback_types" { default = "g5.2xlarge,g6e.xlarge,g6.xlarge,g5.xlarge" }
variable "idle_minutes" { default = 10 }
variable "root_volume_gb" { default = 45 }
variable "github_repo" { default = "https://github.com/skagancelik/yue.git" }
variable "alert_email" { default = "skcelik@gmail.com" }
variable "monthly_budget_usd" { default = 30 }

data "aws_caller_identity" "me" {}

locals {
  name     = "yue"
  account  = data.aws_caller_identity.me.account_id
  boundary = "arn:aws:iam::${local.account}:policy/yue-app-boundary"
  bucket   = "yue-studio-${local.account}"
}

# Newest Canonical Ubuntu 24.04 at first apply; ignored afterwards so the
# prepared root volume is never replaced.
data "aws_ami" "ubuntu" {
  most_recent = true
  owners      = ["099720109477"]
  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*"]
  }
}

output "url" { value = "https://${aws_cloudfront_distribution.web.domain_name}" }
output "instance_id" { value = aws_instance.gpu.id }
output "bucket" { value = aws_s3_bucket.studio.bucket }
output "distribution_id" { value = aws_cloudfront_distribution.web.id }
