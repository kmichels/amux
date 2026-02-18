# cmux

Single-file project: everything lives in `cmux-server.py` (Python server + inline HTML/CSS/JS dashboard).

## Workflow

- **Commit after every completed task.** When you finish a piece of work (bug fix, feature, refactor), immediately `git add cmux-server.py && git commit` with a concise message. Don't batch multiple tasks into one commit.
- The server auto-restarts on file save (watches its own mtime), so changes are live immediately.
- Always verify Python syntax after edits: `python3 -c "import ast; ast.parse(open('cmux-server.py').read())"`
