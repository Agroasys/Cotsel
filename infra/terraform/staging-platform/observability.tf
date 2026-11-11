# WP-8 settlement observability (B-17, COMP-04, INFRA-08, REPORT-04).
#
# Every settlement signal comes from structured records the services already emit through the
# shared default-deny telemetry schema. Nothing here adds instrumentation, so nothing here
# can widen what reaches telemetry. Metric filters count records and never publish dimensions:
# trade, wallet, account, and transaction identifiers stay in access-controlled logs and are
# reachable only through the saved correlation query.
#
# Alarm actions are inputs. An empty topic list keeps the alarm visible on the dashboard but
# routes it nowhere; assigning named on-call destinations is the WP-8 incident decision (#672).

locals {
  settlement_signal_catalog = jsondecode(file("${path.module}/settlement-signals.json"))
  observability_namespace   = "${local.settlement_signal_catalog.namespace}/${var.environment}"

  observability_log_groups = merge(
    { for name, group in aws_cloudwatch_log_group.service : name => group.name },
    { relayer = data.terraform_remote_state.foundation.outputs.runtime_prerequisite_log_groups["relayer"].name },
  )

  settlement_signals = { for signal in local.settlement_signal_catalog.signals : signal.id => signal }

  # Each condition is an OR over exact values of one field; conditions are AND-ed.
  settlement_signal_patterns = {
    for id, signal in local.settlement_signals : id => format("{ %s }", join(" && ", [
      for condition in signal.conditions : format("(%s)", join(" || ", [
        for value in condition.equals : format("$.%s = \"%s\"", condition.field, value)
      ]))
    ]))
  }

  observed_services = merge(
    {
      gateway = {
        name          = aws_ecs_service.gateway.name
        desired_count = var.gateway_desired_count
      }
      indexer = {
        name          = aws_ecs_service.indexer.name
        desired_count = var.indexer_desired_count
      }
      oracle = {
        name          = aws_ecs_service.oracle.name
        desired_count = var.oracle_desired_count
      }
      reconciliation = {
        name          = aws_ecs_service.reconciliation.name
        desired_count = var.reconciliation_desired_count
      }
      relayer = {
        name          = aws_ecs_service.relayer.name
        desired_count = var.relayer_desired_count
      }
    },
    {
      for name, service in aws_ecs_service.private_runtime : name => {
        name          = service.name
        desired_count = local.private_runtime_services[name].desired_count
      }
    },
  )

  alarm_actions_by_severity = {
    critical = var.critical_alarm_topic_arns
    high     = var.high_alarm_topic_arns
  }

  settlement_event_alarms = {
    for id, signal in local.settlement_signals : id => signal
    if try(signal.alarm.kind, "") == "event"
  }

  # A heartbeat alarm treats silence as failure, so it exists only while its service is
  # expected to run. A service scaled to zero is a reviewed state, not an incident.
  settlement_heartbeat_alarms = {
    for id, signal in local.settlement_signals : id => signal
    if try(signal.alarm.kind, "") == "heartbeat" && try(local.observed_services[signal.alarm.service].desired_count, 0) > 0
  }

  running_service_alarms = {
    for name, service in local.observed_services : name => service if service.desired_count > 0
  }

  # Multi-window, multi-burn-rate alerting over the approved availability objective (#199).
  # A burn rate of 14.4 spends 2% of a 30-day budget in one hour; 6 spends 5% in six hours.
  gateway_error_budget = (100 - var.gateway_availability_slo_percent) / 100
  gateway_burn_windows = {
    "fast-long"  = { period = 3600, burn_rate = 14.4 }
    "fast-short" = { period = 300, burn_rate = 14.4 }
    "slow-long"  = { period = 21600, burn_rate = 6 }
    "slow-short" = { period = 1800, burn_rate = 6 }
  }

  # ALB RequestCount excludes requests the load balancer answered itself, such as 503s
  # with no healthy target, so load-balancer 5xx are added to the denominator. Otherwise a
  # full gateway outage drives RequestCount to zero and neither burn alarm fires.
  gateway_error_ratio_expression = "IF((FILL(requests, 0) + FILL(edge_5xx, 0)) > 0, (FILL(target_5xx, 0) + FILL(edge_5xx, 0)) / (FILL(requests, 0) + FILL(edge_5xx, 0)), 0)"

  gateway_readiness_probe_enabled = var.gateway_desired_count > 0
}

resource "aws_cloudwatch_log_metric_filter" "settlement_signal" {
  for_each = local.settlement_signals

  name           = "${local.name_prefix}-${replace(each.key, "_", "-")}"
  log_group_name = local.observability_log_groups[each.value.logGroup]
  pattern        = local.settlement_signal_patterns[each.key]

  metric_transformation {
    name      = each.key
    namespace = local.observability_namespace
    value     = try("$.${each.value.valueField}", "1")
    unit      = try(each.value.unit, "Count")
  }
}

resource "aws_cloudwatch_metric_alarm" "settlement_event" {
  for_each = local.settlement_event_alarms

  alarm_name          = "${local.name_prefix}-${replace(each.key, "_", "-")}"
  alarm_description   = "[${upper(each.value.alarm.severity)}] ${each.value.description} Runbook: docs/runbooks/settlement-observability.md"
  namespace           = local.observability_namespace
  metric_name         = each.key
  statistic           = "Sum"
  period              = try(each.value.alarm.periodSeconds, 300)
  evaluation_periods  = 1
  threshold           = try(each.value.alarm.threshold, 1)
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions_by_severity[each.value.alarm.severity]
  ok_actions          = local.alarm_actions_by_severity[each.value.alarm.severity]

  tags = {
    WorkPackage = "WP-8"
    Severity    = each.value.alarm.severity
    Domain      = each.value.domain
  }

  depends_on = [aws_cloudwatch_log_metric_filter.settlement_signal]
}

resource "aws_cloudwatch_metric_alarm" "settlement_heartbeat" {
  for_each = local.settlement_heartbeat_alarms

  alarm_name          = "${local.name_prefix}-${replace(each.key, "_", "-")}-silent"
  alarm_description   = "[${upper(each.value.alarm.severity)}] ${each.value.description} Runbook: docs/runbooks/settlement-observability.md"
  namespace           = local.observability_namespace
  metric_name         = each.key
  statistic           = "SampleCount"
  period              = each.value.alarm.periodSeconds
  evaluation_periods  = each.value.alarm.evaluationPeriods
  threshold           = 1
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "breaching"
  alarm_actions       = local.alarm_actions_by_severity[each.value.alarm.severity]
  ok_actions          = local.alarm_actions_by_severity[each.value.alarm.severity]

  tags = {
    WorkPackage = "WP-8"
    Severity    = each.value.alarm.severity
    Domain      = each.value.domain
  }

  depends_on = [aws_cloudwatch_log_metric_filter.settlement_signal]
}

# Container Insights is enabled on the cluster. A running count below the reviewed desired
# count for three of five minutes tolerates the serialized 100/0 rollout but not an outage.
resource "aws_cloudwatch_metric_alarm" "service_running_tasks" {
  for_each = local.running_service_alarms

  alarm_name          = "${local.name_prefix}-${each.key}-running-tasks"
  alarm_description   = "[HIGH] ${each.key} is running fewer tasks than its reviewed desired count. Runbook: docs/runbooks/settlement-observability.md"
  namespace           = "ECS/ContainerInsights"
  metric_name         = "RunningTaskCount"
  statistic           = "Minimum"
  period              = 60
  evaluation_periods  = 5
  datapoints_to_alarm = 3
  threshold           = each.value.desired_count
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "breaching"
  alarm_actions       = var.high_alarm_topic_arns
  ok_actions          = var.high_alarm_topic_arns

  dimensions = {
    ClusterName = aws_ecs_cluster.staging.name
    ServiceName = each.value.name
  }

  tags = {
    WorkPackage = "WP-8"
    Severity    = "high"
    Domain      = "services"
  }
}

resource "aws_cloudwatch_metric_alarm" "gateway_burn_rate" {
  for_each = local.gateway_burn_windows

  alarm_name          = "${local.name_prefix}-gateway-slo-burn-${each.key}"
  alarm_description   = "Gateway 5xx ratio over ${each.value.period / 60} minutes exceeds ${each.value.burn_rate}x the ${var.gateway_availability_slo_percent}% error budget. Component of a composite burn-rate alarm; it routes nowhere on its own."
  evaluation_periods  = 1
  threshold           = each.value.burn_rate * local.gateway_error_budget
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"

  metric_query {
    id = "requests"

    metric {
      namespace   = "AWS/ApplicationELB"
      metric_name = "RequestCount"
      period      = each.value.period
      stat        = "Sum"
      dimensions  = { LoadBalancer = aws_lb.gateway.arn_suffix }
    }
  }

  metric_query {
    id = "target_5xx"

    metric {
      namespace   = "AWS/ApplicationELB"
      metric_name = "HTTPCode_Target_5XX_Count"
      period      = each.value.period
      stat        = "Sum"
      dimensions  = { LoadBalancer = aws_lb.gateway.arn_suffix }
    }
  }

  metric_query {
    id = "edge_5xx"

    metric {
      namespace   = "AWS/ApplicationELB"
      metric_name = "HTTPCode_ELB_5XX_Count"
      period      = each.value.period
      stat        = "Sum"
      dimensions  = { LoadBalancer = aws_lb.gateway.arn_suffix }
    }
  }

  metric_query {
    id          = "error_ratio"
    expression  = local.gateway_error_ratio_expression
    label       = "Gateway 5xx ratio"
    return_data = true
  }

  tags = {
    WorkPackage = "WP-8"
    Domain      = "gateway"
  }
}

resource "aws_cloudwatch_composite_alarm" "gateway_slo_fast_burn" {
  alarm_name        = "${local.name_prefix}-gateway-slo-fast-burn"
  alarm_description = "[CRITICAL] Gateway is spending its ${var.gateway_availability_slo_percent}% availability budget at 14.4x over both 1h and 5m. Runbook: docs/runbooks/settlement-observability.md"
  alarm_rule        = "ALARM(\"${aws_cloudwatch_metric_alarm.gateway_burn_rate["fast-long"].alarm_name}\") AND ALARM(\"${aws_cloudwatch_metric_alarm.gateway_burn_rate["fast-short"].alarm_name}\")"
  alarm_actions     = var.critical_alarm_topic_arns
  ok_actions        = var.critical_alarm_topic_arns

  tags = {
    WorkPackage = "WP-8"
    Severity    = "critical"
    Domain      = "gateway"
  }
}

resource "aws_cloudwatch_composite_alarm" "gateway_slo_slow_burn" {
  alarm_name        = "${local.name_prefix}-gateway-slo-slow-burn"
  alarm_description = "[HIGH] Gateway is spending its ${var.gateway_availability_slo_percent}% availability budget at 6x over both 6h and 30m. Runbook: docs/runbooks/settlement-observability.md"
  alarm_rule        = "ALARM(\"${aws_cloudwatch_metric_alarm.gateway_burn_rate["slow-long"].alarm_name}\") AND ALARM(\"${aws_cloudwatch_metric_alarm.gateway_burn_rate["slow-short"].alarm_name}\")"
  alarm_actions     = var.high_alarm_topic_arns
  ok_actions        = var.high_alarm_topic_arns

  tags = {
    WorkPackage = "WP-8"
    Severity    = "high"
    Domain      = "gateway"
  }
}

resource "aws_cloudwatch_metric_alarm" "gateway_latency_p99" {
  alarm_name          = "${local.name_prefix}-gateway-latency-p99"
  alarm_description   = "[HIGH] Gateway p99 target response time exceeds ${var.gateway_latency_p99_seconds}s for 15 minutes. Runbook: docs/runbooks/settlement-observability.md"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "TargetResponseTime"
  extended_statistic  = "p99"
  period              = 300
  evaluation_periods  = 3
  threshold           = var.gateway_latency_p99_seconds
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.high_alarm_topic_arns
  ok_actions          = var.high_alarm_topic_arns

  dimensions = {
    LoadBalancer = aws_lb.gateway.arn_suffix
  }

  tags = {
    WorkPackage = "WP-8"
    Severity    = "high"
    Domain      = "gateway"
  }
}

# External synthetic: checkers in three regions request the public readiness path through
# CloudFront and WAF, so a failure anywhere on the user path, or fail-closed financial
# readiness, turns this red. /readyz carries no identity, credential, or request body.
resource "aws_route53_health_check" "gateway_readiness" {
  count = local.gateway_readiness_probe_enabled ? 1 : 0

  fqdn              = var.public_gateway_domain_name
  port              = 443
  type              = "HTTPS"
  resource_path     = "/api/dashboard-gateway/v1/readyz"
  request_interval  = 30
  failure_threshold = 3
  measure_latency   = true
  enable_sni        = true
  regions           = ["us-east-1", "eu-west-1", "ap-southeast-1"]

  tags = {
    Name        = "${local.name_prefix}-gateway-readiness"
    WorkPackage = "WP-8"
  }
}

# Route 53 publishes health-check metrics only in us-east-1, so this alarm and its topics live there.
resource "aws_cloudwatch_metric_alarm" "gateway_readiness_probe" {
  provider = aws.edge
  count    = local.gateway_readiness_probe_enabled ? 1 : 0

  alarm_name          = "${local.name_prefix}-gateway-readiness-probe"
  alarm_description   = "[HIGH] External readiness checks of https://${var.public_gateway_domain_name}/api/dashboard-gateway/v1/readyz are failing. Runbook: docs/runbooks/settlement-observability.md"
  namespace           = "AWS/Route53"
  metric_name         = "HealthCheckStatus"
  statistic           = "Minimum"
  period              = 60
  evaluation_periods  = 3
  threshold           = 1
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "breaching"
  alarm_actions       = var.edge_alarm_topic_arns
  ok_actions          = var.edge_alarm_topic_arns

  dimensions = {
    HealthCheckId = aws_route53_health_check.gateway_readiness[0].id
  }

  tags = {
    WorkPackage = "WP-8"
    Severity    = "high"
    Domain      = "gateway"
  }
}

resource "aws_cloudwatch_query_definition" "correlation_trace" {
  name            = "${local.name_prefix}/settlement/correlation-trace"
  log_group_names = sort(values(local.observability_log_groups))

  # Replace REPLACE_WITH_ID with one correlation, request, trade, or transaction identifier.
  query_string = <<-EOT
    fields @timestamp, service, level, coalesce(message, msg) as event, eventType, correlationId, requestId, tradeId, actionKey, txHash, @logStream
    | filter correlationId = "REPLACE_WITH_ID" or requestId = "REPLACE_WITH_ID" or tradeId = "REPLACE_WITH_ID" or txHash = "REPLACE_WITH_ID"
    | sort @timestamp asc
    | limit 500
  EOT
}

resource "aws_cloudwatch_query_definition" "errors_by_service" {
  name            = "${local.name_prefix}/settlement/errors-by-service"
  log_group_names = sort(values(local.observability_log_groups))

  query_string = <<-EOT
    fields @timestamp, service, coalesce(message, msg) as event
    | filter level = "error" or level = 4 or level = 5
    | stats count(*) as errors by service, event, bin(15m)
    | sort errors desc
  EOT
}
