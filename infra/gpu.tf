resource "aws_iam_role" "gpu" {
  name                 = "yue-gpu"
  path                 = "/yue/app/"
  permissions_boundary = local.boundary
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "ec2.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy_attachment" "gpu_ssm" {
  role       = aws_iam_role.gpu.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_role_policy" "gpu" {
  name = "yue-gpu"
  role = aws_iam_role.gpu.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["s3:GetObject", "s3:PutObject", "s3:ListBucket"],
      Resource = [aws_s3_bucket.studio.arn, "${aws_s3_bucket.studio.arn}/*"] },
      { Effect = "Allow", Action = ["dynamodb:*"], Resource = [aws_dynamodb_table.jobs.arn, "${aws_dynamodb_table.jobs.arn}/index/*"] },
      { Effect = "Allow", Action = ["ssm:GetParameter"], Resource = "arn:aws:ssm:${var.region}:${local.account}:parameter/yue/*" },
      { Effect = "Allow", Action = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"], Resource = "*" },
    ]
  })
}

resource "aws_iam_instance_profile" "gpu" {
  name = "yue-gpu"
  path = "/yue/"
  role = aws_iam_role.gpu.name
}

resource "aws_instance" "gpu" {
  ami                                  = data.aws_ami.ubuntu.id
  instance_type                        = var.gpu_instance_type
  subnet_id                            = aws_subnet.public.id
  vpc_security_group_ids               = [aws_security_group.gpu.id]
  iam_instance_profile                 = aws_iam_instance_profile.gpu.name
  instance_initiated_shutdown_behavior = "stop"

  root_block_device {
    volume_type           = "gp3"
    volume_size           = var.root_volume_gb
    delete_on_termination = true
    encrypted             = true
    tags                  = { Name = "yue-gpu-root", Project = "yue" }
  }

  metadata_options {
    http_tokens = "required"
  }

  # Runs on every boot: pulls the repo from GitHub and hands off to worker/boot.sh.
  user_data_replace_on_change = false
  user_data                   = <<-EOT
    Content-Type: multipart/mixed; boundary="//"
    MIME-Version: 1.0

    --//
    Content-Type: text/cloud-config; charset="us-ascii"

    #cloud-config
    cloud_final_modules:
    - [scripts-user, always]

    --//
    Content-Type: text/x-shellscript; charset="us-ascii"

    #!/bin/bash
    set -e
    mkdir -p /opt/yue
    cat > /etc/yue.env <<ENV
    YUE_REGION=${var.region}
    YUE_BUCKET=${local.bucket}
    YUE_TABLE=${aws_dynamodb_table.jobs.name}
    YUE_IDLE_MINUTES=${var.idle_minutes}
    YUE_REPO=${var.github_repo}
    ENV
    if [ ! -d /opt/yue/app/.git ]; then git clone ${var.github_repo} /opt/yue/app; fi
    git -C /opt/yue/app fetch --depth 1 origin main && git -C /opt/yue/app reset --hard origin/main
    exec bash /opt/yue/app/worker/boot.sh
    --//--
  EOT

  tags = { Name = "yue-gpu" }

  lifecycle {
    # The instance is started/stopped/retyped by Lambda; never let Terraform fight it.
    ignore_changes = [ami, instance_type, user_data]
  }
}
