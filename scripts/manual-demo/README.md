# Manual Delivery Notification Demo Tools

Manual demo/testing only. Not production sender. Never sends to customer contact info.

The scripts in this folder are quarantined from the production delivery notification workflow. They require explicit test-recipient environment variables and demo send guards before provider calls can run.

Do not wire these scripts into scheduled jobs, interval services, `package.json` scripts, or production worker paths. Production notification sending should be implemented separately with real attempt recording, provider abstraction, retry handling, and customer-recipient safety checks.
