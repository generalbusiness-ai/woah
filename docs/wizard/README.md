# Wizard reference

Operations that require wizard authority — that is, your actor has the
wizard flag set. Check with `;has_flag(actor, "wizard")`; if it returns
`false`, none of these will work for you.

This section is for **privileged** operations only. For ordinary
authoring (creating objects, programming verbs, packaging catalogs),
see [`../designing/`](../designing/). For day-to-day usage of a
running world, see [`../using/`](../using/).

## Pages

- **[recycle.md](recycle.md)** — destroying objects (routine and forced).

## Where wizard authority comes from

On a deployed (Cloudflare/Net) world you cannot grant yourself the flag
from inside, and neither can anyone else: the seeded `$wiz` actor has no
placement, so every turn it attempts is refused, and
`$system:set_actor_flag` is not usable over the network path either.

A wizard actor is created by an **operator**, from outside, with a signed
command:

```bash
npm run provision:net-wizard -- \
  --base-url https://<your world> \
  --human <your human actor id> \
  --provision-id ops-wizard-1 \
  --name OpsWizard \
  --credential-name OPS_WIZARD_WOO_APIKEY
```

That mints an agent owned by the named human, carrying both the wizard
flag and the programmer authoring surface, plus an API key the operator
holds. Re-running it changes nothing.

To retire one, the owning human calls `revoke_agent` on their own
account surface with the agent's id. That strips the authoring surface,
revokes the key, and deactivates the actor, so it can no longer sign in.

The operator needs the deployment's internal secret, so this is a
deploy-machine operation, not something a logged-in user can do. See
`spec/identity/provisioning.md` §AP11.

## General notes

- Wizard authority is gated on `actor`, not just `progr`. Wrappers that
  forward options must be careful not to launder user intent (for
  example, `force_reserved` is gated on `actor` even when called through
  a wizard-owned wrapper).
- Hard floors: `$system`, `$root`, `$nowhere` cannot be recycled or
  reparented from inside a running world. No flag bypasses this.
- Prefer the catalog wrapper on `$builder` or `$programmer` over the
  raw builtin when one exists — wrappers emit audit observations and
  centralize the permission check.
