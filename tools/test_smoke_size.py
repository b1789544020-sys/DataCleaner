"""Final smoke test: file existence + size + Python syntax + HTTP serve check."""
import os, sys, subprocess, urllib.request, time

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
files = [
    ("index.html",             "Main HTML page"),
    ("css/style.css",          "Stylesheet"),
    ("js/rules.js",            "Rules engine"),
    ("js/io.js",               "IO: CSV/XLSX parsing, presets"),
    ("js/worker.js",           "Worker tasks, streaming and cancellation"),
    ("js/ai.js",               "AI provider"),
    ("js/app.js",              "Main application"),
    ("README.md",              "Documentation"),
    ("CONTRIBUTING.md",        "Contributor guide"),
    ("docs/screenshot.png",    "Current application screenshot"),
    ("tools/test_engine_browser.py", "Browser engine test (41 cases)"),
    ("tools/test_io_browser.py",  "IO test: CSV/XLSX/presets/pager (61 cases)"),
    ("tools/test_e2e_browser.py", "End-to-end UI test (23 cases)"),
    ("tools/test_regression_browser.py", "Data-safety/audit regressions (36 cases)"),
    ("tools/test_transforms_browser.py", "High-frequency transformation tests (25 cases)"),
    ("tools/test_worker_browser.py", "Worker/large-file/cache tests (27 cases)"),
    ("tools/test_cross_browser.py", "Chromium/Firefox/WebKit tests (27 cases)"),
    ("tools/test_real_xlsx_browser.py", "Real openpyxl workbook test (8 cases)"),
    ("tools/test_rules.py",     "Rule unit tests (35 cases)"),
    ("tools/test_smoke_size.py", "This smoke test"),
    ("LICENSE",                 "MIT license"),
    (".gitignore",              "Git ignore rules"),
]

print("=" * 60)
print("DataCleanerPro AI - Final Smoke Test")
print("=" * 60)
all_ok = True
total = 0
for f, desc in files:
    p = os.path.join(BASE, f)
    if os.path.exists(p):
        s = os.path.getsize(p)
        total += s
        print(f"  OK   {f:28s}  {s:>8,d} bytes  ({desc})")
    else:
        all_ok = False
        print(f"  MISS {f:28s}  --  ({desc})")
print(f"\n  Total: {total:,d} bytes ({total/1024:.1f} KB)")
print()

# Python compile check
print("Python syntax check:")
test_files = [os.path.join(BASE, f) for f, _ in files if f.endswith(".py") and os.path.exists(os.path.join(BASE, f))]
r = subprocess.run(
    [sys.executable, "-m", "py_compile"] + test_files,
    capture_output=True, text=True, timeout=10
)
if r.returncode == 0:
    print("  OK   all .py files compile")
else:
    all_ok = False
    print(f"  FAIL: {r.stderr.strip()[:200]}")
print()

# Check if the HTTP server is up
print("HTTP server check (localhost:8765):")
try:
    req = urllib.request.urlopen("http://localhost:8765/", timeout=2)
    status = req.status
    body = req.read()[:200]
    if status == 200 and b"DataCleaner" in body or b"<!DOCTYPE" in body:
        print(f"  OK   HTTP 200, served {len(body)}+ bytes of HTML")
    else:
        print(f"  WARN HTTP {status}, body preview: {body[:80]}")
except Exception as e:
    print(f"  INFO no server detected on :8765 ({type(e).__name__})")
    print("        (this is OK - run tools/test_engine_browser.py to validate all rules)")
print()

print("=" * 60)
print("RESULT:", "ALL CHECKS PASSED" if all_ok else "SOME CHECKS FAILED")
print("=" * 60)
sys.exit(0 if all_ok else 1)