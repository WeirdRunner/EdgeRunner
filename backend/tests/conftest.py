import os
os.environ.setdefault("EDGERUNNER_NO_AUTH", "1")
os.environ.setdefault("EDGERUNNER_HOME", os.path.join(os.path.dirname(__file__), ".edgerunner-test-home"))
