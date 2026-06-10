###############################################################################
# demo3 server logs → CloudWatch  (Bug #3: direct Nuxeo server logs in the portal)
#
# The API Lambda lives in AWS and cannot reach the Hetzner box, so we don't pull
# logs from the box — the box PUSHES them. A fluent-bit DaemonSet on the demo3
# k3s node tails the Nuxeo pod's container log and ships it to this CloudWatch
# log group; the portal's GET /logs route then reads the group server-side.
#
# This file creates: (a) the log group, and (b) a least-privilege IAM user whose
# access key the box's fluent-bit uses to PutLogEvents. The Lambda's READ grant
# on the group lives in api.tf. The box manifest + runbook are in box/logging/.
###############################################################################

resource "aws_cloudwatch_log_group" "nuxeo" {
  name              = "/nuxeo/demo3"
  retention_in_days = var.nuxeo_log_retention_days
  tags              = merge(var.tags, { Project = var.project })
}

# Box-side shipper identity. Mirrors the addons_ro pattern: a plain IAM user
# (the box is not on EC2, so no instance role) scoped to write ONLY this group.
resource "aws_iam_user" "log_shipper" {
  name = "${var.project}-log-shipper"
  tags = merge(var.tags, { Project = var.project })
}

resource "aws_iam_user_policy" "log_shipper" {
  name = "ship-nuxeo-logs"
  user = aws_iam_user.log_shipper.name
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid    = "ShipNuxeoLogs"
      Effect = "Allow"
      Action = [
        "logs:CreateLogStream",
        "logs:PutLogEvents",
        "logs:DescribeLogStreams",
      ]
      # The group itself + its streams. CreateLogGroup is deliberately omitted —
      # Terraform owns the group, and fluent-bit runs with auto_create_group=false.
      Resource = [
        aws_cloudwatch_log_group.nuxeo.arn,
        "${aws_cloudwatch_log_group.nuxeo.arn}:*",
      ]
    }]
  })
}

resource "aws_iam_access_key" "log_shipper" {
  user = aws_iam_user.log_shipper.name
}
