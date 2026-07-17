# Delivery Notifications Production Reset

The controlled demo send path has been quarantined under `scripts/manual-demo`. It is manual demo/testing only, is not exposed through `package.json`, and must not be used as the production sender.

Production-safe pieces that remain active:

- Delivery confirmation page: `/delivery/confirm/[token]`
- 42-day delivery confirmation event creation
- Delivery confirmation token/state helpers
- Delivery reminder message renderers
- Delivery readiness and payment evaluation helpers

Provider sending is not wired into the production interval services. A production sender still needs a dedicated implementation for notification attempts, provider abstraction, retries, recipient safety, and audit behavior.
