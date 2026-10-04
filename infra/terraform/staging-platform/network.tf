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

data "terraform_remote_state" "foundation" {
  backend = "s3"

  config = {
    bucket = var.state_bucket
    key    = "cotsel/staging-platform/foundation.tfstate"
    region = var.state_bucket_region
  }
}

locals {
  vpc_id                     = data.terraform_remote_state.network.outputs.vpc_id
  private_subnet_ids         = data.terraform_remote_state.network.outputs.private_subnet_ids
  data_client_sg_id          = data.terraform_remote_state.data.outputs.client_security_group_id
  data_kms_key_arn           = data.terraform_remote_state.data.outputs.kms_key_arn
  postgres_master_secret_arn = data.terraform_remote_state.data.outputs.master_secret_arn
  postgres_endpoint          = data.terraform_remote_state.data.outputs.postgres_endpoint
  redis_primary_endpoint     = data.terraform_remote_state.data.outputs.redis_primary_endpoint
}

resource "aws_security_group" "gateway" {
  name = "${local.name_prefix}-gateway"
  # AWS security-group descriptions are immutable. Keep this aligned with the
  # deployed group so a documentation-only edit cannot replace live ingress.
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

resource "aws_vpc_security_group_egress_rule" "gateway_to_ricardian" {
  security_group_id            = aws_security_group.gateway.id
  description                  = "Authenticated private HTTP calls from the gateway to Ricardian."
  referenced_security_group_id = aws_security_group.internal_services.id
  from_port                    = 3100
  to_port                      = 3100
  ip_protocol                  = "tcp"
}

resource "aws_vpc_security_group_egress_rule" "gateway_to_treasury" {
  security_group_id            = aws_security_group.gateway.id
  description                  = "Authenticated private HTTP calls from the gateway to Treasury."
  referenced_security_group_id = aws_security_group.internal_services.id
  from_port                    = 3200
  to_port                      = 3200
  ip_protocol                  = "tcp"
}

# Cotsel tasks share the Agroasys staging VPC. Their only internet path is private subnet ->
# same-zone AWS Network Firewall -> NAT, owned by the agroasys-backend staging-network root.
# That firewall passes only TLS SNI names approved in its reviewed contract and drops the
# rest. Cotsel's own destinations are owned here, in egress-destinations.json.
locals {
  egress_contract      = jsondecode(file("${path.module}/egress-destinations.json"))
  network_egress       = try(data.terraform_remote_state.network.outputs.egress_inventory, {})
  network_approved_tls = toset(try(local.network_egress.approved_tls_names, []))

  # Unresolved entries carry a null hostname; compare them as empty strings.
  egress_destinations = [
    for entry in local.egress_contract.entries : merge(entry, {
      hostname = entry.hostname == null ? "" : entry.hostname
    })
  ]

  unresolved_egress_destinations = [
    for entry in local.egress_destinations : entry.service
    if entry.status != "required" || !can(regex("^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,63}$", entry.hostname))
  ]
  unapproved_egress_destinations = [
    for entry in local.egress_destinations : "${entry.service} (${entry.hostname})"
    if entry.status == "required" && !contains(local.network_approved_tls, entry.hostname)
  ]
}

# The two HTTPS rules below are only as narrow as the firewall behind them, so the plan
# refuses unless the network root reports default-deny enforcement and approves every
# destination Cotsel needs.
resource "terraform_data" "egress_enforcement_gate" {
  lifecycle {
    precondition {
      condition     = try(local.network_egress.denied_by_default, false) == true
      error_message = "The staging network does not report default-deny egress enforcement. Apply the agroasys-backend staging-network Network Firewall first."
    }

    precondition {
      condition     = length(local.unresolved_egress_destinations) == 0
      error_message = "Every Cotsel egress destination needs status \"required\" and a bare lowercase hostname. Unresolved: ${join(", ", local.unresolved_egress_destinations)}."
    }

    precondition {
      condition     = length(local.unapproved_egress_destinations) == 0
      error_message = "The staging Network Firewall does not approve these Cotsel destinations, so the tasks would fail closed: ${join(", ", local.unapproved_egress_destinations)}. Approve them in agroasys-backend docs/readiness/wp2-staging-egress.json and apply staging-network first."
    }
  }
}

# Trivy cannot follow the route-table hop through AWS Network Firewall and therefore sees
# only the IP-wide security-group rules. Each exception covers TCP 443 on one rule; the
# enforcement gate above, the network root's strict-order default-drop policy, and deployed
# denial evidence remain mandatory. Renew it only with that evidence.
#trivy:ignore:AVD-AWS-0104:exp:2026-12-31
resource "aws_vpc_security_group_egress_rule" "gateway_https" {
  security_group_id = aws_security_group.gateway.id
  description       = "HTTPS to approved RPC and Agroasys callback endpoints through managed NAT."
  cidr_ipv4         = "0.0.0.0/0"
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"

  depends_on = [terraform_data.egress_enforcement_gate]
}

#trivy:ignore:AVD-AWS-0104:exp:2026-12-31
resource "aws_vpc_security_group_egress_rule" "services_https" {
  security_group_id = aws_security_group.internal_services.id
  description       = "HTTPS to approved Base RPC and provider endpoints through managed NAT."
  cidr_ipv4         = "0.0.0.0/0"
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"

  depends_on = [terraform_data.egress_enforcement_gate]
}
