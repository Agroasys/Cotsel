data "terraform_remote_state" "network" {
  backend = "s3"

  config = {
    bucket = var.state_bucket
    key    = "staging-network/terraform.tfstate"
    region = var.state_bucket_region
  }
}

data "terraform_remote_state" "data" {
  backend = "s3"

  config = {
    bucket = var.state_bucket
    key    = "staging-data/terraform.tfstate"
    region = var.state_bucket_region
  }
}

locals {
  vpc_id                         = data.terraform_remote_state.network.outputs.vpc_id
  private_subnet_ids             = data.terraform_remote_state.network.outputs.private_subnet_ids
  data_client_sg_id              = data.terraform_remote_state.data.outputs.client_security_group_id
  data_kms_key_arn               = data.terraform_remote_state.data.outputs.kms_key_arn
  postgres_master_secret_arn     = data.terraform_remote_state.data.outputs.master_secret_arn
  postgres_master_secret_kms_arn = data.terraform_remote_state.data.outputs.master_secret_kms_key_arn
  postgres_endpoint              = data.terraform_remote_state.data.outputs.postgres_endpoint
  redis_primary_endpoint         = data.terraform_remote_state.data.outputs.redis_primary_endpoint
}

resource "aws_security_group" "gateway" {
  name        = "${local.name_prefix}-gateway"
  description = "Cotsel gateway tasks. Ingress is restricted to the internal ALB."
  vpc_id      = local.vpc_id

  tags = { Name = "${local.name_prefix}-gateway" }
}

resource "aws_security_group" "internal_services" {
  name        = "${local.name_prefix}-internal-services"
  description = "Private Cotsel services. Ingress is restricted to Cotsel tasks."
  vpc_id      = local.vpc_id

  tags = { Name = "${local.name_prefix}-internal-services" }
}

resource "aws_security_group" "alb" {
  name        = "${local.name_prefix}-alb"
  description = "Internal Cotsel gateway origin. CloudFront is the only ingress source."
  vpc_id      = local.vpc_id

  tags = { Name = "${local.name_prefix}-alb" }
}

data "aws_ec2_managed_prefix_list" "cloudfront_origin" {
  name = "com.amazonaws.global.cloudfront.origin-facing"
}

resource "aws_vpc_security_group_ingress_rule" "alb_from_cloudfront" {
  security_group_id = aws_security_group.alb.id
  description       = "HTTPS from CloudFront VPC origins only."
  prefix_list_id    = data.aws_ec2_managed_prefix_list.cloudfront_origin.id
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
}

resource "aws_vpc_security_group_egress_rule" "alb_to_gateway" {
  security_group_id            = aws_security_group.alb.id
  description                  = "Forward requests only to the Cotsel gateway."
  referenced_security_group_id = aws_security_group.gateway.id
  from_port                    = 3600
  to_port                      = 3600
  ip_protocol                  = "tcp"
}

resource "aws_vpc_security_group_ingress_rule" "gateway_from_alb" {
  security_group_id            = aws_security_group.gateway.id
  description                  = "Gateway ingress from the internal ALB only."
  referenced_security_group_id = aws_security_group.alb.id
  from_port                    = 3600
  to_port                      = 3600
  ip_protocol                  = "tcp"
}

resource "aws_vpc_security_group_ingress_rule" "services_from_gateway" {
  security_group_id            = aws_security_group.internal_services.id
  description                  = "Internal HTTP calls from the gateway."
  referenced_security_group_id = aws_security_group.gateway.id
  from_port                    = 3000
  to_port                      = 3999
  ip_protocol                  = "tcp"
}

resource "aws_vpc_security_group_ingress_rule" "services_from_services" {
  security_group_id            = aws_security_group.internal_services.id
  description                  = "Authenticated service-to-service HTTP inside Cotsel."
  referenced_security_group_id = aws_security_group.internal_services.id
  from_port                    = 3000
  to_port                      = 3999
  ip_protocol                  = "tcp"
}

# Cotsel currently needs HTTPS egress for Base RPC and the reciprocal Agroasys
# callback. Destination restriction is added after the two managed RPC endpoints
# and the callback edge addresses are pinned. VPC flow logs remain the detection
# control inherited from staging-network in the interim.
#trivy:ignore:AVD-AWS-0104:exp:2026-09-30
resource "aws_vpc_security_group_egress_rule" "gateway_https" {
  security_group_id = aws_security_group.gateway.id
  description       = "HTTPS to approved RPC and Agroasys callback endpoints through managed NAT."
  cidr_ipv4         = "0.0.0.0/0"
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
}

#trivy:ignore:AVD-AWS-0104:exp:2026-09-30
resource "aws_vpc_security_group_egress_rule" "services_https" {
  security_group_id = aws_security_group.internal_services.id
  description       = "HTTPS to approved Base RPC and provider endpoints through managed NAT."
  cidr_ipv4         = "0.0.0.0/0"
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
}
