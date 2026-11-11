# WP-8 settlement dashboard. Widgets read only dimensionless settlement metrics, AWS service
# metrics, and alarm state, so the dashboard shows no trade, wallet, or account identifier.

locals {
  dashboard_domains = [
    { key = "transactions", title = "Transactions: gasless, signer, relayer, settlement callback" },
    { key = "oracle", title = "Oracle milestones and maker-checker" },
    { key = "indexer", title = "Indexer: poison logs and startup gates" },
    { key = "reconciliation", title = "Reconciliation: drift, coverage, leases, containment" },
    { key = "treasury", title = "Treasury ingestion runs and integrity" },
    { key = "services", title = "Service error records" },
  ]

  dashboard_domain_signals = {
    for domain in local.dashboard_domains : domain.key => [
      for id, signal in local.settlement_signals : id
      if signal.domain == domain.key && try(signal.valueField, null) == null
    ]
  }

  dashboard_alarm_arns = concat(
    [for alarm in aws_cloudwatch_metric_alarm.settlement_event : alarm.arn],
    [for alarm in aws_cloudwatch_metric_alarm.settlement_heartbeat : alarm.arn],
    [for alarm in aws_cloudwatch_metric_alarm.service_running_tasks : alarm.arn],
    [
      aws_cloudwatch_composite_alarm.gateway_slo_fast_burn.arn,
      aws_cloudwatch_composite_alarm.gateway_slo_slow_burn.arn,
      aws_cloudwatch_metric_alarm.gateway_latency_p99.arn,
    ],
  )

  dashboard_alb_dimension = ["LoadBalancer", aws_lb.gateway.arn_suffix]

  dashboard_header = [{
    type   = "text"
    x      = 0
    y      = 0
    width  = 24
    height = 2

    properties = {
      markdown = join("", [
        "## Cotsel ${var.environment} settlement operations\n",
        "Gateway availability objective ${var.gateway_availability_slo_percent}% (decision #199). ",
        "Every alarm maps to a response in `docs/runbooks/settlement-observability.md`. ",
        "Trace one request, trade, or transaction across services with the saved Logs Insights query ",
        "`${aws_cloudwatch_query_definition.correlation_trace.name}`.",
      ])
    }
  }]

  dashboard_gateway_row = [
    {
      type   = "metric"
      x      = 0
      y      = 2
      width  = 8
      height = 6

      properties = {
        title  = "Gateway requests and 5xx"
        region = var.region
        view   = "timeSeries"
        stat   = "Sum"
        period = 300

        metrics = [
          concat(["AWS/ApplicationELB", "RequestCount"], local.dashboard_alb_dimension, [{ label = "Requests" }]),
          concat(["AWS/ApplicationELB", "HTTPCode_Target_5XX_Count"], local.dashboard_alb_dimension, [{ label = "Target 5xx" }]),
          concat(["AWS/ApplicationELB", "HTTPCode_ELB_5XX_Count"], local.dashboard_alb_dimension, [{ label = "Load balancer 5xx" }]),
        ]
      }
    },
    {
      type   = "metric"
      x      = 8
      y      = 2
      width  = 8
      height = 6

      properties = {
        title  = "Gateway 5xx ratio against the error budget"
        region = var.region
        view   = "timeSeries"
        period = 300

        metrics = [
          concat(["AWS/ApplicationELB", "RequestCount"], local.dashboard_alb_dimension, [{ id = "requests", stat = "Sum", visible = false }]),
          concat(["AWS/ApplicationELB", "HTTPCode_Target_5XX_Count"], local.dashboard_alb_dimension, [{ id = "target_5xx", stat = "Sum", visible = false }]),
          concat(["AWS/ApplicationELB", "HTTPCode_ELB_5XX_Count"], local.dashboard_alb_dimension, [{ id = "edge_5xx", stat = "Sum", visible = false }]),
          [{ expression = local.gateway_error_ratio_expression, id = "error_ratio", label = "5xx ratio" }],
        ]
        annotations = {
          horizontal = [
            { label = "Error budget", value = local.gateway_error_budget },
            { label = "Slow burn (6x)", value = 6 * local.gateway_error_budget },
          ]
        }
      }
    },
    {
      type   = "metric"
      x      = 16
      y      = 2
      width  = 8
      height = 6

      properties = {
        title  = "Gateway target response time"
        region = var.region
        view   = "timeSeries"
        period = 300

        metrics = [
          concat(["AWS/ApplicationELB", "TargetResponseTime"], local.dashboard_alb_dimension, [{ stat = "p50", label = "p50" }]),
          concat(["AWS/ApplicationELB", "TargetResponseTime"], local.dashboard_alb_dimension, [{ stat = "p99", label = "p99" }]),
        ]
        annotations = {
          horizontal = [{ label = "p99 objective", value = var.gateway_latency_p99_seconds }]
        }
      }
    },
  ]

  dashboard_runtime_row = concat(
    [{
      type   = "metric"
      x      = 0
      y      = 8
      width  = local.gateway_readiness_probe_enabled ? 12 : 24
      height = 6

      properties = {
        title  = "Running tasks by service"
        region = var.region
        view   = "timeSeries"
        stat   = "Minimum"
        period = 60

        metrics = [
          for name, service in local.observed_services : [
            "ECS/ContainerInsights", "RunningTaskCount",
            "ClusterName", aws_ecs_cluster.staging.name,
            "ServiceName", service.name,
            { label = name },
          ]
        ]
      }
    }],
    [for check in aws_route53_health_check.gateway_readiness : {
      type   = "metric"
      x      = 12
      y      = 8
      width  = 12
      height = 6

      properties = {
        title  = "External readiness probe (1 = healthy)"
        region = "us-east-1"
        view   = "timeSeries"
        period = 60

        metrics = [
          ["AWS/Route53", "HealthCheckStatus", "HealthCheckId", check.id, { stat = "Minimum", label = "Readiness" }],
          ["AWS/Route53", "HealthCheckPercentageHealthy", "HealthCheckId", check.id, { stat = "Average", label = "Checkers healthy %", yAxis = "right" }],
        ]
      }
    }],
  )

  dashboard_domain_widgets = [
    for index, domain in local.dashboard_domains : {
      type   = "metric"
      x      = (index % 2) * 12
      y      = 14 + floor(index / 2) * 6
      width  = 12
      height = 6

      properties = {
        title   = domain.title
        region  = var.region
        view    = "timeSeries"
        stat    = "Sum"
        period  = 300
        metrics = [for id in local.dashboard_domain_signals[domain.key] : [local.observability_namespace, id, { label = id }]]
      }
    }
  ]

  dashboard_footer_y = 14 + ceil(length(local.dashboard_domains) / 2) * 6

  dashboard_footer = [
    {
      type   = "metric"
      x      = 0
      y      = local.dashboard_footer_y
      width  = 12
      height = 6

      properties = {
        title  = "Treasury evidence freshness"
        region = var.region
        view   = "timeSeries"
        stat   = "Maximum"
        period = 300

        metrics = [
          [local.observability_namespace, "treasury_ingestion_age_seconds", { label = "Age (s)" }],
          [local.observability_namespace, "treasury_ingestion_lag_blocks", { label = "Lag (blocks)", yAxis = "right" }],
        ]
      }
    },
    {
      type   = "alarm"
      x      = 12
      y      = local.dashboard_footer_y
      width  = 12
      height = 6

      properties = {
        title  = "Settlement alarms"
        alarms = local.dashboard_alarm_arns
      }
    },
  ]
}

resource "aws_cloudwatch_dashboard" "settlement" {
  dashboard_name = "${local.name_prefix}-settlement"

  dashboard_body = jsonencode({
    widgets = concat(
      local.dashboard_header,
      local.dashboard_gateway_row,
      local.dashboard_runtime_row,
      local.dashboard_domain_widgets,
      local.dashboard_footer,
    )
  })
}
