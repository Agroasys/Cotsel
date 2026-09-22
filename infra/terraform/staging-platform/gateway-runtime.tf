locals {
  gateway_runtime_service_names = toset([
    "auth",
    "gateway",
  ])

  gateway_runtime_containers = [
    local.gateway_container,
    local.auth_container,
  ]

  gateway_reviewed_config_sha256 = sha256(jsonencode([
    for container in local.gateway_runtime_containers : {
      name              = container.name
      environment       = try(container.environment, [])
      secret_references = try(container.secrets, [])
    }
  ]))
}

# The historical gateway revision in state predates skip_destroy=true. Its
# original state would cause the provider to deregister it on replacement.
# Retire that state address without touching the live revision, then manage the
# corrected gateway under a new address with retention enabled from creation.
removed {
  from = aws_ecs_task_definition.gateway

  lifecycle {
    destroy = false
  }
}

resource "aws_ecs_task_definition" "gateway_current" {
  family                   = "${local.name_prefix}-gateway"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 2048
  memory                   = 4096
  execution_role_arn       = aws_iam_role.gateway_execution.arn
  task_role_arn            = aws_iam_role.gateway_task.arn
  skip_destroy             = true

  runtime_platform {
    cpu_architecture        = "X86_64"
    operating_system_family = "LINUX"
  }

  dynamic "volume" {
    for_each = local.gateway_runtime_service_names

    content {
      name = "${volume.value}-tmp"
    }
  }

  container_definitions = jsonencode(local.gateway_runtime_containers)

  lifecycle {
    create_before_destroy = true
  }

  tags = {
    ReviewedConfigSha256 = local.gateway_reviewed_config_sha256
  }
}

resource "aws_ecs_service" "gateway" {
  name                   = "${local.name_prefix}-gateway"
  cluster                = aws_ecs_cluster.staging.id
  task_definition        = aws_ecs_task_definition.gateway_current.arn
  desired_count          = var.gateway_desired_count
  launch_type            = "FARGATE"
  enable_execute_command = false
  # Keep replacement serialized during the staged cutover. The gateway can be
  # scaled beyond one only after distributed replay and nonce evidence passes.
  deployment_maximum_percent         = 100
  deployment_minimum_healthy_percent = 0
  health_check_grace_period_seconds  = 120

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    assign_public_ip = false
    security_groups = [
      aws_security_group.gateway.id,
      local.data_client_sg_id,
    ]
    subnets = local.private_subnet_ids
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.gateway.arn
    container_name   = "gateway"
    container_port   = 3600
  }

  service_registries {
    registry_arn = data.terraform_remote_state.foundation.outputs.runtime_service_discovery_arns["gateway"]
  }

  depends_on = [
    aws_iam_role_policy.gateway_execution,
    aws_lb_listener.gateway,
  ]
}
