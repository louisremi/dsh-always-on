# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker.

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `needs-human`        | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table.

Edit the "Label in our tracker" column to match whatever vocabulary you actually use.

## This repo's own agent workflow labels

`dsh-always-on` also runs a maintainer agent that drives issues through its own pipeline. Those labels are **separate** from the five triage roles above and are not managed by `/triage`. Don't reuse, rename, or clear them from a triage skill run:

| Label                           | Meaning                                                        |
| ------------------------------- | -------------------------------------------------------------- |
| `agent-fix`                     | The maintainer agent has claimed this issue to work a fix       |
| `agent-in-progress`             | Work is underway                                                 |
| `agent-rereview`                | Back for another review pass                                   |
| `agent-drafting-pr-in-progress` | A PR draft is being prepared                                   |
| `no-agent`                      | Explicitly excluded from agent pickup                          |

So `ready-for-agent` here means "a human has judged this issue ready for agentic work". The maintainer agent's `agent-*` labels then record what it actually did with it. A `needs-human` issue is out of that pipeline: leave the existing label in place and don't try to convert it.
