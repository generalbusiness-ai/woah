# task states and transitions

The notes/2026-05-06-task-obligation-model.md is implemented, draft.
The user-primary UI is kanban states, which are an observable side-effect
of the actual status of the task: conditions met.

But we don't get much flexibility in routing decisions,
and want some of those decisions to be automatable with rules
    - e.g. triage assignes a priority from an enum list;
      high priority tickets send a notification to some group of actors;
      maybe auto-close or whatever we want to build later.

Also, the conditions for "is it done" are super loose
where they need to be not only "text description of the conditions of
satisfaction", but actual yes/no expressible on properties of the task.

Instead we should do an xstate-like machine where states are primary
and their transitions follow rules that are defined in each state.

Compare keep:
- /Users/hugh/play/keep/docs/FLOWS.md
- /Users/hugh/play/keep/docs/FLOW_STATE_DOCS.md
- /Users/hugh/play/keep/later/design/state-doc-schema.md
- /Users/hugh/play/keep/later/design/state-doc-compositioin.md
- (etc)

    - state -> named sequence of actions (or parallel actions)
    - action -> run code to do stuff, or "call and return" another state
    - terminal "done" or "error" (not very expressive)

    - but: keep's actions are python code,
      and our model is more like a "workflow" than a "search strategy".

    - we don't need overrides, because the agent is a programmer
      and building states is controlled by inworld permissions.

    - our tasks will stop and sit in a state until someone moves them

---

so states ~= "steps" in the current task model,
but we need them to be richer, and composable.

Could project them onto kanban columns, as "state"
(versus "status" which is derived & may be less granular)

---

Who has permission to create/edit the states?
    - wizard, creator, and **whoever else they assign**
    - but must be a programmer, because states are objects.

States are objects because they have verbs,
and the verbs will often be custom,
written by whoever is creating the workflow.

    The states may need to be actually created/edited by some delegation thing
    on the workflow, because the workflow knows who has permission
    to manage its states.

    States are otherwise immutable.
    They ~never get recycled.

Task holds a reference to the state it's in.

Task runs verbs on its state.

Then: a simple protocol:
- state:task_enter(task) => do some thing; verb defined by the state author.  Default state: no-op.
- state:task_comment(task) => 
- state:task_claimed(task) => 
- do we need anything more than this??
    - state:task_property_changed(task, prop) => do some thing.  Default state: no-op.
    (this may be the wrong thing, need examples of what triggers we need)
    - Maybe also a verb for (task exits the state)?
Not implying that a state is a room.  The current model of a task being "claimed" is good.


Track the history of states;

"Add comment" method available at any time -> updates, then triggers "comment_added"

---

We should also deign a concrete instance of all this:
map all the GitHub issue and PR states onto our states,
so that we can track and mirror their transitions.

    (This is relatively heavyweight, & really just to support
    a github-mirror plug/block, and the only reason to do that
    is that we want a "room for discussion" that can hold
    other context...
    
    more compelling examples would be simpler, just enough to
    get agents working together on a thing)

- bug => state "bug/new" -> 
- state "bug/closed" -> task_enter(): notify the task creator
- PR => "PR/new" -> check is author in known-authors-list? => if not, transition to "rejected PR"
- "PR/ready-for-review"
- "PR/approved"
- "PR/changes-requested"

- "PR/closed" state - want to declare an enum of reasons,
    that can be enforced within the state's task_enter()
    (but how is it specified?)


    - the task has some standard properties
      but we want it to be able to have arbitrary others too
      **set by the creator** any way they like?
      as long as they **don't** shadow parent-class properties

      (these properties can then be set by the state's verbs...)
      task:set_property(...)

    - by convention we'll name "workflow types" as the first part (id, no spaces etc)
      and the second is a state
      but you maybe can't create new tasks at any actual state, the workflow routes it for you??
      with a special "initial" state that has an unqualified name
        task(workflow="bug") -> state="bug/new"



