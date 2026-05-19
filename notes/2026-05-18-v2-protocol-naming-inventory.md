# V2 Protocol Naming Inventory

The normative v2 protocol names are the `woo.*.v1` names in
`spec/protocol/v2-turn-network.md`. The current implementation still carries
many implementation-era `*.shadow.v1` names inside substrate, worker, tests, and
cache records. That is intentional only as a migration bridge.

Current known categories:

- Envelopes and turn execution: `woo.turn.*.shadow.v1`.
- Commit and scope state: `woo.commit.*.shadow.v1`,
  `woo.scope_head.shadow.v1`.
- State transfer and proof material: `woo.state.transfer.shadow.v1`,
  `woo.state_proof.shadow.v1`, `shadow.anchor_mac.v1`,
  `shadow.relay_mac.v1`.
- Effect transcript and replay support: `woo.effect_transcript.shadow.v1`,
  `woo.touched_state_hash.shadow.v1`.
- Execution capability ads: `woo.exec_capability_ad.shadow.v1`.
- Browser projection/live/control shim messages:
  `woo.scope_projection*.shadow.v1`, `woo.browser_*.shadow.v1`,
  `woo.live.event.shadow.v1`.
- State page records: `woo.state_page.*.shadow.v1`.
- Native/bridge diagnostics: `woo.native_primitive_contract.shadow.v1`,
  `woo.remote_bridge_transcript_policy.shadow.v1`.

Rules for follow-up cleanup:

- Do not rename casually inside the current branch while behavior is still
  moving; broad renames make implementation review harder.
- At module boundaries, prefer adapters that translate old local names to the
  normative protocol names.
- Add a test guard for each retired family before removing it from local code.
- Completion means no user-visible protocol, spec text, diagnostics, metrics, or
  public API depends on the interim names.
