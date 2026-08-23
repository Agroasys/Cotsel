resource "aws_service_discovery_private_dns_namespace" "runtime" {
  name        = "cotsel-staging.internal"
  description = "Private DNS names for independently deployed Cotsel staging services."
  vpc         = local.vpc_id
}

resource "aws_service_discovery_service" "runtime" {
  for_each = toset([
    "ricardian",
    "treasury",
  ])

  name = each.value

  dns_config {
    namespace_id = aws_service_discovery_private_dns_namespace.runtime.id

    dns_records {
      ttl  = 10
      type = "A"
    }

    routing_policy = "MULTIVALUE"
  }

  health_check_custom_config {
    failure_threshold = 1
  }
}
