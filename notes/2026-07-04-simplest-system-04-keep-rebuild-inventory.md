# Simplest Deployable System — Stage 4: Keep/Rebuild Inventory

Date: 2026-07-04. Series: see `2026-07-04-simplest-system-00-method.md`.
Evidence pass: LOC + import-coupling audit of `src/` (75,554 LOC, 84 files),
`catalogs/` (12,428 LOC assets), tests (66,500 LOC, 110 files + e2e 2,212).

## 4.1 Headline

The codebase splits almost exactly in half: **~35k LOC keep, ~34k LOC
discard-shaped, ~3k rewrite.** The discard half is concentrated and
self-identifying (`shadow-*`, `src/worker/`, `v2-browser-*`,
`dev-v2-helpers`), and its own file headers document retired designs
("B7 retired the closure mode", B8 routing-cost fields) — iterated-in-place
protocol scaffolding, not settled architecture.

## 4.2 Keep as-is (~35k src + 12.4k catalog assets)

- **Pure substrate ~13.5k**: `tiny-vm.ts` 1683, `dsl-compiler.ts` 1293,
  `executor.ts` 1306, `authoring.ts` 981, `catalog-installer.ts` 2023,
  `local-catalogs.ts` 2045, `bootstrap.ts` 1438, `types.ts` 797, plus
  small support files. Coupling audit: `dsl-compiler` imports only
  source-hash+types (**zero** world/v2/CF coupling); `tiny-vm` and
  `catalog-installer` have **type-only** world imports; `bootstrap` imports
  WooWorld + v1 repository, **no v2/CF import**.
- **world.ts object-model core ~10.9k of 12,391** (~88%): 590 methods, of
  which ~305 are pure object/session/authoring and only ~54 (~9%) belong to
  the v2 turn layer — but v2 is *threaded through the write paths* via live
  imports from `authority-slice`, `shadow-commit-scope` (9 fns),
  `projection-delta`, `turn-recorder`, `effect-transcript` (world.ts:31-58).
  Unthreading ≈ 1.5k LOC of hooks.
- **v1 persistence ~1.2k**: `repository.ts` 403, `LocalSQLiteRepository` 643,
  json-folder 166. Clean, sync, single-host.
- **Base client UI ~7.5k**: `main.ts` 5743, `framework.ts` 1610.
- **Transport shells ~2-3k** of mcp/host+server+dev-server minus v2 wiring.
- **catalogs/ 12,428** — manifests have **no host/CF keys**; conformance +
  catalog tests are host-agnostic. Fully portable, confirmed by grep.

**Critical existence proof:** `bootstrap → world → sqlite-repository`,
driven by `dev-server` (which imports no worker module), is a **complete
working non-distributed runtime already present underneath the turn layer.**
The rebuild question is only about the distribution shell around it.

## 4.3 Discard-shaped (~34k)

- **v2 core turn network 13.1k**: `shadow-browser-node` 3280,
  `shadow-turn-exec` 2220, `shadow-commit-scope` 2111 (these three = 7.6k),
  `authority-slice` 940, `projection-delta` 748, `effect-transcript` 867,
  nine more shadow-* files, turn-*, v2-fanout-projection, planning-world,
  capability-ad, object-host-write-through.
- **worker/CF 16.0k**: `persistent-object-do.ts` 9183, `commit-scope-do.ts`
  2836, `directory-do.ts` 955, `admin.ts` 1116, `cf-repository.ts` 761,
  index/auth/metrics/fault-inject.
- **client v2 plumbing 4.8k**: `v2-browser-worker` 3074 + ten satellites.
- **server/dev-v2-helpers 794**.

## 4.4 Rewrite/rethread (~3-4k)

- The ~54 distribution methods + transcript imports inside world.ts.
- `mcp/gateway.ts` 2218 + `mcp/host.ts` 1689 straddle transport and v2
  dispatch — partial rewrite.
- A new thin distribution layer replacing the 34k (size target: see plan).

## 4.5 The one real extraction cost: the VM's host surface

The VM's coupling to world.ts is **two-tier**:
1. `ExecutorContext` (~24 methods, world.ts:264+) — already designed as the
   cross-host boundary.
2. The native-builtin library: the VM calls **~90 distinct `ctx.world.*`
   methods** (long tail of one-shot builtin implementations). Decoupling
   means either extracting a ~90-method `WooHost` interface or accepting
   WooWorld as the VM's host object.

Judgment: do **not** pay the 90-method interface extraction as part of this
plan. The substrate (VM + WooWorld object-model core) travels *together* as
"the world engine"; the seam that matters is between the world engine and
the distribution layer, not inside the engine. (E4 decomposition of world.ts
into modules can proceed later without changing this conclusion.)

## 4.6 Tests

Conformance/catalog/vm/compiler tests survive unchanged. The v2/shadow/turn
test files (a large share of the 110) go with the layer they test. The gate
architecture (curated `npm test`, guards, three smoke lanes with one shared
scenario) is kept as *process*, re-pointed at the new layer.

## 4.7 C1-C4 criteria applied (from stage 0)

| Layer | C1 invariants clear | C2 accident-dominant | C3 seam exists | C4 build < migrate | Verdict |
|---|---|---|---|---|---|
| Substrate (VM/compiler/installer/bootstrap) | — | no | — | — | **keep** |
| world.ts object model | — | no (88% sound) | — | — | **keep, unthread v2 hooks** |
| v1 persistence + local modes | — | no | — | — | **keep** |
| Catalogs + conformance | — | no | — | — | **keep wholesale** |
| v2 turn network + CF worker layer | yes (cell-authority spec + VTN invariants) | yes (flag field, retired-design headers, 7 state copies) | yes (transport shells above, world engine below) | see plan §migration | **new-build candidate — decided in stage 5/plan** |
| Client v2 plumbing | partially | yes (3.3k browser-worker for a "narrow" B9 node) | yes (framework handlers) | yes | **new-build with the layer** |
