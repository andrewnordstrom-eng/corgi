{
  "sourcePatchSha256": "dded7bd336b7e020927b6e6adc23cc22ff2d9be8dcd68441801ed94b0932ee1d",
  "sourceFiles": {
    "checker": "b1b30ca86463384e0be0012f390619c375adeabc2ec2c8ae5acea8b5545e755c",
    "tests": "187428f6cef40f47bb22e744c108aceb86160b1312f8e4e053c4a3d3589dcc17"
  },
  "focused": {
    "command": [
      "node22.23.2",
      "node_modules/vitest/vitest.mjs",
      "run",
      "tests/runtime-contract.test.ts",
      "tests/demo-shadow-isolation.test.ts"
    ],
    "exitCode": 0,
    "testFilesPassed": 2,
    "testsPassed": 388,
    "logPath": "/private/tmp/corgi-2228-validation/qa-codeql-fix-focused.log",
    "logSha256": "dbda1c1fcc2e98003c6c764a72dcc1fbfca3b1075c7d1f4356619c6ed4b06bd9"
  },
  "scope": "CodeQL remediation: exact trimmed-line Docker COPY instruction matching; positive valid source and missing/wildcard lookalike negative cases.",
  "limitations": [
    "No Docker build or runtime execution in this QA pass.",
    "No production qualification, deployment, credentials, or protected-host rollback."
  ]
}

## Runtime Health Check

Focused checks used Node 22.23.2.

## Deterministic Eval

388 tests passed; see recorded command and hash.

## Live Acceptance

No protected-host or production claim.

### Automation Summary

Clear the two CodeQL alerts on the next hosted head.
