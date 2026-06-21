---
description: "Strictly enforces Windows OS environment awareness. Prevents Unix-specific commands and enforces PowerShell or Python fallbacks for terminal operations."
author: "Cline User"
version: "1.0"
category: "Environment Standards"
tags: ["windows", "terminal", "powershell", "cmd", "error-prevention"]
globs: ["*"]
---

### Windows Environment Constraints 🚨

#### Objective
You are operating in a **Windows environment**. The default terminal is PowerShell. You **MUST** ensure all executed commands are fully compatible with Windows. 

#### Core Directives
*   **NEVER** use Unix-specific commands or flags (e.g., `mkdir -p`, `rm -rf`, `touch`, `ls -la`, `cat`, `grep`).
*   **NEVER** use legacy CMD branching logic (e.g., `if not exist`) if the terminal is PowerShell.
*   **ALWAYS** use valid PowerShell cmdlets OR standard Python one-liners for file system operations.
*   **MUST** use Python scripts (`python -c "..."`) as the primary fallback for creating directories or files, as Python is inherently cross-platform and avoids terminal syntax issues.

#### Examples

✅ **CORRECT (Python Cross-Platform Fallback - PREFERRED):**
```shell
python -c "import os; os.makedirs('data/cases', exist_ok=True)"
❌ WRONG (Unix Syntax - WILL FAIL):
mkdir -p data/cases
✅ CORRECT (Native PowerShell):
New-Item -ItemType Directory -Force -Path "data\cases"
❌ WRONG (Legacy CMD syntax inside PowerShell):
if not exist data\cases ( mkdir data\cases )
Verification Step (BLOCKER ⛔️)
Before invoking the execute_command tool, you MUST perform this internal check using a <thinking> block: <thinking>
Is the command I am about to run containing any Unix-exclusive syntax (like -p or -rf)?
If using native commands, is it 100% valid PowerShell syntax?
Could I use a simple Python script instead to guarantee this works on Windows without syntax errors?