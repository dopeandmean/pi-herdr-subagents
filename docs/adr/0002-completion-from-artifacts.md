# Runs report completion through artifacts, not through the child

The parent session has to learn that a run ended, how it ended, and what it produced. It cannot ask the child: a run's session may already be gone, and an interactive run deliberately outlives the turn that finished. So completion is read from artifacts — the sidecar a child writes when its agent loop ends, the sentinel a launch command leaves in pane output, and pane disappearance as the last resort — and liveness is read from activity snapshots plus pane inspection.

Rejected: a socket or RPC channel between child and parent, which would add a server and a second lifetime to keep alive, and would tell the parent nothing about a child that died without saying goodbye. Process exit was also rejected as the primary signal, because interactive runs stay open after their turn ends.

Consequence: the child process must be able to write into an artifact directory the parent already knows, and every artifact written by an older version must stay readable, since a parent can outlive a child from a release it no longer runs.
