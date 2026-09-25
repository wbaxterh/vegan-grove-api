#!/usr/bin/env python3
"""Render /vegan-grove/api/* from SSM Parameter Store into KEY=VALUE lines for .env."""
import json
import subprocess

result = subprocess.run(
    ["aws", "ssm", "get-parameters-by-path", "--region", "us-east-1", "--path", "/vegan-grove/api",
     "--with-decryption", "--output", "json"],
    check=True, capture_output=True, text=True,
)
for param in sorted(json.loads(result.stdout)["Parameters"], key=lambda p: p["Name"]):
    name = param["Name"].rsplit("/", 1)[-1]
    print(f"{name}={param['Value']}")
