import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const platform = join(here, '..', 'staging-platform');
const read = (path) => readFileSync(join(platform, path), 'utf8');
const variables = read('variables.tf');
const edge = read('edge.tf');
const alb = read('alb.tf');
const network = read('network.tf');
const runtime = read('runtime-gateway-auth.tf');
const iam = read('iam.tf');
const naming = read('naming.tf');
const outputs = read('outputs.tf');
const logging = read('logging.tf');
const workflow = readFileSync(
  join(here, '..', '..', '..', '.github', 'workflows', 'terraform.yml'),
  'utf8',
);

test('auth route and feature switches default off and reject other dashboard origins', () => {
  assert.match(variables, /variable "dashboard_session_routes_enabled"[\s\S]*?default\s+=\s+false/);
  assert.match(variables, /variable "trusted_session_exchange_enabled"[\s\S]*?default\s+=\s+false/);
  assert.match(variables, /variable "admin_control_enabled"[\s\S]*?default\s+=\s+false/);
  assert.match(variables, /variable "gateway_enable_mutations"[\s\S]*?default\s+=\s+false/);
  assert.match(
    variables,
    /var\.dashboard_origin == "" \|\| var\.dashboard_origin == "https:\/\/cotsel\.agroasys\.com"/,
  );
  assert.match(
    variables,
    /!var\.dashboard_session_routes_enabled \|\| var\.dashboard_origin == "https:\/\/cotsel\.agroasys\.com"/,
  );
  assert.match(variables, /sg-\(\[0-9a-f\]\{8\}\|\[0-9a-f\]\{17\}\)/);
});

test('CloudFront adds only the three uncached session paths and forwards bearer/CORS headers', () => {
  assert.match(
    edge,
    /for_each = var\.dashboard_session_routes_enabled \? local\.dashboard_auth_session_paths : toset\(\[\]\)/,
  );
  for (const path of [
    '"/api/auth/v1/session"',
    '"/api/auth/v1/session/refresh"',
    '"/api/auth/v1/session/revoke"',
  ]) {
    assert.ok(edge.includes(path), `missing CloudFront session path ${path}`);
  }
  assert.match(
    edge,
    /allowed_methods\s+=\s+\["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"\]/,
  );
  assert.match(edge, /cache_policy_id\s+=\s+aws_cloudfront_cache_policy\.gateway_no_cache\.id/);
  assert.match(
    edge,
    /origin_request_policy_id\s+=\s+aws_cloudfront_origin_request_policy\.dashboard_auth_session\.id/,
  );
  const policy = edge.split(
    'resource "aws_cloudfront_origin_request_policy" "dashboard_auth_session"',
  )[1];
  assert.ok(policy);
  for (const header of [
    'Authorization',
    'Origin',
    'Content-Type',
    'X-Request-Id',
    'X-Correlation-Id',
    'Access-Control-Request-Method',
    'Access-Control-Request-Headers',
  ]) {
    assert.ok(policy.includes(`"${header}"`), `missing forwarded browser header ${header}`);
  }
  assert.match(policy, /query_string_behavior\s+=\s+"none"/);
  assert.doesNotMatch(policy, /header_behavior\s+=\s+"all"/);
});

test('Dashboard gateway behavior is origin-gated, uncached, and preserves HMAC/idempotency headers', () => {
  assert.match(
    edge,
    /for_each = var\.dashboard_origin == "" \? \[\] : \["\/api\/dashboard-gateway\/v1\/\*"\]/,
  );
  assert.match(
    edge,
    /for_each = var\.dashboard_origin == "" \? \[\] : \["\/api\/dashboard-gateway\/v1\/\*"\][\s\S]*?cache_policy_id\s+=\s+aws_cloudfront_cache_policy\.gateway_no_cache\.id[\s\S]*?origin_request_policy_id\s+=\s+aws_cloudfront_origin_request_policy\.dashboard_gateway_browser\.id/,
  );
  const browserPolicy = edge.split(
    'resource "aws_cloudfront_origin_request_policy" "dashboard_gateway_browser"',
  )[1];
  assert.ok(browserPolicy);
  for (const header of [
    'Authorization',
    'Origin',
    'Content-Type',
    'Idempotency-Key',
    'X-Api-Key',
    'X-Timestamp',
    'X-Signature',
    'X-Nonce',
    'X-Agroasys-Timestamp',
    'X-Agroasys-Signature',
    'X-Agroasys-Nonce',
    'X-Request-Id',
    'X-Correlation-Id',
    'Access-Control-Request-Method',
    'Access-Control-Request-Headers',
  ]) {
    assert.ok(
      browserPolicy.includes(`"${header}"`),
      `missing preserved browser/HMAC header ${header}`,
    );
  }
  assert.match(browserPolicy, /query_string_behavior\s+=\s+"all"/);
  const hmacPolicy = edge
    .split('resource "aws_cloudfront_origin_request_policy" "gateway_hmac"')[1]
    ?.split('resource "aws_cloudfront_origin_request_policy" "dashboard_auth_session"')[0];
  assert.ok(hmacPolicy);
  for (const header of [
    'Content-Type',
    'Idempotency-Key',
    'X-Agroasys-Nonce',
    'X-Agroasys-Signature',
    'X-Agroasys-Timestamp',
    'X-Api-Key',
    'X-Nonce',
    'X-Request-Id',
    'X-Signature',
    'X-Timestamp',
  ]) {
    assert.ok(hmacPolicy.includes(`"${header}"`), `existing HMAC policy lost ${header}`);
  }
  assert.match(hmacPolicy, /query_string_behavior\s+=\s+"all"/);
});

test('ALB forwards only the exact supported methods and paths to auth on port 3005', () => {
  const rules = alb.split('dashboard_auth_session_listener_rules =')[1]?.split('} : {}')[0];
  assert.ok(rules);
  assert.equal((rules.match(/path\s+=/g) ?? []).length, 6);
  assert.deepEqual(
    [...rules.matchAll(/method\s+=\s+"([A-Z]+)"/g)].map((match) => match[1]),
    ['GET', 'OPTIONS', 'POST', 'OPTIONS', 'POST', 'OPTIONS'],
  );
  assert.match(
    alb,
    /count = var\.dashboard_session_routes_enabled \? 1 : 0[\s\S]*?port\s+=\s+3005/,
  );
  assert.match(
    alb,
    /condition\s*\{\s*http_request_method\s*\{\s*values\s*=\s*\[each\.value\.method\]/,
  );
  assert.match(alb, /condition\s*\{\s*path_pattern\s*\{\s*values\s*=\s*\[each\.value\.path\]/);
  assert.match(alb, /target_group_arn\s*=\s*aws_lb_target_group\.dashboard_auth_session\[0\]\.arn/);
  assert.doesNotMatch(alb, /session\/exchange\/agroasys|\/admin\//);
});

test('security groups scope public auth to the internal ALB and private auth to the API task SG', () => {
  assert.match(
    network,
    /resource "aws_vpc_security_group_egress_rule" "alb_to_auth_session"[\s\S]*?referenced_security_group_id\s+=\s+aws_security_group\.gateway\.id[\s\S]*?from_port\s+=\s+3005[\s\S]*?to_port\s+=\s+3005/,
  );
  assert.match(
    network,
    /resource "aws_vpc_security_group_ingress_rule" "auth_session_from_alb"[\s\S]*?referenced_security_group_id\s+=\s+aws_security_group\.alb\.id[\s\S]*?from_port\s+=\s+3005[\s\S]*?to_port\s+=\s+3005/,
  );
  assert.match(
    network,
    /resource "aws_vpc_security_group_ingress_rule" "auth_session_from_backend_api"[\s\S]*?var\.trusted_session_exchange_enabled \|\| var\.admin_control_enabled[\s\S]*?referenced_security_group_id\s+=\s+var\.backend_api_task_security_group_id[\s\S]*?from_port\s+=\s+3005[\s\S]*?to_port\s+=\s+3005/,
  );
  assert.match(network, /data\.aws_security_group\.backend_api_task\[0\]\.vpc_id == local\.vpc_id/);
  assert.doesNotMatch(network, /auth_session[\s\S]{0,500}(cidr_ipv4|0\.0\.0\.0\/0)/);
  assert.match(
    outputs,
    /output "gateway_task_security_group_id"[\s\S]*?value\s+=\s+aws_security_group\.gateway\.id/,
  );
});

test('Cotsel auth environment keeps features off and isolates each credential secret', () => {
  assert.match(
    runtime,
    /GATEWAY_ENABLE_MUTATIONS", value = tostring\(var\.gateway_enable_mutations\)/,
  );
  assert.match(
    runtime,
    /AUTH_ADMIN_CONTROL_ENABLED", value = tostring\(var\.admin_control_enabled\)/,
  );
  assert.match(runtime, /GATEWAY_STEP_UP_ENFORCEMENT", value = "enforce"/);
  assert.match(runtime, /GATEWAY_STEP_UP_ACCEPTED_STRENGTHS", value = "hardware_webauthn"/);
  assert.match(runtime, /GATEWAY_STEP_UP_MAX_AGE_SECONDS", value = "300"/);
  assert.match(
    runtime,
    /TRUSTED_SESSION_EXCHANGE_ENABLED", value = tostring\(var\.trusted_session_exchange_enabled\)/,
  );
  assert.match(
    runtime,
    /AUTH_ADMIN_CONTROL_ALLOWED_API_KEY_IDS", value = var\.admin_control_allowed_api_key_ids/,
  );
  assert.match(
    runtime,
    /TRUSTED_SESSION_EXCHANGE_KEY_POLICIES_JSON", value = var\.trusted_session_exchange_key_policies_json/,
  );
  assert.match(
    runtime,
    /TRUSTED_SESSION_EXCHANGE_API_KEYS_JSON", valueFrom = aws_secretsmanager_secret\.platform\["auth-upstream-exchange"\]\.arn/,
  );
  assert.match(
    runtime,
    /AUTH_ADMIN_CONTROL_API_KEYS_JSON", valueFrom = aws_secretsmanager_secret\.platform\["auth-admin-control"\]\.arn/,
  );
  assert.doesNotMatch(
    runtime,
    /var\.trusted_session_exchange_key_policies_json[^\n]*secret|var\.admin_control_allowed_api_key_ids[^\n]*secret/i,
  );
  assert.match(
    iam,
    /var\.trusted_session_exchange_enabled \? \[[\s\S]*?\["auth-upstream-exchange"\]\.arn/,
  );
  assert.match(iam, /var\.admin_control_enabled \? \[[\s\S]*?\["auth-admin-control"\]\.arn/);
  assert.match(
    naming,
    /integration_secret_names\s+=\s+toset\(concat\([\s\S]*?var\.admin_control_enabled \? \[[\s\S]*?"auth-admin-control"/,
  );
  assert.doesNotMatch(
    naming.split('integration_secret_names =')[1]?.split('secret_names =')[0] ?? '',
    /"auth-admin-control"[\s\S]*var\.admin_control_enabled/,
  );
  assert.match(
    variables,
    /!var\.gateway_enable_mutations \|\| \(\s*var\.trusted_session_exchange_enabled/,
  );
  assert.doesNotMatch(
    runtime,
    /trusted_session_exchange_enabled\s*=\s*var\.gateway_enable_mutations/,
  );
  assert.doesNotMatch(runtime, /admin_control_enabled\s*=\s*var\.gateway_enable_mutations/);
});

test('CORS adds only the configured exact origin and workflow defaults keep toggles off', () => {
  assert.match(runtime, /dashboard_origin == "" \? \[\] : \[var\.dashboard_origin\]/);
  assert.match(
    runtime,
    /GATEWAY_CORS_ALLOWED_ORIGINS", value = local\.dashboard_cors_allowed_origins/,
  );
  assert.match(
    runtime,
    /AUTH_CORS_ALLOWED_ORIGINS", value = local\.dashboard_cors_allowed_origins/,
  );
  assert.match(
    workflow,
    /TF_VAR_dashboard_session_routes_enabled: \$\{\{ vars\.COTSEL_STAGING_DASHBOARD_SESSION_ROUTES_ENABLED \|\| 'false' \}\}/,
  );
  assert.match(
    workflow,
    /TF_VAR_trusted_session_exchange_enabled: \$\{\{ vars\.COTSEL_STAGING_TRUSTED_SESSION_EXCHANGE_ENABLED \|\| 'false' \}\}/,
  );
  assert.match(
    workflow,
    /TF_VAR_admin_control_enabled: \$\{\{ vars\.COTSEL_STAGING_AUTH_ADMIN_CONTROL_ENABLED \|\| 'false' \}\}/,
  );
  assert.match(
    workflow,
    /TF_VAR_gateway_enable_mutations: \$\{\{ vars\.COTSEL_STAGING_GATEWAY_ENABLE_MUTATIONS \|\| 'false' \}\}/,
  );
  assert.doesNotMatch(workflow, /TF_VAR_(dashboard|trusted_session|admin_control)[^\n]*secrets\./i);
  assert.match(logging, /"authorization"/);
});
