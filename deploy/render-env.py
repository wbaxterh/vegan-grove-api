#!/usr/bin/env python3
"""Render /vegan-grove/api/* from SSM Parameter Store into KEY=VALUE lines."""
import json, subprocess, sys
out = subprocess.run(["aws", "ssm", "get-parameters-by-path", "--region", "us-east-1", "--path", "/vegan-grove/api",
                      "--with-decryption", "--output", "json"], check=True, capture_output=True, text=True).stdout
params = json.loads(out)["Parameters"]
for p in sorted(params, key=lambda p: p["Name"]):
    name = p["Name"].rsplit("/", 1)[-1]
    value = p["Value"].replace("
", "\n")
    print(f"{name}={value}")
