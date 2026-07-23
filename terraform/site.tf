# ─────────────────────────────────────────────────────────────────────────────
# AgentDeck marketing site — static hosting on S3 + CloudFront + ACM.
#
# ADDITIVE ONLY. This file introduces new resources and touches nothing the
# relay/VPS depend on — they share this state but are otherwise independent.
# The provider is already pinned to us-east-1 (provider.tf), which is exactly
# where CloudFront requires its ACM cert to live, so no second provider alias
# is needed.
#
# DNS for agentdeck.run lives at Namecheap (not Route53), so this file creates
# NO DNS records. The ACM validation records and the CloudFront target are
# emitted as OUTPUTS for a human to enter at the registrar.
#
# Two-phase apply, so the site provisions immediately without waiting on a
# human to set DNS:
#   Phase 1 (site_enable_custom_domain = false, the default):
#     S3 + CloudFront on the default *.cloudfront.net cert, plus the ACM cert
#     REQUEST. Outputs the validation CNAME(s) and the CloudFront domain.
#   Phase 2 (site_enable_custom_domain = true, after the cert shows ISSUED):
#     attaches the agentdeck.run + www aliases and the ACM cert to the
#     distribution. The validation CNAME must be live at Namecheap first, or
#     the apply blocks waiting for issuance.
# ─────────────────────────────────────────────────────────────────────────────

variable "site_domain" {
  description = "Apex domain for the marketing site."
  type        = string
  default     = "agentdeck.run"
}

variable "site_enable_custom_domain" {
  description = "Phase 2 switch: attach the apex + www aliases and the ACM cert to CloudFront. Only flip to true AFTER the ACM cert shows ISSUED (validation CNAME live at Namecheap), or the apply will block."
  type        = bool
  default     = false
}

locals {
  site_bucket_name = "agentdeck-run-site-${data.aws_caller_identity.current.account_id}"
  site_aliases     = [var.site_domain, "www.${var.site_domain}"]
}

# ── Private origin bucket: no public access; only CloudFront reads it via OAC.
resource "aws_s3_bucket" "site" {
  bucket        = local.site_bucket_name
  force_destroy = true

  tags = {
    Name    = "agentdeck-site"
    Project = "agentdeck"
  }
}

resource "aws_s3_bucket_public_access_block" "site" {
  bucket                  = aws_s3_bucket.site.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# ── ACM cert for the CloudFront aliases (must be us-east-1; provider already is).
resource "aws_acm_certificate" "site" {
  domain_name               = var.site_domain
  # Wildcard SAN instead of just www: ACM validates "*.agentdeck.run" with the
  # SAME DNS CNAME as the apex (agentdeck.run), which is already live + SUCCESS
  # at Namecheap — so the cert issues with no additional record to enter. The
  # wildcard still covers www.agentdeck.run (and any future subdomain).
  subject_alternative_names = ["*.${var.site_domain}"]
  validation_method         = "DNS"

  lifecycle {
    create_before_destroy = true
  }

  tags = {
    Name    = "agentdeck-site"
    Project = "agentdeck"
  }
}

# Phase 2 only: waits until the cert is ISSUED. Creates no records (validation
# CNAMEs are entered at Namecheap by hand); it just enforces ordering so the
# distribution doesn't try to reference an un-issued cert.
resource "aws_acm_certificate_validation" "site" {
  count                   = var.site_enable_custom_domain ? 1 : 0
  certificate_arn         = aws_acm_certificate.site.arn
  validation_record_fqdns = [for o in aws_acm_certificate.site.domain_validation_options : o.resource_record_name]
}

# ── Origin Access Control: CloudFront signs requests to the private bucket.
resource "aws_cloudfront_origin_access_control" "site" {
  name                              = "agentdeck-site-oac"
  description                       = "OAC for the AgentDeck marketing site bucket"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_distribution" "site" {
  enabled             = true
  is_ipv6_enabled     = true
  http_version        = "http2and3"
  default_root_object = "index.html"
  price_class         = "PriceClass_100"
  comment             = "agentdeck marketing site"
  aliases             = var.site_enable_custom_domain ? local.site_aliases : []

  origin {
    domain_name              = aws_s3_bucket.site.bucket_regional_domain_name
    origin_id                = "s3-agentdeck-site"
    origin_access_control_id = aws_cloudfront_origin_access_control.site.id
  }

  default_cache_behavior {
    target_origin_id       = "s3-agentdeck-site"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true
    # AWS managed policy: CachingOptimized (honors origin Cache-Control).
    cache_policy_id = "658327ea-f89d-4fab-a63d-7e88639e58f6"
  }

  # Static single-page site — serve index.html for any missing/forbidden path.
  custom_error_response {
    error_code            = 403
    response_code         = 200
    response_page_path    = "/index.html"
    error_caching_min_ttl = 10
  }
  custom_error_response {
    error_code            = 404
    response_code         = 200
    response_page_path    = "/index.html"
    error_caching_min_ttl = 10
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = var.site_enable_custom_domain ? null : true
    acm_certificate_arn            = var.site_enable_custom_domain ? one(aws_acm_certificate_validation.site[*].certificate_arn) : null
    ssl_support_method             = var.site_enable_custom_domain ? "sni-only" : null
    minimum_protocol_version       = var.site_enable_custom_domain ? "TLSv1.2_2021" : "TLSv1"
  }

  tags = {
    Name    = "agentdeck-site"
    Project = "agentdeck"
  }
}

# ── Bucket policy: only this distribution (via OAC) may read objects.
data "aws_iam_policy_document" "site_s3" {
  statement {
    sid       = "AllowCloudFrontServicePrincipalRead"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.site.arn}/*"]

    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.site.arn]
    }
  }
}

resource "aws_s3_bucket_policy" "site" {
  bucket = aws_s3_bucket.site.id
  policy = data.aws_iam_policy_document.site_s3.json
}

# ── Outputs ──────────────────────────────────────────────────────────────────
output "site_bucket" {
  description = "S3 bucket holding the site content (sync with: aws s3 sync packages/website/ s3://<bucket>/)."
  value       = aws_s3_bucket.site.bucket
}

output "site_cloudfront_domain" {
  description = "CloudFront distribution domain — the site is live here immediately, and the www/apex records point at it."
  value       = aws_cloudfront_distribution.site.domain_name
}

output "site_cloudfront_distribution_id" {
  value = aws_cloudfront_distribution.site.id
}

output "site_acm_certificate_arn" {
  value = aws_acm_certificate.site.arn
}

output "site_acm_validation_records" {
  description = "DNS validation records to add at Namecheap (type CNAME). Host is the record name minus the .agentdeck.run. suffix."
  value = [for o in aws_acm_certificate.site.domain_validation_options : {
    domain = o.domain_name
    name   = o.resource_record_name
    type   = o.resource_record_type
    value  = o.resource_record_value
  }]
}
