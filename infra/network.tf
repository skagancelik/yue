# Dedicated tiny VPC: one public subnet, no NAT gateway (NAT would cost ~$35/mo).
# The GPU box gets an auto-assigned public IP only while running and has no
# inbound rules; access is via SSM.
resource "aws_vpc" "main" {
  cidr_block           = "10.77.0.0/24"
  enable_dns_hostnames = true
  enable_dns_support   = true
  tags                 = { Name = "yue" }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = "yue" }
}

resource "aws_subnet" "public" {
  vpc_id                  = aws_vpc.main.id
  cidr_block              = "10.77.0.0/25"
  availability_zone       = var.az
  map_public_ip_on_launch = true
  tags                    = { Name = "yue-public" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }
  tags = { Name = "yue-public" }
}

resource "aws_route_table_association" "public" {
  subnet_id      = aws_subnet.public.id
  route_table_id = aws_route_table.public.id
}

resource "aws_security_group" "gpu" {
  name        = "yue-gpu"
  description = "YuE GPU worker - egress only"
  vpc_id      = aws_vpc.main.id
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
  tags = { Name = "yue-gpu" }
}
