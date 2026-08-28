# CloudFront is global, but AWS requires CloudFront-scope web ACLs in us-east-1. The managed
# groups begin in count mode so staging evidence can distinguish legitimate signed traffic from
# false positives. The IP rate rule blocks volumetric abuse only; service authority remains HMAC,
# nonce, timestamp, and idempotency validation in the gateway.
resource "aws_wafv2_web_acl" "gateway" {
  provider = aws.edge

  name        = "${local.name_prefix}-gateway-edge"
  description = "WP-7 WAF and rate controls for the Cotsel staging gateway."
  scope       = "CLOUDFRONT"

  default_action {
    allow {}
  }

  dynamic "rule" {
    for_each = { for index, group in var.managed_rule_groups : group => index }

    content {
      name     = rule.key
      priority = rule.value + 1

      override_action {
        dynamic "count" {
          for_each = contains(var.blocking_rule_groups, rule.key) ? [] : [1]
          content {}
        }
        dynamic "none" {
          for_each = contains(var.blocking_rule_groups, rule.key) ? [1] : []
          content {}
        }
      }

      statement {
        managed_rule_group_statement {
          vendor_name = "AWS"
          name        = rule.key
        }
      }

      visibility_config {
        cloudwatch_metrics_enabled = true
        metric_name                = replace(rule.key, "AWSManagedRules", "")
        sampled_requests_enabled   = true
      }
    }
  }

  rule {
    name     = "RateLimit"
    priority = 100

    action {
      block {}
    }

    statement {
      rate_based_statement {
        limit              = var.edge_rate_limit_per_five_minutes
        aggregate_key_type = "IP"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "RateLimit"
      sampled_requests_enabled   = true
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "${local.name_prefix}-gateway-edge"
    sampled_requests_enabled   = true
  }
}
