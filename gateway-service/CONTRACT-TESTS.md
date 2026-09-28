# Gateway contract coverage

Run the local Gateway simulator HTTP/SSE contract cases with:

```sh
npm run build
npm run contract
```

The script starts an isolated **simulated Gateway** instance with a temporary state file. Each HTTP call prints its curl method, URL, request body, expected and actual status, and response body. It removes its temporary state and log files when it exits. Set `PORT` to select another local port. These cases do not connect to a production/real external Gateway, real external user, or real LLM.

The cases map to section 2.1 of the candidate brief:

- Accounts: idle/null seed, stable connect ID, offline actions, reconnect, rate limit extension and recovery, suspended/session-expired permanence, status events, and automatic member removal.
- Simulated external accounts: CRUD, platform-user-ID collision, group join/leave, external message send, membership checks, and deleted-account 404 behavior.
- Groups: creator membership without a join event, invitation readiness/expiry/scope, accepted and missing joins, duplicate joins, delayed member events, promote permission/timing, normal/delayed/timed-out kick, owner-left, leave success/failure, offline members, and external member changes.
- Messages: delayed 202, asynchronous sent/failed events, both failure codes, group/sender/account errors, duplicate client IDs and earliest lookup, 504 accepted/not accepted, 503, late delivery after disconnect, and `sentAt` retention.
- Event stream: immediate connection headers before any account connects, all six event types, replay duplicates, fresh-ID redelivery, monotonic IDs, exclusive `since`, reconnect catch-up, malformed cursors, and the general 503 outage switch.
- Media: returned bytes, invalid metadata, and expiry.
- Restart recovery: persisted account/group/event state and a send accepted immediately before a simulated Gateway process restart.

The simulator exposes test-only controls on the routes used by the script, including delay parameters, `neverArrive`, `simulateTimeout`, and `x-simulate-unavailable`. `/admin/*` endpoints support event replay/redelivery and one-shot send faults.
