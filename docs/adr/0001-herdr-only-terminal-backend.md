# Herdr is the only terminal backend

A subagent needs a terminal surface of its own, and every surface this extension touches — panes, tabs, workspaces, focus, pane inspection — is a herdr concept. We decided herdr is the only supported backend, so pane operations are called directly instead of behind a mux interface.

The alternative was a terminal abstraction with tmux or zellij as a second adapter. That was rejected: there is no second adapter, the integration suite runs inside herdr, and the extension is inert outside it. A seam with one adapter is a seam nobody can test the other side of, and the codebase had already grown vestigial backend parameters that every call site ignored.
