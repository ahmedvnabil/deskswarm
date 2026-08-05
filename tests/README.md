# Tests

```bash
pip install flask gunicorn docker requests pytest
pytest tests -q
```

No Docker daemon, agent, or desktop is needed: `conftest.py` stubs `fleet.py`
(the only module that talks to Docker) and points the app at a temporary
database.

`test_security.py` is the important one. The dashboard can run shell commands
as root inside a machine, so a cross-site request that reaches a mutating
endpoint is remote code execution. Those tests fail against the code as it was
before the Origin check was added — that is what makes them worth having.
