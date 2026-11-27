locals {
  dashboard_auth_session_listener_rules = var.dashboard_session_routes_enabled ? {
    session_get     = { path = "/api/auth/v1/session", method = "GET", priority = 1 }
    session_options = { path = "/api/auth/v1/session", method = "OPTIONS", priority = 2 }
    refresh_post    = { path = "/api/auth/v1/session/refresh", method = "POST", priority = 3 }
    refresh_options = { path = "/api/auth/v1/session/refresh", method = "OPTIONS", priority = 4 }
    revoke_post     = { path = "/api/auth/v1/session/revoke", method = "POST", priority = 5 }
    revoke_options  = { path = "/api/auth/v1/session/revoke", method = "OPTIONS", priority = 6 }
  } : {}
}

resource "aws_lb" "gateway" {
  name                       = "${local.name_prefix}-gateway"
  internal                   = true
  load_balancer_type         = "application"
  security_groups            = [aws_security_group.alb.id]
  subnets                    = local.private_subnet_ids
  drop_invalid_header_fields = true
  enable_deletion_protection = true

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_lb_target_group" "gateway" {
  name        = "${local.name_prefix}-gateway"
  port        = 3600
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = local.vpc_id

  deregistration_delay = 30

  health_check {
    enabled             = true
    healthy_threshold   = 2
    interval            = 15
    matcher             = "200"
    path                = "/api/dashboard-gateway/v1/healthz"
    port                = "traffic-port"
    protocol            = "HTTP"
    timeout             = 5
    unhealthy_threshold = 3
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_lb_target_group" "dashboard_auth_session" {
  count = var.dashboard_session_routes_enabled ? 1 : 0

  name        = "${local.name_prefix}-auth-session"
  port        = 3005
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = local.vpc_id

  deregistration_delay = 30

  health_check {
    enabled             = true
    healthy_threshold   = 2
    interval            = 15
    matcher             = "200"
    path                = "/api/auth/v1/health"
    port                = "traffic-port"
    protocol            = "HTTP"
    timeout             = 5
    unhealthy_threshold = 3
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_lb_listener" "gateway" {
  load_balancer_arn = aws_lb.gateway.arn
  port              = 443
  protocol          = "HTTPS"
  certificate_arn   = var.origin_certificate_arn
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.gateway.arn
  }
}

resource "aws_lb_listener_rule" "dashboard_auth_session" {
  for_each = local.dashboard_auth_session_listener_rules

  listener_arn = aws_lb_listener.gateway.arn
  priority     = 20 + each.value.priority

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.dashboard_auth_session[0].arn
  }

  condition {
    http_request_method {
      values = [each.value.method]
    }
  }

  condition {
    path_pattern {
      values = [each.value.path]
    }
  }
}
