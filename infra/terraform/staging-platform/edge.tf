locals {
  gateway_origin_id = "${local.name_prefix}-gateway-vpc-origin"
}

resource "aws_cloudfront_vpc_origin" "gateway" {
  vpc_origin_endpoint_config {
    arn                    = aws_lb.gateway.arn
    http_port              = 80
    https_port             = 443
    name                   = "${local.name_prefix}-gateway"
    origin_protocol_policy = "https-only"

    origin_ssl_protocols {
      items    = ["TLSv1.2"]
      quantity = 1
    }
  }

  timeouts {
    create = "30m"
    update = "30m"
    delete = "30m"
  }
}

resource "aws_cloudfront_cache_policy" "gateway_no_cache" {
  name        = "${local.name_prefix}-gateway-no-cache"
  comment     = "Disable caching for the signed Cotsel staging gateway API."
  default_ttl = 0
  max_ttl     = 0
  min_ttl     = 0

  parameters_in_cache_key_and_forwarded_to_origin {
    enable_accept_encoding_brotli = false
    enable_accept_encoding_gzip   = false

    cookies_config {
      cookie_behavior = "none"
    }

    headers_config {
      header_behavior = "none"
    }

    query_strings_config {
      query_string_behavior = "none"
    }
  }
}

resource "aws_cloudfront_origin_request_policy" "gateway_hmac" {
  name    = "${local.name_prefix}-gateway-hmac"
  comment = "Forward only headers required by Cotsel HMAC service auth and request tracing."

  cookies_config {
    cookie_behavior = "none"
  }

  headers_config {
    header_behavior = "whitelist"

    headers {
      items = [
        "Content-Type",
        "Idempotency-Key",
        "X-Agroasys-Nonce",
        "X-Agroasys-Signature",
        "X-Agroasys-Timestamp",
        "X-Api-Key",
        "X-Nonce",
        "X-Request-Id",
        "X-Signature",
        "X-Timestamp",
      ]
    }
  }

  query_strings_config {
    query_string_behavior = "all"
  }
}

resource "aws_cloudfront_distribution" "gateway" {
  aliases             = [var.public_gateway_domain_name]
  comment             = "Cotsel staging gateway edge for ${var.public_gateway_domain_name}"
  enabled             = true
  http_version        = "http2"
  is_ipv6_enabled     = true
  price_class         = "PriceClass_100"
  retain_on_delete    = true
  wait_for_deployment = true
  web_acl_id          = aws_wafv2_web_acl.gateway.arn

  origin {
    connection_attempts = 3
    connection_timeout  = 10
    domain_name         = var.public_gateway_domain_name
    origin_id           = local.gateway_origin_id

    vpc_origin_config {
      origin_keepalive_timeout = 5
      origin_read_timeout      = 30
      vpc_origin_id            = aws_cloudfront_vpc_origin.gateway.id
    }
  }

  default_cache_behavior {
    allowed_methods = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
    cached_methods  = ["GET", "HEAD"]
    compress        = false

    cache_policy_id          = aws_cloudfront_cache_policy.gateway_no_cache.id
    origin_request_policy_id = aws_cloudfront_origin_request_policy.gateway_hmac.id
    target_origin_id         = local.gateway_origin_id
    viewer_protocol_policy   = "https-only"
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    acm_certificate_arn      = var.edge_certificate_arn
    minimum_protocol_version = "TLSv1.2_2021"
    ssl_support_method       = "sni-only"
  }

  lifecycle {
    prevent_destroy = true
  }
}
