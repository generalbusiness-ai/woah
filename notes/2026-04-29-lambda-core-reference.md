# LambdaCore Reference Plan

LambdaCore is a reference corpus, not an import target for the first build.

Local reference:

```text
/Users/hugh/play/LambdaCore/LambdaCore-latest.db
```

## Extraction Goals

Extract enough structure to inform Woo's base library:

- object id
- name
- parent
- owner
- flags
- local property names
- local verb names
- selected verb source for core objects

Important objects:

- `#1` Root Class
- `#3` generic room
- `#5` generic thing
- `#6` generic player
- `#7` generic exit
- `#8` generic container
- `#9` generic note
- `#57` generic wizard
- `#58` generic programmer

## Non-Goals

- no full LambdaMOO database loader
- no automatic Woo import
- no compatibility promise
- no mail/help/editor clone in first build

## Deliverables

- JSON summary of extracted objects
- markdown note summarizing core object roles
- list of behaviors worth reinterpreting in Woo
