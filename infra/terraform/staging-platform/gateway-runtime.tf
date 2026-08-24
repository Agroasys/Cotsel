resource "aws_ecs_task_definition" "gateway" {
  family                   = "${local.name_prefix}-gateway"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 2048
  memory                   = 4096
  execution_role_arn       = aws_iam_role.gateway_execution.arn
  task_role_arn            = aws_iam_role.gateway_task.arn

  runtime_platform {
    cpu_architecture        = "X86_64"
    operating_system_family = "LINUX"
  }

  container_definitions = jsonencode([
    local.gateway_container,
    local.auth_container,
    local.indexer_pipeline_container,
    local.indexer_graphql_container,
    local.oracle_container,
    local.reconciliation_container,
  ])

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_ecs_service" "gateway" {
  name            = "${local.name_prefix}-gateway"
  cluster         = aws_ecs_cluster.staging.id
  task_definition = aws_ecs_task_definition.gateway.arn
  desired_count   = var.gateway_desired_count
  launch_type     = "FARGATE"
  # Keep the authenticated settlement boundary available while ECS replaces a
  # task. A single desired task with a 0% minimum allows an avoidable outage.
  # Keep the bundled gateway rollout serialized. The task also runs the
  # indexer pipeline, so overlapping revisions can process the same stream.
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

  depends_on = [
    aws_iam_role_policy.gateway_execution,
    aws_lb_listener.gateway,
  ]
}
