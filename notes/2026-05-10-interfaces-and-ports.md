

Port TUI is the primary human interface
  - because: everywhere at the edge
  - because: composable UI
  - because: functionality wired in
      **need to make this super strong** for this specific use case!

github block
  - just makes tickets
  - says things when events

hermes "user outside a block"
  - focus the tasks space (voluntarily)
  - attach the tui to websocket
      - it just hears what's being said in the room
      - if it needs to go look at a thing, it can do
  - "tell hermes go look at this ticket"
  - hermes can spin up a developer, tester, etc.

tester "user in a block"
  - lives in the task space
  - loop:
      - something to do? -> do it
      - nothing to do? -> pick something
  - who runs the loop???
      - not the plug, that's just mechanical
      - tester with a cron
      - tester with interrupt instructions

- either/both, they're the same - just the block is single task


is there an "interrupt" model?
  (stop this thing, because...)
  - not because more important
  - yes because "stop that"

